import "server-only";

import { auth, currentUser } from "@clerk/nextjs/server";

import type { User } from "@/generated/prisma/client";
import type { UserRole } from "@/generated/prisma/enums";
import { AppError } from "@/lib/errors";
import { authEnabled } from "@/lib/env";
import { prisma } from "@/lib/prisma";

/**
 * The bridge between Clerk's identity and this application's user records.
 *
 * The division of responsibility, which the rest of the codebase depends on:
 *
 *   Clerk    — who the person is. Password, MFA, sessions, email verification.
 *              We never see a credential and never store one.
 *   Postgres — what that person is inside the inventory app. Their role, and a
 *              row for foreign keys such as `stock_transactions.created_by` to
 *              point at.
 *
 * `clerkId` is the join, and it is the *only* acceptable one. Email is unique
 * in our table and would appear to work, but a user can change their email in
 * Clerk whenever they like; the next request would then look like a different
 * person and quietly create a second local record. `clerkId` never changes.
 *
 * Nothing here trusts the client. The caller cannot pass in a user id — the
 * identity comes from the Clerk session on the request, and that is the only
 * place it can come from.
 *
 * Syncing is lazy: a local row appears the first time its owner makes a
 * request. That keeps the moving parts to one function and has no failure mode
 * of its own — if the sync does not run, nobody was using the app. The cost is
 * that the local mirror only refreshes when a row is created or claimed, so a
 * user who later changes their name or email in Clerk keeps the old value here
 * until something updates it. Identity is unaffected (the lookup is by
 * `clerkId`), but a stale display name is a real if minor wrong.
 *
 * A Clerk webhook on `user.updated` / `user.deleted` is the production answer
 * to that, and to deletions, which lazy sync cannot see at all — a user removed
 * in Clerk simply stops arriving, leaving a local row that looks active
 * forever. That is worth adding when the app has real users; it is not worth
 * the endpoint, the signature verification, and the replay handling today,
 * when nothing yet depends on the mirror being fresh.
 */

/**
 * Marks a local user created before their Clerk account existed — the seeded
 * accounts, or anyone imported from elsewhere. The first sign-in from a Clerk
 * account with a matching email claims the row (see `resolveUser`).
 *
 * A placeholder rather than a null so the identity key can stay NOT NULL and
 * every lookup can stop worrying about it.
 */
export const UNLINKED_CLERK_ID_PREFIX = "unlinked_";

export const isUnlinked = (user: Pick<User, "clerkId">): boolean =>
  user.clerkId.startsWith(UNLINKED_CLERK_ID_PREFIX);

/** The fields of a Clerk account this app mirrors locally. */
interface ClerkProfile {
  clerkId: string;
  email: string;
  name: string;
}

/**
 * The current user, or null if the request is not authenticated.
 *
 * Returns null in setup mode too (Clerk unconfigured, development only): with
 * no identity provider there is no one to attribute a write to, so callers that
 * need a user get nothing and the write is refused rather than recorded against
 * a guess.
 */
export async function getCurrentUser(): Promise<User | null> {
  if (!authEnabled) return null;

  const { userId } = await auth();
  if (!userId) return null;

  return resolveUser(userId);
}

/**
 * The current user, or a 401. Use this at the top of every server action and
 * route handler that writes.
 */
export async function requireUser(): Promise<User> {
  const user = await getCurrentUser();

  if (!user) {
    throw new AppError(
      "UNAUTHORIZED",
      authEnabled
        ? "You must be signed in to do that."
        : "Authentication is not configured, so this action is unavailable.",
    );
  }

  return user;
}

/**
 * The current user, provided they hold one of `allowed` — otherwise a 403.
 *
 * This is the *only* place a role is allowed to gate anything. Hiding a button
 * in the UI is a courtesy to the user; it stops nobody who can open devtools
 * and call the action directly, so every privileged path re-checks here, on the
 * server, against the role stored in our database rather than anything the
 * request carried with it.
 */
export async function requireRole(
  ...allowed: readonly UserRole[]
): Promise<User> {
  const user = await requireUser();

  if (!allowed.includes(user.role)) {
    throw new AppError(
      "FORBIDDEN",
      `This action requires the ${allowed.join(" or ")} role.`,
    );
  }

  return user;
}

