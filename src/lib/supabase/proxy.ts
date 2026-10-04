import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import { requireSupabaseAuthConfig } from "@/lib/supabase/config";

/**
 * Refreshes the Supabase session on every request, and writes the result back.
 *
 * ## Why this has to exist
 *
 * An access token expires after an hour. Something has to spend the refresh
 * token for a new one and put the new cookies on the response — and a Server
 * Component cannot, because by the time it runs Next has begun streaming and
 * `cookies().set()` throws. The proxy is the one place in a Next application
 * where the response headers are still open, so it is the one place a refresh
 * can be persisted. Without it, `src/lib/supabase/server.ts` swallows every
 * refresh and the browser repeats it on the next request forever.
 *
 * ## Why the cookies are written twice
 *
 * `setAll` writes to the *request* as well as the response. The request copy is
 * what the rest of this same request sees: a Server Component created later in
 * the pipeline builds its own client from the incoming cookies, and if those
 * still held the token that was just rotated it would read a stale session or
 * try to refresh again. The response copy is what the browser keeps.
 *
 * `NextResponse.next({ request })` is re-created at that point so the mutated
 * request headers are the ones forwarded onward. That is the part of the
 * documented pattern that looks redundant and is not.
 *
 * ## `getClaims()`, not `getSession()`
 *
 * The call is what triggers the refresh, so it has to happen here. It is
 * `getClaims()` because that verifies the JWT's signature, while `getSession()`
 * would decode an attacker-supplied cookie and hand back whatever it claimed.
 * Nothing here *authorises* anything — that is `requireRole`'s job, against the
 * role in our own database — but a proxy that refreshes on the strength of an
 * unverified token is doing work on behalf of a forged one.
 *
 * ## Deliberately not an authorisation boundary
 *
 * This does not decide who may see what. Path matching here would be a second,
 * parallel description of the route tree that can drift from the real one and
 * leave a resource reachable. Access is checked where the protected data is
 * read — in the `(app)` layout — so a page added under that group is protected
 * because of where it lives rather than because someone updated a regex.
 */
export async function updateSession(
  request: NextRequest,
): Promise<NextResponse> {
  const { url, publishableKey } = requireSupabaseAuthConfig();

  let response = NextResponse.next({ request });

  const supabase = createServerClient(url, publishableKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }

        response = NextResponse.next({ request });

        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  // Must be awaited before the response is returned: a refresh that completes
  // after the headers are sent cannot be written anywhere.
  await supabase.auth.getClaims();

  return response;
}
