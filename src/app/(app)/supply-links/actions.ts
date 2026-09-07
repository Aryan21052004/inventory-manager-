"use server";

import { revalidatePath } from "next/cache";

import { toSafeError } from "@/lib/errors";
import {
  createSupplyLink,
  removeSupplyLink,
  updateSupplyLinkQuantity,
} from "@/server/supply-links";

/**
 * The supply-link actions, as thin wrappers.
 *
 * Same shape as the orders, purchases and lots actions: turn a payload into a
 * call, revalidate the pages the write affects, and convert a thrown error into
 * something a form can render. The rules — same product, positive quantity,
 * enough outstanding, enough unallocated, an eligible purchase — all live in
 * src/server/supply-links.ts, so they hold however the operation is invoked.
 *
 * Both documents are revalidated on every write, because a link is a fact about
 * both: promising three units of a delivery to one order changes what the order
 * page shows *and* what is left for the purchase page to offer anybody else.
 *
 * Nothing here touches stock, so `/stock-movements`, `/products` and
 * `/dashboard` are deliberately not revalidated. A link moves nothing.
 */

export type SupplyLinkActionResult =
  | { ok: true; message: string }
  | { ok: false; message: string };

function revalidateBoth(orderId: string, purchaseId: string): void {
  revalidatePath(`/orders/${orderId}`);
  revalidatePath(`/purchases/${purchaseId}`);
}

export async function createSupplyLinkAction(
  orderItemId: string,
  purchaseItemId: string,
  quantity: number,
): Promise<SupplyLinkActionResult> {
  try {
    const outcome = await createSupplyLink({
      orderItemId,
      purchaseItemId,
      quantity: String(quantity),
    });

    revalidateBoth(outcome.orderId, outcome.purchaseId);

    return {
      ok: true,
      message: `${outcome.quantity} ${outcome.quantity === 1 ? "unit" : "units"} of ${outcome.productName} expected from that delivery. Nothing has shipped — fulfil the order when the goods are ready to go out.`,
    };
  } catch (error) {
    return {
      ok: false,
      message: toSafeError(error, "createSupplyLinkAction").message,
    };
  }
}

export async function updateSupplyLinkAction(
  supplyLinkId: string,
  quantity: number,
): Promise<SupplyLinkActionResult> {
  try {
    const outcome = await updateSupplyLinkQuantity({
      supplyLinkId,
      quantity: String(quantity),
    });

    revalidateBoth(outcome.orderId, outcome.purchaseId);

    return {
      ok: true,
      message: `Now expecting ${outcome.quantity} ${outcome.quantity === 1 ? "unit" : "units"} of ${outcome.productName} from that delivery.`,
    };
  } catch (error) {
    return {
      ok: false,
      message: toSafeError(error, "updateSupplyLinkAction").message,
    };
  }
}

export async function removeSupplyLinkAction(
  supplyLinkId: string,
): Promise<SupplyLinkActionResult> {
  try {
    const outcome = await removeSupplyLink(supplyLinkId);
    revalidateBoth(outcome.orderId, outcome.purchaseId);

    return {
      ok: true,
      message: `That delivery is no longer expected to cover the ${outcome.productName} line.`,
    };
  } catch (error) {
    return {
      ok: false,
      message: toSafeError(error, "removeSupplyLinkAction").message,
    };
  }
}
