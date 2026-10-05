import "server-only";

import type { User } from "@/generated/prisma/client";
import type { UserRole } from "@/generated/prisma/enums";
import { AppError } from "@/lib/errors";
import { authEnabled } from "@/lib/env";
import { prisma } from "@/lib/prisma";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * The bridge between the identity provider and this application's user records.
 *
 * The division of responsibility, which the rest of the codebase depends on:
 *
 *   Supabase Auth — who the person is. Password, MFA, sessions, email
 *                   verification. We never see a credential and never store one.
 *   Postgres      — what that person is inside the inventory app. Their role,
 *                   and a row for foreign keys such as
 *                   `stock_transactions.created_by` to point at.
 *
 * `supabaseUserId` is the join, and it is the *only* acceptable one. Email is
 * unique in our table and would appear to work, but a user can change their
 * email with the provider whenever they like; the next request would then look
 * like a different person and quietly create a second local record. The
 * provider's user id never changes.
 *
 * Nothing here trusts the client. The caller cannot pass in a user id — the
 * identity comes from the verified session on the request, and that is the only
 * place it can come from.
 *
 * Syncing is lazy: a local row appears the first time its owner makes a request.
 * That keeps the moving parts to one function and has no failure mode of its own
 * — if the sync does not run, nobody was using the app. The cost is that the
 * local mirror only refreshes when a row is created or claimed, so a user who
 * later changes their name with the provider keeps the old one here. Identity is
 * unaffected, because the lookup is by `supabaseUserId`, but a stale display
 * name is a real if minor wrong.
 *
 * `requireRole` is the single authorisation gate, and it reads the `role` column
 * in our own database rather than anything the request carried. That is why the
 * provider could be replaced underneath it without touching it, and why the rest
 * of the codebase imports `requireUser` and `requireRole` without ever learning
 * which provider authenticated.
 */

/**
 * Fills `users.clerk_id` for a row no Clerk account owns.
 *
 * The column is a leftover. It is still NOT NULL, so every row created from here
 * on needs *something* in it, and this prefix says plainly that the something is
 * not an identity. Nothing reads it: the only identity key is `supabaseUserId`.
 *
 * It goes away when the column does, which is a separate and irreversible step.
 */
export const UNLINKED_CLERK_ID_PREFIX = "unlinked_";

/**
 * The current user, or null if the request is not authenticated.
 *
 * Supabase Auth is the identity source. Returns null in setup mode too
 * (Supabase unconfigured, development only): with no identity provider there is
 * no one to attribute a write to, so callers that need a user get nothing and
 * the write is refused rather than recorded against a guess.
 *
 * ## Why `getClaims()` and not `getSession()`
 *
 * The session lives in a cookie, and a cookie is attacker-supplied data until
 * something checks it. `getSession()` decodes it and hands back whatever it
 * said; `getClaims()` verifies the JWT's signature first. Authorisation that
 * reads the former is authorisation that trusts the request to describe itself,
 * so this uses the latter and the installed SDK says the same thing in its own
 * security notice.
 *
 * ## Why `getUser()` is reached only on first contact
 *
 * The verified claims carry `sub`, which is the identity key, so a user who
 * already has a local row is resolved with one indexed lookup and no second
 * network call — the overwhelming majority of requests.
 *
 * What the claims do *not* carry is `email_confirmed_at`: that is a field of
 * the Auth user record, not a JWT claim. It is also the fact the one-time
 * adoption below turns on. So the fresh record is fetched here and only here,
 * on the one request per account that can adopt a row.
 */
