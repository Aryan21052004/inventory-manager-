import { z } from "zod";

/**
 * Validation for recording a sales return.
 *
 * A return says goods that were shipped have physically come back. That is a
 * different claim from a cancellation, which says the sale never happened, and
 * the shapes differ accordingly: a cancellation names a document, while a
 * return names *lines and quantities*, because only some of what shipped
 * usually comes back.
 *
 * What is deliberately absent, and will stay absent:
 *
 *   **No cost.** The returned units keep the cost they left at, read from the
 *   `StockLotConsumption` rows the original shipment wrote. A cost supplied
 *   here would be a number somebody typed about units they are handing back,
 *   which is exactly the invented figure the whole costing layer exists to
 *   prevent. There is no field for it, so there is nothing to invent.
 *
 *   **No lot selection.** Which source layers a partial return draws from is
 *   resolved from the original consumption order — see `resolveReturnLayers`.
 *   The operator override for units whose physical batch is known is a decided
 *   future addition, not a gap here.
 *
 *   **No status.** Every returned lot starts quarantined. Letting a form say
 *   otherwise would make "this stock is saleable" something a data-entry screen
 *   could assert, when it is a judgement somebody makes after inspecting it.
 *
 * As with every stock input there is no `createdBy`: attribution is read from
 * the session on the server, because a field the client can set is a field the
 * client can lie about.
 */

/**
 * How many units of one line are coming back.
 *
 * Arrives from FormData as a string, and is checked as a string before it is
 * converted — the same reasoning the adjustment and product schemas use.
 * `Number("")` is `0`, so coercing first would read a field the operator
 * cleared as a deliberate zero.
 */
const returnedQuantity = z
  .string()
  .trim()
  .min(1, "Enter how many units came back")
  .refine((value) => /^\d+$/.test(value), "Quantity must be a whole number")
  .transform(Number)
  .refine((value) => value > 0, "Quantity must be at least 1")
  .refine((value) => value <= 1_000_000, "Quantity is too large");

/**
 * One line of a return.
 *
 * Addressed by `orderItemId` rather than by product, for the same reason
 * fulfilment is: the line is the thing with a returnable quantity, and two
 * orders for the same part are two different obligations.
 */
export const returnLineSchema = z.object({
  orderItemId: z.string().trim().min(1, "Order line is required"),
  quantity: returnedQuantity,
});

export const salesReturnSchema = z
  .object({
    orderId: z.string().trim().min(1, "Order is required"),

    /**
     * Why the goods came back, in the customer's terms.
     *
     * Required, and required to say something. This is the only durable record
     * of why a shipped sale was partly undone; unlike a quantity it cannot be
     * reconstructed from anything else afterwards, and "returned" with no
     * reason is a hole in the audit trail nobody can fill in later.
     */
    reason: z
      .string()
      .trim()
      .min(3, "Give a reason — it is the only record of why the goods came back")
      .max(500, "Reason must be 500 characters or fewer"),

    lines: z
      .array(returnLineSchema)
      .min(1, "Choose at least one line to return"),
  })
  .superRefine((input, ctx) => {
    /*
     * One entry per line. Two entries for the same line would be a form that
     * disagrees with itself about how many units came back, and silently
     * summing them would let a caller slip past the per-line bound by splitting
     * a request in two.
     */
    const seen = new Set<string>();

    for (const [index, line] of input.lines.entries()) {
      if (seen.has(line.orderItemId)) {
        ctx.addIssue({
          code: "custom",
          path: ["lines", index, "orderItemId"],
          message: "This line is already in the return — combine the quantities.",
        });
      }

      seen.add(line.orderItemId);
    }
  });

export type SalesReturnInput = z.infer<typeof salesReturnSchema>;

export interface SalesReturnFieldErrors {
  orderId?: string;
  reason?: string;
  lines?: string;
  form?: string;
}

export function toSalesReturnFieldErrors(
  error: z.ZodError,
): SalesReturnFieldErrors {
  const errors: SalesReturnFieldErrors = {};

  for (const issue of error.issues) {
    const field = issue.path[0];
    const key =
      field === "orderId" || field === "reason" || field === "lines"
        ? field
        : "form";

    if (!errors[key]) errors[key] = issue.message;
  }

  return errors;
}

/**
 * How many units of a line may still be sent back.
 *
 * Exported because the server enforces it and the screen has to show it, and
 * two places computing the same subtraction is how they come to disagree about
 * what a button should do.
 */
export function returnableQuantity(line: {
  fulfilledQuantity: number;
  returnedQuantity: number;
}): number {
  return Math.max(0, line.fulfilledQuantity - line.returnedQuantity);
}
