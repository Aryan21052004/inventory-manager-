import { beforeEach, describe, expect, it, vi } from "vitest";

// Explicitly unset, whatever an earlier test file in this process left behind.
vi.hoisted(() => {
  delete process.env["GEMINI_API_KEY"];
});

const createGeminiModel = vi.hoisted(() => vi.fn());
vi.mock("@/server/assistant/gemini", () => ({ createGeminiModel }));

import { POST } from "@/app/api/assistant/route";
import { assistantEnabled } from "@/lib/env";

import { signOutSupabase } from "./supabase-auth-mock";
import { resetDatabase, signInWithRole } from "./database";

/**
 * Without a Gemini key the assistant is switched off, not broken: the rest of
 * the application boots, and the endpoint answers 503 — to a signed-in user
 * only, so an anonymous caller still cannot learn how the installation is set
 * up.
 */

function post(): Request {
  return new Request("http://localhost:3000/api/assistant", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://localhost:3000",
      "sec-fetch-site": "same-origin",
    },
    body: JSON.stringify({ messages: [{ role: "user", content: "Hello" }] }),
  });
}

beforeEach(async () => {
  signOutSupabase();
  await resetDatabase();
});

describe("an installation without a Gemini key", () => {
  it("reports the assistant as disabled", () => {
    expect(assistantEnabled).toBe(false);
  });

  it("answers a signed-in user with 503", async () => {
    await signInWithRole("ADMIN");

    const response = await POST(post());

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    expect(createGeminiModel).not.toHaveBeenCalled();
  });

  it("still answers a signed-out caller with 401", async () => {
    const response = await POST(post());
    expect(response.status).toBe(401);
  });
});
