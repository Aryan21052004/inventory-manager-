import "server-only";

import { ApiError, FunctionCallingConfigMode, GoogleGenAI } from "@google/genai";

import { env } from "@/lib/env";
import { AppError } from "@/lib/errors";

import type { AssistantModel } from "./agent";

/**
 * The Gemini adapter: the only module that talks to the AI provider.
 *
 * What it sends is the conversation, the system instruction and the tool
 * *declarations* — names, descriptions and argument schemas. What it never
 * sends is anything that could act: the model cannot reach Prisma, SQL,
 * credentials or the network through this request, only ask for a declared
 * tool by name, which `runAssistant` then validates and runs itself.
 * Automatic function calling is switched off explicitly for the same reason:
 * the SDK must never execute anything on the model's behalf.
 *
 * The model is `GEMINI_MODEL`, so moving to a newer one is a configuration
 * change. Nothing here depends on a particular model beyond text generation
 * and function calling.
 */

/** Per attempt. The route's own deadline bounds the whole question. */
const REQUEST_TIMEOUT_MS = 25_000;

/**
 * Low, because the job is reading figures out of tool results accurately, not
 * writing creatively. Generous enough on output for a list of a few dozen rows.
 */
const TEMPERATURE = 0.2;
const MAX_OUTPUT_TOKENS = 2_048;

export function createGeminiModel(): AssistantModel {
  if (!env.GEMINI_API_KEY) {
    throw new AppError(
      "SERVICE_UNAVAILABLE",
      "The assistant is not configured on this installation.",
    );
  }

  const ai = new GoogleGenAI({
    apiKey: env.GEMINI_API_KEY,
    httpOptions: {
      timeout: REQUEST_TIMEOUT_MS,
      // One retry on a rate limit or a transient server error.
      retryOptions: { attempts: 2, httpStatusCodes: [429, 500, 502, 503, 504] },
    },
  });

  return async (request) => {
    try {
      const response = await ai.models.generateContent({
        model: env.GEMINI_MODEL,
        contents: request.contents,
        config: {
          systemInstruction: request.systemInstruction,
          tools: [{ functionDeclarations: request.functionDeclarations }],
          toolConfig: {
            functionCallingConfig: {
              mode: request.allowFunctionCalls
                ? FunctionCallingConfigMode.AUTO
                : FunctionCallingConfigMode.NONE,
            },
          },
          automaticFunctionCalling: { disable: true },
          temperature: TEMPERATURE,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          abortSignal: request.signal,
        },
      });

      const candidate = response.candidates?.[0];

      return {
        content: candidate?.content ?? null,
        finishReason: candidate?.finishReason ?? null,
        blockReason: response.promptFeedback?.blockReason ?? null,
        usage: {
          inputTokens: response.usageMetadata?.promptTokenCount ?? 0,
          outputTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
        },
      };
    } catch (error) {
      throw providerError(error, request.signal);
    }
  };
}

/**
 * A provider failure as an error the route can report.
 *
 * The provider's own message is logged and not passed on: it can name the
 * model, the project or the request in ways a user has no use for. The status
 * decides only which of two sentences they see.
 */
function providerError(error: unknown, signal: AbortSignal): AppError {
  if (signal.aborted) {
    return new AppError(
      "SERVICE_UNAVAILABLE",
      "The assistant took too long to answer. Try a narrower question.",
    );
  }

  const status = error instanceof ApiError ? error.status : null;

  /*
   * The provider's explanation goes to the server log in full — it is what
   * distinguishes a bad key from a disabled API, a retired model or a rejected
   * tool schema, all of which arrive as a bare 400/403/404 otherwise. It never
   * reaches the user, and Google's error bodies do not echo the key.
   */
  console.error(
    "[inventory-manager] assistant model request failed:",
    JSON.stringify({
      status,
      model: env.GEMINI_MODEL,
      error: error instanceof Error ? error.name : "unknown",
      message: (error instanceof Error ? error.message : String(error)).slice(0, 1_000),
    }),
  );

  if (status === 429) {
    return new AppError(
      "RATE_LIMITED",
      "The assistant is busy right now. Please try again in a minute.",
    );
  }

  return new AppError(
    "SERVICE_UNAVAILABLE",
    "The assistant could not reach its AI service. Please try again shortly.",
  );
}
