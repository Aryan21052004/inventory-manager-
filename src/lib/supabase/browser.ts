import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

import { requireSupabaseAuthConfig } from "@/lib/supabase/config";

/**
 * The Supabase Auth client for client components.
 *
 * ## No cookie handling here
 *
 * `createBrowserClient` reads and writes `document.cookie` itself, and the
 * installed version's documentation is explicit that the `cookies` option
 * should be left alone unless a custom store is involved. Cookies rather than
 * `localStorage` is the point: the server client in `./server.ts` has to be
 * able to read the same session out of the request, which it cannot do if the
 * tokens only exist in browser storage.
 *
 * ## Safe to call repeatedly
 *
 * The underlying client is a singleton by default, so calling this from several
 * components returns the same instance rather than opening a second auth
 * listener. It is still a function rather than a module-level constant, because
 * a constant would be constructed while the module is first evaluated — during
 * server rendering of a client component — and throw there if the environment
 * is unset, instead of at the point of use.
 *
 * ## Nothing secret reaches this file
 *
 * It is built from `NEXT_PUBLIC_` values only, which is enforced by taking them
 * from `./config.ts` rather than reading `process.env` here. The service-role
 * key lives behind `src/lib/env.ts`, which is `server-only` and would fail to
 * build if it were imported from a client component.
 */
export function createSupabaseBrowserClient(): SupabaseClient {
  const { url, publishableKey } = requireSupabaseAuthConfig();

  return createBrowserClient(url, publishableKey);
}
