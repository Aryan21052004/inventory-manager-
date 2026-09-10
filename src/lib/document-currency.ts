import type { Currency } from "@/lib/currency";

/**
 * What changing a document's currency does to the figures already on it.
 *
 * Shared by the order and purchase builders because it is one rule with two
 * vocabularies — a quoted price and a supplier's unit cost — and two copies of
 * it would drift. The builders map their own line shape onto `PricedLine` and
 * read the answer back by key.
 *
 * **Nothing here converts anything.** There are no exchange rates in this
 * system, so a currency change re-states what the figures mean and leaves the
 * operator to re-decide them. These functions only say which figures the form
 * may discard on their behalf and which ones it must not.
 *
 * Kept out of the components so it can be tested directly: the decision is
 * pure, the components are not, and the test suite has no DOM.
 */

export interface PricedLine {
  /** Identifies the line. The product id, in both builders. */
  key: string;
  /** The figure as typed, exactly as it sits in the input. */
  amount: string;
  /**
   * True when the form put this number there — a catalogue selling price, or
   * the last cost paid for the part — rather than a person typing it.
   *
   * This is knowable only in the form. Neither `OrderItem` nor `PurchaseItem`
   * records where a figure came from, and both are replaced wholesale on an
   * edit, so there is nothing on the server for such a flag to survive on.
   */
  prefilled: boolean;
}

/**
 * The lines whose figure a currency change should clear.
 *
 * A prefilled figure was denominated in something else — the catalogue's
 * currency, or whatever an earlier delivery was bought in — so carrying it
 * into a new currency would assert a price nobody set. It goes.
 *
 * A typed figure stays, always. Deleting somebody's own work to tidy up a
 * currency change is worse than leaving them to check it, and the
 * acknowledgement below is how they say they have.
 */
export function clearedByCurrencyChange(
  lines: readonly PricedLine[],
): string[] {
  return lines.filter((line) => line.prefilled).map((line) => line.key);
}

/**
 * The lines whose figure survived a currency change untouched.
 *
 * Compared against the figures the document was *loaded* with rather than
 * against the live form, which is what makes this the same test the server
 * runs on save: it refuses a line whose submitted amount still equals the
 * stored one when the currency has moved. Mirroring it here means the form
 * cannot offer a save the server is about to reject.
 *
 * Empty whenever the currency has not actually moved, and empty for a document
 * that has no stored currency yet — a new one, or a legacy row being given a
 * currency for the first time. In neither case is there a previous
 * denomination for a figure to have been carried across.
 */
export function carriedAcrossCurrencyChange(
  lines: readonly PricedLine[],
  baselineAmounts: ReadonlyMap<string, string>,
  params: { from: Currency | null; to: Currency },
): string[] {
  if (params.from === null || params.from === params.to) return [];

  return lines
    .filter((line) => baselineAmounts.get(line.key) === line.amount)
    .map((line) => line.key);
}
