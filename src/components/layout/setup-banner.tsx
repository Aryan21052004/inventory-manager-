import Link from "next/link";
import { ShieldAlert } from "lucide-react";

/**
 * Shown across the top of every page while Clerk is unconfigured.
 *
 * Running without auth is a development convenience, and a convenience that is
 * easy to forget about is a security hole waiting to happen — so it announces
 * itself on every screen rather than hiding in a log line. Production refuses
 * to boot in this state; see `src/lib/env.ts`.
 */
function SetupBanner() {
  return (
    <div className="border-b border-warning/30 bg-warning/10 px-4 py-2.5 sm:px-6">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <ShieldAlert className="size-4 shrink-0 text-warning" aria-hidden />
        <span className="font-medium">Setup mode — authentication is off.</span>
        <span className="text-muted-foreground">
          Every route is publicly reachable until Clerk keys are added.
        </span>
        <Link
          href="/settings"
          className="font-medium text-primary underline-offset-4 hover:underline"
        >
          Finish setup
        </Link>
      </div>
    </div>
  );
}

export { SetupBanner };
