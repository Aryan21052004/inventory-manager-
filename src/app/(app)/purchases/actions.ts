"use server";

import { revalidatePath } from "next/cache";

import { toSafeError } from "@/lib/errors";
import type { PurchaseStatus } from "@/lib/purchase-status";
import type { PurchaseFieldErrors } from "@/lib/validation/purchase";
import { requireUser } from "@/server/auth";
import {
  cancelPurchase,
  createPurchase,
  receivePurchase,
  searchPurchaseProducts,
  setPurchaseStatus,
  updatePurchase,
  type PurchaseProductOption,
} from "@/server/purchases";

/**
 * The purchases module's server actions.
 *
 * Thin, like the orders ones: turn a payload into a call, revalidate the pages
 * a write affects, and convert a thrown error into something a form can render.
 * Every rule — who may act, whether a transition is legal, what the total is,
 * whether a product has been retired — lives in src/server/purchases.ts.
 *
 * Nothing here forwards a status, a total, or a `createdBy` from the client. An
 * action is a public endpoint with a generated name, so the payload is whatever
 * the browser chose to send; the only things read out of it are the fields the
 * schema names.
 */

export type PurchaseActionResult =
  | { ok: true; message: string; purchaseId: string }
  | { ok: false; message: string; fieldErrors?: PurchaseFieldErrors };

export type PurchaseTransitionResult =
  | { ok: true; message: string; status: PurchaseStatus }
  | { ok: false; message: string };

function toFailure(
  error: unknown,
  context: string,
): { ok: false; message: string; fieldErrors?: PurchaseFieldErrors } {
  const safe = toSafeError(error, context);
  const field = safe.details?.["field"];

  return {
    ok: false,
    message: safe.message,
    fieldErrors:
      typeof field === "string"
        ? ({ [field]: safe.message } as PurchaseFieldErrors)
        : undefined,
  };
}

/**
 * Pages a write can change.
 *
 * Receiving or cancelling moves stock, so it invalidates far more than the
 * purchase itself: product balances, the dashboard's figures, and the movements
 * ledger all shift.
 */
function revalidatePurchase(purchaseId?: string, movedStock = false): void {
  revalidatePath("/purchases");
  revalidatePath("/dashboard");
  if (purchaseId) revalidatePath(`/purchases/${purchaseId}`);

  if (movedStock) {
    revalidatePath("/products");
    revalidatePath("/stock-movements");
  }
}

export interface PurchaseSubmission {
  supplierId: string;
  items: { productId: string; quantity: number; unitCost: string }[];
  purchaseDate?: string;
}

/**
 * Creates a draft purchase, and optionally receives it in the same breath.
 *
 * The two steps stay separate transactions on purpose. If receiving fails —
 * a product retired between raising and delivery — the draft still exists, so
 * the work of entering the delivery note is not thrown away and the person
 * lands on the purchase with a message explaining what to fix.
 */
export async function createPurchaseAction(
  submission: PurchaseSubmission,
  receive = false,
): Promise<PurchaseActionResult> {
  let purchaseId: string;
  let purchaseNumber: string;

  try {
    const created = await createPurchase(submission);
    purchaseId = created.id;
    purchaseNumber = created.purchaseNumber;
  } catch (error) {
    return toFailure(error, "createPurchaseAction");
  }

  revalidatePurchase(purchaseId);

  if (!receive) {
    return {
      ok: true,
      purchaseId,
      message: `Purchase ${purchaseNumber} saved as a draft.`,
    };
  }

  try {
    const outcome = await receivePurchase(purchaseId);
    revalidatePurchase(purchaseId, true);

    return {
      ok: true,
      purchaseId,
      message: `Purchase ${purchaseNumber} received. ${describeMovements(outcome.movements)}`,
    };
  } catch (error) {
    const failure = toSafeError(error, "createPurchaseAction:receive");

    return {
      ok: false,
      message: `Purchase ${purchaseNumber} was saved as a draft, but could not be received: ${failure.message}`,
    };
  }
}

