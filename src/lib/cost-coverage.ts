/**
 * How a partially-costed figure is allowed to be presented.
 *
 * Some stock has no known acquisition cost — it predates lot costing, or was
 * counted in by hand without one — and FIFO will consume it like anything else.
 * A sale of 15 units can therefore be costed for 10 of them and no more, which
 * leaves every money figure downstream with a coverage question attached: how
 * much of this does the number actually describe?
 *
 * The trap this module exists to close is a single subtraction. Given revenue
 * of ₹180,000 and a known cost of ₹80,000 covering 10 of 15 units, it is very
 * natural to write `revenue - cost` and call the ₹100,000 profit. It is not
 * profit. It is an upper bound that would only be reached if the five uncosted
 * units had been free. The honest figure is the margin on the units whose cost
 * is known — ₹40,000 on 10 units — with the remaining five disclosed rather
 * than absorbed.
 *
 * So nothing here returns a bare number. Every result carries what it covers,
 * coverage aggregates instead of averaging away, and the formatting helpers
 * refuse to render a total without saying how much of the line it speaks for.
 *
 * ---------------------------------------------------------------------------
 *
 * **Three quantities, not two, and the middle one is the recent arrival.**
 *
 * An order may now be confirmed against a shelf that cannot fill it: the units
 * on hand leave and are costed, and the rest become an outstanding obligation
 * with no movement, no lot and no cost. So a line's units fall into three
 * groups, and collapsing any pair of them produces a figure that is wrong in a
 * way that reads as authoritative:
 *
 *     costedQuantity                        shipped, cost known
 *     fulfilledQuantity - costedQuantity    shipped, cost unknown
 *     quantity - fulfilledQuantity          never shipped, no cost exists
 *
 * The denominator for coverage is therefore `fulfilledQuantity`, never
 * `quantity`. An unfulfilled unit is not an uncosted unit — there is nothing
 * to know about its acquisition cost yet, because it has not been acquired
 * against this sale. Counting it as uncosted would report a fulfilment gap as
 * a costing failure, which is precisely the kind of confidently wrong number
 * the rest of this file exists to prevent.
 */

export interface Coverage {
  /** Units the money figures describe. */
  costedQuantity: number;
  /** Units that have physically left. The denominator coverage is read against. */
  fulfilledQuantity: number;
  /** Units in total, shipped or not. */
  quantity: number;
}

export interface MarginResult extends Coverage {
  /**
   * Revenue from the costed units only — not the whole line.
   *
   * Deliberately apportioned. Setting the full revenue against a partial cost
   * is the overstatement this type exists to prevent.
   */
  revenue: number;
  /** What those units cost. */
  cost: number;
  /** `revenue - cost`, over the costed units alone. */
  margin: number;
  /** Margin as a percentage of the costed revenue, or null when there is none. */
  marginPercent: number | null;
  /** True when every unit that shipped has a known cost, and every unit shipped. */
  complete: boolean;
  /** Units that shipped with no known acquisition cost. */
  uncostedQuantity: number;
  /** Units still owed to the customer. No movement, no lot, no cost. */
  unfulfilledQuantity: number;
}

/**
 * Margin over the portion of a line whose cost is known.
 *
 * `unitPrice` is used to apportion revenue to the costed units rather than
 * charging the whole line's revenue against a partial cost. On a fully
 * fulfilled, fully costed line this is identical to the obvious calculation;
 * on a partial one it is the difference between a defensible figure and a
 * flattering one.
 *
 * `fulfilledQuantity` is required rather than defaulted to `quantity`. A
 * default would silently preserve the old arithmetic at any call site whose
 * author had not thought about fulfilment, which is the failure mode this
 * whole module is built to make impossible.
 */
