import type { OrderStatus, PurchaseStatus } from "@/generated/prisma/enums";

/**
 * Which documents count as money, and which are still only intentions.
 *
 * These four constants were previously three: `REVENUE_STATUSES` lived in the
 * customers module, an equivalent `SPEND_STATUSES` was private to suppliers,
 * and the orders and purchases modules each wrote their own status filters
 * inline. Three modules had opinions about what "value" meant and no single
 * place said so, which is how `openValue` came to mean CONFIRMED while
 * `lifetimeValue` meant CONFIRMED + COMPLETED — both defensible, neither
 * discoverable from the other.
 *
 * The dashboard needs all of them at once, which is what forced the question.
 * They live here now, and every module reads them from here.
 *
 * The distinction they encode is the one an accountant would draw: a document
 * that has *happened* is money, and a document that is still being written or
 * that was called off is not. Nothing in between gets counted twice.
 */

/**
 * Sales that have actually happened.
 *
 * CONFIRMED is the point stock left the building, and COMPLETED is that same
 * sale once it shipped — so both are realised. DRAFT is an unfinished document
 * and CANCELLED is a sale that did not happen; counting either as revenue
 * would inflate the top line with business nobody did.
 */
export const REVENUE_STATUSES = ["CONFIRMED", "COMPLETED"] as const;

/**
 * Sales that are committed but not yet shipped.
 *
 * A narrower question than revenue, and a different one: this is what is owed
 * to customers right now. COMPLETED orders are deliberately absent — they are
 * revenue, but they are no longer an open commitment.
 *
 * **Intentionally unused for now.** Nothing calls this yet; it is reserved for
 * the reporting and operational layer, where "what have we committed to ship"
 * is a question that will be asked and must be asked in one agreed way rather
 * than reinvented at the call site. A dead-code audit will keep finding it —
 * this comment is the answer.
 *
 * Note what it is *not*: the customers module's `UNCOMMITTED_ORDER_STATUSES`
 * (DRAFT + PENDING) is the opposite end of the lifecycle, not a synonym.
 */
export const OPEN_ORDER_STATUSES = ["CONFIRMED"] as const;

/**
 * Orders that still need somebody to do something.
 *
 * PENDING is finished and waiting; CONFIRMED is committed and awaiting
 * fulfilment. DRAFT is deliberately excluded — a draft is a document somebody
 * has not finished writing, not work queued up, and counting it makes the one
 * figure meant to prompt action overstate what is actually outstanding.
 */
export const ACTIONABLE_ORDER_STATUSES = ["PENDING", "CONFIRMED"] as const;

/**
 * Procurement that has actually happened.
 *
 * RECEIVED only. A draft is a plan, a pending purchase is in transit and may
 * still be cancelled, and a cancelled one did not happen — none of the three is
 * money spent. This is the same rule the supplier detail page has always used
 * for `totalPurchased`, now stated once.
 */
export const SPEND_STATUSES = ["RECEIVED"] as const;

/**
 * Procurement placed with a supplier but not yet arrived — money committed.
 *
 * PENDING only. A draft has not been placed with anybody yet, so it commits
 * nothing.
 */
export const COMMITTED_SPEND_STATUSES = ["PENDING"] as const;

/**
 * Purchases somebody is still waiting on, for the attention count.
 *
 * DRAFT is included here and nowhere else, and the difference is deliberate:
 * as *money* a draft commits nothing, but as *work* an unfinished purchase
 * order is something sitting on somebody's desk. It counts towards attention
 * and never towards spend.
 */
export const OUTSTANDING_PURCHASE_STATUSES = ["DRAFT", "PENDING"] as const;

/** Mutable copies, because Prisma's `in` filters do not take readonly arrays. */
export const revenueStatuses = (): OrderStatus[] => [...REVENUE_STATUSES];
/** Reserved alongside OPEN_ORDER_STATUSES; see the note there. */
export const openOrderStatuses = (): OrderStatus[] => [...OPEN_ORDER_STATUSES];
export const actionableOrderStatuses = (): OrderStatus[] => [
  ...ACTIONABLE_ORDER_STATUSES,
];
export const spendStatuses = (): PurchaseStatus[] => [...SPEND_STATUSES];
export const committedSpendStatuses = (): PurchaseStatus[] => [
  ...COMMITTED_SPEND_STATUSES,
];
export const outstandingPurchaseStatuses = (): PurchaseStatus[] => [
  ...OUTSTANDING_PURCHASE_STATUSES,
];
