/**
 * Display formatters.
 *
 * Every formatter is pinned to an explicit locale so the server and the browser
 * produce byte-identical strings. Left to the ambient locale they would differ,
 * and React would report a hydration mismatch on every number on the page.
 *
 * Money is the exception to "pinned here": its locale depends on the currency
 * the installation is set to, so both the locale table and the formatter cache
 * live in src/lib/currency.ts and `formatCurrency` below is a thin re-export.
 * The rule is unchanged — the locale is still fixed rather than ambient — it is
 * simply fixed per currency instead of once for the module.
 */

import { formatMoney, type Currency, type Money } from "@/lib/currency";

const LOCALE = "en-US";

const numberFormatter = new Intl.NumberFormat(LOCALE);

const dateFormatter = new Intl.DateTimeFormat(LOCALE, {
  year: "numeric",
  month: "short",
  day: "numeric",
});

const dateTimeFormatter = new Intl.DateTimeFormat(LOCALE, {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/**
 * Accepts a Prisma `Decimal` as well as a number — money columns come back as
 * Decimal objects, and calling `.toString()` on them avoids the precision loss
 * of an implicit float conversion.
 *
 * Re-exported from src/lib/currency.ts, where it now lives alongside the
 * formatter that consumes it. Kept exported here so the many modules that
 * import `Money` from this file do not all have to move.
 */
export type { Money };

/**
 * Money, in the currency the installation is set to.
 *
 * **The currency argument is required, and must stay required.** This function
 * used to close over a module-level `const CURRENCY = "USD"`, which meant every
 * one of the seventy-odd call sites rendered dollars without saying so. Giving
 * the parameter a default would reproduce that exactly: a call site nobody
 * updated would keep rendering the default while the setting said otherwise,
 * and it would read as correct in review. Requiring it makes the compiler list
 * every place money reaches a screen.
 *
 * Server components resolve the currency once per render with `getCurrency()`
 * from src/server/settings.ts and thread it down as a prop; client components
 * read it from `useCurrency()`. Neither reaches for a global.
 */
export function formatCurrency(value: Money, currency: Currency): string {
  return formatMoney(value, currency);
}

export function formatNumber(value: number): string {
  return numberFormatter.format(value);
}

export function formatDate(value: Date | string): string {
  return dateFormatter.format(new Date(value));
}

export function formatDateTime(value: Date | string): string {
  return dateTimeFormatter.format(new Date(value));
}

/** A signed delta, for the stock ledger: `+150`, `-20`. */
export function formatDelta(value: number): string {
  return `${value > 0 ? "+" : ""}${numberFormatter.format(value)}`;
}
