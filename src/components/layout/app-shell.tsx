import type { ReactNode } from "react";

import { CurrencyProvider } from "@/components/layout/currency-provider";
import { Header } from "@/components/layout/header";
import { SetupBanner } from "@/components/layout/setup-banner";
import { Sidebar } from "@/components/layout/sidebar";
import { UserMenu, type UserMenuAccount } from "@/components/layout/user-menu";
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
  account,
  currency,
  children,
}: {
  appName: string;
  authEnabled: boolean;
  /**
   * The signed-in user's display details, resolved on the server from our own
   * `users` table. Narrowed to three fields on purpose — the full row carries
   * ids and timestamps the header has no use for, and anything passed here
   * crosses into a client component.
   */
  account: UserMenuAccount | null;
  currency: Currency;
  children: ReactNode;
}) {
  return (
    <div className="min-h-svh bg-background">
      <Sidebar appName={appName} />

      <div className="flex min-h-svh flex-col lg:pl-60">
        {/* Rendered here, not inside Header, so the account details stay a prop
            resolved by this server component rather than something the client
            has to fetch for itself. It travels as an element. */}
        <Header
          appName={appName}
          userMenu={<UserMenu authEnabled={authEnabled} account={account} />}
        />
        {!authEnabled ? <SetupBanner /> : null}

        <main className="flex-1 px-4 py-5 sm:px-6 lg:px-6">
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
