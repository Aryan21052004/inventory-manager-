import { z } from "zod";

/**
 * Validation for stock movements.
 *
 * Note what this schema does not contain: any way to say who made the movement.
 * `createdBy` is not an input and never will be — it is read from the session on
 * the server. A field the client can set is a field the client can lie about,
 * and an audit log that records whoever the browser claimed to be is not an
 * audit log. See `recordStockMovement` in src/server/stock.ts.
 */

/**
 * Movements caused by a document carry that document's id; MANUAL ones carry
 * nothing. This mirrors the `stock_transactions_reference_pairing` check
 * constraint, so a bad pairing is caught with a readable message here rather
 * than as a constraint violation from Postgres.
 *
 * Strict, unlike the rest of this schema. Zod's default is to drop unknown
 * keys, which for a reference means `{ type: "MANUAL", id: "ord_1" }` quietly
 * becomes an unlinked row — the caller believes they attached the movement to
 * something and the ledger disagrees. The two halves of a reference only mean
 * anything together, so a mismatched pair is an error worth raising.
 */
export const stockReferenceSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("ORDER"), id: z.string().min(1) }),
  z.strictObject({ type: z.literal("PURCHASE"), id: z.string().min(1) }),
  /**
   * Goods a customer sent back, pointing at the Return that received them —
   * never at the order, even though a return always concerns one.
   *
   * `cancelOrder` gathers a document's movements with
   * `referenceType = 'ORDER' AND referenceId = orderId` and nets them to decide
   * what to restore. A return carrying that reference would be swept into the
   * netting and the lots would be mis-restored, so keeping the two references
   * apart is what makes the documents disjoint by construction.
   */
  z.strictObject({ type: z.literal("SALES_RETURN"), id: z.string().min(1) }),
  z.strictObject({
    type: z.literal("STOCK_TRANSACTION"),
    id: z.string().min(1),
  }),
  z.strictObject({ type: z.literal("MANUAL") }),
]);

const quantity = z
  .number()
  .int("Quantity must be a whole number")
  .refine((value) => value !== 0, "Quantity cannot be zero");

export const stockMovementSchema = z
  .object({
    productId: z.string().min(1, "Product is required"),
    type: z.enum(["STOCK_IN", "STOCK_OUT", "ADJUSTMENT", "REVERSAL"]),
    /**
     * Signed for ADJUSTMENT and REVERSAL, which can go either way. For
     * STOCK_IN and STOCK_OUT the direction is already implied by the type, so
     * a sign here would be a second, contradictable source of truth.
     */
    quantity,
    reference: stockReferenceSchema,
    /**
     * Why the move happened. Optional in general — a STOCK_OUT that points at
     * an order is already explained by the order — but mandatory for the two
     * types that have no document behind them, which is checked below.
     */
    note: z.string().trim().max(500).optional(),
  })
  .superRefine((input, ctx) => {
    const directional = input.type === "STOCK_IN" || input.type === "STOCK_OUT";

    if (directional && input.quantity < 0) {
      ctx.addIssue({
        code: "custom",
        path: ["quantity"],
        message: `${input.type} quantity must be positive — the type already says which way the stock moves.`,
      });
    }

    /*
     * ADJUSTMENT and REVERSAL overwrite what the system believes without a
     * document to justify it. A reason is the only thing that will ever explain
     * such a row to whoever reads the ledger afterwards, and it cannot be
     * reconstructed later — so it is required at the point the movement is
     * recorded, not requested afterwards.
     */
    if (!directional && !input.note?.trim()) {
      ctx.addIssue({
        code: "custom",
        path: ["note"],
        message: `A ${input.type} needs a reason — it is the only record of why stock changed.`,
      });
    }
  });

export type StockMovementInput = z.infer<typeof stockMovementSchema>;

/** What a movement points at. Exported so the stock engine can take one. */
export type StockReference = z.infer<typeof stockReferenceSchema>;

/**
 * The signed change a movement makes to stock on hand.
 *
 * STOCK_IN and STOCK_OUT take their direction from the type; ADJUSTMENT and
 * REVERSAL carry it in the sign of the quantity.
 */
export function stockDelta(input: StockMovementInput): number {
  switch (input.type) {
    case "STOCK_IN":
      return Math.abs(input.quantity);
    case "STOCK_OUT":
      return -Math.abs(input.quantity);
    default:
      return input.quantity;
  }
}
