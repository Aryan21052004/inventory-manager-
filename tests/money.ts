import type { Currency } from "@/lib/currency";
import type { MoneyByCurrency } from "@/lib/money-by-currency";

/**
 * Reading a per-currency total the way a test used to read a scalar.
 *
 * Every monetary aggregate now comes back as a list of `(currency, amount)`
 * pairs, because nothing guarantees the rows behind it share a currency and
 * there are no exchange rates in this application. Most tests set up data in
 * one currency and want the one number back — but "the one number" is only
 * meaningful if there really is one, so these helpers assert that rather than
 * assuming it.
 *
 * That makes them **stricter** than the scalar reads they replace: a total
 * that has silently become mixed, or lost its currency label, fails here
 * instead of being flattened into a plausible-looking figure.
 */

/**
 * The single amount a total holds, asserting it is in exactly `currency`.
 *
 * Throws rather than returning NaN or zero: a test whose aggregate came back
 * mixed has found a real defect, and the message needs to say so.
 */
export function amountIn(
  total: MoneyByCurrency,
  currency: Currency | null,
): number {
  if (total.length !== 1) {
    throw new Error(
      `expected one currency, got ${total.length}: ${JSON.stringify(total)}`,
    );
  }

  const only = total[0]!;

  if (only.currency !== currency) {
    throw new Error(
      `expected ${String(currency)}, got ${String(only.currency)}`,
    );
  }

  return Number(only.amount);
}

/** The same, as the decimal string the database produced. */
export function stringIn(
  total: MoneyByCurrency,
  currency: Currency | null,
): string {
  if (total.length !== 1) {
    throw new Error(
      `expected one currency, got ${total.length}: ${JSON.stringify(total)}`,
    );
  }

  const only = total[0]!;

  if (only.currency !== currency) {
    throw new Error(
      `expected ${String(currency)}, got ${String(only.currency)}`,
    );
  }

  return only.amount;
}

/** The currencies a total spans, in the order it presents them. */
export function currenciesOf(total: MoneyByCurrency): (Currency | null)[] {
  return total.map((entry) => entry.currency);
}