/**
 * Finds the local user for a Clerk id, creating or claiming one if needed.
 *
 * The happy path is a single indexed lookup — the overwhelming majority of
 * requests are from users who already have a row, and those never touch Clerk's
 * API or write anything.
 */
export async function resolveUser(clerkId: string): Promise<User> {
  const existing = await prisma.user.findUnique({ where: { clerkId } });
  if (existing) return existing;

  return syncUser(clerkId);
}

/**
 * First contact: this Clerk account has no local row yet.
 *
 * Two requests from the same new user can arrive at once — two tabs, or a page
 * whose components each load data — and both will find nothing and both will
 * try to write. That is not prevented here; it is made harmless. The unique
 * index on `clerk_id` lets exactly one of them win, and the loser reads back
 * the winner's row instead of failing. Checking first and writing second cannot
 * be made safe by looking harder, because the gap between the two is where the
 * race lives; the database is the only thing that can arbitrate.
 */
async function syncUser(clerkId: string): Promise<User> {
  const profile = await loadClerkProfile(clerkId);

  try {
    return await prisma.$transaction(async (tx) => {
      // Claim a row that was created before this Clerk account existed. Email
      // is safe to match on here and only here: it is a one-time adoption of an
      // explicitly unlinked record, not the ongoing identity lookup. From this
      // point on the row is found by clerkId and the email can change freely.
      const unlinked = await tx.user.findFirst({
        where: {
          email: profile.email,
          clerkId: { startsWith: UNLINKED_CLERK_ID_PREFIX },
        },
      });

      if (unlinked) {
        return tx.user.update({
          where: { id: unlinked.id },
          // The role is deliberately left alone. It was set by whoever created
          // the record, and signing in is not a reason to change it.
          data: { clerkId, name: profile.name },
        });
      }

      return tx.user.create({
        data: {
          clerkId,
          email: profile.email,
          name: profile.name,
          // New accounts start with the least privilege. Promotion to ADMIN is
          // a deliberate act by an existing admin, never a side effect of
          // signing up.
          role: "STAFF",
        },
      });
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;

    // Someone else got there first. Their row is the canonical one.
    const winner = await prisma.user.findUnique({ where: { clerkId } });
    if (winner) return winner;

    // The clash was on email, not clerkId: a different Clerk account already
    // owns this address locally. That needs a human, not a retry.
    throw new AppError(
      "CONFLICT",
      "Another account in this workspace already uses that email address.",
    );
  }
}

/**
 * Reads the signed-in user's profile from Clerk.
 *
 * `currentUser()` only ever returns the user the request is authenticated as,
 * which is exactly the guarantee wanted here — there is no way to ask it for
 * somebody else. The `clerkId` argument is checked against what comes back
 * rather than trusted.
 */
async function loadClerkProfile(clerkId: string): Promise<ClerkProfile> {
  const clerkUser = await currentUser();

  if (!clerkUser || clerkUser.id !== clerkId) {
    throw new AppError(
      "UNAUTHORIZED",
      "Your session could not be verified. Please sign in again.",
    );
  }

  const email =
    clerkUser.primaryEmailAddress?.emailAddress ??
    clerkUser.emailAddresses[0]?.emailAddress;

  if (!email) {
    // Every Clerk instance this app supports requires an email address, so
    // reaching here means the instance is configured for a sign-in method we
    // have no local representation for.
    throw new AppError(
      "BAD_REQUEST",
      "Your account has no email address, which this application requires.",
    );
  }

  return { clerkId, email, name: displayName(clerkUser, email) };
}

/**
 * A name to show. Clerk makes every name field optional — a user who signed up
 * with an email link may have none — so this falls back through what is
 * available and finally to the local part of the address, because `name` is
 * NOT NULL and an empty string is not a name.
 */
function displayName(
  clerkUser: {
    fullName: string | null;
    firstName: string | null;
    lastName: string | null;
    username: string | null;
  },
  email: string,
): string {
  const candidates = [
    clerkUser.fullName,
    [clerkUser.firstName, clerkUser.lastName].filter(Boolean).join(" "),
    clerkUser.username,
    email.split("@")[0],
  ];

  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (trimmed) return trimmed;
  }

  return "Unnamed user";
}

/**
 * Prisma's unique-constraint code. Matched structurally rather than with
 * `instanceof PrismaClientKnownRequestError`, which fails across the two client
 * instances a bundler can end up with.
 */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "P2002"
  );
}
