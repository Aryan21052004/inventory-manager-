import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@clerk/nextjs/server", async () => {
  const { clerkServerMock } = await import("./clerk-mock");
  return clerkServerMock;
});

import { AppError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import {
  requireRole,
  requireUser,
  resolveUser,
  UNLINKED_CLERK_ID_PREFIX,
} from "@/server/auth";

import { auth as clerkAuth } from "@clerk/nextjs/server";

import { fakeClerkUser, signInAs, signOut, updateSession } from "./clerk-mock";
import { resetDatabase } from "./database";
import { fakeSupabaseUser, signInAsSupabase, signOutSupabase } from "./supabase-auth-mock";

beforeEach(async () => {
  signOut();
  signOutSupabase();
  await resetDatabase();
});

/**
 * What `getCurrentUser()` used to do, before Supabase Auth became the active
 * provider: read the Clerk session, then resolve it through the Clerk resolver.
 *
 * The mapping tests below are about that resolver, which still exists as
 * migration code and still has to be correct for a rollback to be possible. They
 * are no longer testing the application's live authentication path —
 * `getCurrentUser` reaches Supabase now, and `supabase-auth.test.ts` covers it.
 */
async function currentClerkUser() {
  const { userId } = await clerkAuth();
  if (!userId) return null;
  return resolveUser(userId);
}

describe("resolving a Clerk session to a local user (legacy resolver)", () => {
  it("returns the existing local user when one is already linked", async () => {
    const created = await prisma.user.create({
      data: {
        clerkId: "user_existing",
        name: "Existing Person",
        email: "existing@example.com",
        role: "ADMIN",
      },
    });

    signInAs(fakeClerkUser("user_existing", "existing@example.com"));

    const resolved = await currentClerkUser();

    expect(resolved?.id).toBe(created.id);
    // The role is ours, not Clerk's, and resolving must not disturb it.
    expect(resolved?.role).toBe("ADMIN");
    expect(await prisma.user.count()).toBe(1);
  });

  it("creates a local user on first sight of a Clerk account", async () => {
    signInAs(
      fakeClerkUser("user_newcomer", "newcomer@example.com", {
        firstName: "New",
        lastName: "Comer",
        fullName: "New Comer",
      }),
    );

    const resolved = await currentClerkUser();

    expect(resolved).not.toBeNull();
    expect(resolved?.clerkId).toBe("user_newcomer");
    expect(resolved?.email).toBe("newcomer@example.com");
    expect(resolved?.name).toBe("New Comer");
    // Least privilege: signing up is not a route to ADMIN.
    expect(resolved?.role).toBe("STAFF");
  });

  it("falls back to the email local part when Clerk has no name", async () => {
    signInAs(fakeClerkUser("user_nameless", "quiet.person@example.com"));

    const resolved = await currentClerkUser();

    // `name` is NOT NULL, so something has to be there — but not an empty
    // string pretending to be a name.
    expect(resolved?.name).toBe("quiet.person");
  });

  it("claims a pre-existing unlinked user instead of creating a second one", async () => {
    // What the seed leaves behind: a real user record that predates Clerk.
    const seeded = await prisma.user.create({
      data: {
        clerkId: `${UNLINKED_CLERK_ID_PREFIX}seed_admin`,
        name: "Seeded Admin",
        email: "admin@inventory.local",
        role: "ADMIN",
      },
    });

    signInAs(fakeClerkUser("user_realadmin", "admin@inventory.local"));

    const resolved = await currentClerkUser();

    expect(resolved?.id).toBe(seeded.id);
    expect(resolved?.clerkId).toBe("user_realadmin");
    // The whole point of claiming rather than creating: the ADMIN role survives.
    expect(resolved?.role).toBe("ADMIN");
    expect(await prisma.user.count()).toBe(1);
  });

  it("rejects an unauthenticated request", async () => {
    expect(await currentClerkUser()).toBeNull();

    await expect(requireUser()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      status: 401,
    });
  });
});

