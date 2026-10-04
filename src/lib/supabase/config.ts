/**
 * The public Supabase configuration, read in exactly one place.
 *
 * Both Auth clients — the browser one and the server one — are built from this
 * module. They have to agree: the server validates the session against one
 * project and the browser obtains it from another, so a mismatch does not fail
 * loudly, it fails as a sign-in that appears to succeed while the server never
 * recognises the session. Two copies of two environment variable names is
 * exactly how that mismatch gets introduced, so there is one copy.
 *
 * This is deliberately *not* `src/lib/env.ts`. That module is `server-only`,
 * which is right for a service-role key and wrong for a value the browser has
 * to read. Nothing here is secret: both variables carry the `NEXT_PUBLIC_`
 * prefix precisely so they reach the client bundle.
 *
 * ## Service-role access is somewhere else entirely
 *
 * `SUPABASE_SERVICE_ROLE_KEY` and the unprefixed `SUPABASE_URL` belong to the
 * certificate storage driver, are read only through `src/lib/env.ts`, and must
 * never appear here. That key bypasses row-level security; this module's values
 * are compiled into a public bundle. Keeping the two apart is the whole reason
 * the storage driver does not share these clients.
 *
 * ## Read as literals, on purpose
 *
 * `process.env.NEXT_PUBLIC_*` is substituted at *build* time, not read at
 * runtime, and only where it appears as a literal member access. Writing it any
 * other way — a dynamic key, a spread of `process.env` — leaves `undefined` in
 * the client bundle with nothing to indicate why.
 *
 * The consequence is that these values are frozen into a deployment when it is
 * built. Changing either one in the hosting provider's dashboard does nothing
 * until the application is rebuilt, which is a genuinely confusing failure and
 * worth knowing before debugging a sign-in that works locally.
 */

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

/**
 * Whether Supabase Auth has been configured.
 *
 * Mirrors `authEnabled` in `src/lib/env.ts`, which lets the application run in
 * development with no identity provider at all. Callers that can degrade check
 * this; callers that cannot use `requireSupabaseAuthConfig`.
 */
export const supabaseAuthConfigured = Boolean(url && publishableKey);

export interface SupabaseAuthConfig {
  url: string;
  publishableKey: string;
}

/**
 * The configuration, or a thrown error naming what is missing.
 *
 * Constructing a Supabase client with an empty URL or key fails later and less
 * clearly — somewhere inside a fetch, on a request that looked fine — so the
 * refusal happens here, where the cause is still visible.
 */
export function requireSupabaseAuthConfig(): SupabaseAuthConfig {
  if (!url || !publishableKey) {
    const missing = [
      url ? null : "NEXT_PUBLIC_SUPABASE_URL",
      publishableKey ? null : "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
    ].filter(Boolean);

    throw new Error(
      `Supabase Auth is not configured: ${missing.join(" and ")} ` +
        "is not set. See .env.example. Note that NEXT_PUBLIC_ values are " +
        "baked in at build time, so a deployment must be rebuilt after they " +
        "are changed.",
    );
  }

  return { url, publishableKey };
}
