import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", async () => {
  const { supabaseServerMock } = await import("./supabase-auth-mock");
  return supabaseServerMock;
});

vi.mock("@clerk/nextjs/server", async () => {
  const { clerkServerMock } = await import("./clerk-mock");
  return clerkServerMock;
});

import { AppError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import {
  getCurrentSupabaseUser,
  requireRole,
  resolveSupabaseUser,
  UNLINKED_CLERK_ID_PREFIX,
} from "@/server/auth";

import { fakeClerkUser, signInAs, signOut } from "./clerk-mock";
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
  signOut();
  await resetDatabase();
});

describe("an unauthenticated request", () => {
  it("returns null when there is no Supabase session", async () => {
    expect(await getCurrentSupabaseUser()).toBeNull();
  });

  it("creates no user row when there is no session", async () => {
    await getCurrentSupabaseUser();

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

    await expect(getCurrentSupabaseUser()).rejects.toBeInstanceOf(AppError);
    expect(await prisma.user.count()).toBe(0);
  });

  /*
   * The escalation this guards against: an unverified sign-up using an
   * administrator's address must not adopt the administrator's row.
   */
  it("does not let an unverified address claim an administrator's row", async () => {
    const admin = await prisma.user.create({
      data: {
        clerkId: "user_admin",
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

    await expect(getCurrentSupabaseUser()).rejects.toBeInstanceOf(AppError);

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

    await expect(getCurrentSupabaseUser()).rejects.toBeInstanceOf(AppError);
    expect(await prisma.user.count()).toBe(0);
  });
});

describe("a session already linked to a row", () => {
  it("returns the linked row", async () => {
    const created = await prisma.user.create({
      data: {
        clerkId: `${UNLINKED_CLERK_ID_PREFIX}existing`,
        supabaseUserId: "sb_linked",
        name: "Existing Person",
        email: "existing@example.com",
        role: "ADMIN",
      },
    });

    signInAsSupabase(fakeSupabaseUser("sb_linked", "existing@example.com"));

    const resolved = await getCurrentSupabaseUser();

    expect(resolved?.id).toBe(created.id);
    expect(await prisma.user.count()).toBe(1);
  });

  it("leaves the role, email and name alone", async () => {
    await prisma.user.create({
      data: {
        clerkId: `${UNLINKED_CLERK_ID_PREFIX}existing`,
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

    const resolved = await getCurrentSupabaseUser();

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
        clerkId: `${UNLINKED_CLERK_ID_PREFIX}linked`,
        supabaseUserId: "sb_linked",
        name: "Linked",
        email: "linked@example.com",
        role: "STAFF",
      },
    });

    const decoy = await prisma.user.create({
      data: {
        clerkId: "user_decoy",
        name: "Decoy Admin",
        email: "decoy@example.com",
        role: "ADMIN",
      },
    });

    // The session's id matches the linked row while its email matches the
    // unclaimed admin row. The id must win.
    signInAsSupabase(fakeSupabaseUser("sb_linked", "decoy@example.com"));

    const resolved = await getCurrentSupabaseUser();

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
        clerkId: "user_clerk_era",
        name: "Warehouse Lead",
        email: "lead@example.com",
        role: "STAFF",
      },
    });

    signInAsSupabase(fakeSupabaseUser("sb_new", "lead@example.com"));

    const resolved = await getCurrentSupabaseUser();

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
        clerkId: "user_admin",
        name: "The Administrator",
        email: "admin@example.com",
        role: "ADMIN",
      },
    });

    signInAsSupabase(fakeSupabaseUser("sb_admin", "admin@example.com"));

    const resolved = await getCurrentSupabaseUser();

    expect(resolved?.id).toBe(admin.id);
    expect(resolved?.role).toBe("ADMIN");
  });

  it("writes only the identity key, leaving name, email and clerkId intact", async () => {
    const existing = await prisma.user.create({
      data: {
        clerkId: "user_clerk_era",
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

    await getCurrentSupabaseUser();

    const after = await prisma.user.findUniqueOrThrow({
      where: { id: existing.id },
    });

    expect(after.supabaseUserId).toBe("sb_new");
    expect(after.name).toBe("Original Name");
    expect(after.email).toBe("person@example.com");
    expect(after.clerkId).toBe("user_clerk_era");
    expect(after.role).toBe("ADMIN");
  });

  it("matches the email case-insensitively", async () => {
    const existing = await prisma.user.create({
      data: {
        clerkId: "user_clerk_era",
        name: "Person",
        email: "person@example.com",
        role: "STAFF",
      },
    });

    signInAsSupabase(fakeSupabaseUser("sb_new", "Person@Example.COM"));

    const resolved = await getCurrentSupabaseUser();

    expect(resolved?.id).toBe(existing.id);
  });

  it("refuses to claim a row a different Supabase account already took", async () => {
    await prisma.user.create({
      data: {
        clerkId: "user_clerk_era",
        supabaseUserId: "sb_first",
        name: "Person",
        email: "person@example.com",
        role: "ADMIN",
      },
    });

    signInAsSupabase(fakeSupabaseUser("sb_second", "person@example.com"));

    await expect(getCurrentSupabaseUser()).rejects.toBeInstanceOf(AppError);

    const rows = await prisma.user.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.supabaseUserId).toBe("sb_first");
  });
});

