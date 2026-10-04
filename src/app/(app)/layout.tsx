import type { ReactNode } from "react";
import { redirect } from "next/navigation";

import { AppShell } from "@/components/layout/app-shell";
import { authEnabled, env } from "@/lib/env";
import { getCurrentUser } from "@/server/auth";
import { getCurrency } from "@/server/settings";

/**
 * Wraps every signed-in page in the dashboard chrome. The route group `(app)`
 * groups these pages without adding a segment to their URLs, so the dashboard
 * stays at `/dashboard` rather than `/app/dashboard`.
 *
 * This layout is also the authorisation boundary. Checking here rather than in
 * the proxy means protection follows the route tree itself: any page added
 * under this group is protected because of where it lives, and the sign-in
 * pages are public because they live outside it. `getCurrentUser()` reads the
 * request's cookies, which opts every page beneath this into dynamic rendering —
 * exactly what you want, since a statically prerendered page would otherwise be
 * servable without this check ever running.
 *
 * The check is deliberately "is there a user", not "which role". Roles gate
 * actions, and they do it in `requireRole` against the column in our own
 * database; duplicating any of that here would create a second place for the
 * answer to live and drift.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  if (authEnabled) {
    const user = await getCurrentUser();

    // `redirect` throws, so nothing below runs for an unauthenticated request.
    if (!user) redirect("/sign-in");
  }

  /*
   * Resolved here so the client components beneath can reach it. Server
   * components call `getCurrency()` themselves — it is memoised per render, so
   * this is not a second query — and the provider only exists to carry the
   * value across the client boundary.
   */
  const currency = await getCurrency();

  return (
    <AppShell
      appName={env.NEXT_PUBLIC_APP_NAME}
      authEnabled={authEnabled}
      currency={currency}
    >
      {children}
    </AppShell>
  );
}