export async function updatePurchaseAction(
  purchaseId: string,
  submission: PurchaseSubmission,
): Promise<PurchaseActionResult> {
  try {
    const updated = await updatePurchase(purchaseId, submission);
    revalidatePurchase(purchaseId);

    return {
      ok: true,
      purchaseId,
      message: `Purchase ${updated.purchaseNumber} updated.`,
    };
  } catch (error) {
    return toFailure(error, "updatePurchaseAction");
  }
}

export async function receivePurchaseAction(
  purchaseId: string,
): Promise<PurchaseTransitionResult> {
  try {
    const outcome = await receivePurchase(purchaseId);
    revalidatePurchase(purchaseId, true);

    return {
      ok: true,
      status: outcome.status,
      message: `Purchase ${outcome.purchaseNumber} received. ${describeMovements(outcome.movements)}`,
    };
  } catch (error) {
    return {
      ok: false,
      message: toSafeError(error, "receivePurchaseAction").message,
    };
  }
}

export async function cancelPurchaseAction(
  purchaseId: string,
  reason?: string,
): Promise<PurchaseTransitionResult> {
  try {
    const outcome = await cancelPurchase(purchaseId, reason);
    revalidatePurchase(purchaseId, true);

    if (outcome.alreadyInState) {
      return {
        ok: true,
        status: outcome.status,
        message: `Purchase ${outcome.purchaseNumber} was already cancelled. Nothing changed.`,
      };
    }

    return {
      ok: true,
      status: outcome.status,
      message:
        outcome.movements.length > 0
          ? `Purchase ${outcome.purchaseNumber} cancelled. ${describeMovements(outcome.movements, "removed")}`
          : `Purchase ${outcome.purchaseNumber} cancelled. It had not added any stock.`,
    };
  } catch (error) {
    return {
      ok: false,
      message: toSafeError(error, "cancelPurchaseAction").message,
    };
  }
}

export async function setPurchaseStatusAction(
  purchaseId: string,
  status: PurchaseStatus,
): Promise<PurchaseTransitionResult> {
  try {
    const outcome = await setPurchaseStatus(purchaseId, status);
    revalidatePurchase(purchaseId);

    return {
      ok: true,
      status: outcome.status,
      message: `Purchase ${outcome.purchaseNumber} moved to ${outcome.status.toLowerCase()}.`,
    };
  } catch (error) {
    return {
      ok: false,
      message: toSafeError(error, "setPurchaseStatusAction").message,
    };
  }
}

/**
 * Product search for the purchase builder. Only ACTIVE products come back.
 *
 * **The session is checked here, not inherited.** Same reasoning as
 * `searchOrderProductsAction`, and the exposure was slightly worse: alongside
 * each product this returns `lastPaidUnitCost`, so an unauthenticated caller
 * was able to read supplier pricing as well as the catalogue.
 *
 * The check sits in the action rather than in `searchPurchaseProducts` because
 * that function reports and returns `[]` from its own `catch`, which would turn
 * a refusal into an empty result set. Out here the standard UNAUTHORIZED error
 * survives. The server components that call it during a page render are
 * unaffected — they are already behind the `(app)` layout guard.
 *
 * Authentication only: STAFF raise purchases too.
 */
export async function searchPurchaseProductsAction(
  search: string,
): Promise<PurchaseProductOption[]> {
  await requireUser();
  return searchPurchaseProducts(search);
}

/** "100 units of Widget added (50 → 150)." */
function describeMovements(
  movements: {
    productName: string;
    quantity: number;
    previousStock: number;
    newStock: number;
  }[],
  verb: "added" | "removed" = "added",
): string {
  if (movements.length === 0) return "";

  if (movements.length === 1) {
    const only = movements[0]!;
    return `${only.quantity} units of ${only.productName} ${verb} (${only.previousStock} → ${only.newStock}).`;
  }

  const units = movements.reduce((sum, move) => sum + move.quantity, 0);
  return `${units} units across ${movements.length} products ${verb}.`;
}
