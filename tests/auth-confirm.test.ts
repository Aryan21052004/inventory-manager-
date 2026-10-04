import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `redirect()` throws, which is how it stops the handler. Replacing it with a
 * throw of our own is what makes the route testable without a Next request
 * context — and without depending on the shape of Next's internal redirect
 * digest, which is not a public contract.
 */
class Redirected extends Error {
  constructor(readonly location: string) {
    super(`redirect to ${location}`);
  }
}

vi.mock("next/navigation", () => ({
  redirect: (location: string) => {
    throw new Redirected(location);
  },
}));

const verifyOtp = vi.fn<
  (params: { type: string; token_hash: string }) => Promise<{
    error: { message: string } | null;
  }>
>();

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { verifyOtp } }),
}));

import { GET } from "@/app/auth/confirm/route";
import {
  CONFIRMATION_FAILED_PATH,
  confirmCallbackUrl,
  confirmationRequest,
  EMAIL_DESTINATION,
  RECOVERY_DESTINATION,
  safeNextPath,
} from "@/lib/validation/auth-confirm";

/**
 * The emailed-link callback.
 *
 * No database and no browser: the route's only side effect is a redirect, and
 * the Supabase client it uses is mocked — reaching the real one would mean
 * talking to the production project.
 *
 * The open-redirect cases are the ones worth having. `next` arrives from a URL
 * that anyone can construct and send to a user, so every value it accepts is a
 * place this application will send someone who trusted a link with our hostname
 * in it.
 */

/** Runs the handler and returns wherever it redirected to. */
async function locationFor(query: string): Promise<string> {
  const request = new Request(`https://app.example.com/auth/confirm?${query}`);

  try {
    // The handler's parameter is typed as NextRequest; a Request is all it
    // actually reads (`request.url`), and constructing a NextRequest here would
    // be mocking Next rather than testing the route.
    await GET(request as never);
  } catch (error) {
    if (error instanceof Redirected) return error.location;
    throw error;
  }

  throw new Error("the handler returned without redirecting");
}

beforeEach(() => {
  verifyOtp.mockReset();
  verifyOtp.mockResolvedValue({ error: null });
});

describe("refusing a request it should not act on", () => {
  it("redirects to sign-in when token_hash is missing", async () => {
    expect(await locationFor("type=email")).toBe(CONFIRMATION_FAILED_PATH);
  });

  it("does not call verifyOtp when token_hash is missing", async () => {
    await locationFor("type=email");

    expect(verifyOtp).not.toHaveBeenCalled();
  });

  it("redirects to sign-in when type is missing", async () => {
    expect(await locationFor("token_hash=abc")).toBe(CONFIRMATION_FAILED_PATH);
  });

  /*
   * Supabase's own `EmailOtpType` ends in `(string & {})`, so it would accept
   * any of these. This application only ever sends two kinds of email, and a
   * link asking for a third is a link it did not send.
   */
  it("refuses a verification type this application never initiates", async () => {
    for (const type of [
      "email_change",
      "magiclink",
      "invite",
      "signup",
      "sms",
      "EMAIL",
      "",
    ]) {
      expect(
        await locationFor(`token_hash=abc&type=${encodeURIComponent(type)}`),
        type,
      ).toBe(CONFIRMATION_FAILED_PATH);
    }

    expect(verifyOtp).not.toHaveBeenCalled();
  });

  it("redirects to sign-in when verifyOtp fails", async () => {
    verifyOtp.mockResolvedValue({ error: { message: "Token has expired" } });

    expect(await locationFor("token_hash=abc&type=email")).toBe(
      CONFIRMATION_FAILED_PATH,
    );
  });

  it("does not report why verification failed", async () => {
    verifyOtp.mockResolvedValue({
      error: { message: "Token has expired or is invalid" },
    });

    const location = await locationFor("token_hash=abc&type=recovery");

    expect(location).not.toMatch(/expired|invalid|token/i);
  });
});

describe("verifying a legitimate link", () => {
  it("sends a confirmed email to the dashboard", async () => {
    expect(await locationFor("token_hash=abc&type=email")).toBe(
      EMAIL_DESTINATION,
    );
  });

  it("sends a recovery link to the reset form", async () => {
    expect(await locationFor("token_hash=abc&type=recovery")).toBe(
      RECOVERY_DESTINATION,
    );
  });

  it("calls verifyOtp with exactly the type and token hash from the link", async () => {
    await locationFor("token_hash=hash-from-email&type=recovery");

    expect(verifyOtp).toHaveBeenCalledTimes(1);
    expect(verifyOtp).toHaveBeenCalledWith({
      type: "recovery",
      token_hash: "hash-from-email",
    });
  });

  it("honours a safe next path", async () => {
    expect(
      await locationFor("token_hash=abc&type=recovery&next=%2Freset-password"),
    ).toBe("/reset-password");

    expect(await locationFor("token_hash=abc&type=email&next=%2Fsettings")).toBe(
      "/settings",
    );
  });
});

