import { z } from "zod";

/**
 * Validation for a manual stock adjustment.
 *
 * An adjustment is the only way stock changes without a document behind it —
 * no order shipped, no purchase arrived, just someone saying the shelf holds a
 * different number than the system believes. That makes it the movement most
 * worth constraining, and the one where the audit trail has to be complete.
 *
 * The shape reflects how the operation is actually thought about: a positive
 * count and a direction, not a signed number. "Decrease 20" is what someone
 * means; "-20" is what the ledger stores, and `adjustmentDelta` is the one
 * place the translation happens.
 *
 * As with every stock input, there is no `createdBy` here and there never will
 * be. Attribution is read from the Clerk session on the server — a field the
 * client can set is a field the client can lie about. See `recordStockMovement`
 * in src/server/stock.ts.
 */

export const ADJUSTMENT_DIRECTIONS = ["INCREASE", "DECREASE"] as const;

export type AdjustmentDirection = (typeof ADJUSTMENT_DIRECTIONS)[number];

/**
 * The quantity arrives from FormData as a string. Same reasoning as the product
 * schema: check the string before converting, because `Number("")` is 0 and
 * coercing first would read a blank field as a valid zero.
 */
const adjustmentQuantity = z
  .string()
  .trim()
  .min(1, "Quantity is required")
  .refine((value) => Number.isFinite(Number(value)), "Quantity must be a number")
  .transform(Number)
  .refine(Number.isInteger, "Quantity must be a whole number")
  .refine((value) => value > 0, "Quantity must be at least 1")
  .refine((value) => value <= 2_147_483_647, "Quantity is too large");

export const stockAdjustmentSchema = z.object({
  productId: z.string().trim().min(1, "Product is required"),
  quantity: adjustmentQuantity,
  direction: z.enum(ADJUSTMENT_DIRECTIONS, {
    message: "Choose whether stock goes up or down",
  }),
  /**
   * Required, and required to say something. This is the whole justification
   * for a movement that has no document to point at: an adjustment with a blank
   * reason is a hole in the audit trail that nobody can fill in later.
   */
  reason: z
    .string()
    .trim()
    .min(3, "Give a reason — it is the only record of why stock changed")
    .max(500, "Reason must be 500 characters or fewer"),
});

export type StockAdjustmentInput = z.infer<typeof stockAdjustmentSchema>;

export type AdjustmentFieldErrors = Partial<
  Record<keyof StockAdjustmentInput, string>
>;

/** The signed change an adjustment makes to stock on hand. */
export function adjustmentDelta(input: {
  quantity: number;
  direction: AdjustmentDirection;
}): number {
  return input.direction === "INCREASE" ? input.quantity : -input.quantity;
}

export function toAdjustmentFieldErrors(
  error: z.ZodError,
): AdjustmentFieldErrors {
  const fieldErrors: AdjustmentFieldErrors = {};

  for (const issue of error.issues) {
    const field = issue.path[0] as keyof AdjustmentFieldErrors | undefined;
    if (field && !fieldErrors[field]) {
      fieldErrors[field] = issue.message;
    }
  }

  return fieldErrors;
}
