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
      message: `Order ${orderNumber} confirmed. ${describeMovements(outcome.movements)}`,
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
      message: `Order ${outcome.orderNumber} confirmed. ${describeMovements(outcome.movements)}`,
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
  verb: "deducted" | "restored" = "deducted",
): string {
  if (movements.length === 0) return "";

  if (movements.length === 1) {
    const only = movements[0]!;
    return `${only.quantity} units of ${only.productName} ${verb} (${only.previousStock} → ${only.newStock}).`;
  }

  const units = movements.reduce((sum, move) => sum + move.quantity, 0);
  return `${units} units across ${movements.length} products ${verb}.`;
}
