"use server";

import { revalidatePath } from "next/cache";

import { toSafeError } from "@/lib/errors";
import type { AdjustmentFieldErrors } from "@/lib/validation/adjustment";
import type { ProductFieldErrors } from "@/lib/validation/product";
import {
  adjustStock,
  createProduct,
  deleteProduct,
  updateProduct,
} from "@/server/products";

/**
 * The products module's server actions.
 *
 * These are the endpoints the browser can reach, and they are deliberately
 * thin: parse nothing, decide nothing, authorise nothing. Every one of those
 * happens in src/server/products.ts, which they call — so the rules hold no
 * matter how the operation is invoked, and the tests can exercise them without
 * a request to fake.
 *
 * What lives here is the part that only makes sense inside Next: turning a
 * `FormData` into an object, invalidating the cached pages a write affects, and
 * converting a thrown error into something a form can render.
 *
 * A note on trust. An action is a public HTTP endpoint with a generated name.
 * Anything in the `FormData` is whatever the client chose to send, including
 * fields the form does not have — which is why nothing here forwards the raw
 * object anywhere except a schema that names the fields it accepts, and why
 * `createdBy` is never among them. Attribution comes from the Clerk session,
 * server-side, in `recordStockMovement`.
 */

export type ProductActionResult =
  | { ok: true; message: string; productId?: string }
  | { ok: false; message: string; fieldErrors?: ProductFieldErrors };

export type AdjustmentActionResult =
  | { ok: true; message: string; newStock: number }
  | { ok: false; message: string; fieldErrors?: AdjustmentFieldErrors };

/**
 * Turns a thrown error into a form-shaped failure.
 *
 * `AppError.details.field` is how the write layer says which input a message
 * belongs under — a duplicate SKU should appear beneath the SKU box, not only
 * in a toast. Anything else has already been through `toSafeError`, so the
 * message is one we wrote rather than a leaked database error.
 */
function toFailure<T extends string>(
  error: unknown,
  context: string,
): { ok: false; message: string; fieldErrors?: Partial<Record<T, string>> } {
  const safe = toSafeError(error, context);
  const field = safe.details?.["field"];

  return {
    ok: false,
    message: safe.message,
    fieldErrors:
      typeof field === "string"
        ? ({ [field]: safe.message } as Partial<Record<T, string>>)
        : undefined,
  };
}

/** Pages whose content a product write can change. */
function revalidateProduct(id?: string): void {
  revalidatePath("/products");
  revalidatePath("/dashboard");
  if (id) revalidatePath(`/products/${id}`);
}

export async function createProductAction(
  formData: FormData,
): Promise<ProductActionResult> {
  try {
    const product = await createProduct(Object.fromEntries(formData));
    revalidateProduct(product.id);

    return {
      ok: true,
      productId: product.id,
      message: `"${product.name}" added to the catalogue.`,
    };
  } catch (error) {
    return toFailure<keyof ProductFieldErrors>(error, "createProductAction");
  }
}

export async function updateProductAction(
  id: string,
  formData: FormData,
): Promise<ProductActionResult> {
  try {
    const product = await updateProduct(id, Object.fromEntries(formData));
    revalidateProduct(product.id);

    return {
      ok: true,
      productId: product.id,
      message: `"${product.name}" updated.`,
    };
  } catch (error) {
    return toFailure<keyof ProductFieldErrors>(error, "updateProductAction");
  }
}

export async function deleteProductAction(
  id: string,
): Promise<ProductActionResult> {
  try {
    const { name } = await deleteProduct(id);
    revalidateProduct(id);

    return { ok: true, message: `"${name}" deleted.` };
  } catch (error) {
    return toFailure<keyof ProductFieldErrors>(error, "deleteProductAction");
  }
}

export async function adjustStockAction(
  formData: FormData,
): Promise<AdjustmentActionResult> {
  try {
    const outcome = await adjustStock(Object.fromEntries(formData));
    revalidateProduct(outcome.productId);
    revalidatePath("/stock-movements");

    return {
      ok: true,
      newStock: outcome.newStock,
      message: `${outcome.productName}: ${outcome.previousStock} → ${outcome.newStock} units.`,
    };
  } catch (error) {
    return toFailure<keyof AdjustmentFieldErrors>(error, "adjustStockAction");
  }
}
