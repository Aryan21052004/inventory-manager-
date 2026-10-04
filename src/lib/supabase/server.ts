import "server-only";

import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";

import { requireSupabaseAuthConfig } from "@/lib/supabase/config";

/**
 * A Supabase Auth client bound to the current request's cookies.
 *
 * ## One client per request, never shared
 *
 * The session lives in the request's cookies, so a client that outlived the
 * request would answer for whoever happened to create it. There is deliberately
 * no module-level instance here and no `globalThis` cache of the kind
 * `src/lib/prisma.ts` keeps: a connection pool is safe to share between
 * requests and an identity is not.
 *
 * ## Why `setAll` is wrapped in a try/catch
 *
 * Supabase refreshes an expiring access token during `getUser()` and writes the
 * new tokens back through `setAll`. In a Server Component that write is not
 * allowed — Next has already begun streaming the response, and `cookies().set`
 * throws. Swallowing it is correct rather than lazy: the refreshed session is
 * lost for this render, the caller still gets a valid user because the token it
 * just obtained is in memory, and the next request refreshes again.
 *
 * What makes that sustainable is a client in the proxy (`src/proxy.ts`) that
 * calls `getUser()` on every request, where cookies *can* be written. Reaching
 * this catch on every request means that is missing or broken, and the symptom
 * is not an error but a token refreshed over and over.
 *
 * Note for the Clerk migration: the proxy still runs `clerkMiddleware` and does
 * not touch Supabase. Until that changes, this catch is load-bearing, and a
 * Supabase session will be refreshed per render rather than per request.
 *
 * ## This client carries no privilege
 *
 * It is built from the publishable key, so it can do exactly what an
 * unauthenticated or signed-in visitor can do — which, since the Data API
 * restriction migration, is no table access at all. It is used for identity and
 * nothing else; application data goes through Prisma.
 */
export async function createSupabaseServerClient(): Promise<SupabaseClient> {
  const { url, publishableKey } = requireSupabaseAuthConfig();

  const cookieStore = await cookies();

  return createServerClient(url, publishableKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Called from a Server Component, where the response has already
          // started. See the note above — the proxy is what makes this safe.
        }
      },
    },
  });
}
