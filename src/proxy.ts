import { NextResponse, type NextRequest } from "next/server";

import { updateSession } from "@/lib/supabase/proxy";

/**
 * Refreshes the Supabase Auth session on every request (Next.js `proxy`
 * convention, formerly `middleware`).
 *
 * Note what this deliberately does *not* do: decide who may see what. Path
 * matching here would be a second, parallel description of the route tree that
 * can drift from the real one and leave a resource reachable. Access is checked
 * where the protected data is actually read — `getCurrentUser()` in the `(app)`
 * layout — so a new page under it is protected by where it lives rather than by
 * someone remembering to update a regex.
 *
 * What it *is* for is the one thing only a proxy can do. An access token
 * expires, and the refreshed cookies have to be written to a response whose
 * headers are still open. A Server Component's are not, so
 * `src/lib/supabase/server.ts` discards refreshes it cannot persist and depends
 * on this having run first.
 *
 * Keys are read straight from `process.env` rather than through `lib/env`, to
 * keep the edge bundle free of database configuration it has no use for.
 */

const authConfigured = Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_URL &&
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
);

export default async function proxy(request: NextRequest): Promise<NextResponse> {
  // In setup mode Supabase is unconfigured and constructing a client would throw
  // on every request, so the proxy steps aside. Production refuses to start
  // without the pair (see src/lib/env.ts), so this can only happen in
  // development.
  if (!authConfigured) return NextResponse.next({ request });

  return updateSession(request);
}

export const config = {
  matcher: [
    // Everything except Next internals and static files, unless a search param
    // is present — those still need their session refreshed.
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