describe("clerkId as the identity key", () => {
  it("refuses two local users with the same clerkId", async () => {
    await prisma.user.create({
      data: {
        clerkId: "user_duplicate",
        name: "First",
        email: "first@example.com",
      },
    });

    await expect(
      prisma.user.create({
        data: {
          clerkId: "user_duplicate",
          name: "Second",
          email: "second@example.com",
        },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("does not create a duplicate when the same user arrives concurrently", async () => {
    signInAs(fakeClerkUser("user_racer", "racer@example.com"));

    // Two tabs, or one page whose components each load data. Both find nothing
    // and both try to write; the unique index has to settle it.
    const resolved = await Promise.all([
      currentClerkUser(),
      currentClerkUser(),
      currentClerkUser(),
      currentClerkUser(),
      currentClerkUser(),
    ]);

    const ids = new Set(resolved.map((user) => user?.id));

    expect(await prisma.user.count()).toBe(1);
    expect(ids.size).toBe(1);
    expect([...ids][0]).toBeDefined();
  });

  it("keeps the mapping when the Clerk email changes", async () => {
    signInAs(fakeClerkUser("user_movinghouse", "before@example.com"));

    const first = await currentClerkUser();
    expect(first?.email).toBe("before@example.com");

    // The scenario email-as-a-key would break: Clerk lets people change their
    // address, and the next request must still be the same person.
    updateSession({
      emailAddresses: [{ emailAddress: "after@example.com" }],
      primaryEmailAddress: { emailAddress: "after@example.com" },
    });

    const second = await currentClerkUser();

    expect(second?.id).toBe(first?.id);
    expect(second?.clerkId).toBe("user_movinghouse");
    expect(await prisma.user.count()).toBe(1);
  });

  it("does not adopt a linked user that happens to share an email", async () => {
    // Already linked to somebody else's Clerk account, so it is not up for
    // grabs — only `unlinked_` rows can be claimed.
    await prisma.user.create({
      data: {
        clerkId: "user_owner",
        name: "Rightful Owner",
        email: "shared@example.com",
        role: "ADMIN",
      },
    });

    signInAs(fakeClerkUser("user_impostor", "shared@example.com"));

    // The email unique constraint stops the second record being created, and
    // the impostor is told rather than silently handed the admin's row.
    await expect(currentClerkUser()).rejects.toMatchObject({
      code: "CONFLICT",
    });

    const owner = await prisma.user.findUnique({
      where: { clerkId: "user_owner" },
    });
    expect(owner?.role).toBe("ADMIN");
    expect(await prisma.user.count()).toBe(1);
  });
});

describe("setup mode (Supabase Auth not configured)", () => {
  /*
   * `authEnabled` is decided when `@/lib/env` is first imported, so this is the
   * one place the modules have to be re-imported with a different environment
   * rather than simply called differently.
   */
  it("has no current user and refuses to attribute anything", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "");
    vi.resetModules();

    try {
      const auth = await import("@/server/auth");

      // Even with a session available, an unconfigured provider means there is
      // no verified identity — so writes are refused rather than recorded
      // against a guess.
      signInAsSupabase(fakeSupabaseUser("sb_anyone", "anyone@example.com"));

      expect(await auth.getCurrentUser()).toBeNull();
      await expect(auth.requireUser()).rejects.toMatchObject({
        code: "UNAUTHORIZED",
      });
      expect(await prisma.user.count()).toBe(0);
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});

describe("role checks", () => {
  it("lets an ADMIN through an ADMIN-only gate", async () => {
    await prisma.user.create({
      data: {
        clerkId: `${UNLINKED_CLERK_ID_PREFIX}sb_admin`,
        supabaseUserId: "sb_admin",
        name: "Admin",
        email: "admin@example.com",
        role: "ADMIN",
      },
    });
    signInAsSupabase(fakeSupabaseUser("sb_admin", "admin@example.com"));

    await expect(requireRole("ADMIN")).resolves.toMatchObject({
      role: "ADMIN",
    });
  });

  it("refuses STAFF at an ADMIN-only gate", async () => {
    await prisma.user.create({
      data: {
        clerkId: `${UNLINKED_CLERK_ID_PREFIX}sb_staff`,
        supabaseUserId: "sb_staff",
        name: "Staff",
        email: "staff@example.com",
        role: "STAFF",
      },
    });
    signInAsSupabase(fakeSupabaseUser("sb_staff", "staff@example.com"));

    const error = await requireRole("ADMIN").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: "FORBIDDEN", status: 403 });
  });

  it("refuses an unauthenticated request at any gate", async () => {
    await expect(requireRole("ADMIN", "STAFF")).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });
});
