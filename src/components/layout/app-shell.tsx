import type { ReactNode } from "react";

import { Header } from "@/components/layout/header";
import { SetupBanner } from "@/components/layout/setup-banner";
import { Sidebar } from "@/components/layout/sidebar";

/**
 * The dashboard chrome: fixed sidebar, sticky header, scrolling content.
 *
 * A server component, so the env lookups stay on the server and only the two
 * pieces that need interactivity — the header and the nav — ship as client
 * components.
 */
function AppShell({
  appName,
  authEnabled,
  children,
}: {
  appName: string;
  authEnabled: boolean;
  children: ReactNode;
}) {
  return (
    <div className="min-h-svh bg-background">
      <Sidebar appName={appName} />

      <div className="flex min-h-svh flex-col lg:pl-64">
        <Header appName={appName} authEnabled={authEnabled} />
        {!authEnabled ? <SetupBanner /> : null}

        <main className="flex-1 px-4 py-6 sm:px-6 lg:px-8">
          {/* Caps line length on ultrawide displays; tables still scroll inside their cards. */}
          <div className="mx-auto w-full max-w-[1400px]">{children}</div>
        </main>

        <footer className="border-t border-border px-4 py-4 sm:px-6 lg:px-8">
          <p className="text-xs text-muted-foreground">
            {appName} — foundation build. Feature modules are scaffolded but not
            yet implemented.
          </p>
        </footer>
      </div>
    </div>
  );
}

export { AppShell };
