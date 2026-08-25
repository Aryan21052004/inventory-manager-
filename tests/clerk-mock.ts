/**
 * A stand-in for Clerk's server SDK.
 *
 * Only the two functions `src/server/auth.ts` actually uses are implemented:
 * `auth()` for the session's user id, and `currentUser()` for the profile. The
 * shape follows Clerk's, including the parts that are awkward — every name
 * field nullable, `primaryEmailAddress` separate from `emailAddresses` — since
 * that awkwardness is exactly what the code under test has to cope with.
 */

export interface FakeClerkUser {
  id: string;
  emailAddresses: { emailAddress: string }[];
  primaryEmailAddress: { emailAddress: string } | null;
  firstName: string | null;
  lastName: string | null;
  fullName: string | null;
  username: string | null;
}

let session: FakeClerkUser | null = null;

/** Builds a Clerk user, defaulting the fields a test does not care about. */
export function fakeClerkUser(
  id: string,
  email: string,
  overrides: Partial<FakeClerkUser> = {},
): FakeClerkUser {
  return {
    id,
    emailAddresses: [{ emailAddress: email }],
    primaryEmailAddress: { emailAddress: email },
    firstName: null,
    lastName: null,
    fullName: null,
    username: null,
    ...overrides,
  };
}

export function signInAs(user: FakeClerkUser): void {
  session = user;
}

export function signOut(): void {
  session = null;
}

/** Mutates the signed-in user, for testing what happens when Clerk data moves. */
export function updateSession(changes: Partial<FakeClerkUser>): void {
  if (!session) throw new Error("No session to update — call signInAs first.");
  session = { ...session, ...changes };
}

/** The module namespace that stands in for `@clerk/nextjs/server`. */
export const clerkServerMock = {
  auth: async () => ({ userId: session?.id ?? null }),
  currentUser: async () => session,
};
