import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env["GEMINI_API_KEY"] = "test-placeholder-not-a-real-key";
  process.env["GEMINI_MODEL"] = "gemini-test-model";
});

/*
 * The SDK client is replaced; its enums and error class are the real ones, so
 * the adapter is checked against the values the real API expects.
 */
const sdk = vi.hoisted(() => ({
  generateContent: vi.fn(),
  constructed: [] as unknown[],
}));

vi.mock("@google/genai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@google/genai")>();

  class FakeGoogleGenAI {
    models = { generateContent: sdk.generateContent };
    constructor(options: unknown) {
      sdk.constructed.push(options);
    }
  }

  return { ...actual, GoogleGenAI: FakeGoogleGenAI };
});

import { ApiError, FunctionCallingConfigMode } from "@google/genai";

import { createGeminiModel } from "@/server/assistant/gemini";
import type { ModelRequest } from "@/server/assistant/agent";

/**
 * The Gemini adapter's side of the contract: what it sends, what it reads
 * back, and how a provider failure is reported. No network.
 */

function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    systemInstruction: "Be helpful.",
    contents: [{ role: "user", parts: [{ text: "Hi" }] }],
    functionDeclarations: [{ name: "get_inventory_summary", description: "Summary." }],
    allowFunctionCalls: true,
    signal: new AbortController().signal,
    ...overrides,
  };
}

beforeEach(() => {
  sdk.generateContent.mockReset();
  sdk.constructed.length = 0;
});

afterAll(() => {
  delete process.env["GEMINI_API_KEY"];
  delete process.env["GEMINI_MODEL"];
});

describe("the request", () => {
  it("uses the configured model, offers declarations only, and never auto-executes", async () => {
    sdk.generateContent.mockResolvedValue({ candidates: [] });

    await createGeminiModel()(request());

    expect(sdk.constructed[0]).toMatchObject({ apiKey: "test-placeholder-not-a-real-key" });

    const sent = sdk.generateContent.mock.calls[0]![0];
    expect(sent.model).toBe("gemini-test-model");
    expect(sent.config.systemInstruction).toBe("Be helpful.");
    expect(sent.config.tools).toEqual([
      { functionDeclarations: [{ name: "get_inventory_summary", description: "Summary." }] },
    ]);
    expect(sent.config.automaticFunctionCalling).toEqual({ disable: true });
    expect(sent.config.toolConfig.functionCallingConfig.mode).toBe(
      FunctionCallingConfigMode.AUTO,
    );
    // The key travels in the client's configuration, never in the request body.
    expect(JSON.stringify(sent)).not.toContain("test-placeholder-not-a-real-key");
  });

  it("switches function calling off for the final, answer-only round", async () => {
    sdk.generateContent.mockResolvedValue({ candidates: [] });

    await createGeminiModel()(request({ allowFunctionCalls: false }));

    const sent = sdk.generateContent.mock.calls[0]![0];
    expect(sent.config.toolConfig.functionCallingConfig.mode).toBe(
      FunctionCallingConfigMode.NONE,
    );
  });
});

describe("the response", () => {
  it("reads the first candidate's content unchanged, with its finish reason and usage", async () => {
    const content = {
      role: "model",
      parts: [{ functionCall: { name: "get_inventory_summary", args: {} }, thoughtSignature: "sig" }],
    };
    sdk.generateContent.mockResolvedValue({
      candidates: [{ content, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 8 },
    });

    const turn = await createGeminiModel()(request());

    expect(turn).toEqual({
      content,
      finishReason: "STOP",
      blockReason: null,
      usage: { inputTokens: 120, outputTokens: 8 },
    });
  });

  it("reports a blocked prompt", async () => {
    sdk.generateContent.mockResolvedValue({ promptFeedback: { blockReason: "SAFETY" } });

    const turn = await createGeminiModel()(request());

    expect(turn).toMatchObject({ content: null, blockReason: "SAFETY" });
  });
});

describe("provider failures", () => {
  it("turns a provider rate limit into RATE_LIMITED", async () => {
    sdk.generateContent.mockRejectedValue(new ApiError({ message: "quota", status: 429 }));

    await expect(createGeminiModel()(request())).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
  });

  it("turns anything else into SERVICE_UNAVAILABLE without repeating the provider's message", async () => {
    sdk.generateContent.mockRejectedValue(
      new ApiError({ message: "API key not valid for project 98765", status: 400 }),
    );

    const failure = createGeminiModel()(request());

    await expect(failure).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    await expect(failure).rejects.not.toMatchObject({ message: expect.stringContaining("98765") });
  });

  it("reports a request abandoned by the deadline as a timeout", async () => {
    const controller = new AbortController();
    controller.abort();
    sdk.generateContent.mockRejectedValue(new Error("aborted"));

    await expect(
      createGeminiModel()(request({ signal: controller.signal })),
    ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE", message: expect.stringMatching(/too long/) });
  });
});
