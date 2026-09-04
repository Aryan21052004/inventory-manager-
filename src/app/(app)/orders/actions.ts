"use server";

import { revalidatePath } from "next/cache";

import { toSafeError } from "@/lib/errors";
import type { OrderStatus } from "@/lib/order-status";
import type { OrderFieldErrors } from "@/lib/validation/order";
import {
  cancelOrder,
  completeOrder,
  confirmOrder,
  createOrder,
  fulfilOrder,
  searchOrderProducts,
  setOrderStatus,
  updateOrder,
  type OrderProductOption,
} from "@/server/orders";

/**
 * The orders module's server actions.
 *
 * Thin, like the products ones: turn a payload into a call, revalidate the
 * pages a write affects, and convert a thrown error into something a form can
 * render. Every rule — who may act, whether a transition is legal, what the
 * totals are, whether there is enough stock — lives in src/server/orders.ts.
 *
 * Nothing here forwards a status, a total, or a `createdBy` from the client. An
 * action is a public endpoint with a generated name, so the payload is whatever
 * the browser chose to send; the only things read out of it are the fields the
 * schema names.
 */

export type OrderActionResult =
  | { ok: true; message: string; orderId: string }
  | { ok: false; message: string; fieldErrors?: OrderFieldErrors };

export type TransitionActionResult =
  | { ok: true; message: string; status: OrderStatus }
  | { ok: false; message: string };

function toFailure(error: unknown, context: string): {
  ok: false;
  message: string;
  fieldErrors?: OrderFieldErrors;
} {
  const safe = toSafeError(error, context);
  const field = safe.details?.["field"];

  return {
    ok: false,
    message: safe.message,
    fieldErrors:
      typeof field === "string"
        ? ({ [field]: safe.message } as OrderFieldErrors)
        : undefined,
  };
}

/**
 * Pages a write can change.
 *
 * Confirming or cancelling moves stock, so it invalidates far more than the
 * order itself: product balances, the dashboard's figures, and the movements
 * ledger all shift.
 */
function revalidateOrder(orderId?: string, movedStock = false): void {
  revalidatePath("/orders");
  revalidatePath("/dashboard");
  if (orderId) revalidatePath(`/orders/${orderId}`);

  if (movedStock) {
    revalidatePath("/products");
    revalidatePath("/stock-movements");
  }
}

export interface OrderSubmission {
  customerId: string;
  items: { productId: string; quantity: number }[];
  discount: string;
}

/**
 * Creates a draft order, and optionally confirms it in the same breath.
 *
 * The two steps stay separate transactions on purpose. If the confirmation
 * fails for want of stock, the draft still exists — the work of building the
 * order is not thrown away because the warehouse was short, and the user lands
 * on the order with a message explaining what to fix.
 */
export async function createOrderAction(
  submission: OrderSubmission,
  confirm = false,
): Promise<OrderActionResult> {
  let orderId: string;
  let orderNumber: string;

  try {
    const created = await createOrder(submission);
    orderId = created.id;
    orderNumber = created.orderNumber;
  } catch (error) {
    return toFailure(error, "createOrderAction");
  }

  revalidateOrder(orderId);

  if (!confirm) {
    return {
      ok: true,
      orderId,
      message: `Order ${orderNumber} saved as a draft.`,
    };
  }

  try {
    const outcome = await confirmOrder(orderId);
    revalidateOrder(orderId, true);

    return {
      ok: true,
      orderId,
      message:
        `Order ${orderNumber} confirmed. ${describeOutcome(outcome, "deducted")}`.trimEnd(),
    };
  } catch (error) {
    const failure = toSafeError(error, "createOrderAction:confirm");

    // The draft survived; say so, so nobody rebuilds an order that already
    // exists.
    return {
      ok: false,
      message: `Order ${orderNumber} was saved as a draft, but could not be confirmed: ${failure.message}`,
    };
  }
}

export async function updateOrderAction(
  orderId: string,
  submission: OrderSubmission,
): Promise<OrderActionResult> {
  try {
    const updated = await updateOrder(orderId, submission);
    revalidateOrder(orderId);

    return {
      ok: true,
      orderId,
      message: `Order ${updated.orderNumber} updated.`,
    };
  } catch (error) {
    return toFailure(error, "updateOrderAction");
  }
}

export async function confirmOrderAction(
  orderId: string,
): Promise<TransitionActionResult> {
  try {
    const outcome = await confirmOrder(orderId);
    revalidateOrder(orderId, true);

    return {
      ok: true,
      status: outcome.status,
      message:
        `Order ${outcome.orderNumber} confirmed. ${describeOutcome(outcome, "deducted")}`.trimEnd(),
    };
  } catch (error) {
    return { ok: false, message: toSafeError(error, "confirmOrderAction").message };
  }
}

