import type { ReactNode } from "react";

import { Brand } from "@/components/layout/brand";
import { env } from "@/lib/env";

/**
 * Centred, chrome-free layout for the sign-in and sign-up screens — no sidebar,
 * since there is nothing to navigate to until the user is authenticated.
 */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-8 bg-muted/40 px-4 py-12">
      <Brand appName={env.NEXT_PUBLIC_APP_NAME} />
      {children}
      <p className="text-xs text-muted-foreground">
        Stock control for growing teams.
      </p>
    </div>
  );
}
