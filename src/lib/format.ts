/**
 * Display formatters.
 *
 * Every formatter is pinned to an explicit locale so the server and the browser
 * produce byte-identical strings. Left to the ambient locale they would differ,
 * and React would report a hydration mismatch on every number on the page.
 */

const LOCALE = "en-US";
const CURRENCY = "USD";

const currencyFormatter = new Intl.NumberFormat(LOCALE, {
  style: "currency",
  currency: CURRENCY,
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

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
 */
export type Money = number | string | { toString(): string };

function toNumber(value: Money): number {
  if (typeof value === "number") return value;
  const parsed = Number(value.toString());
  return Number.isFinite(parsed) ? parsed : 0;
}

export function formatCurrency(value: Money): string {
  return currencyFormatter.format(toNumber(value));
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
