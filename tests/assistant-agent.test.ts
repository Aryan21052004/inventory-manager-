import type { Content } from "@google/genai";
import { beforeEach, describe, expect, it } from "vitest";

import {
  MAX_CALLS_PER_ROUND,
  MAX_TOOL_ROUNDS,
  runAssistant,
  toContents,
  type AssistantModel,
  type ModelRequest,
  type ModelTurn,
} from "@/server/assistant/agent";
import { systemInstruction } from "@/server/assistant/prompt";

import { signOutSupabase } from "./supabase-auth-mock";
import { resetDatabase, seedProduct, signInWithRole } from "./database";

/**
 * The function-calling loop, driven by a scripted model.
 *
 * The real model is non-deterministic and behind a network; the loop is
 * neither. A fake that replays a fixed list of turns, and records every request
 * it is sent, is enough to prove the parts that matter: a call reaches only a
 * declared tool, its result goes back paired with the call, the history the
 * model wrote is returned untouched, and the loop stops.
 */

const NOW = new Date("2026-10-05T12:00:00.000Z");

function calls(...functionCalls: { name: string; args?: Record<string, unknown>; id?: string }[]): ModelTurn {
  return {
    content: {
      role: "model",
      parts: functionCalls.map((call) => ({ functionCall: { args: {}, ...call } })),
    },
    finishReason: "STOP",
    blockReason: null,
    usage: { inputTokens: 10, outputTokens: 5 },
  };
}

function says(text: string): ModelTurn {
  return {
    content: { role: "model", parts: [{ text }] },
    finishReason: "STOP",
    blockReason: null,
    usage: { inputTokens: 10, outputTokens: 5 },
  };
}

/** A model that plays `turns` in order and keeps a copy of every request. */
function scripted(turns: ModelTurn[]): { model: AssistantModel; requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  let next = 0;

  const model: AssistantModel = async (request) => {
    // A snapshot: the loop keeps appending to the same array afterwards.
    requests.push({ ...request, contents: structuredClone(request.contents) });
    const turn = turns[Math.min(next, turns.length - 1)];
    next += 1;
    if (!turn) throw new Error("script exhausted");
    return turn;
  };

  return { model, requests };
}

function ask(model: AssistantModel, role: "ADMIN" | "STAFF" = "ADMIN", question = "How many?") {
  return runAssistant({
    role,
    messages: [{ role: "user", content: question }],
    model,
    now: NOW,
    signal: new AbortController().signal,
  });
}

/** The function responses the loop sent back in a given request. */
function responsesIn(request: ModelRequest): Record<string, unknown>[] {
  const last = request.contents[request.contents.length - 1] as Content;
  return (last.parts ?? []).map((part) => part.functionResponse as Record<string, unknown>);
}

beforeEach(async () => {
  signOutSupabase();
  await resetDatabase();
  await signInWithRole("ADMIN");
});

describe("a tool round trip", () => {
  it("runs the requested tool and returns the model's answer with server-built links", async () => {
    const product = await seedProduct({ sku: "LOOP-1", stockQuantity: 7 });

    const { model, requests } = scripted([
      calls({ name: "get_product", args: { sku: "LOOP-1" }, id: "call-1" }),
      says("You have 7 units of LOOP-1."),
    ]);

    const reply = await ask(model);

    expect(reply.answer).toBe("You have 7 units of LOOP-1.");
    expect(reply.steps).toEqual([{ tool: "get_product", label: "Product details", ok: true }]);
    expect(reply.sources).toEqual([{ label: "Product LOOP-1", href: `/products/${product.id}` }]);

    const [response] = responsesIn(requests[1]!);
    expect(response).toMatchObject({ id: "call-1", name: "get_product" });
    expect(response!.response).toMatchObject({
      output: { found: true, product: { sku: "LOOP-1", stock: { onHand: 7 } } },
    });
  });

  it("returns the model's own turn to it unchanged, thought signature included", async () => {
    await seedProduct({ sku: "SIG-1" });

    const turn = calls({ name: "get_product", args: { sku: "SIG-1" } });
    turn.content!.parts![0]!.thoughtSignature = "opaque-signature";

    const { model, requests } = scripted([turn, says("Done.")]);
    await ask(model);

    const echoed = requests[1]!.contents[1]!;
    expect(echoed).toEqual(turn.content);
  });

  it("offers the model the tools for the asker's role and states today's date", async () => {
    const { model, requests } = scripted([says("Hello.")]);

    await ask(model, "STAFF");

    const names = requests[0]!.functionDeclarations.map((declaration) => declaration.name);
    expect(names).not.toContain("list_quarantined_stock");
    expect(requests[0]!.systemInstruction).toContain("Today is 2026-10-05 (UTC)");
    expect(requests[0]!.systemInstruction).toContain("role is STAFF");
    expect(requests[0]!.allowFunctionCalls).toBe(true);
  });
});

