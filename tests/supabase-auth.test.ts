import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", async () => {
  const { supabaseServerMock } = await import("./supabase-auth-mock");
  return supabaseServerMock;
});

import { AppError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import {
  getCurrentUser,
  requireRole,
  resolveSupabaseUser,
} from "@/server/auth";

import { resetDatabase } from "./database";
import {
  fakeSupabaseUser,
  signInAsSupabase,
  signOutSupabase,
} from "./supabase-auth-mock";

/**
 * Mapping a Supabase Auth identity onto a local user row.
 *
 * Against a real database, like the rest of this suite: the properties worth
 * proving here are that a unique index arbitrates a race, that a conditional
 * update refuses to take a row twice, and that a claim writes one column and
 * no others. A mocked Prisma client would only prove the mock was written to
 * agree with the test.
 *
 * Supabase Auth itself is mocked — see `supabase-auth-mock.ts`. Reaching the
 * real project would make the suite depend on a network and an account, and
 * the project in question holds production data.
 */

beforeEach(async () => {
  signOutSupabase();
  await resetDatabase();
});

describe("an unauthenticated request", () => {
  it("returns null when there is no Supabase session", async () => {
    expect(await getCurrentUser()).toBeNull();
  });

  it("creates no user row when there is no session", async () => {
    await getCurrentUser();

    expect(await prisma.user.count()).toBe(0);
  });
});

describe("a session that cannot be mapped", () => {
  it("refuses an unverified email rather than creating an account", async () => {
    signInAsSupabase(
      fakeSupabaseUser("sb_unverified", "someone@example.com", {
        email_confirmed_at: null,
      }),
    );

    await expect(getCurrentUser()).rejects.toBeInstanceOf(AppError);
    expect(await prisma.user.count()).toBe(0);
  });

  /*
   * The escalation this guards against: an unverified sign-up using an
   * administrator's address must not adopt the administrator's row.
   */
  it("does not let an unverified address claim an administrator's row", async () => {
    const admin = await prisma.user.create({
      data: {
        name: "The Administrator",
        email: "admin@example.com",
        role: "ADMIN",
      },
    });

    signInAsSupabase(
      fakeSupabaseUser("sb_impostor", "admin@example.com", {
        email_confirmed_at: null,
      }),
    );

    await expect(getCurrentUser()).rejects.toBeInstanceOf(AppError);

    const untouched = await prisma.user.findUniqueOrThrow({
      where: { id: admin.id },
    });
    expect(untouched.supabaseUserId).toBeNull();
    expect(untouched.role).toBe("ADMIN");
  });

  it("refuses an anonymous session", async () => {
    signInAsSupabase(
      fakeSupabaseUser("sb_anon", "admin@example.com", { is_anonymous: true }),
    );

    await expect(getCurrentUser()).rejects.toBeInstanceOf(AppError);
    expect(await prisma.user.count()).toBe(0);
  });
});

describe("a session already linked to a row", () => {
  it("returns the linked row", async () => {
    const created = await prisma.user.create({
      data: {
        supabaseUserId: "sb_linked",
        name: "Existing Person",
        email: "existing@example.com",
        role: "ADMIN",
      },
    });

    signInAsSupabase(fakeSupabaseUser("sb_linked", "existing@example.com"));

    const resolved = await getCurrentUser();

    expect(resolved?.id).toBe(created.id);
    expect(await prisma.user.count()).toBe(1);
  });

  it("leaves the role, email and name alone", async () => {
    await prisma.user.create({
      data: {
        supabaseUserId: "sb_linked",
        name: "Locally Renamed",
        email: "local@example.com",
        role: "ADMIN",
      },
    });

    // The Supabase account now carries a different address and a name.
    signInAsSupabase(
      fakeSupabaseUser("sb_linked", "changed@example.com", {
        user_metadata: { full_name: "Changed In Supabase" },
      }),
    );

    const resolved = await getCurrentUser();

    expect(resolved?.role).toBe("ADMIN");
    expect(resolved?.email).toBe("local@example.com");
    expect(resolved?.name).toBe("Locally Renamed");
  });

  /*
   * Requirement stated as a test because it is the difference between an
   * identity key and a guess: once a row is linked, the email must not be
   * consulted, even when it matches a different claimable row.
   */
  it("is found by id, never by an email that matches another row", async () => {
    const linked = await prisma.user.create({
      data: {
        supabaseUserId: "sb_linked",
        name: "Linked",
        email: "linked@example.com",
        role: "STAFF",
      },
    });

    const decoy = await prisma.user.create({
      data: {
        name: "Decoy Admin",
        email: "decoy@example.com",
        role: "ADMIN",
      },
    });

    // The session's id matches the linked row while its email matches the
    // unclaimed admin row. The id must win.
    signInAsSupabase(fakeSupabaseUser("sb_linked", "decoy@example.com"));

    const resolved = await getCurrentUser();

    expect(resolved?.id).toBe(linked.id);
    expect(resolved?.role).toBe("STAFF");

    const stillUnclaimed = await prisma.user.findUniqueOrThrow({
      where: { id: decoy.id },
    });
    expect(stillUnclaimed.supabaseUserId).toBeNull();
    expect(stillUnclaimed.role).toBe("ADMIN");
  });
});

describe("claiming an existing unlinked row", () => {
  it("links the row by email on first sign-in", async () => {
    const existing = await prisma.user.create({
      data: {
        name: "Warehouse Lead",
        email: "lead@example.com",
        role: "STAFF",
      },
    });

    signInAsSupabase(fakeSupabaseUser("sb_new", "lead@example.com"));

    const resolved = await getCurrentUser();

    expect(resolved?.id).toBe(existing.id);
    expect(resolved?.supabaseUserId).toBe("sb_new");
    expect(await prisma.user.count()).toBe(1);
  });

  /*
   * The reason the claim path exists. The one administrator this installation
   * has was created under Clerk; adopting the row rather than creating a new
   * one is what stops the migration from locking them out of their own data.
   */
  it("preserves an ADMIN role through the claim", async () => {
    const admin = await prisma.user.create({
      data: {
        name: "The Administrator",
        email: "admin@example.com",
        role: "ADMIN",
      },
    });

    signInAsSupabase(fakeSupabaseUser("sb_admin", "admin@example.com"));

    const resolved = await getCurrentUser();

    expect(resolved?.id).toBe(admin.id);
    expect(resolved?.role).toBe("ADMIN");
  });

  it("writes only the identity key, leaving name, email and role intact", async () => {
    const existing = await prisma.user.create({
      data: {
        name: "Original Name",
        email: "person@example.com",
        role: "ADMIN",
      },
    });

    signInAsSupabase(
      fakeSupabaseUser("sb_new", "person@example.com", {
        user_metadata: { full_name: "Name From Supabase" },
      }),
    );

    await getCurrentUser();

    const after = await prisma.user.findUniqueOrThrow({
      where: { id: existing.id },
    });

    expect(after.supabaseUserId).toBe("sb_new");
    expect(after.name).toBe("Original Name");
    expect(after.email).toBe("person@example.com");
    expect(after.role).toBe("ADMIN");
  });

  it("matches the email case-insensitively", async () => {
    const existing = await prisma.user.create({
      data: {
        name: "Person",
        email: "person@example.com",
        role: "STAFF",
      },
    });

    signInAsSupabase(fakeSupabaseUser("sb_new", "Person@Example.COM"));

    const resolved = await getCurrentUser();

    expect(resolved?.id).toBe(existing.id);
  });

  it("refuses to claim a row a different Supabase account already took", async () => {
    await prisma.user.create({
      data: {
        supabaseUserId: "sb_first",
        name: "Person",
        email: "person@example.com",
        role: "ADMIN",
      },
    });

    signInAsSupabase(fakeSupabaseUser("sb_second", "person@example.com"));

    await expect(getCurrentUser()).rejects.toBeInstanceOf(AppError);

    const rows = await prisma.user.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.supabaseUserId).toBe("sb_first");
  });
});

