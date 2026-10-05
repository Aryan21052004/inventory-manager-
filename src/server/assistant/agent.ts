import "server-only";

import type { Content, FunctionCall, FunctionDeclaration, Part } from "@google/genai";

import type { UserRole } from "@/generated/prisma/enums";

import { systemInstruction } from "./prompt";
import { toolsFor, type AssistantSource, type AssistantTool, type ToolContext } from "./tools";

/**
 * The function-calling loop.
 *
 * Gemini is asked the question with the declared tools. While it answers with
 * function calls, each call is checked against the tools this user may use,
 * its arguments are validated, the matching read-only loader runs, and the
 * result goes back as a function response. When it answers with text, that is
 * the reply.
 *
 * Three limits keep a confused model from turning one question into an
 * unbounded run: rounds of tool use per question, calls per round, and — on
 * the route — a wall-clock deadline. When the rounds run out the model is asked
 * once more with function calling switched off, so it answers from what it has
 * rather than the user getting nothing.
 *
 * The model is passed in rather than constructed here. The route hands it the
 * Gemini adapter (./gemini.ts); the tests hand it a scripted fake, which is how
 * this loop is exercised without a network or an API key.
 */

export interface ModelRequest {
  systemInstruction: string;
  contents: Content[];
  functionDeclarations: FunctionDeclaration[];
  /** False on the final round: the model must answer in text. */
  allowFunctionCalls: boolean;
  signal: AbortSignal;
}

export interface ModelTurn {
  /** The model's turn exactly as returned — appended to the history unchanged. */
  content: Content | null;
  finishReason: string | null;
  /** Set when the prompt itself was blocked and no candidate was produced. */
  blockReason: string | null;
  usage: { inputTokens: number; outputTokens: number };
}

export type AssistantModel = (request: ModelRequest) => Promise<ModelTurn>;

/** One message of the conversation as the browser holds it: text only. */
export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AssistantStep {
  tool: string;
  label: string;
  ok: boolean;
}

export interface AssistantReply {
  answer: string;
  sources: AssistantSource[];
  steps: AssistantStep[];
}

export const MAX_TOOL_ROUNDS = 5;
export const MAX_CALLS_PER_ROUND = 6;
const MAX_SOURCES = 8;

/**
 * The browser's transcript as model contents.
 *
 * Text only, by construction: the client never sends tool calls or tool
 * results, so nothing it supplies can pose as data the server looked up.
 * Every question re-runs its lookups here, against live data, under this
 * request's session. Leading assistant messages are dropped because the
 * conversation sent to the model has to open with the user.
 */
export function toContents(messages: readonly ChatMessage[]): Content[] {
  const firstUser = messages.findIndex((message) => message.role === "user");

  return messages.slice(Math.max(0, firstUser)).map((message) => ({
    role: message.role === "user" ? "user" : "model",
    parts: [{ text: message.content }],
  }));
}

/** The visible text of a turn. Thought summaries, if any, are not the answer. */
function textOf(content: Content | null): string {
  return (content?.parts ?? [])
    .filter((part) => typeof part.text === "string" && !part.thought)
    .map((part) => part.text)
    .join("")
    .trim();
}

function functionCallsOf(content: Content | null): FunctionCall[] {
  return (content?.parts ?? [])
    .map((part) => part.functionCall)
    .filter((call): call is FunctionCall => call !== undefined);
}

/** What to say when a turn ends without usable text. Never a model's guess. */
function fallbackAnswer(turn: ModelTurn): string {
  if (turn.blockReason) {
    return "I can't help with that request. Try asking about your products, stock, orders, purchases, customers, suppliers or reports.";
  }

  switch (turn.finishReason) {
    case "MAX_TOKENS":
      return "The answer was too long to complete. Try a narrower question, such as one product, one supplier or a shorter period.";
    case "MALFORMED_FUNCTION_CALL":
    case "UNEXPECTED_TOOL_CALL":
      return "I couldn't work out how to look that up. Try rephrasing the question, for example with a part number, order number or period.";
    case "SAFETY":
    case "PROHIBITED_CONTENT":
    case "BLOCKLIST":
    case "SPII":
      return "I can't help with that request. Try asking about your products, stock, orders, purchases, customers, suppliers or reports.";
    default:
      return "I couldn't produce an answer to that. Try rephrasing the question.";
  }
}