describe("what the model may not do", () => {
  it("answers an undeclared tool with an error instead of running anything", async () => {
    const { model, requests } = scripted([
      calls({ name: "delete_everything" }),
      says("I can't do that."),
    ]);

    const reply = await ask(model);

    expect(reply.steps).toEqual([{ tool: "delete_everything", label: "delete_everything", ok: false }]);
    expect(responsesIn(requests[1]!)[0]!.response).toEqual({
      error: { code: "UNKNOWN_TOOL", message: 'There is no tool named "delete_everything".' },
    });
  });

  it("treats an ADMIN-only tool as unknown for STAFF", async () => {
    await signInWithRole("STAFF");
    const { model, requests } = scripted([
      calls({ name: "list_quarantined_stock" }),
      says("Not available."),
    ]);

    await ask(model, "STAFF");

    expect(responsesIn(requests[1]!)[0]!.response).toMatchObject({
      error: { code: "UNKNOWN_TOOL" },
    });
  });

  it("returns invalid arguments to the model as an error it can correct", async () => {
    const { model, requests } = scripted([
      calls({ name: "search_orders", args: { status: "SHIPPED" } }),
      says("Which status?"),
    ]);

    await ask(model);

    expect(responsesIn(requests[1]!)[0]!.response).toMatchObject({
      error: { code: "INVALID_ARGUMENTS" },
    });
  });

  it("caps the calls run in one round", async () => {
    const many = Array.from({ length: MAX_CALLS_PER_ROUND + 2 }, (_, index) => ({
      name: "get_inventory_summary",
      id: `c${index}`,
    }));
    const { model, requests } = scripted([calls(...many), says("Summary.")]);

    await ask(model);

    const responses = responsesIn(requests[1]!);
    expect(responses).toHaveLength(MAX_CALLS_PER_ROUND + 2);
    expect(
      responses.filter(
        (entry) => (entry.response as { error?: { code: string } }).error?.code === "TOO_MANY_CALLS",
      ),
    ).toHaveLength(2);
  });

  it("stops after the round limit and makes the model answer with what it has", async () => {
    const { model, requests } = scripted([
      ...Array.from({ length: MAX_TOOL_ROUNDS }, () => calls({ name: "get_inventory_summary" })),
      // Even if the model still asks for a tool on the final round, it is not run.
      {
        ...calls({ name: "get_inventory_summary" }),
        content: {
          role: "model",
          parts: [
            { functionCall: { name: "get_inventory_summary", args: {} } },
            { text: "Here is what I found." },
          ],
        },
      },
    ]);

    const reply = await ask(model);

    expect(requests).toHaveLength(MAX_TOOL_ROUNDS + 1);
    expect(requests[MAX_TOOL_ROUNDS]!.allowFunctionCalls).toBe(false);
    expect(reply.steps).toHaveLength(MAX_TOOL_ROUNDS);
    expect(reply.answer).toBe("Here is what I found.");
  });
});

describe("turns without an answer", () => {
  it("explains a blocked prompt rather than returning nothing", async () => {
    const { model } = scripted([
      { content: null, finishReason: null, blockReason: "SAFETY", usage: { inputTokens: 1, outputTokens: 0 } },
    ]);

    const reply = await ask(model);
    expect(reply.answer).toMatch(/can't help with that/i);
  });

  it("explains an answer cut off by the output limit", async () => {
    const { model } = scripted([
      { content: { role: "model", parts: [] }, finishReason: "MAX_TOKENS", blockReason: null, usage: { inputTokens: 1, outputTokens: 1 } },
    ]);

    const reply = await ask(model);
    expect(reply.answer).toMatch(/too long/i);
  });
});

describe("the conversation sent to the model", () => {
  it("is text only, opens with the user, and maps roles to Gemini's", () => {
    const contents = toContents([
      { role: "assistant", content: "Hi, how can I help?" },
      { role: "user", content: "Stock of ABC123?" },
      { role: "assistant", content: "12 units." },
      { role: "user", content: "And value?" },
    ]);

    expect(contents).toEqual([
      { role: "user", parts: [{ text: "Stock of ABC123?" }] },
      { role: "model", parts: [{ text: "12 units." }] },
      { role: "user", parts: [{ text: "And value?" }] },
    ]);
  });

  it("states the read-only and currency rules, in codes rather than symbols", () => {
    const instruction = systemInstruction("ADMIN", NOW);

    expect(instruction).toMatch(/read-only/i);
    expect(instruction).toMatch(/never add, subtract, average, compare or convert amounts in different currencies/i);
    expect(instruction).not.toMatch(/[€₹]/);
  });
});
