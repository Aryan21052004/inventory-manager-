"use server";

import { revalidatePath } from "next/cache";

import { toSafeError } from "@/lib/errors";
import { releaseLot, rejectLot, writeOffLot } from "@/server/lots";

/**
 * The inspection actions, as thin wrappers.
 *
 * Same shape as the orders and products actions: turn a payload into a call,
 * revalidate the pages the write affects, and convert a thrown error into
 * something a form can render. The rules — who may do this, which batches
 * qualify, what a legal transition is — all live in src/server/lots.ts, so they
 * hold however the operation is invoked and can be tested without a request.
 *
 * Authorisation is emphatically not here. These are `"use server"` entry points
 * a browser can call directly, so hiding a button proves nothing; every one of
 * the three functions below re-checks ADMIN on the server.
 */

export type LotActionResult =
  | { ok: true; message: string }
  | { ok: false; message: string };

/**
 * Pages a lot decision changes.
 *
 * The product page shows the batch and its status; the quarantine queue lists
 * what is still awaiting inspection. A write-off also moves stock, so it
 * invalidates the movement ledger and the dashboard as every stock write does.
 */
function revalidateLot(productId: string, movedStock = false): void {
  revalidatePath("/returns");
  revalidatePath("/products");
  revalidatePath(`/products/${productId}`);

  if (movedStock) {
    revalidatePath("/stock-movements");
    revalidatePath("/dashboard");
  }
}

export async function releaseLotAction(
  lotId: string,
  reason: string,
): Promise<LotActionResult> {
  try {
    const outcome = await releaseLot({ lotId, reason });
    revalidateLot(outcome.productId);

    return {
      ok: true,
      message: outcome.alreadyInState
        ? `That batch of ${outcome.productName} had already been released.`
        : `Batch released — these units of ${outcome.productName} are saleable again. Certificate cover is unchanged.`,
    };
  } catch (error) {
    return { ok: false, message: toSafeError(error, "releaseLotAction").message };
  }
}

export async function rejectLotAction(
  lotId: string,
  reason: string,
): Promise<LotActionResult> {
  try {
    const outcome = await rejectLot({ lotId, reason });
    revalidateLot(outcome.productId);

    return {
      ok: true,
      message: outcome.alreadyInState
        ? `That batch of ${outcome.productName} had already been rejected.`
        : `Batch rejected. The units stay on the shelf and keep their cost until they are written off.`,
    };
  } catch (error) {
    return { ok: false, message: toSafeError(error, "rejectLotAction").message };
  }
}

export async function writeOffLotAction(
  lotId: string,
  quantity: number,
  reason: string,
): Promise<LotActionResult> {
  try {
    const outcome = await writeOffLot({
      lotId,
      quantity: String(quantity),
      reason,
    });

    revalidateLot(outcome.productId, true);

    const value =
      outcome.writtenOffValue === null
        ? "no recorded cost"
        : `₹${outcome.writtenOffValue}`;

    return {
      ok: true,
      message:
        `Wrote off ${outcome.quantity} ${outcome.quantity === 1 ? "unit" : "units"} of ` +
        `${outcome.productName} at ${value}. ${outcome.quantityRemaining} left in that batch.`,
    };
  } catch (error) {
    return { ok: false, message: toSafeError(error, "writeOffLotAction").message };
  }
}
