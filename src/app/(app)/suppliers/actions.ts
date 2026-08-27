"use server";

import { revalidatePath } from "next/cache";

import { toSafeError } from "@/lib/errors";
import type { SupplierFieldErrors } from "@/lib/validation/supplier";
import {
  createSupplier,
  deleteSupplier,
  setSupplierStatus,
  updateSupplier,
} from "@/server/suppliers";

/**
 * The suppliers module's server actions.
 *
 * Thin, like the ones next door: parse nothing, decide nothing, authorise
 * nothing. All of that happens in src/server/suppliers.ts, which these call, so
 * the rules hold no matter how the operation is invoked and the tests can
 * exercise them without a request to fake.
 *
 * What lives here is the part that only makes sense inside Next: turning a
 * `FormData` into an object, invalidating the cached pages a write affects, and
 * converting a thrown error into something a form can render.
 *
 * An action is a public HTTP endpoint with a generated name, and the `FormData`
 * is whatever the client chose to send — including fields the form does not
 * have. Nothing here forwards the raw object anywhere except a schema that
 * names the fields it accepts, and `status` is not one of them: archiving is
 * `setSupplierStatusAction`, which re-checks for ADMIN on the server.
 */

export type SupplierActionResult =
  | { ok: true; message: string; supplierId?: string }
  | { ok: false; message: string; fieldErrors?: SupplierFieldErrors };

/**
 * Turns a thrown error into a form-shaped failure.
 *
 * `AppError.details.field` is how the write layer says which input a message
 * belongs under — a duplicate email should appear beneath the email box, not
 * only in a toast. Anything else has been through `toSafeError`, so the message
 * is one we wrote rather than a leaked database error.
 */
function toFailure(error: unknown, context: string): SupplierActionResult {
  const safe = toSafeError(error, context);
  const field = safe.details?.["field"];

  return {
    ok: false,
    message: safe.message,
    fieldErrors:
      typeof field === "string"
        ? ({ [field]: safe.message } as SupplierFieldErrors)
        : undefined,
  };
}

/**
 * Pages whose content a supplier write can change.
 *
 * Wider than the customers equivalent, because a supplier is referenced from
 * both sides of the application. The purchase pages carry the supplier picker
 * and display supplier names on every document; the product pages carry the
 * same picker on the catalogue form and show who each item is sourced from.
 * Archiving somebody has to reach all of them, or a picker keeps offering a
 * supplier who left circulation a moment ago.
 */
function revalidateSupplier(id?: string): void {
  revalidatePath("/suppliers");
  revalidatePath("/purchases");
  revalidatePath("/purchases/new");
  revalidatePath("/products");
  if (id) revalidatePath(`/suppliers/${id}`);
}

export async function createSupplierAction(
  formData: FormData,
): Promise<SupplierActionResult> {
  try {
    const supplier = await createSupplier(Object.fromEntries(formData));
    revalidateSupplier(supplier.id);

    return {
      ok: true,
      supplierId: supplier.id,
      message: `"${supplier.name}" added.`,
    };
  } catch (error) {
    return toFailure(error, "createSupplierAction");
  }
}

export async function updateSupplierAction(
  id: string,
  formData: FormData,
): Promise<SupplierActionResult> {
  try {
    const supplier = await updateSupplier(id, Object.fromEntries(formData));
    revalidateSupplier(supplier.id);

    return {
      ok: true,
      supplierId: supplier.id,
      message: `"${supplier.name}" updated.`,
    };
  } catch (error) {
    return toFailure(error, "updateSupplierAction");
  }
}

/**
 * Archives a supplier, or brings them back. ADMIN only, checked on the server.
 *
 * The status is passed as an argument rather than read from a form because
 * there is no form — it is a menu item — but it is validated all the same:
 * `setSupplierStatus` parses it against a schema that knows the two values.
 */
export async function setSupplierStatusAction(
  id: string,
  status: string,
): Promise<SupplierActionResult> {
  try {
    const supplier = await setSupplierStatus(id, { status });
    revalidateSupplier(supplier.id);

    return {
      ok: true,
      supplierId: supplier.id,
      message:
        supplier.status === "INACTIVE"
          ? `"${supplier.name}" archived. Their purchases and the stock they delivered are untouched — they simply will not be offered for new purchases or new products.`
          : `"${supplier.name}" is active again.`,
    };
  } catch (error) {
    return toFailure(error, "setSupplierStatusAction");
  }
}

export async function deleteSupplierAction(
  id: string,
): Promise<SupplierActionResult> {
  try {
    const { name } = await deleteSupplier(id);
    revalidateSupplier(id);

    return { ok: true, message: `"${name}" deleted.` };
  } catch (error) {
    return toFailure(error, "deleteSupplierAction");
  }
}
