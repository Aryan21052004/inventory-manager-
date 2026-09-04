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
 * Whether the operator can say what the incoming units cost.
 *
 * An adjustment that adds stock creates a batch, and a batch has an
 * acquisition cost or honestly does not. This used to be neither asked nor
 * recorded: every increase produced an UNKNOWN lot, so a cost the operator
 * knew perfectly well was discarded by the shape of the form, and
 * `LotCostSource.ADJUSTMENT` was a value nothing could produce.
 *
 * There is no default, and that is the whole mechanism. UNKNOWN remains fully
 * available — units found in a corner with no paperwork genuinely have no
 * acquisition cost, and demanding a number there would guarantee an invented
 * one, which is the single thing this costing model exists to prevent. What
 * changes is that unknown becomes something the operator *said* rather than
 * something the form *assumed*.
 */
export const ADJUSTMENT_COST_BASES = ["KNOWN", "UNKNOWN"] as const;

export type AdjustmentCostBasis = (typeof ADJUSTMENT_COST_BASES)[number];

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

/**
 * A price that may be absent, checked as a string before it is converted.
 *
 * The same reasoning as the product schema's version, kept local rather than
 * shared because the two modules own their own field vocabulary: `Number("")`
 * is 0, so coercing first would read a cleared field as "these units were
 * free" — a cost, and a wrong one — instead of as an empty field.
 */
const optionalUnitCost = z
  .string()
  .trim()
  // A field the form did not render at all is as absent as one left blank.
  .optional()
  .transform((value) => (value === undefined || value === "" ? null : value))
  .refine(
    (value) => value === null || Number.isFinite(Number(value)),
    "Unit cost must be a number",
  )
  .transform((value) => (value === null ? null : Number(value)))
  .refine((value) => value === null || value >= 0, "Unit cost cannot be negative")
  .refine(
    (value) => value === null || value <= 9_999_999_999.99,
    "Unit cost is too large",
  );

/** The longest an unknown-cost explanation may be, on its own. */
const UNKNOWN_COST_REASON_MAX = 200;

/**
 * The most the composed ledger note may run to.
 *
 * `stockMovementSchema` caps a note at 500 characters, and an increase that
 * declares its cost unknown writes both explanations into that one field. The
 * pair is therefore bounded here, where the message can name the two fields,
 * rather than downstream where it would surface as a movement-level error the
 * operator cannot act on.
 */
const NOTE_MAX = 500;

export const stockAdjustmentSchema = z
  .object({
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
    /**
     * Only meaningful when stock is going up, which is why all three costing
     * fields are optional here and required conditionally below. A decrease
     * draws from the lots already on the shelf and is costed from them; there
     * is nothing for a caller to supply and anything sent is ignored.
     */
    costBasis: z.enum(ADJUSTMENT_COST_BASES).optional(),
    unitCost: optionalUnitCost,
    unknownCostReason: z
      .string()
      .trim()
      .optional()
      .transform((value) => (value === undefined || value === "" ? null : value)),
  })
  .superRefine((input, ctx) => {
    if (input.direction !== "INCREASE") return;

    if (!input.costBasis) {
      ctx.addIssue({
        code: "custom",
        path: ["costBasis"],
        message:
          "Say whether the acquisition cost of these units is known. Leaving it unanswered is what used to record a cost as unknown by accident.",
      });
      return;
    }

    if (input.costBasis === "KNOWN") {
      if (input.unitCost === null) {
        ctx.addIssue({
          code: "custom",
          path: ["unitCost"],
          message:
            "Enter what one unit cost, or say the cost is unknown — never a placeholder.",
        });
      }
      return;
    }

    /*
     * Unknown, and it has to be justified.
     *
     * This is the asymmetry the whole option rests on. A known cost is
     * evidenced by the number itself; an unknown one leaves a permanent hole
     * in the valuation of every sale that later draws on this batch, and the
     * only thing that will ever explain that hole is what the operator writes
     * here. Requiring it is not busywork — it is the difference between "we
     * do not know" and "nobody asked".
     */
    const explanation = input.unknownCostReason ?? "";

    if (explanation.length < 3) {
      ctx.addIssue({
        code: "custom",
        path: ["unknownCostReason"],
        message:
          "Say why the cost is unknown — these units will report as uncosted for as long as they last.",
      });
      return;
    }

    if (explanation.length > UNKNOWN_COST_REASON_MAX) {
      ctx.addIssue({
        code: "custom",
        path: ["unknownCostReason"],
        message: `That explanation must be ${UNKNOWN_COST_REASON_MAX} characters or fewer.`,
      });
      return;
    }

    if (composeAdjustmentNote(input.reason, explanation).length > NOTE_MAX) {
      ctx.addIssue({
        code: "custom",
        path: ["unknownCostReason"],
        message: `The reason and this explanation are written to the ledger together, and must come to ${NOTE_MAX} characters or fewer between them.`,
      });
    }
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

/**
 * The two explanations, as the one string the ledger stores.
 *
 * Declared before the schema uses it and exported for the server, so the
 * length the schema validates and the length the ledger receives are the same
 * string built by the same function.
 */
function composeAdjustmentNote(reason: string, unknownCostReason: string | null): string {
  return unknownCostReason === null
    ? reason
    : `${reason} (Acquisition cost unknown: ${unknownCostReason})`;
}

/**
 * What the ledger records as the reason for this movement.
 *
 * An increase whose cost is unknown carries both halves: why the stock changed
 * and why nobody can price it. They are different facts with different
 * consequences — one explains a quantity, the other explains every uncosted
 * sale that batch will produce — and the note is the only durable place the
 * second can live.
 */
export function adjustmentNote(input: {
  reason: string;
  direction: AdjustmentDirection;
  costBasis?: AdjustmentCostBasis | undefined;
  unknownCostReason?: string | null | undefined;
}): string {
  const declaresUnknown =
    input.direction === "INCREASE" && input.costBasis === "UNKNOWN";

  return composeAdjustmentNote(
    input.reason,
    declaresUnknown ? (input.unknownCostReason ?? null) : null,
  );
}

/**
 * What the incoming units cost, in cents, or null when nobody knows.
 *
 * Null for a decrease as well as for a declared unknown, and the two nulls
 * mean different things that happen to travel the same way: a decrease draws
 * from lots that already carry their own cost, so it has nothing to supply.
 * `recordStockMovement` ignores the value on outbound movements for exactly
 * that reason.
 *
 * There is no branch here that reaches for a catalogue figure, and there must
 * never be one. A guessed acquisition cost is indistinguishable from a real
 * one the moment it is written.
 */
export function adjustmentUnitCostCents(input: {
  direction: AdjustmentDirection;
  costBasis?: AdjustmentCostBasis | undefined;
  unitCost?: number | null | undefined;
}): number | null {
  if (input.direction !== "INCREASE") return null;
  if (input.costBasis !== "KNOWN") return null;
  if (input.unitCost === null || input.unitCost === undefined) return null;

  return Math.round(input.unitCost * 100);
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