describe("not becoming an open redirect", () => {
  const HOSTILE = [
    "https://evil.example/steal",
    "http://evil.example",
    "//evil.example",
    "//evil.example/path",
    "javascript:alert(document.cookie)",
    "JavaScript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "\\\\evil.example",
    "/\\evil.example",
    "\t//evil.example",
    " //evil.example",
    "mailto:someone@evil.example",
    "relative-without-slash",
  ];

  it("falls back to the default destination for every hostile next", async () => {
    for (const next of HOSTILE) {
      expect(
        await locationFor(
          `token_hash=abc&type=recovery&next=${encodeURIComponent(next)}`,
        ),
        next,
      ).toBe(RECOVERY_DESTINATION);
    }
  });

  it("never redirects anywhere but a path on this origin", async () => {
    for (const next of HOSTILE) {
      const location = await locationFor(
        `token_hash=abc&type=email&next=${encodeURIComponent(next)}`,
      );

      expect(location.startsWith("/"), next).toBe(true);
      expect(location.startsWith("//"), next).toBe(false);
      expect(location, next).not.toMatch(/evil\.example/);
      expect(location, next).not.toMatch(/^[a-z][a-z0-9+.-]*:/i);
    }
  });

  it("rejects a next that would carry a credential into the address bar", async () => {
    for (const next of [
      "/dashboard?token_hash=abc",
      "/dashboard?access_token=xyz",
      "/dashboard?refresh_token=xyz",
    ]) {
      expect(safeNextPath(next), next).toBeNull();
    }
  });
});

describe("the token never appears in a redirect", () => {
  it("is absent on success", async () => {
    const location = await locationFor(
      "token_hash=super-secret-hash&type=email",
    );

    expect(location).not.toContain("super-secret-hash");
    expect(location).not.toContain("token_hash");
  });

  it("is absent on failure", async () => {
    verifyOtp.mockResolvedValue({ error: { message: "nope" } });

    const location = await locationFor(
      "token_hash=super-secret-hash&type=recovery",
    );

    expect(location).not.toContain("super-secret-hash");
    expect(location).not.toContain("token_hash");
  });

  it("is absent even when next tries to smuggle it", async () => {
    const location = await locationFor(
      "token_hash=super-secret-hash&type=recovery&next=" +
        encodeURIComponent("/reset-password?token_hash=super-secret-hash"),
    );

    expect(location).toBe(RECOVERY_DESTINATION);
    expect(location).not.toContain("super-secret-hash");
  });
});

describe("safeNextPath in isolation", () => {
  it("accepts ordinary application paths", () => {
    for (const path of [
      "/",
      "/dashboard",
      "/reset-password",
      "/products/abc123",
      "/reports/stock?page=2",
    ]) {
      expect(safeNextPath(path), path).toBe(path);
    }
  });

  it("returns null for nothing at all", () => {
    expect(safeNextPath(null)).toBeNull();
    expect(safeNextPath(undefined)).toBeNull();
    expect(safeNextPath("")).toBeNull();
  });
});

describe("confirmationRequest in isolation", () => {
  const parse = (query: string) =>
    confirmationRequest(new URLSearchParams(query));

  it("defaults by type when next is absent", () => {
    const email = parse("token_hash=a&type=email");
    const recovery = parse("token_hash=a&type=recovery");

    expect(email.ok && email.destination).toBe(EMAIL_DESTINATION);
    expect(recovery.ok && recovery.destination).toBe(RECOVERY_DESTINATION);
  });

  it("carries the token hash through unchanged", () => {
    const parsed = parse("token_hash=a%2Bb%2Fc&type=email");

    expect(parsed.ok && parsed.tokenHash).toBe("a+b/c");
  });
});

describe("the URLs the forms send", () => {
  /*
   * Asserted on the shared builder rather than by rendering a form. The value
   * that matters is the string Supabase is given, and these two are the whole
   * reason the callback route gets reached at all.
   */
  it("points signup confirmation at /auth/confirm", () => {
    const url = confirmCallbackUrl("https://app.example.com");

    expect(url).toBe("https://app.example.com/auth/confirm");
    expect(url).toContain("/auth/confirm");
  });

  it("points password recovery at /auth/confirm with an encoded next", () => {
    const url = confirmCallbackUrl(
      "https://app.example.com",
      RECOVERY_DESTINATION,
    );

    expect(url).toBe(
      "https://app.example.com/auth/confirm?next=%2Freset-password",
    );
    expect(new URL(url).pathname).toBe("/auth/confirm");
    expect(new URL(url).searchParams.get("next")).toBe("/reset-password");
  });

  it("builds against the supplied origin, hardcoding no hostname", () => {
    expect(confirmCallbackUrl("http://localhost:3000")).toBe(
      "http://localhost:3000/auth/confirm",
    );
  });

  it("encodes a next that would otherwise break out of the query", () => {
    const url = confirmCallbackUrl(
      "https://app.example.com",
      "/dashboard?a=1&b=2",
    );

    // The whole value stays inside one parameter.
    expect(new URL(url).searchParams.get("next")).toBe("/dashboard?a=1&b=2");
    expect([...new URL(url).searchParams.keys()]).toEqual(["next"]);
  });
});
