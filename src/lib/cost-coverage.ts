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
 */

export interface Coverage {
  /** Units the money figures describe. */
  costedQuantity: number;
  /** Units in total, costed or not. */
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
  /** True when every unit is accounted for. */
  complete: boolean;
  /** Units with no known acquisition cost. */
  uncostedQuantity: number;
}

/**
 * Margin over the portion of a line whose cost is known.
 *
 * `unitPrice` is used to apportion revenue to the costed units rather than
 * charging the whole line's revenue against a partial cost. On a complete line
 * this is identical to the obvious calculation; on a partial one it is the
 * difference between a defensible figure and a flattering one.
 */
export function marginOf(input: {
  quantity: number;
  unitPrice: number;
  costTotal: number | null;
  costedQuantity: number;
}): MarginResult {
  const costedQuantity = Math.max(0, Math.min(input.costedQuantity, input.quantity));
  const cost = input.costTotal ?? 0;
  const revenue = input.unitPrice * costedQuantity;
  const margin = revenue - cost;

  return {
    revenue,
    cost,
    margin,
    marginPercent: revenue === 0 ? null : (margin / revenue) * 100,
    costedQuantity,
    quantity: input.quantity,
    uncostedQuantity: input.quantity - costedQuantity,
    complete: costedQuantity === input.quantity && input.quantity > 0,
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
      quantity: sum.quantity + part.quantity,
    }),
    { costedQuantity: 0, quantity: 0 },
  );
}

export function isComplete(coverage: Coverage): boolean {
  return coverage.quantity > 0 && coverage.costedQuantity === coverage.quantity;
}

export function uncostedUnits(coverage: Coverage): number {
  return Math.max(0, coverage.quantity - coverage.costedQuantity);
}

/**
 * The sentence shown beside a partial figure.
 *
 * Returns null when coverage is complete, so a caller can render it
 * unconditionally and get nothing when there is nothing to disclose. Never
 * returns a form of words that could be mistaken for a complete total.
 */
export function coverageNote(coverage: Coverage): string | null {
  if (coverage.quantity === 0) return null;
  if (isComplete(coverage)) return null;

  const missing = uncostedUnits(coverage);

  if (coverage.costedQuantity === 0) {
    return `Acquisition cost unknown for ${missing === 1 ? "this unit" : `all ${missing} units`}, so no margin can be calculated.`;
  }

  return `Margin calculated for ${coverage.costedQuantity} of ${coverage.quantity} units; ${missing} ${missing === 1 ? "unit has" : "units have"} unknown acquisition cost.`;
}

/** A compact form of the same disclosure, for a table cell or a tile. */
export function coverageLabel(coverage: Coverage): string | null {
  if (coverage.quantity === 0) return null;
  if (isComplete(coverage)) return null;
  if (coverage.costedQuantity === 0) return "Cost unknown";
  return `${coverage.costedQuantity} of ${coverage.quantity} units costed`;
}
