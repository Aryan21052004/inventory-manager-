import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", async () => {
  const { supabaseServerMock } = await import("./supabase-auth-mock");
  return supabaseServerMock;
});

import { AppError } from "@/lib/errors";
import { getCurrentUser, requireRole, requireUser } from "@/server/auth";

import {
  fakeSupabaseUser,
  signInAsSupabase,
  signOutSupabase,
} from "./supabase-auth-mock";

/**
 * The part of the gate that runs before the database does.
 *
 * `getCurrentUser()` answers these cases from the verified JWT claims alone and
 * returns without reading a row, which is why they are in their own file: they
 * need no database and can run while the test database is still being isolated.
 * Everything past the gate — the lookup, the one-time adoption, the race, the
 * verified-email refusal — reads or writes a row and lives in
 * `supabase-auth.test.ts`.
 *
 * What is proved here is that a request carrying nothing, or carrying a session
 * with no person behind it, is refused without the database being consulted at
 * all. A gate that only works after a round trip is one that fails open when the
 * database is unavailable.
 */

beforeEach(() => {
  signOutSupabase();
});

describe("a request with no session", () => {
  it("has no current user", async () => {
    expect(await getCurrentUser()).toBeNull();
  });

  it("is refused by requireUser", async () => {
    await expect(requireUser()).rejects.toBeInstanceOf(AppError);
  });

  it("is refused at any role gate", async () => {
    await expect(requireRole("ADMIN")).rejects.toBeInstanceOf(AppError);
    await expect(requireRole("ADMIN", "STAFF")).rejects.toBeInstanceOf(AppError);
  });

  /*
   * UNAUTHORIZED, not FORBIDDEN. The distinction reaches the user as "sign in"
   * rather than "you may not", and reaches the client as 401 rather than 403.
   */
  it("is refused with UNAUTHORIZED rather than FORBIDDEN", async () => {
    const error = await requireRole("ADMIN").catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "UNAUTHORIZED", status: 401 });
  });

  it("creates no user row, because it never reaches the database", async () => {
    // Nothing to assert against a table here — the point is that this resolves
    // at all. These tests run with DATABASE_URL pointed at a closed port, so a
    // query would throw a connection error rather than return null.
    expect(await getCurrentUser()).toBeNull();
  });
});

describe("a session with no person behind it", () => {
  /*
   * Supabase can mint an anonymous session. It carries a `sub` like any other,
   * so a resolver that checked only for one would go on to claim or create a row
   * for nobody — and the claim path matches on email, which an anonymous session
   * can carry.
   */
  it("refuses an anonymous session without any lookup", async () => {
    signInAsSupabase(
      fakeSupabaseUser("sb_anon", "admin@example.com", { is_anonymous: true }),
    );

    expect(await getCurrentUser()).toBeNull();
  });

  it("refuses an anonymous session at the role gate too", async () => {
    signInAsSupabase(
      fakeSupabaseUser("sb_anon", "admin@example.com", { is_anonymous: true }),
    );

    await expect(requireRole("ADMIN")).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  it("refuses it even when the email matches an administrator's", async () => {
    // The address is the adoption key, so an anonymous session presenting one
    // is exactly the case that must not get as far as the adoption lookup.
    signInAsSupabase(
      fakeSupabaseUser("sb_anon", "admin@inventory.local", {
        is_anonymous: true,
      }),
    );

    expect(await getCurrentUser()).toBeNull();
  });
});
