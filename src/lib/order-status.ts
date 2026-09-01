/**
 * The order lifecycle: which states exist, which moves between them are legal,
 * and which of them touch inventory.
 *
 * This is the single description of the state machine. The server enforces it
 * (see `assertTransition`), the UI reads it to decide which buttons to offer,
 * and the two therefore cannot disagree about what an order can do next.
 *
 * The rule that matters most is which statuses move stock, and it is stated
 * once here rather than inferred at each call site:
 *
 *   DRAFT      nothing
 *   PENDING    nothing
 *   CONFIRMED  deducts — this is the moment goods are committed
 *   COMPLETED  nothing; the stock already left on CONFIRMED
 *   CANCELLED  restores, but only what was actually deducted
 */

export const ORDER_STATUSES = [
  "DRAFT",
  "PENDING",
  "CONFIRMED",
  "COMPLETED",
  "CANCELLED",
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

export function isOrderStatus(value: unknown): value is OrderStatus {
  return (
    typeof value === "string" && ORDER_STATUSES.includes(value as OrderStatus)
  );
}

/**
 * Legal transitions, as an explicit map.
 *
 * A table rather than a chain of `if`s, because the interesting part of a state
 * machine is what it *refuses*, and a table makes the refusals visible. Reading
 * down it: a cancelled order is final, a completed order is final, and nothing
 * returns to DRAFT once it has left.
 *
 * Two absences are deliberate rather than oversights:
 *
 *   CANCELLED → anything. Reviving a cancelled order would mean deducting
 *   stock that was already restored, against a document someone has been told
 *   is dead. A new order is the right way to sell the goods again.
 *
 *   COMPLETED → CANCELLED. The goods have shipped. Putting the units back
 *   because a status changed would invent inventory that is physically
 *   somewhere else; a return is a real workflow with a receipt and an
 *   inspection, and this module does not implement one. It is refused with a
 *   message that says so rather than silently allowed.
 */
const TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  DRAFT: ["PENDING", "CONFIRMED", "CANCELLED"],
  PENDING: ["DRAFT", "CONFIRMED", "CANCELLED"],
  CONFIRMED: ["COMPLETED", "CANCELLED"],
  COMPLETED: [],
  CANCELLED: [],
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function allowedTransitions(from: OrderStatus): readonly OrderStatus[] {
  return TRANSITIONS[from];
}

/**
 * Why a particular transition is refused, in words a user can act on.
 *
 * A generic "invalid transition" tells someone their click did nothing without
 * telling them what would work, and the three cases below are the ones people
 * actually hit.
 */
export function transitionRefusal(
  from: OrderStatus,
  to: OrderStatus,
): string | null {
  if (canTransition(from, to)) return null;

  if (from === to) {
    return `This order is already ${orderStatusLabel(to).toLowerCase()}.`;
  }

  if (from === "CANCELLED") {
    return "This order was cancelled and cannot be reopened. Raise a new order instead — its stock has already been returned.";
  }

  if (from === "COMPLETED" && to === "CANCELLED") {
    return "This order is already completed, so its goods have shipped. Cancelling it would put units back into stock that are no longer on the shelf — record a return instead, once that workflow exists.";
  }

  if (from === "COMPLETED") {
    return "This order is completed and is not going to change again.";
  }

  return `An order cannot go from ${orderStatusLabel(from).toLowerCase()} to ${orderStatusLabel(to).toLowerCase()}.`;
}

/** Whether an order in this status is holding stock it has taken out. */
export function holdsDeductedStock(status: OrderStatus): boolean {
  return status === "CONFIRMED" || status === "COMPLETED";
}

/** Whether an order in this status can still have its lines edited. */
export function isEditable(status: OrderStatus): boolean {
  return status === "DRAFT" || status === "PENDING";
}

const LABELS: Record<OrderStatus, string> = {
  DRAFT: "Draft",
  PENDING: "Pending",
  CONFIRMED: "Confirmed",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
};

export function orderStatusLabel(status: OrderStatus): string {
  return LABELS[status];
}

/*
 * How a status *looks* is not decided here. src/components/ui/order-status-badge.tsx
 * owns that, because colour alone does not distinguish five states for everyone
 * — it pairs each status with an icon as well, and a tone map here could only
 * ever be half of that answer kept in a second place.
 */
