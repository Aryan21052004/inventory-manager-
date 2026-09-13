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

/**
 * Whether two figures can be compared arithmetically.
 *
 * True only when both name a currency and both name the same one. With no
 * exchange rate anywhere in this system that is the only case in which
 * subtracting one from the other yields a number meaning anything: across two
 * currencies the difference is nonsense, and a missing currency is not evidence
 * of agreement but the absence of evidence either way, so it answers false
 * rather than optimistically matching.
 *
 * Used where a screen wants to say how far one amount sits from another — a
 * quote against its catalogue reference. When this says no, the honest move is
 * to show both figures in their own currencies and leave the reader the
 * comparison this code cannot make for them.
 */
export function sameKnownCurrency(
  a: Currency | null,
  b: Currency | null,
): boolean {
  if (a === null || b === null) return false;
  return a === b;
}

/**
 * The historical figure a new line may start at, or nothing at all.
 *
 * Both builders offer a number when a line is created — the catalogue's selling
 * price on an order, the last cost paid on a purchase — and both face the same
 * question about it: is it denominated in what this document is denominated in?
 * Only then is it a default. Otherwise it is a different number wearing a
 * familiar shape, and copying it in would not convert it, it would silently
 * re-denominate it — there being no rate here to convert it with.
 *
 * Returns the amount unchanged, or null. There is no third answer and in
 * particular no converted one: a blank box is what "we cannot say" looks like,
 * and the operator enters the figure in the document's own currency.
 *
 * Null is also what tells the caller to record the line as the operator's own
 * rather than the reference's, so a later currency change has nothing to clear.
 */
export function prefillableAmount(params: {
  amount: string | null;
  currency: Currency | null;
  documentCurrency: Currency | null;
}): string | null {
  if (params.amount === null) return null;

  return sameKnownCurrency(params.documentCurrency, params.currency)
    ? params.amount
    : null;
}
