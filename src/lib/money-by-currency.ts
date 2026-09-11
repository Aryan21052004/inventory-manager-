import { CURRENCIES, type Currency } from "@/lib/currency";

/**
 * A monetary total that knows what it is denominated in.
 *
 * Every aggregate in this application that adds money now returns a list of
 * these rather than one number, because there is no longer any guarantee that
 * the rows behind it share a currency — and there are no exchange rates here,
 * so a single figure spanning two of them would be arithmetic nobody can
 * defend.
 *
 * `currency: null` is a real answer, not a missing one. It means the amount
 * came from rows whose currency was never recorded — legacy data that predates
 * per-record currency — and it stays in its own bucket so it can never be read
 * as, or added to, a named currency.
 */
export interface CurrencyTotal {
  currency: Currency | null;
  /** A decimal string, exactly as the database produced it. Never converted. */
  amount: string;
}

/**
 * The result of summing money that may span currencies.
 *
 * An empty list means there was nothing to total, which is different from a
 * zero in some particular currency. One entry is the ordinary case and reads
 * exactly as a single figure always did. More than one entry means the rows
 * genuinely disagreed, and the caller must show them separately.
 */
export type MoneyByCurrency = CurrencyTotal[];

/** Ordering: the supported currencies in their canonical order, unknown last. */
function rank(currency: Currency | null): number {
  if (currency === null) return CURRENCIES.length;
  const index = CURRENCIES.indexOf(currency);
  return index === -1 ? CURRENCIES.length : index;
}

/**
 * A decimal amount with at most two places: `0`, `-4`, `12.3`, `-1234.56`.
 *
 * Anchored, and deliberately narrow. Exponential notation, thousands
 * separators, currency symbols, a bare `.`, an empty string and a third
 * decimal place all fail it, because every one of those reaching this module
 * means something upstream is not the money column it was taken for.
 */
const TWO_DECIMAL_AMOUNT = /^-?\d+(?:\.\d{1,2})?$/;

/** The message every rejection here carries, so a stack trace names the value. */
function reject(amount: string, why: string): never {
  throw new RangeError(`${why}: ${JSON.stringify(amount)}`);
}

/**
 * Money as an exact integer count of minor units.
 *
 * Every monetary column in this schema is `Decimal(12, 2)`, and
 * `CURRENCY_EXPONENT` in src/lib/currency.ts says every supported currency has
 * two of them. Parsing the digits rather than going via `Number` keeps a sum
 * of a few thousand invoice lines exact, which a float does not.
 *
 * **It refuses rather than approximates.** An amount carrying a third decimal
 * is not this application's money and must not be quietly rounded or trimmed
 * into something that looks like it; text that is not a number at all used to
 * come back out as the string "NaN.NaN", which is worse than an error in every
 * way. A loader that hits either wraps the throw into its own error result, so
 * the page shows that it could not load rather than a plausible wrong figure.
 */
function toMinorUnits(amount: string): number {
  const text = amount.trim();

  if (!TWO_DECIMAL_AMOUNT.test(text)) {
    reject(amount, "not a monetary amount with at most two decimal places");
  }

  const negative = text.startsWith("-");
  const [whole = "0", fraction = ""] = text.replace("-", "").split(".");

  // Safe now, not a truncation: the pattern above allows at most two digits.
  const minor = `${fraction}00`.slice(0, 2);
  const value = Number(whole) * 100 + Number(minor);

  /*
   * Integers this size are exact in a double, but only up to 2^53. A
   * `Decimal(12, 2)` column cannot reach that; an unconstrained `SUM()` over
   * enough rows could, and silently losing the low digits is precisely the
   * class of error this module exists to prevent.
   */
  if (!Number.isSafeInteger(value)) {
    reject(amount, "monetary amount too large to represent exactly");
  }

  return negative ? -value : value;
}

