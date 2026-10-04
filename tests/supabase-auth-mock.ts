/**
 * A stand-in for the server Supabase Auth client.
 *
 * Only what `src/server/auth.ts` actually uses is implemented: one
 * `createSupabaseServerClient` returning something with
 * `auth.getUser()`. Reaching a real Supabase project from a test would make
 * the suite depend on a network, an account, and — since the project in
 * question is the production one — on nothing going wrong.
 *
 * The user shape follows Supabase's, including the parts that matter to the
 * code under test: `email` optional, `email_confirmed_at` optional, and
 * `user_metadata` an untyped bag. That awkwardness is exactly what the mapping
 * has to cope with.
 */

export interface FakeSupabaseUser {
  id: string;
  email?: string | null;
  email_confirmed_at?: string | null;
  is_anonymous?: boolean;
  user_metadata?: Record<string, unknown> | null;
}

let session: FakeSupabaseUser | null = null;

/**
 * Builds a Supabase user, defaulting the fields a test does not care about.
 *
 * The email is verified by default. The unverified case has to be asked for
 * explicitly, because a test that forgot it would silently exercise the
 * fail-closed path and still pass for the wrong reason.
 */
export function fakeSupabaseUser(
  id: string,
  email: string,
  overrides: Partial<FakeSupabaseUser> = {},
): FakeSupabaseUser {
  return {
    id,
    email,
    email_confirmed_at: "2026-01-01T00:00:00.000Z",
    is_anonymous: false,
    user_metadata: null,
    ...overrides,
  };
}

export function signInAsSupabase(user: FakeSupabaseUser): void {
  session = user;
}

export function signOutSupabase(): void {
  session = null;
}

/**
 * The module namespace that stands in for `@/lib/supabase/server`.
 *
 * Both calls the application makes are implemented, and the difference between
 * them is modelled rather than glossed over:
 *
 * `getClaims()` returns the JWT payload, which carries `sub`, `email`,
 * `is_anonymous` and `user_metadata` — and **not** `email_confirmed_at`, because
 * a real token does not. Leaving it out is the point: if the mock supplied it,
 * the verified-email gate would appear to be satisfiable from the claims alone
 * and the tests would stop proving that `getUser()` is what makes adoption safe.
 *
 * `getClaims()` also returns `{ data: null, error: null }` for a request with no
 * session, which is the real SDK's third outcome and the ordinary one.
 */
export const supabaseServerMock = {
  createSupabaseServerClient: async () => ({
    auth: {
      getClaims: async () => {
        if (!session) return { data: null, error: null };

        return {
          data: {
            claims: {
              sub: session.id,
              email: session.email ?? undefined,
              is_anonymous: session.is_anonymous ?? false,
              user_metadata: session.user_metadata ?? {},
            },
          },
          error: null,
        };
      },
      getUser: async () => ({
        data: { user: session },
        error: null,
      }),
    },
  }),
};