export async function getCurrentUser(): Promise<User | null> {
  if (!authEnabled) return null;

  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase.auth.getClaims();

  // Three outcomes, and `{ data: null, error: null }` is the ordinary one: no
  // session on this request.
  if (error || !data) return null;

  const { claims } = data;

  // An anonymous sign-in is a real session with no person behind it. It must
  // never reach the adoption path, where an email would be matched.
  if (claims.is_anonymous === true) return null;
  if (!claims.sub) return null;

  const linked = await prisma.user.findUnique({
    where: { supabaseUserId: claims.sub },
  });
  if (linked) return linked;

  const { data: fresh, error: freshError } = await supabase.auth.getUser();
  if (freshError || !fresh.user) return null;

  const identity = supabaseIdentityFrom(fresh.user);

  if (!identity) {
    throw new AppError(
      "BAD_REQUEST",
      "Your account needs a verified email address before it can be used here.",
    );
  }

  return resolveSupabaseUser(identity);
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

// ---------------------------------------------------------------------------
// Supabase Auth
// ---------------------------------------------------------------------------

/**
 * Mapping a Supabase Auth identity onto a local user row.
 *
 * ## The join key
 *
 * `supabaseUserId` is the identity key: it never changes, and an email does. The
 * column is nullable rather than carrying a placeholder — a NULL already means
 * "no Supabase identity has claimed this row", and PostgreSQL treats NULLs as
 * distinct in a unique index, so every unclaimed row coexists while no two rows
 * can share an id.
 *
 * ## Why a verified email is required
 *
 * Email is the one-time adoption key: the first Supabase sign-in with an
 * address that matches an unclaimed row takes that row over, including its
 * role. That is how the existing administrator keeps their account instead of
 * arriving as a new STAFF user — and it is also, stated plainly, a privilege
 * escalation path if the address is not proven. Anyone able to register an
 * unverified account with an administrator's address would inherit the
 * administrator's row.
 *
 * So an unverified or absent email is refused outright rather than falling back
 * to creating a fresh account. Failing closed costs a user a confusing sign-in;
 * failing open costs the installation its authorisation model.
 */

/**
 * The Supabase Auth fields this mapping needs. Structural, so a test can supply
 * one without constructing a whole `@supabase/supabase-js` user.
 */
export interface SupabaseAuthUserLike {
  id: string;
  email?: string | null;
  email_confirmed_at?: string | null;
  is_anonymous?: boolean;
  user_metadata?: Record<string, unknown> | null;
}

/** What a usable Supabase identity reduces to, once checked. */
export interface SupabaseIdentity {
  supabaseUserId: string;
  email: string;
  name: string;
}

/**
 * Reduces a Supabase Auth user to the identity this application can map, or
 * `null` if it cannot be mapped safely.
 *
 * Pure, and separate from the database work on purpose: every rule that decides
 * whether a sign-in may be trusted is decided here, where it can be read in one
 * place and tested without a database.
 *
 * `null` means "fail closed" — refuse rather than guess. The three ways to get
 * it are an anonymous session (Supabase can mint one with no identity at all),
 * a missing email, and an unverified email. None of them are recoverable by
 * trying harder.
 */
export function supabaseIdentityFrom(
  user: SupabaseAuthUserLike,
): SupabaseIdentity | null {
  // An anonymous sign-in is a real Supabase session with no person behind it.
  // It must never reach the adoption path, where an email would be matched.
  if (user.is_anonymous === true) return null;

  const email = user.email?.trim().toLowerCase();
  if (!email) return null;

  // Supabase sets `email_confirmed_at` when the address is proven. Without it
  // the address is merely claimed, which is not enough to adopt a row with.
  if (!user.email_confirmed_at) return null;

  return {
    supabaseUserId: user.id,
    email,
    name: supabaseDisplayName(user.user_metadata, email),
  };
}

/**
 * Finds the local user for a Supabase identity, claiming or creating one if
 * needed.
 *
 * The lookup is by `supabaseUserId` and only by `supabaseUserId`. Once a row is
 * linked, the email on the Supabase account can change freely without this
 * function noticing or caring, which is the property that makes the id the
 * identity key and the address merely a field.
 */
export async function resolveSupabaseUser(
  identity: SupabaseIdentity,
): Promise<User> {
  const existing = await prisma.user.findUnique({
    where: { supabaseUserId: identity.supabaseUserId },
  });

  // Found by identity key. Return it untouched — not the role, not the email,
  // not the name. Signing in is not an instruction to overwrite a profile, and
  // a local edit should not be reverted by its owner's next request.
  if (existing) return existing;

  return claimOrCreateSupabaseUser(identity);
}

/**
 * First contact: this Supabase account has no local row yet.
 *
 * Check, write, and let the database arbitrate the gap between the two, because
 * that gap is where the race lives and no amount of looking first can close it.
 */
async function claimOrCreateSupabaseUser(
  identity: SupabaseIdentity,
): Promise<User> {
  try {
    return await prisma.$transaction(async (tx) => {
      const unlinked = await tx.user.findFirst({
        where: { email: identity.email, supabaseUserId: null },
      });

      if (unlinked) {
        /*
         * Compare-and-set rather than a plain update. Two different Supabase
         * accounts could present the same address — an invited user and a
         * self-registration, say — and both find this row unclaimed. A bare
         * `update` would let the second silently take the row from the first,
         * because they write different ids to the same row and the unique index
         * has nothing to object to. Re-testing `supabaseUserId: null` inside
         * the write makes the first writer the only winner.
         */
        const claimed = await tx.user.updateMany({
          where: { id: unlinked.id, supabaseUserId: null },
          // Only the identity key. The role is what the existing administrator
          // keeps; the name and email are what somebody chose. Adoption links
          // an account, it does not refresh a profile.
          data: { supabaseUserId: identity.supabaseUserId },
        });

        if (claimed.count === 1) {
          return tx.user.findUniqueOrThrow({ where: { id: unlinked.id } });
        }

        // Lost the race. Fall through to the create, which will collide on the
        // email index and be resolved by the handler below — either this is the
        // same account arriving twice, or it is a genuine clash.
      }

      return tx.user.create({
        data: {
          supabaseUserId: identity.supabaseUserId,
          email: identity.email,
          name: identity.name,
          /*
           * `clerk_id` is still NOT NULL, so a new row needs something in it
           * until that column is dropped. Nothing reads the value — see
           * UNLINKED_CLERK_ID_PREFIX.
           */
          clerkId: `${UNLINKED_CLERK_ID_PREFIX}${identity.supabaseUserId}`,
          // Least privilege. ADMIN is only ever reached by adopting a row that
          // already held it, or by an existing admin granting it. Never by
          // signing up.
          role: "STAFF",
        },
      });
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;

    // Someone else got there first with this same Supabase account.
    const winner = await prisma.user.findUnique({
      where: { supabaseUserId: identity.supabaseUserId },
    });
    if (winner) return winner;

    // The clash was on email: a different Supabase account already owns this
    // address locally. Resolving it means deciding which person it belongs to,
    // which is not a decision a retry can make.
    throw new AppError(
      "CONFLICT",
      "Another account in this workspace already uses that email address.",
    );
  }
}

/**
 * A name to show, from whatever the Supabase account carries.
 *
 * Supabase puts provider profile fields in `user_metadata` with no guaranteed
 * shape — an OAuth sign-in may bring `full_name`, a magic link brings nothing —
 * so this reads the conventional keys defensively and falls back to the local
 * part of the address, because `name` is NOT NULL and "" is not a name.
 */
function supabaseDisplayName(
  metadata: Record<string, unknown> | null | undefined,
  email: string,
): string {
  const fromMetadata = [
    "full_name",
    "name",
    "user_name",
    "preferred_username",
  ]
    .map((key) => metadata?.[key])
    .find(
      (value): value is string =>
        typeof value === "string" && Boolean(value.trim()),
    );

  return fromMetadata?.trim() ?? email.split("@")[0] ?? "Unnamed user";
}
