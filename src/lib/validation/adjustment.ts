import { z } from "zod";

import {
  COST_BASES,
  optionalCost,
  refineCostBasis,
  unknownCostReason,
  withUnknownCostReason,
  costBasisUnitCostCents,
  type CostBasis,
} from "@/lib/validation/cost-basis";

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
 * The question, its two answers and the rule joining them are shared with the
 * opening-stock form — see validation/cost-basis.ts, which explains why. These
 * aliases are kept so this module still reads in its own vocabulary.
 */
export const ADJUSTMENT_COST_BASES = COST_BASES;

export type AdjustmentCostBasis = CostBasis;

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

const optionalUnitCost = optionalCost("Unit cost");

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
    unknownCostReason,
  })
  .superRefine((input, ctx) => {
    /*
     * Only an increase creates a batch, so only an increase has an acquisition
     * cost to state. A decrease draws from the lots already on the shelf and is
     * costed from them — there is nothing to supply and nothing to ask.
     */
    if (input.direction !== "INCREASE") return;

    refineCostBasis(
      ctx,
      {
        basis: input.costBasis,
        unitCost: input.unitCost,
        reason: input.unknownCostReason,
      },
      {
        paths: {
          basis: "costBasis",
          unitCost: "unitCost",
          reason: "unknownCostReason",
        },
        subject: "these units",
        /*
         * The one rule genuinely local to adjustments. Both explanations — why
         * stock changed, and why nobody can price it — are written into the
         * single note the ledger stores, so the pair is bounded here, where the
         * message can name both fields, rather than downstream where it would
         * surface as a movement-level error the operator cannot act on.
         */
        extraReasonCheck: (explanation) =>
          composeAdjustmentNote(input.reason, explanation).length > NOTE_MAX
            ? `The reason and this explanation are written to the ledger together, and must come to ${NOTE_MAX} characters or fewer between them.`
            : null,
      },
    );
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
function composeAdjustmentNote(reason: string, explanation: string | null): string {
  return explanation === null
    ? reason
    : withUnknownCostReason(reason, explanation);
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

  return costBasisUnitCostCents({
    basis: input.costBasis,
    unitCost: input.unitCost,
  });
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
