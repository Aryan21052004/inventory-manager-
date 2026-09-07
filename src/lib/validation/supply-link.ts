import { z } from "zod";

/**
 * Validation for recording which delivery is expected to cover which order line.
 *
 * A supply link is an expectation and nothing more. It says "we think these
 * units of this purchase line will clear these outstanding units of that order
 * line", and it says it before anything has physically happened — which is
 * exactly why it exists, since outstanding units have no stock movement, no lot
 * and no consumption row to hang a reference on.
 *
 * What these schemas deliberately do not carry:
 *
 *   **No product.** Both lines already name one, and the two must match. A
 *   product field here would be a third opinion about a fact the database
 *   already holds twice, and the one place it could disagree.
 *
 *   **No cost.** A link buys nothing and sells nothing. The purchase line
 *   carries what the supplier charges and the order line carries what the
 *   customer was quoted; a figure typed here would belong to neither.
 *
 *   **No date.** When a delivery is expected is a fact about the purchase, not
 *   about who is waiting for it.
 *
 *   **No status.** A link that no longer applies is deleted. Giving it a
 *   lifecycle would make an expectation into a document, and this is not one.
 *
 * The two bounds that actually matter — that a link may not exceed the order
 * line's outstanding quantity, nor the purchase line's unallocated quantity —
 * cannot live here. Both are facts about database rows read under a lock, and
 * both are checked on the server at the moment of the write, where they are
 * still true. See `src/server/supply-links.ts`.
 *
 * As everywhere else, there is no actor field: attribution comes from the
 * session on the server, never from the request.
 */

/**
 * How many units of the delivery are earmarked for the order line.
 *
 * Arrives from FormData as a string and is checked as one before conversion —
 * the same reasoning the return, adjustment and lot-action schemas use.
 * `Number("")` is `0`, so coercing first would read a field the operator
 * cleared as a deliberate zero rather than as an empty box.
 */
const linkQuantity = z
  .string()
  .trim()
  .min(1, "Enter how many units this delivery is expected to cover")
  .refine((value) => /^\d+$/.test(value), "Quantity must be a whole number")
  .transform(Number)
  .refine((value) => value > 0, "Quantity must be at least 1")
  .refine((value) => value <= 1_000_000, "Quantity is too large");

const orderItemId = z.string().trim().min(1, "An order line is required");
const purchaseItemId = z.string().trim().min(1, "A purchase line is required");

/** Recording a new expectation between one order line and one purchase line. */
export const supplyLinkSchema = z.object({
  orderItemId,
  purchaseItemId,
  quantity: linkQuantity,
});

export type SupplyLinkInput = z.infer<typeof supplyLinkSchema>;

/**
 * Changing how much of a delivery is expected to cover a line.
 *
 * Addressed by the link's own id rather than by the pair it joins. The pair is
 * unique, so either would resolve — but an id is what the screen already holds,
 * and re-deriving the row from two foreign keys is a second way to address one
 * thing.
 */
export const supplyLinkUpdateSchema = z.object({
  supplyLinkId: z.string().trim().min(1, "A supply link is required"),
  quantity: linkQuantity,
});

export type SupplyLinkUpdateInput = z.infer<typeof supplyLinkUpdateSchema>;

export interface SupplyLinkFieldErrors {
  orderItemId?: string;
  purchaseItemId?: string;
  supplyLinkId?: string;
  quantity?: string;
  form?: string;
}

export function toSupplyLinkFieldErrors(
  error: z.ZodError,
): SupplyLinkFieldErrors {
  const errors: SupplyLinkFieldErrors = {};

  for (const issue of error.issues) {
    const field = issue.path[0];
    const key =
      field === "orderItemId" ||
      field === "purchaseItemId" ||
      field === "supplyLinkId" ||
      field === "quantity"
        ? field
        : "form";

    if (!errors[key]) errors[key] = issue.message;
  }

  return errors;
}