export async function completeOrderAction(
  orderId: string,
): Promise<TransitionActionResult> {
  try {
    const outcome = await completeOrder(orderId);
    // No stock moved — it left on confirmation.
    revalidateOrder(orderId);

    return {
      ok: true,
      status: outcome.status,
      message: `Order ${outcome.orderNumber} completed.`,
    };
  } catch (error) {
    return { ok: false, message: toSafeError(error, "completeOrderAction").message };
  }
}

export async function cancelOrderAction(
  orderId: string,
  reason?: string,
): Promise<TransitionActionResult> {
  try {
    const outcome = await cancelOrder(orderId, reason);
    revalidateOrder(orderId, true);

    if (outcome.alreadyInState) {
      return {
        ok: true,
        status: outcome.status,
        message: `Order ${outcome.orderNumber} was already cancelled. Nothing changed.`,
      };
    }

    return {
      ok: true,
      status: outcome.status,
      message:
        outcome.movements.length > 0
          ? `Order ${outcome.orderNumber} cancelled. ${describeMovements(outcome.movements, "restored")}`
          : `Order ${outcome.orderNumber} cancelled. It had not deducted any stock.`,
    };
  } catch (error) {
    return { ok: false, message: toSafeError(error, "cancelOrderAction").message };
  }
}

/** One line's worth of "we are shipping this many today". */
export interface FulfilmentSubmission {
  orderItemId: string;
  quantity: number;
}

/**
 * Ships outstanding units against an order.
 *
 * Moves stock, so it revalidates the product and movement pages alongside the
 * order — the same set a confirmation invalidates, for the same reason.
 *
 * Note there is no "fulfil everything" variant here. The quantities come from
 * the operator's form, which the UI prefills with what is available; letting an
 * action decide for itself how much to ship would put an allocation policy in
 * a place nobody would think to look for one.
 */
export async function fulfilOrderAction(
  orderId: string,
  lines: FulfilmentSubmission[],
): Promise<TransitionActionResult> {
  try {
    const outcome = await fulfilOrder(orderId, { lines });
    revalidateOrder(orderId, true);

    return {
      ok: true,
      status: outcome.status,
      message:
        `Order ${outcome.orderNumber}: ${describeOutcome(outcome, "fulfilled")}`.trimEnd(),
    };
  } catch (error) {
    return { ok: false, message: toSafeError(error, "fulfilOrderAction").message };
  }
}

export async function setOrderStatusAction(
  orderId: string,
  status: OrderStatus,
): Promise<TransitionActionResult> {
  try {
    const outcome = await setOrderStatus(orderId, status);
    revalidateOrder(orderId);

    return {
      ok: true,
      status: outcome.status,
      message: `Order ${outcome.orderNumber} moved to ${outcome.status.toLowerCase()}.`,
    };
  } catch (error) {
    return {
      ok: false,
      message: toSafeError(error, "setOrderStatusAction").message,
    };
  }
}

/**
 * Product search for the order builder.
 *
 * A server action rather than a route handler: it is only ever called from one
 * component, it needs no caching, and it inherits the session automatically.
 * Returns only ACTIVE products — see `searchOrderProducts`.
 */
export async function searchOrderProductsAction(
  search: string,
): Promise<OrderProductOption[]> {
  return searchOrderProducts(search);
}

/** "150 units of Widget deducted (200 → 50)." */
function describeMovements(
  movements: { productName: string; quantity: number; previousStock: number; newStock: number }[],
  verb: "deducted" | "restored" | "fulfilled" = "deducted",
): string {
  if (movements.length === 0) return "";

  if (movements.length === 1) {
    const only = movements[0]!;
    return `${only.quantity} units of ${only.productName} ${verb} (${only.previousStock} → ${only.newStock}).`;
  }

  const units = movements.reduce((sum, move) => sum + move.quantity, 0);
  return `${units} units across ${movements.length} products ${verb}.`;
}

/**
 * What a confirmation or fulfilment actually did, as one sentence.
 *
 * Both halves are conditional, and that is the point. An order confirmed
 * against an empty shelf moves nothing at all, so `describeMovements` returns
 * an empty string and the old `${verb}. ${movements}` template left a stray
 * full stop and a trailing space. And an order that could not be filled has
 * something to say that a movement list cannot express — what is still owed —
 * which is the number the operator most needs to see at that moment.
 */
function describeOutcome(
  outcome: {
    movements: {
      productName: string;
      quantity: number;
      previousStock: number;
      newStock: number;
    }[];
    unfulfilledUnits?: number;
  },
  verb: "deducted" | "fulfilled",
): string {
  const parts: string[] = [];

  const moved = describeMovements(outcome.movements, verb);
  if (moved) parts.push(moved);

  const outstanding = outcome.unfulfilledUnits ?? 0;

  if (outstanding > 0) {
    parts.push(
      outcome.movements.length === 0
        ? `Nothing was in stock, so all ${outstanding} ${outstanding === 1 ? "unit remains" : "units remain"} outstanding.`
        : `${outstanding} ${outstanding === 1 ? "unit remains" : "units remain"} outstanding.`,
    );
  }

  return parts.join(" ");
}
