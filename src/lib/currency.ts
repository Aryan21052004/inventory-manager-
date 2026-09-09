/**
 * The application's currency, and the one place money becomes a string.
 *
 * **Client-safe by construction.** This module imports nothing — no Prisma, no
 * `server-only`, no environment. The order builder, the purchase builder and
 * the batch inspection dialog are client components that render money, so
 * anything they need to format it has to survive being bundled for the browser.
 * The *value* of the setting is loaded on the server (src/server/settings.ts)
 * and handed to those components through a context; the *rules* for turning a
 * number into a string live here and are shared by both runtimes.
 *
 * ## What this is, and what it deliberately is not
 *
 * One global currency for the whole installation. Not a per-row currency, not a
 * per-user preference, and emphatically **not a conversion layer**. USD, INR
 * and EUR are accounting currencies here: the currency says what the numbers
 * already in the database *mean*, and changing it re-labels them rather than
 * re-valuing them. There are no exchange rates in this system and none may be
 * introduced — a converted amount is indistinguishable from a real one once it
 * is written down, which is the same failure the costing layer exists to
 * prevent.
 *
 * A consequence worth stating plainly, because it is accepted rather than
 * overlooked: switching the currency re-labels history. A purchase recorded
 * while the app was set to USD renders with a rupee sign afterwards. That is
 * the deliberate trade for a single global setting, and the admin UI says so
 * before it saves.
 */

/**
 * The supported currencies, as ISO 4217 codes.
 *
 * Codes rather than symbols, for the reason a symbol cannot be a key: `₹` is a
 * rendering of INR, not the currency itself, and several currencies share `$`.
 * The code is what the database stores, what this module keys on, and what a
 * CSV states.
 *
 * All three carry a two-decimal minor unit. **That is load-bearing.** The whole
 * costing engine works in integer minor units — `toCents`, `centsToDecimal`,
 * `Decimal(12, 2)` — and every one of those assumes an exponent of 2. Adding a
 * currency with a different exponent (JPY has 0, KWD has 3) would silently
 * mis-scale every stored amount, and no existing test would catch it. Any
 * future addition to this list must confirm the exponent first.
 */
export const CURRENCIES = ["USD", "INR", "EUR"] as const;

export type Currency = (typeof CURRENCIES)[number];

/** The application default, used when nothing has been chosen yet. */
export const DEFAULT_CURRENCY: Currency = "INR";

/**
 * How each currency is named in the interface.
 *
 * The symbol is included because an administrator picking from a list wants to
 * recognise the thing they are choosing, and "INR" alone is a code rather than
 * a currency to most readers. It is a *label* — nothing formats money by
 * reaching for it.
 */
export const CURRENCY_LABELS: Record<Currency, string> = {
  USD: "US Dollar ($)",
  INR: "Indian Rupee (₹)",
  EUR: "Euro (€)",
};

/**
 * The locale each currency formats under. Fixed, and fixed for two reasons.
 *
 * The first is correctness across the server/browser boundary. Every formatter
 * in this codebase is pinned to an explicit locale so both runtimes produce
 * byte-identical strings; left to the ambient locale they diverge and React
 * reports a hydration mismatch on every number on the page. `navigator.language`
 * is therefore not merely discouraged here, it is unusable.
 *
 * The second is that grouping is a business decision, not a technical one.
 * `en-IN` groups in lakhs and crores — ₹1,80,104.96, not ₹180,104.96 — which is
 * how the figure is read by the people who read it. USD and EUR stay on `en-US`
 * because that is the convention the rest of this file's formatters already
 * use and there is no reason to move them.
 */
export const CURRENCY_LOCALES: Record<Currency, string> = {
  USD: "en-US",
  INR: "en-IN",
  EUR: "en-US",
};

/**
 * A Prisma `Decimal`, a plain number, or the decimal strings the loaders
 * return.
 *
 * Money columns come back from Prisma as `Decimal` objects and cross to the
 * client as strings; `toString()` on a Decimal avoids the precision loss of an
 * implicit float conversion, which is the whole reason this accepts an object
 * rather than demanding a number at every call site.
 */
export type Money = number | string | { toString(): string };

/**
 * One `Intl.NumberFormat` per currency, built once.
 *
 * Constructing a formatter is expensive relative to using one, and a table
 * listing money calls this hundreds of times per render. The cache is keyed by
 * currency and its entries are immutable once created — note what it is *not*:
 * a mutable "current formatter" that some other module reassigns when the
 * setting changes. That arrangement would make the output of this function
 * depend on module load order and on which request touched it last, which on a
 * server handling concurrent renders is a correctness bug rather than a style
 * one. Every caller passes the currency it wants and gets exactly that.
 */
const formatters = new Map<Currency, Intl.NumberFormat>();

function formatterFor(currency: Currency): Intl.NumberFormat {
  const existing = formatters.get(currency);
  if (existing) return existing;

  const created = new Intl.NumberFormat(CURRENCY_LOCALES[currency], {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  formatters.set(currency, created);
  return created;
}

/**
 * A number as it arrives from the database, without going through a float
 * where it can be helped.
 *
 * A value that cannot be read as a number becomes 0 rather than `NaN`. That is
 * a display decision, not a costing one: `NaN` on a dashboard tile is worse
 * than useless, and every path that *matters* — an unknown acquisition cost —
 * carries `null` and is handled by the caller before it reaches here.
 */
function toNumber(value: Money): number {
  if (typeof value === "number") return value;
  const parsed = Number(value.toString());
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Money, in the active currency.
 *
 * The currency is a required argument on purpose. It was once a module
 * constant — `const CURRENCY = "USD"` — and a default here would quietly
 * restore that: a call site nobody updated would keep rendering dollars while
 * the setting said rupees, and it would look correct in review. Requiring the
 * argument makes the compiler enumerate every place money is shown.
 */
export function formatMoney(value: Money, currency: Currency): string {
  return formatterFor(currency).format(toNumber(value));
}

/** Whether a string is one of the supported codes. Narrows for callers. */
export function isCurrency(value: unknown): value is Currency {
  return (
    typeof value === "string" && (CURRENCIES as readonly string[]).includes(value)
  );
}

/** The display name for a currency, for a label or a select option. */
export function currencyLabel(currency: Currency): string {
  return CURRENCY_LABELS[currency];
}
