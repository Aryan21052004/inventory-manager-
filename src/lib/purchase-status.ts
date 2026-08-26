/**
 * The purchase lifecycle: which states exist, which moves between them are
 * legal, and which of them touch inventory.
 *
 * The mirror image of src/lib/order-status.ts, and deliberately a separate file
 * rather than a shared generic one. The two machines look alike today — four
 * states, one of which moves stock — but they describe different businesses:
 * an order commits goods you have, a purchase brings in goods you do not. They
 * will diverge (partial receipts, back-orders, supplier returns), and a shared
 * abstraction would have to be unpicked at exactly that point.
 *
 * Which statuses move stock, stated once:
 *
 *   DRAFT      nothing
 *   PENDING    nothing — placed with the supplier, not yet arrived
 *   RECEIVED   adds — this is the moment goods are physically in
 *   CANCELLED  removes what was added, once, and only if it was received
 */

export const PURCHASE_STATUSES = [
  "DRAFT",
  "PENDING",
  "RECEIVED",
  "CANCELLED",
] as const;

export type PurchaseStatus = (typeof PURCHASE_STATUSES)[number];

export function isPurchaseStatus(value: unknown): value is PurchaseStatus {
  return (
    typeof value === "string" &&
    PURCHASE_STATUSES.includes(value as PurchaseStatus)
  );
}

/**
 * Legal transitions, as an explicit table — because the interesting part of a
 * state machine is what it refuses.
 *
 * Two absences are deliberate:
 *
 *   CANCELLED → anything. A cancelled purchase has already given back whatever
 *   it added. Reviving it would add the goods a second time against a document
 *   someone has been told is dead; raise a new purchase instead.
 *
 *   RECEIVED → PENDING or DRAFT. The goods are on the shelf. Winding the status
 *   back without moving stock would leave the document and the inventory
 *   disagreeing; cancelling is the operation that undoes a receipt, and it does
 *   the stock work too.
 */
const TRANSITIONS: Record<PurchaseStatus, readonly PurchaseStatus[]> = {
  DRAFT: ["PENDING", "RECEIVED", "CANCELLED"],
  PENDING: ["DRAFT", "RECEIVED", "CANCELLED"],
  RECEIVED: ["CANCELLED"],
  CANCELLED: [],
};

export function canTransition(
  from: PurchaseStatus,
  to: PurchaseStatus,
): boolean {
  return TRANSITIONS[from].includes(to);
}

export function allowedTransitions(
  from: PurchaseStatus,
): readonly PurchaseStatus[] {
  return TRANSITIONS[from];
}

/** Why a transition is refused, in words someone can act on. */
export function transitionRefusal(
  from: PurchaseStatus,
  to: PurchaseStatus,
): string | null {
  if (canTransition(from, to)) return null;

  if (from === to) {
    return `This purchase is already ${purchaseStatusLabel(to).toLowerCase()}.`;
  }

  if (from === "CANCELLED") {
    return "This purchase was cancelled and cannot be reopened. Its stock has already been taken back — raise a new purchase instead.";
  }

  if (from === "RECEIVED") {
    return "This purchase has already been received, so its goods are on the shelf. Cancel it if the delivery has to be undone — that takes the stock back too.";
  }

  return `A purchase cannot go from ${purchaseStatusLabel(from).toLowerCase()} to ${purchaseStatusLabel(to).toLowerCase()}.`;
}

/** Whether a purchase in this status has put stock on the shelf. */
export function holdsAddedStock(status: PurchaseStatus): boolean {
  return status === "RECEIVED";
}

/** Whether a purchase in this status can still have its lines edited. */
export function isEditable(status: PurchaseStatus): boolean {
  return status === "DRAFT" || status === "PENDING";
}

const LABELS: Record<PurchaseStatus, string> = {
  DRAFT: "Draft",
  PENDING: "Pending",
  RECEIVED: "Received",
  CANCELLED: "Cancelled",
};

export function purchaseStatusLabel(status: PurchaseStatus): string {
  return LABELS[status];
}

export type PurchaseStatusTone =
  | "muted"
  | "secondary"
  | "success"
  | "destructive";

const TONES: Record<PurchaseStatus, PurchaseStatusTone> = {
  DRAFT: "muted",
  PENDING: "secondary",
  RECEIVED: "success",
  CANCELLED: "destructive",
};

export function purchaseStatusTone(status: PurchaseStatus): PurchaseStatusTone {
  return TONES[status];
}