class SourceList {
  private readonly byHref = new Map<string, AssistantSource>();

  add(sources: readonly AssistantSource[]): void {
    for (const source of sources) {
      if (this.byHref.size >= MAX_SOURCES) return;
      // Only in-app paths, built by the tools from database ids. The check is a
      // backstop: nothing the model wrote ever reaches this list.
      if (!source.href.startsWith("/") || source.href.startsWith("//")) continue;
      if (!this.byHref.has(source.href)) this.byHref.set(source.href, source);
    }
  }

  list(): AssistantSource[] {
    return [...this.byHref.values()];
  }
}

async function runCall(
  call: FunctionCall,
  index: number,
  tools: ReadonlyMap<string, AssistantTool>,
  context: ToolContext,
  steps: AssistantStep[],
  sources: SourceList,
): Promise<Part> {
  const name = call.name ?? "";
  const tool = tools.get(name);

  const respond = (response: Record<string, unknown>): Part => ({
    functionResponse: { id: call.id, name, response },
  });

  // Unknown, or not one this user may use. The same answer either way, so a
  // STAFF session cannot even learn that an ADMIN tool exists.
  if (!tool) {
    steps.push({ tool: name, label: name, ok: false });
    return respond({
      error: { code: "UNKNOWN_TOOL", message: `There is no tool named "${name}".` },
    });
  }

  if (index >= MAX_CALLS_PER_ROUND) {
    steps.push({ tool: name, label: tool.label, ok: false });
    return respond({
      error: {
        code: "TOO_MANY_CALLS",
        message: `At most ${MAX_CALLS_PER_ROUND} lookups can run at once. Ask for fewer at a time.`,
      },
    });
  }

  const result = await tool.invoke(call.args ?? {}, context);
  steps.push({ tool: name, label: tool.label, ok: result.ok });

  if (!result.ok) return respond({ error: result.error });

  sources.add(result.sources);
  return respond({ output: result.output });
}

export async function runAssistant(input: {
  role: UserRole;
  messages: readonly ChatMessage[];
  model: AssistantModel;
  now: Date;
  signal: AbortSignal;
  /** Called once per model turn, for usage logging. */
  onTurn?: (turn: ModelTurn) => void;
}): Promise<AssistantReply> {
  const available = toolsFor(input.role);
  const tools = new Map(available.map((tool) => [tool.name, tool] as const));
  const functionDeclarations = available.map((tool) => tool.declaration);
  const context: ToolContext = { role: input.role, now: input.now };
  const instruction = systemInstruction(input.role, input.now);

  const contents = toContents(input.messages);
  const steps: AssistantStep[] = [];
  const sources = new SourceList();

  for (let round = 0; ; round += 1) {
    const allowFunctionCalls = round < MAX_TOOL_ROUNDS;

    const turn = await input.model({
      systemInstruction: instruction,
      contents,
      functionDeclarations,
      allowFunctionCalls,
      signal: input.signal,
    });
    input.onTurn?.(turn);

    const calls = allowFunctionCalls ? functionCallsOf(turn.content) : [];

    if (calls.length === 0 || turn.content === null) {
      const answer = textOf(turn.content);
      return {
        answer: answer || fallbackAnswer(turn),
        sources: sources.list(),
        steps,
      };
    }

    // The model's turn goes back exactly as it came — including any thought
    // signatures on its function-call parts, which Gemini requires to be
    // returned unchanged — followed by one response per call, in one turn.
    contents.push(turn.content);

    const responses = await Promise.all(
      calls.map((call, index) =>
        runCall(call, index, tools, context, steps, sources),
      ),
    );

    contents.push({ role: "user", parts: responses });
  }
}
