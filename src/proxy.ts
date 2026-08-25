import { clerkMiddleware } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

/**
 * Establishes the Clerk auth context for every request (Next.js `proxy`
 * convention, formerly `middleware`).
 *
 * Note what this deliberately does *not* do: decide who may see what. Path
 * matching here would be a second, parallel description of the route tree that
 * can drift from the real one and leave a resource reachable. Access is checked
 * where the protected data is actually read — `auth.protect()` in the `(app)`
 * layout — so a new page under it is protected by where it lives rather than by
 * someone remembering to update a regex.
 *
 * Keys are read straight from `process.env` rather than through `lib/env`, to
 * keep the edge bundle free of database configuration it has no use for.
 */

const authConfigured = Boolean(
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY && process.env.CLERK_SECRET_KEY,
);

// In setup mode Clerk is unconfigured and `clerkMiddleware` would throw on every
// request, so the proxy steps aside. Production refuses to start without keys
// (see src/lib/env.ts), so this can only happen in development.
export default authConfigured ? clerkMiddleware() : () => NextResponse.next();

export const config = {
  matcher: [
    // Everything except Next internals and static files, unless a search param
    // is present — those still need an auth context.
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
