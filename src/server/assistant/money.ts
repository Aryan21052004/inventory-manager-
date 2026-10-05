import "server-only";

import { moneyText } from "@/components/ui/money";
import type { Currency } from "@/lib/currency";
import { groupTotals, type MoneyByCurrency } from "@/lib/money-by-currency";

/**
 * How money is handed to the model.
 *
 * Every amount travels in two forms, and neither is arithmetic the model is
 * expected to do:
 *
 *   `byCurrency` — the `MoneyByCurrency` entries unchanged, one per currency,
 *                  with `currency: null` where the rows never recorded one.
 *   `display`    — the same total as the application's screens render it in a
 *                  sentence (`moneyText`), so the model can quote a figure
 *                  rather than format one.
 *
 * Nothing here converts, sums across currencies or picks a dominant one —
 * there is no exchange rate in this application, and the assistant is not the
 * place to invent one. A total spanning three currencies stays three figures.
 */
export interface MoneyView {
  /** One entry per currency. `currency: null` means it was never recorded. */
  byCurrency: { currency: Currency | null; amount: string }[];
  /** The total as the screens print it inline; `"none"` when nothing was totalled. */
  display: string;
}

/** A total that may span currencies. An empty total is "none", never zero. */
export function moneyView(total: MoneyByCurrency): MoneyView {
  return {
    byCurrency: total.map((entry) => ({
      currency: entry.currency,
      amount: entry.amount,
    })),
    display: total.length === 0 ? "none" : moneyText(total),
  };
}

/** One record's own amount, in the currency recorded on that record. */
export function recordMoney(
  amount: string,
  currency: Currency | null,
): MoneyView {
  return moneyView(groupTotals([{ currency, amount }]));
}
