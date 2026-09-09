import type { ReactNode } from "react";

import { CurrencyProvider } from "@/components/layout/currency-provider";
import { Header } from "@/components/layout/header";
import { SetupBanner } from "@/components/layout/setup-banner";
import { Sidebar } from "@/components/layout/sidebar";
import { UserMenu } from "@/components/layout/user-menu";
import type { Currency } from "@/lib/currency";

/**
 * The dashboard chrome: fixed sidebar, sticky header, scrolling content.
 *
 * A server component, so the env lookups stay on the server and only the two
 * pieces that need interactivity — the header and the nav — ship as client
 * components.
 *
 * The currency provider is mounted here rather than in `providers.tsx` because
 * the value comes from the database and only pages under `(app)` render money.
 * The sign-in screens have no use for it and should not pay for the query.
 */
function AppShell({
  appName,
  authEnabled,
  currency,
  children,
}: {
  appName: string;
  authEnabled: boolean;
  currency: Currency;
  children: ReactNode;
}) {
  return (
    <div className="min-h-svh bg-background">
      <Sidebar appName={appName} />

      <div className="flex min-h-svh flex-col lg:pl-64">
        {/* Rendered here, not inside Header: the menu is a server component
            (Clerk's `<Show>` resolves the session on the server) and Header is
            a client one, so it travels as an element rather than an import. */}
        <Header appName={appName} userMenu={<UserMenu authEnabled={authEnabled} />} />
        {!authEnabled ? <SetupBanner /> : null}

        <main className="flex-1 px-4 py-6 sm:px-6 lg:px-8">
          {/* Caps line length on ultrawide displays; tables still scroll inside their cards. */}
          <div className="mx-auto w-full max-w-[1400px]">
            <CurrencyProvider currency={currency}>{children}</CurrencyProvider>
          </div>
        </main>
      </div>
    </div>
  );
}

export { AppShell };
