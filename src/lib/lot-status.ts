import type { LotStatus } from "@/generated/prisma/enums";

/**
 * Which batches may be sold, stated once.
 *
 * A lot's status answers exactly one question — may FIFO draw these units — and
 * it answers no others. In particular it says nothing about how many units
 * exist, what they cost, or what they are worth. Quarantined stock is on the
 * shelf, inside `Product.stockQuantity`, inside the invariant
 * `SUM(quantityRemaining) = stockQuantity`, and inside the valuation. It is
 * simply not available to sell yet.
 *
 * That separation is the whole design. The tempting alternative — excluding
 * blocked units from `stockQuantity` — would make the ledger stop describing
 * the shelf, break the stock movement summary's reconciliation, and quietly
 * remove real assets from the balance sheet the moment somebody sent goods back.
 *
 * Everything this module exports is used. It deliberately does not offer a
 * predicate for filtering loaded rows, or labels for rendering a status: no
 * production path needs either yet, and an export with no caller is a rule
 * nothing is obliged to obey. They belong here when something asks for them.
 */

/**
 * The one status whose units may be consumed.
 *
 * Deliberately a whitelist rather than a list of blocked states. A future
 * status — awaiting recertification, on loan, held for a customer — is far more
 * likely to be one that must *not* be sold, and a blacklist would default it to
 * saleable. This way a new value is excluded until somebody decides otherwise.
 *
 * Exported because lot creation defaults to it, and asked about through
 * `SALEABLE_LOT_SQL` below — so there is one way to *state* it and one way to
 * *query* it. `satisfies` is what makes a typo here a compile error rather than
 * a query that silently matches nothing.
 */
export const SALEABLE_LOT_STATUS = "SALEABLE" satisfies LotStatus;

/**
 * The status a returned batch starts in.
 *
 * Goods that have been in a customer's custody are not saleable on arrival, and
 * nothing but an inspection may change that. Named here rather than written at
 * the point a return lot is built, so the one file that decides what "saleable"
 * means is also the one that decides what a return is *not*.
 */
export const QUARANTINED_LOT_STATUS = "QUARANTINED" satisfies LotStatus;

/**
 * The saleability predicate, as raw SQL.
 *
 * Both queries that care about status build on this one string: the FIFO scan
 * applies it, and the blocked-quantity aggregate applies its negation. Neither
 * spells the status itself, which is the point — a second literal somewhere
 * would be a second rule, and the drift would be silent, because a scan that
 * forgot the clause would sell quarantined stock and report nothing wrong.
 *
 * Raw SQL rather than a bound parameter, and that is deliberate. The partial
 * index `stock_lots_fifo_saleable_idx` is defined `WHERE status = 'SALEABLE'`,
 * and Postgres can only match a partial index when the query's predicate is
 * provably implied by the index's — which it cannot establish for a parameter
 * whose value it does not know at plan time. Binding the status would keep the
 * query correct and quietly stop it using the index it was built for.
 *
 * Safe to interpolate: it is assembled here from a compile-time constant, and
 * no caller-supplied value ever reaches it.
 */
export const SALEABLE_LOT_SQL = `status = '${SALEABLE_LOT_STATUS}'`;

/**
 * What to tell somebody whose order cannot be filled from stock that exists.
 *
 * The single most likely way this feature reads as a bug: a warehouse shows 40
 * units on the product page and the system refuses to ship one. "Not enough
 * stock" would send that person to count a shelf that is full. Naming the
 * blocked quantity is what turns a confusing refusal into an actionable one.
 *
 * Returns null when nothing is blocked, so ordinary shortfalls keep their
 * ordinary message and no screen gains a clause about quarantine it does not
 * need.
 */
export function blockedStockHint(
  physicalQuantity: number,
  blockedQuantity: number,
): string | null {
  if (blockedQuantity <= 0) return null;

  const units = blockedQuantity === 1 ? "unit" : "units";

  return (
    `${physicalQuantity} on hand, but ${blockedQuantity} ${units} ` +
    `are not available to sell — awaiting inspection or rejected.`
  );
}
