import type { ReactNode } from "react";
import { auth } from "@clerk/nextjs/server";

import { AppShell } from "@/components/layout/app-shell";
import { authEnabled, env } from "@/lib/env";

/**
 * Wraps every signed-in page in the dashboard chrome. The route group `(app)`
 * groups these pages without adding a segment to their URLs, so the dashboard
 * stays at `/dashboard` rather than `/app/dashboard`.
 *
 * This layout is also the authorisation boundary. Checking here rather than in
 * the proxy means protection follows the route tree itself: any page added
 * under this group is protected because of where it lives, and the sign-in
 * pages are public because they live outside it. `auth.protect()` reads the
 * request headers, which opts every page beneath this into dynamic rendering —
 * exactly what you want, since a statically prerendered page would otherwise be
 * servable without this check ever running.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  if (authEnabled) {
    await auth.protect();
  }

  return (
    <AppShell appName={env.NEXT_PUBLIC_APP_NAME} authEnabled={authEnabled}>
      {children}
    </AppShell>
  );
}
