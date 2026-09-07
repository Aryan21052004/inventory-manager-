import { z } from "zod";

/**
 * Validation for the three decisions an inspection can produce.
 *
 * A returned batch arrives quarantined and leaves that state only by somebody
 * looking at it: released to sale, or condemned. A condemned batch then leaves
 * *stock* only by being written off against itself. Three actions, all ADMIN,
 * all irreversible, and all requiring the operator to say why.
 *
 * What these schemas deliberately do not carry:
 *
 *   **No cost.** A write-off removes units at the cost the lot already holds,
 *   frozen when the batch was created. A cost supplied here would be somebody
 *   typing a number about stock they are destroying, which is the invented
 *   figure this costing model exists to refuse. There is no field for it.
 *
 *   **No status.** The action decides the status, not the payload. Letting a
 *   form name the target state would make an arbitrary transition expressible,
 *   and the transition table in lot-status.ts exists precisely so they are not.
 *
 *   **No totals.** The value being written off is computed on the server from
 *   the lot's own cost. A client-supplied total is a number nobody checked.
 *
 * As everywhere else, there is no actor field: attribution is read from the
 * session on the server, because a field the client can set is a field the
 * client can lie about.
 */

/**
 * Why the decision was made.
 *
 * Required on all three actions and required to say something. For a release
 * and a rejection this is the inspection finding, and it is the only durable
 * account of a judgement that cannot be reconstructed later. For a write-off it
 * is the disposal record. Three characters is the same floor the adjustment and
 * return schemas use.
 */
const reason = z
  .string()
  .trim()
  .min(3, "Give a reason — it is the only record of this decision")
  .max(500, "Reason must be 500 characters or fewer");

const lotId = z.string().trim().min(1, "A batch is required");

/** Releasing a quarantined batch to sale, or condemning it. */
export const lotInspectionSchema = z.object({
  lotId,
  reason,
});

export type LotInspectionInput = z.infer<typeof lotInspectionSchema>;

/**
 * How many units of a rejected batch are being destroyed.
 *
 * Arrives from FormData as a string and is checked as one before conversion —
 * `Number("")` is `0`, so coercing first would read a cleared field as a
 * deliberate zero. The upper bound against the lot's remaining quantity cannot
 * live here: it is a fact about a database row, checked on the server under the
 * product lock, where it is still true when the write happens.
 */
const writeOffQuantity = z
  .string()
  .trim()
  .min(1, "Enter how many units are being written off")
  .refine((value) => /^\d+$/.test(value), "Quantity must be a whole number")
  .transform(Number)
  .refine((value) => value > 0, "Quantity must be at least 1")
  .refine((value) => value <= 1_000_000, "Quantity is too large");

export const lotWriteOffSchema = z.object({
  lotId,
  quantity: writeOffQuantity,
  reason,
});

export type LotWriteOffInput = z.infer<typeof lotWriteOffSchema>;

export interface LotActionFieldErrors {
  lotId?: string;
  quantity?: string;
  reason?: string;
  form?: string;
}

export function toLotActionFieldErrors(error: z.ZodError): LotActionFieldErrors {
  const errors: LotActionFieldErrors = {};

  for (const issue of error.issues) {
    const field = issue.path[0];
    const key =
      field === "lotId" || field === "quantity" || field === "reason"
        ? field
        : "form";

    if (!errors[key]) errors[key] = issue.message;
  }

  return errors;
}
