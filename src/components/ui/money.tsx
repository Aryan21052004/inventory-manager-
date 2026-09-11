import type { Currency } from "@/lib/currency";
import { formatCurrency } from "@/lib/format";
import type { CurrencyTotal, MoneyByCurrency } from "@/lib/money-by-currency";
import { cn } from "@/lib/utils";

/**
 * How money reaches a screen once every amount carries its own currency.
 *
 * There is no exchange rate anywhere in this application and there never will
 * be, so the display rules follow from that rather than from taste:
 *
 *   nothing to total → an em dash. **Not** `0.00`. No rows contributed at all,
 *                      which is a different fact from rows contributing zero,
 *                      and a zero would read as "we checked, it's nil".
 *   one currency     → exactly what the screen showed before any of this, in
 *                      the row's own currency rather than in whatever the
 *                      installation default happens to be today.
 *   several          → every one of them, stacked. No dominant figure and no
 *                      "+2 more": without a rate, none of them is the answer
 *                      and the others a footnote.
 *   never recorded   → the amount, and an explicit note that nobody knows what
 *                      it is in. Labelling it with the current setting is the
 *                      precise bug this whole change set exists to remove.
 *
 * Pure presentation — no server import — so a client-side builder and a server
 * page render money identically.
 */

/**
 * Money whose currency was never recorded.
 *
 * Pinned locale, for the reason every formatter in this application is pinned:
 * the server and the browser must produce the same string or React reports a
 * hydration mismatch. Two decimal places, because these are the same money
 * columns as everything else — only the label is missing.
 */
const UNLABELLED = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** One entry, formatted in its own currency. Never in anything else's. */
export function formatEntry(entry: CurrencyTotal): string {
  return entry.currency === null
    ? UNLABELLED.format(Number(entry.amount))
    : formatCurrency(entry.amount, entry.currency);
}

/** The marker that says an amount is real but its denomination is not known. */
function UnknownNote() {
  return (
    <span className="ml-1.5 text-xs font-normal text-muted-foreground">
      currency unknown
    </span>
  );
}

/**
 * A monetary total, one line per currency it is denominated in.
 *
 * `stackedClassName` exists only so a large summary tile can drop a size when
 * it carries more than one line; a table cell is already small and passes
 * nothing.
 */
export function MoneyLines({
  total,
  stackedClassName,
}: {
  total: MoneyByCurrency;
  stackedClassName?: string;
}) {
  if (total.length === 0) return <>—</>;

  const stacked = total.length > 1;

  return (
    <>
      {total.map((entry) => (
        <span
          key={entry.currency ?? "unknown"}
          className={cn("block", stacked && stackedClassName)}
        >
          {formatEntry(entry)}
          {entry.currency === null ? <UnknownNote /> : null}
        </span>
      ))}
    </>
  );
}

/**
 * One document's own amount, in the currency recorded on that document.
 *
 * For an order's total, a batch's unit cost, a catalogue price — a single
 * historical figure rather than an aggregate. The currency comes off the
 * record; an order raised in dollars stays in dollars whatever the setting
 * says today, which is the entire point of moving currency onto the record.
 */
export function RecordMoney({
  amount,
  currency,
}: {
  amount: string;
  currency: Currency | null;
}) {
  return (
    <>
      {formatEntry({ currency, amount })}
      {currency === null ? <UnknownNote /> : null}
    </>
  );
}

/** The same as `MoneyLines`, for a sentence where a stack will not fit. */
export function moneyText(total: MoneyByCurrency): string {
  if (total.length === 0) return "—";

  return total
    .map((entry) =>
      entry.currency === null
        ? `${formatEntry(entry)} (currency unknown)`
        : formatEntry(entry),
    )
    .join(" · ");
}