describe("a Supabase identity with no local row", () => {
  it("creates one as STAFF", async () => {
    signInAsSupabase(fakeSupabaseUser("sb_fresh", "newcomer@example.com"));

    const resolved = await getCurrentSupabaseUser();

    expect(resolved?.role).toBe("STAFF");
    expect(resolved?.supabaseUserId).toBe("sb_fresh");
    expect(resolved?.email).toBe("newcomer@example.com");
  });

  it("never creates an ADMIN, even when no other user exists", async () => {
    signInAsSupabase(fakeSupabaseUser("sb_first_ever", "first@example.com"));

    const resolved = await getCurrentSupabaseUser();

    expect(resolved?.role).not.toBe("ADMIN");
    expect(resolved?.role).toBe("STAFF");
  });

  it("stores a placeholder clerkId so the NOT NULL column stays honest", async () => {
    signInAsSupabase(fakeSupabaseUser("sb_fresh", "newcomer@example.com"));

    const resolved = await getCurrentSupabaseUser();

    expect(resolved?.clerkId.startsWith(UNLINKED_CLERK_ID_PREFIX)).toBe(true);
  });

  it("derives a name from the email when Supabase carries none", async () => {
    signInAsSupabase(fakeSupabaseUser("sb_fresh", "warehouse.lead@example.com"));

    const resolved = await getCurrentSupabaseUser();

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
        clerkId: "user_clerk_era",
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

describe("the authorisation contract is unchanged", () => {
  it("still lets an ADMIN through requireRole", async () => {
    await prisma.user.create({
      data: {
        clerkId: "user_admin",
        name: "The Administrator",
        email: "admin@example.com",
        role: "ADMIN",
      },
    });

    signInAs(fakeClerkUser("user_admin", "admin@example.com"));

    const user = await requireRole("ADMIN");

    expect(user.role).toBe("ADMIN");
  });

  it("still refuses a STAFF user an ADMIN-only action", async () => {
    await prisma.user.create({
      data: {
        clerkId: "user_staff",
        name: "Staff Person",
        email: "staff@example.com",
        role: "STAFF",
      },
    });

    signInAs(fakeClerkUser("user_staff", "staff@example.com"));

    await expect(requireRole("ADMIN")).rejects.toBeInstanceOf(AppError);
  });

  /*
   * Authorisation reads the local row whichever provider authenticated, so a
   * row claimed by Supabase is gated by the role it already held.
   */
  it("reads the role from the local row after a Supabase claim", async () => {
    await prisma.user.create({
      data: {
        clerkId: "user_staff",
        name: "Staff Person",
        email: "staff@example.com",
        role: "STAFF",
      },
    });

    signInAsSupabase(fakeSupabaseUser("sb_staff", "staff@example.com"));
    const claimed = await getCurrentSupabaseUser();

    expect(claimed?.role).toBe("STAFF");

    // The same person through the still-active Clerk path is also STAFF.
    signInAs(fakeClerkUser("user_staff", "staff@example.com"));
    await expect(requireRole("ADMIN")).rejects.toBeInstanceOf(AppError);
  });
});