describe("a Supabase identity with no local row", () => {
  it("creates one as STAFF", async () => {
    signInAsSupabase(fakeSupabaseUser("sb_fresh", "newcomer@example.com"));

    const resolved = await getCurrentUser();

    expect(resolved?.role).toBe("STAFF");
    expect(resolved?.supabaseUserId).toBe("sb_fresh");
    expect(resolved?.email).toBe("newcomer@example.com");
  });

  it("never creates an ADMIN, even when no other user exists", async () => {
    signInAsSupabase(fakeSupabaseUser("sb_first_ever", "first@example.com"));

    const resolved = await getCurrentUser();

    expect(resolved?.role).not.toBe("ADMIN");
    expect(resolved?.role).toBe("STAFF");
  });

  it("derives a name from the email when Supabase carries none", async () => {
    signInAsSupabase(fakeSupabaseUser("sb_fresh", "warehouse.lead@example.com"));

    const resolved = await getCurrentUser();

    expect(resolved?.name).toBe("warehouse.lead");
  });
});

describe("two requests arriving at once", () => {
  it("creates exactly one row and both see the same one", async () => {
    const identity = {
      supabaseUserId: "sb_race",
      email: "race@example.com",
      name: "Race",
    };

    const [first, second] = await Promise.all([
      resolveSupabaseUser(identity),
      resolveSupabaseUser(identity),
    ]);

    expect(first.id).toBe(second.id);
    expect(await prisma.user.count()).toBe(1);
  });

  it("claims an unlinked row exactly once under concurrency", async () => {
    const existing = await prisma.user.create({
      data: {
        name: "Person",
        email: "person@example.com",
        role: "ADMIN",
      },
    });

    const identity = {
      supabaseUserId: "sb_race",
      email: "person@example.com",
      name: "Person",
    };

    const [first, second] = await Promise.all([
      resolveSupabaseUser(identity),
      resolveSupabaseUser(identity),
    ]);

    expect(first.id).toBe(existing.id);
    expect(second.id).toBe(existing.id);
    expect(first.role).toBe("ADMIN");
    expect(await prisma.user.count()).toBe(1);
  });
});

