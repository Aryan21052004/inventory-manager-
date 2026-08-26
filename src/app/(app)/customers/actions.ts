"use server";

import { revalidatePath } from "next/cache";

import { toSafeError } from "@/lib/errors";
import type { CustomerFieldErrors } from "@/lib/validation/customer";
import {
  createCustomer,
  deleteCustomer,
  setCustomerStatus,
  updateCustomer,
} from "@/server/customers";

/**
 * The customers module's server actions.
 *
 * Thin, like the ones next door: parse nothing, decide nothing, authorise
 * nothing. All of that happens in src/server/customers.ts, which these call, so
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
 * `setCustomerStatusAction`, which re-checks for ADMIN on the server.
 */

export type CustomerActionResult =
  | { ok: true; message: string; customerId?: string }
  | { ok: false; message: string; fieldErrors?: CustomerFieldErrors };

/**
 * Turns a thrown error into a form-shaped failure.
 *
 * `AppError.details.field` is how the write layer says which input a message
 * belongs under — a duplicate email should appear beneath the email box, not
 * only in a toast. Anything else has been through `toSafeError`, so the message
 * is one we wrote rather than a leaked database error.
 */
function toFailure(error: unknown, context: string): CustomerActionResult {
  const safe = toSafeError(error, context);
  const field = safe.details?.["field"];

  return {
    ok: false,
    message: safe.message,
    fieldErrors:
      typeof field === "string"
        ? ({ [field]: safe.message } as CustomerFieldErrors)
        : undefined,
  };
}

/**
 * Pages whose content a customer write can change.
 *
 * The orders pages are in the list because they display customer names and
 * because the order builder's picker is a list of customers — renaming or
 * archiving one has to reach both, or the picker keeps offering somebody who
 * was archived a moment ago.
 */
function revalidateCustomer(id?: string): void {
  revalidatePath("/customers");
  revalidatePath("/orders");
  revalidatePath("/orders/new");
  if (id) revalidatePath(`/customers/${id}`);
}

export async function createCustomerAction(
  formData: FormData,
): Promise<CustomerActionResult> {
  try {
    const customer = await createCustomer(Object.fromEntries(formData));
    revalidateCustomer(customer.id);

    return {
      ok: true,
      customerId: customer.id,
      message: `"${customer.name}" added.`,
    };
  } catch (error) {
    return toFailure(error, "createCustomerAction");
  }
}

export async function updateCustomerAction(
  id: string,
  formData: FormData,
): Promise<CustomerActionResult> {
  try {
    const customer = await updateCustomer(id, Object.fromEntries(formData));
    revalidateCustomer(customer.id);

    return {
      ok: true,
      customerId: customer.id,
      message: `"${customer.name}" updated.`,
    };
  } catch (error) {
    return toFailure(error, "updateCustomerAction");
  }
}

/**
 * Archives a customer, or brings them back. ADMIN only, checked on the server.
 *
 * The status is passed as an argument rather than read from a form because
 * there is no form — it is a menu item — but it is validated all the same:
 * `setCustomerStatus` parses it against a schema that knows the two values.
 */
export async function setCustomerStatusAction(
  id: string,
  status: string,
): Promise<CustomerActionResult> {
  try {
    const customer = await setCustomerStatus(id, { status });
    revalidateCustomer(customer.id);

    return {
      ok: true,
      customerId: customer.id,
      message:
        customer.status === "INACTIVE"
          ? `"${customer.name}" archived. Their orders are untouched, and they will no longer appear when raising a new one.`
          : `"${customer.name}" is active again.`,
    };
  } catch (error) {
    return toFailure(error, "setCustomerStatusAction");
  }
}

export async function deleteCustomerAction(
  id: string,
): Promise<CustomerActionResult> {
  try {
    const { name } = await deleteCustomer(id);
    revalidateCustomer(id);

    return { ok: true, message: `"${name}" deleted.` };
  } catch (error) {
    return toFailure(error, "deleteCustomerAction");
  }
}
