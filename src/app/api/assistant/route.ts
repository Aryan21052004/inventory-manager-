import { z } from "zod";

import { assistantEnabled } from "@/lib/env";
import { AppError, httpStatusFor, toSafeError } from "@/lib/errors";
import { runAssistant } from "@/server/assistant/agent";
import { createGeminiModel } from "@/server/assistant/gemini";
import { consumeAssistantQuota } from "@/server/assistant/rate-limit";
import { requireUser } from "@/server/auth";

/**
 * The inventory assistant's single endpoint.
 *
 * **This route is its own authorisation boundary.** It lives under `/api`,
 * outside the `(app)` layout whose session check protects the pages, and most
 * of the read loaders the assistant's tools call do not check the session
 * themselves — they were written to run beneath that layout. So the first
 * thing that happens here, before the body is read and before any model is
 * contacted, is `requireUser()`: a signed-out request costs nothing and
 * learns nothing. The role on the returned user is the one the tool list is
 * built from; nothing in the request can claim another.
 *
 * Then, in order: the request must come from this application's own pages
 * (the session cookie alone would let another site's page spend this user's
 * quota), the feature must be configured, the user must be under their rate
 * limit, and the body must be a short, text-only transcript ending with the
 * user's question.
 *
 * The answer comes back as one JSON object rather than a stream. A question
 * is a handful of quick lookups, and an object carries the server-built
 * links and the list of lookups made alongside the text without a framing
 * protocol to keep in step with the client.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
/**
 * The function's ceiling on Vercel. The loop's own deadline sits under it, so
 * a slow model ends as a readable error rather than a killed function.
 */
export const maxDuration = 60;

const DEADLINE_MS = 50_000;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_MESSAGES = 20;
const MAX_MESSAGE_CHARACTERS = 4_000;
const MAX_TRANSCRIPT_CHARACTERS = 24_000;

const NO_STORE = { "Cache-Control": "private, no-store" };

const requestSchema = z
  .strictObject({
    messages: z
      .array(
        z.strictObject({
          role: z.enum(["user", "assistant"]),
          content: z.string().trim().min(1).max(MAX_MESSAGE_CHARACTERS),
        }),
      )
      .min(1)
      .max(MAX_MESSAGES),
  })
  .refine(
    (body) => body.messages[body.messages.length - 1]?.role === "user",
    "The last message must be the user's question.",
  )
  .refine(
    (body) =>
      body.messages.reduce((sum, message) => sum + message.content.length, 0) <=
      MAX_TRANSCRIPT_CHARACTERS,
    "The conversation is too long. Start a new one.",
  );

/**
 * Whether the request came from a page of this application.
 *
 * Browsers mark every fetch with `Sec-Fetch-Site` and every cross-origin POST
 * with `Origin`, so a request from another site's page fails one test or the
 * other. A request with neither header is not from a browser page at all —
 * a script holding the user's own cookie — and that is the user, not a
 * forgery.
 */
function fromThisApplication(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return false;

  const origin = request.headers.get("origin");
  if (!origin) return true;

  const host =
    request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() ||
    request.headers.get("host") ||
    new URL(request.url).host;

  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

async function readBody(request: Request): Promise<z.infer<typeof requestSchema>> {
  if (!request.headers.get("content-type")?.includes("application/json")) {
    throw new AppError("BAD_REQUEST", "Send the conversation as JSON.");
  }

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) {
    throw new AppError("BAD_REQUEST", "The conversation is too long. Start a new one.");
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new AppError("BAD_REQUEST", "The request was not valid JSON.");
  }

  const parsed = requestSchema.safeParse(json);
  if (!parsed.success) {
    throw new AppError(
      "BAD_REQUEST",
      parsed.error.issues[0]?.message ?? "The request was not understood.",
    );
  }

  return parsed.data;
}

export async function POST(request: Request) {
  const startedAt = Date.now();

  try {
    const user = await requireUser();

    if (!fromThisApplication(request)) {
      throw new AppError("FORBIDDEN", "This request did not come from the application.");
    }

    if (!assistantEnabled) {
      throw new AppError(
        "SERVICE_UNAVAILABLE",
        "The assistant is not configured on this installation.",
      );
    }

    consumeAssistantQuota(user.id);

    const body = await readBody(request);

    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(DEADLINE_MS)]);
    let inputTokens = 0;
    let outputTokens = 0;
    let modelTurns = 0;

    const reply = await runAssistant({
      role: user.role,
      messages: body.messages,
      model: createGeminiModel(),
      now: new Date(),
      signal,
      onTurn: (turn) => {
        modelTurns += 1;
        inputTokens += turn.usage.inputTokens;
        outputTokens += turn.usage.outputTokens;
      },
    });

    /*
     * Who asked, which tools ran, and what it cost — never the question, the
     * answer or any data. Enough to audit usage and spend from the host's logs.
     */
    console.info(
      "[inventory-manager] assistant",
      JSON.stringify({
        userId: user.id,
        role: user.role,
        tools: reply.steps.map((step) => `${step.tool}:${step.ok ? "ok" : "error"}`),
        modelTurns,
        inputTokens,
        outputTokens,
        ms: Date.now() - startedAt,
      }),
    );

    return Response.json(reply, { headers: NO_STORE });
  } catch (error) {
    const safe = toSafeError(error, "POST /api/assistant");

    return Response.json(
      { error: safe.message, code: safe.code },
      { status: httpStatusFor(safe.code), headers: NO_STORE },
    );
  }
}