/** Minor units back to the `12.34` string every money value travels as. */
function fromMinorUnits(minor: number): string {
  if (!Number.isSafeInteger(minor)) {
    reject(String(minor), "minor units are not an exact integer");
  }

  const sign = minor < 0 ? "-" : "";
  const absolute = Math.abs(minor);
  return `${sign}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, "0")}`;
}

/**
 * Collects `(currency, amount)` rows into a stable, ordered total.
 *
 * The amounts are **not** re-added here — the database has already grouped and
 * summed within each currency, and this only orders and cleans up. Anything
 * that reaches this function having summed across currencies is already wrong,
 * and no amount of shaping afterwards would fix it.
 *
 * What it does normalise is the *shape* of each figure, to the two decimal
 * places every money column in this schema carries. Producers reach the same
 * total by different routes — raw SQL casts a `numeric(12, 2)` and gets
 * "400.00", while a Prisma `groupBy` hands back a Decimal whose `toString`
 * gives "400" — and two aggregates of the same rows disagreeing on their
 * punctuation is the kind of difference that shows up in a CSV column, or in
 * a comparison between two loaders, long after anyone remembers why.
 *
 * Zero-amount groups are kept. A currency that produced rows summing to zero
 * is a fact about the data; dropping it would make "no orders in EUR" and
 * "EUR orders totalling nothing" indistinguishable. An empty list in is an
 * empty list out — nothing to total is not a zero.
 *
 * Throws a `RangeError` on an amount that is not a decimal with at most two
 * places. See `toMinorUnits` for why that is better than the alternatives.
 */
export function groupTotals(
  rows: readonly { currency: Currency | null; amount: string | null }[],
): MoneyByCurrency {
  return rows
    .map((row) => ({
      currency: row.currency,
      amount: fromMinorUnits(toMinorUnits(row.amount ?? "0")),
    }))
    .sort((a, b) => rank(a.currency) - rank(b.currency));
}

/**
 * Adds amounts **within** each currency, never across them.
 *
 * For producers whose query grouped by something else as well — a status, a
 * month — and so can hand back the same currency more than once. Two dollar
 * figures becoming one dollar figure is ordinary arithmetic; a dollar figure
 * and a euro one stay side by side, which is the whole point of this module.
 *
 * `groupTotals` is the one to reach for when the database has already produced
 * one row per currency: it deliberately does not re-add anything.
 */
export function sumByCurrency(
  rows: readonly { currency: Currency | null; amount: string | null }[],
): MoneyByCurrency {
  const totals = new Map<Currency | null, number>();

  for (const row of rows) {
    const previous = totals.get(row.currency) ?? 0;
    totals.set(row.currency, previous + toMinorUnits(row.amount ?? "0"));
  }

  return groupTotals(
    [...totals].map(([currency, minor]) => ({
      currency,
      amount: fromMinorUnits(minor),
    })),
  );
}

/** True when a total spans more than one currency — including the unknown one. */
export function isMixed(total: MoneyByCurrency): boolean {
  return total.length > 1;
}

/**
 * The one currency a total is in, or null when there is not exactly one.
 *
 * Null covers three different situations on purpose — nothing to total, an
 * unrecorded currency, and several currencies — because a caller that wants a
 * single figure cannot be given one in any of them. A caller that needs to
 * tell them apart reads the list.
 */
export function soleCurrency(total: MoneyByCurrency): Currency | null {
  return total.length === 1 ? (total[0]?.currency ?? null) : null;
}

/**
 * The single amount when a total is in exactly one **known** currency.
 *
 * For the places that legitimately need a scalar — sorting a report column,
 * deciding whether a figure can be compared with another. Null whenever no
 * single defensible number exists, and callers must handle that rather than
 * substituting zero, which would sort an unknown row as though it were empty.
 */
export function soleAmount(total: MoneyByCurrency): string | null {
  if (total.length !== 1) return null;
  const only = total[0];
  if (only === undefined || only.currency === null) return null;
  return only.amount;
}

/** An empty total. Distinct from a zero: there was nothing to add. */
export const NO_MONEY: MoneyByCurrency = [];
