"use client";

import { createContext, useContext, type ReactNode } from "react";

import { DEFAULT_CURRENCY, type Currency } from "@/lib/currency";

/**
 * The active currency, for the client components that render money.
 *
 * Most of the application formats money in server components, which resolve the
 * currency with `getCurrency()` and pass it down as an ordinary prop. Three
 * screens cannot: the order builder, the purchase builder and the batch
 * inspection dialog are `"use client"` because they hold live form state, and a
 * server component's data cannot reach them through React context — context
 * crosses the boundary in one direction only.
 *
 * So they read it from here. The value is still resolved once, on the server,
 * in the `(app)` layout; this provider only carries it across the boundary.
 * Nothing in this file imports Prisma or `server-only`, and nothing may: the
 * whole module is bundled for the browser.
 *
 * There is deliberately no fetching, no state and no setter. The currency
 * changes when an administrator saves the settings form, which revalidates the
 * affected paths and re-renders the tree from the server with the new value.
 * A client-side setter would be a second source of truth for a global setting.
 */
const CurrencyContext = createContext<Currency | null>(null);

function CurrencyProvider({
  currency,
  children,
}: {
  currency: Currency;
  children: ReactNode;
}) {
  return (
    <CurrencyContext.Provider value={currency}>
      {children}
    </CurrencyContext.Provider>
  );
}

/**
 * The active currency inside a client component.
 *
 * Falls back to the application default when no provider is above it. That case
 * should not arise in the app — the provider is mounted in the `(app)` layout,
 * above every page that renders money — but a component rendered in isolation
 * (a test, a future Storybook) should show a plausible figure rather than
 * throw. The fallback is the same default the server loader uses, so the two
 * cannot disagree about what "unset" means.
 */
function useCurrency(): Currency {
  return useContext(CurrencyContext) ?? DEFAULT_CURRENCY;
}

export { CurrencyProvider, useCurrency };