export function marginOf(input: {
  quantity: number;
  fulfilledQuantity: number;
  unitPrice: number;
  costTotal: number | null;
  costedQuantity: number;
}): MarginResult {
  const fulfilledQuantity = Math.max(
    0,
    Math.min(input.fulfilledQuantity, input.quantity),
  );
  const costedQuantity = Math.max(
    0,
    Math.min(input.costedQuantity, fulfilledQuantity),
  );
  const cost = input.costTotal ?? 0;
  const revenue = input.unitPrice * costedQuantity;
  const margin = revenue - cost;

  return {
    revenue,
    cost,
    margin,
    marginPercent: revenue === 0 ? null : (margin / revenue) * 100,
    costedQuantity,
    fulfilledQuantity,
    quantity: input.quantity,
    uncostedQuantity: fulfilledQuantity - costedQuantity,
    unfulfilledQuantity: input.quantity - fulfilledQuantity,
    complete:
      costedQuantity === input.quantity && input.quantity > 0,
  };
}

/**
 * Adds coverage up across lines, orders, periods — anything.
 *
 * Coverage sums; it is never averaged. One uncosted unit anywhere in a report
 * makes that report's profit partial, and this is what carries that fact
 * upward instead of letting it dissolve into a percentage.
 */
export function totalCoverage(parts: readonly Coverage[]): Coverage {
  return parts.reduce<Coverage>(
    (sum, part) => ({
      costedQuantity: sum.costedQuantity + part.costedQuantity,
      fulfilledQuantity: sum.fulfilledQuantity + part.fulfilledQuantity,
      quantity: sum.quantity + part.quantity,
    }),
    { costedQuantity: 0, fulfilledQuantity: 0, quantity: 0 },
  );
}

/** Units that shipped without a known acquisition cost. */
function uncostedUnits(coverage: Coverage): number {
  return Math.max(0, coverage.fulfilledQuantity - coverage.costedQuantity);
}

/** Units still owed. Not a costing problem — nothing has been acquired yet. */
function outstandingUnits(coverage: Coverage): number {
  return Math.max(0, coverage.quantity - coverage.fulfilledQuantity);
}

/**
 * The sentence shown beside a partial figure.
 *
 * Returns null when everything that shipped is costed and nothing is
 * outstanding, so a caller can render it unconditionally and get nothing when
 * there is nothing to disclose. Never returns a form of words that could be
 * mistaken for a complete total.
 *
 * The two shortfalls are named separately and never added together. "3 units
 * have unknown acquisition cost" and "2 units are still outstanding" are
 * different facts with different remedies — one is a paperwork gap that may
 * never close, the other clears the moment the stock arrives and is fulfilled.
 */
export function coverageNote(coverage: Coverage): string | null {
  if (coverage.quantity === 0) return null;

  const missing = uncostedUnits(coverage);
  const outstanding = outstandingUnits(coverage);

  if (missing === 0 && outstanding === 0) return null;

  const clauses: string[] = [];

  if (coverage.fulfilledQuantity === 0) {
    clauses.push(
      outstanding === 1
        ? "This unit has not been fulfilled yet, so it has no cost of sale."
        : `None of these ${coverage.quantity} units has been fulfilled yet, so there is no cost of sale.`,
    );
  } else if (missing === 0) {
    clauses.push(
      `Margin calculated for ${coverage.costedQuantity} of ${coverage.quantity} units.`,
    );
  } else if (coverage.costedQuantity === 0) {
    clauses.push(
      `Acquisition cost unknown for ${missing === 1 ? "the unit fulfilled so far" : `all ${missing} fulfilled units`}, so no margin can be calculated.`,
    );
  } else {
    /*
     * "fulfilled" only when it disambiguates. On a fully shipped line the
     * denominator is the whole line and the word is noise; on a partially
     * shipped one it is the difference between "5 units we cannot price" and
     * "5 units we have not sent", which are not the same problem.
     */
    const denominator =
      outstanding > 0
        ? `${coverage.fulfilledQuantity} fulfilled units`
        : `${coverage.quantity} units`;

    clauses.push(
      `Margin calculated for ${coverage.costedQuantity} of ${denominator}; ${missing} ${missing === 1 ? "unit has" : "units have"} unknown acquisition cost.`,
    );
  }

  if (outstanding > 0 && coverage.fulfilledQuantity > 0) {
    clauses.push(
      `${outstanding} ${outstanding === 1 ? "unit is" : "units are"} still outstanding and ${outstanding === 1 ? "has" : "have"} no cost of sale yet.`,
    );
  }

  return clauses.join(" ");
}