describe("the authorisation contract", () => {
  it("lets an ADMIN through requireRole", async () => {
    await prisma.user.create({
      data: {
        supabaseUserId: "sb_admin",
        name: "The Administrator",
        email: "admin@example.com",
        role: "ADMIN",
      },
    });

    signInAsSupabase(fakeSupabaseUser("sb_admin", "admin@example.com"));

    const user = await requireRole("ADMIN");

    expect(user.role).toBe("ADMIN");
  });

  it("refuses a STAFF user an ADMIN-only action", async () => {
    await prisma.user.create({
      data: {
        supabaseUserId: "sb_staff",
        name: "Staff Person",
        email: "staff@example.com",
        role: "STAFF",
      },
    });

    signInAsSupabase(fakeSupabaseUser("sb_staff", "staff@example.com"));

    await expect(requireRole("ADMIN")).rejects.toBeInstanceOf(AppError);
  });

  it("refuses an unauthenticated request at any gate", async () => {
    await expect(requireRole("ADMIN", "STAFF")).rejects.toBeInstanceOf(AppError);
  });

  /*
   * The role comes from the local row, never from the Auth account. A provider
   * that handed out its own idea of a role — in app_metadata, say — would move
   * authorisation outside the database, where this application cannot audit it.
   */
  it("reads the role from the local row, not from Auth metadata", async () => {
    await prisma.user.create({
      data: {
        name: "Staff Person",
        email: "staff@example.com",
        role: "STAFF",
      },
    });

    // The Auth account claims to be an admin. It is not consulted.
    signInAsSupabase(
      fakeSupabaseUser("sb_staff", "staff@example.com", {
        user_metadata: { role: "ADMIN", app_role: "ADMIN" },
      }),
    );

    const claimed = await getCurrentUser();
    expect(claimed?.role).toBe("STAFF");

    await expect(requireRole("ADMIN")).rejects.toBeInstanceOf(AppError);
  });
});
