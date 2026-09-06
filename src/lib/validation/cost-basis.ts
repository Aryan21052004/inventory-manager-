import { z } from "zod";

/**
 * One acquisition-cost question, asked the same way everywhere it is asked.
 *
 * Stock enters this system by three routes. A purchase carries a supplier
 * invoice and its cost is proven. The other two — an opening balance typed when
 * a product is created, and an upward stock adjustment — are operator
 * assertions about units that arrived without paperwork behind them, and both
 * face the identical question: *can you say what these cost?*
 *
 * Both flows used to answer it by omission. A blank cost box produced an
 * `UNKNOWN` lot silently, so the uncosted units in this system came from forms
 * that never asked rather than from anyone deciding a cost was unrecoverable.
 * Each flow was then fixed separately, which left two copies of the rule: two
 * `["KNOWN", "UNKNOWN"]` tuples, two money parsers, two reason limits, and
 * three validation messages that were identical character for character.
 *
 * Two copies of a rule that exists to stop invented costs is two places for it
 * to drift, and the drift would be silent — a slightly laxer reason check on
 * one path is not something a test for the other path can see. So the rule
 * lives here once, and the two flows differ only in the vocabulary of their own
 * screens: which fields the messages point at, and what the movement is called.
 *
 * What is deliberately *not* here: how each flow composes its ledger note, and
 * what `LotCostSource` each produces. Those are genuinely different — an
 * adjustment's note has an operator reason of its own to combine with, an
 * opening balance has a fixed prefix — and folding them together would trade a
 * real duplication for a fake abstraction.
 */

/**
 * Whether the operator can say what the incoming units cost.
 *
 * There is no default, and that is the whole mechanism. `UNKNOWN` stays fully
 * available, because stock found in a corner with no paperwork genuinely has no
 * acquisition cost and demanding a number there would guarantee an invented one
 * — the single thing this costing model exists to prevent. What changed is that
 * unknown became something an operator *said* rather than something a form
 * *assumed*.
 */
export const COST_BASES = ["KNOWN", "UNKNOWN"] as const;

export type CostBasis = (typeof COST_BASES)[number];

/** The longest an unknown-cost explanation may be, on its own. */
export const UNKNOWN_COST_REASON_MAX = 200;

/**
 * A cost that may legitimately be absent, checked as a string before it is
 * converted.
 *
 * The check runs against the string first because `Number("")` is `0` rather
 * than `NaN`: coercing up front would read a field the operator cleared as
 * "these units were free" — a cost, and a wrong one — instead of as an empty
 * field. That distinction is the one the whole costing layer rests on, and this
 * is the door it would be lost at.
 */
export function optionalCost(label: string) {
  return z
    .string()
    .trim()
    // A field the form did not render at all is as absent as one left blank.
    .optional()
    .transform((value) => (value === undefined || value === "" ? null : value))
    .refine(
      (value) => value === null || Number.isFinite(Number(value)),
      `${label} must be a number`,
    )
    .transform((value) => (value === null ? null : Number(value)))
    .refine(
      (value) => value === null || value >= 0,
      `${label} cannot be negative`,
    )
    .refine(
      (value) => value === null || value <= 9_999_999_999.99,
      `${label} is too large`,
    );
}

/**
 * The explanation field, as it arrives from a form.
 *
 * Blank becomes null rather than an empty string, so "left alone" and "cleared"
 * are the same absence downstream. Whether that absence is allowed is decided
 * by `refineCostBasis`, which knows whether the operator claimed unknown.
 */
export const unknownCostReason = z
  .string()
  .trim()
  .optional()
  .transform((value) => (value === undefined || value === "" ? null : value));

/**
 * The messages both flows show, in one place so they cannot drift apart.
 *
 * `missingBasis` takes the subject because that is the only part that honestly
 * differs — "these units" on an adjustment, "the opening stock" on a new
 * product. Everything after it is the same sentence, and it is the same
 * sentence because it is the same rule.
 */
export const COST_BASIS_MESSAGES = {
  missingBasis: (subject: string) =>
    `Say whether the acquisition cost of ${subject} is known. Leaving it unanswered is what used to record a cost as unknown by accident.`,
  missingCost:
    "Enter what one unit cost, or say the cost is unknown — never a placeholder.",
  missingReason:
    "Say why the cost is unknown — these units will report as uncosted for as long as they last.",
  reasonTooLong: `That explanation must be ${UNKNOWN_COST_REASON_MAX} characters or fewer.`,
} as const;

/** Where each part of the answer lives on the schema being refined. */
export interface CostBasisPaths {
  basis: string;
  unitCost: string;
  reason: string;
}

/** The answer, as the two schemas both shape it. */
export interface CostBasisAnswer {
  basis: CostBasis | undefined;
  unitCost: number | null;
  reason: string | null;
}

/**
 * The rule itself: an acquisition cost is stated, or its absence is justified.
 *
 * Called from a `superRefine` on both schemas, and only once the flow has
 * decided the question applies at all — an adjustment that *reduces* stock and
 * a product that opens holding *nothing* create no batch, so there is nothing
 * to cost and asking would be a question with no subject.
 *
 * The asymmetry between the two answers is deliberate and is the reason this
 * cannot collapse into a plain required-field check. A known cost is evidenced
 * by the number itself. An unknown one leaves a permanent hole in the valuation
 * of every sale that later draws on the batch, and the only thing that will
 * ever explain that hole is what the operator writes here — so unknown is the
 * answer that has to be argued for, not the one that comes free.
 *
 * `extraReasonCheck` exists for the one real difference between the callers:
 * an adjustment writes the operator's reason and this explanation into a single
 * 500-character ledger note, so the pair has to be bounded where a message can
 * name both fields. An opening balance has a fixed 50-character prefix and is
 * bounded by construction, so it passes nothing.
 */
export function refineCostBasis(
  ctx: z.RefinementCtx,
  answer: CostBasisAnswer,
  options: {
    paths: CostBasisPaths;
    /** Names what is being costed, for the missing-basis message. */
    subject: string;
    /** An additional bound on the reason, returning a message when it fails. */
    extraReasonCheck?: (reason: string) => string | null;
  },
): void {
  const { paths } = options;

  if (!answer.basis) {
    ctx.addIssue({
      code: "custom",
      path: [paths.basis],
      message: COST_BASIS_MESSAGES.missingBasis(options.subject),
    });
    return;
  }

  if (answer.basis === "KNOWN") {
    if (answer.unitCost === null) {
      ctx.addIssue({
        code: "custom",
        path: [paths.unitCost],
        message: COST_BASIS_MESSAGES.missingCost,
      });
    }
    return;
  }

  const explanation = answer.reason ?? "";

  if (explanation.length < 3) {
    ctx.addIssue({
      code: "custom",
      path: [paths.reason],
      message: COST_BASIS_MESSAGES.missingReason,
    });
    return;
  }

  if (explanation.length > UNKNOWN_COST_REASON_MAX) {
    ctx.addIssue({
      code: "custom",
      path: [paths.reason],
      message: COST_BASIS_MESSAGES.reasonTooLong,
    });
    return;
  }

  const extra = options.extraReasonCheck?.(explanation);
  if (extra) {
    ctx.addIssue({ code: "custom", path: [paths.reason], message: extra });
  }
}

/**
 * The basis a form should still be holding after its quantity changes.
 *
 * A form only asks about acquisition cost while there is a batch to cost. When
 * the quantity falls to zero the question is withdrawn, and the answer has to
 * be withdrawn with it: the inputs unmount, so nothing stale is *submitted*,
 * but a retained selection would still be highlighted if the operator typed a
 * quantity back in — next to the empty reason box they had already filled in
 * once. That reads as an answer which is still on record when it is not, and
 * this control's whole purpose is that an unknown cost is something somebody
 * actively said.
 *
 * A pure function rather than an effect inside the dialog, because it is a rule
 * about the two values and is worth testing as one.
 */
export function basisForQuantity(
  quantity: number,
  current: CostBasis | null,
): CostBasis | null {
  return quantity > 0 ? current : null;
}

/**
 * How an unknown-cost explanation is appended to whatever the movement already
 * says.
 *
 * One format for both flows, because a reader scanning the ledger should not
 * have to learn two. The reason travels in the note rather than in a column of
 * its own for the same reason the note exists at all: it explains a movement,
 * and it has to survive as long as the movement does.
 */
export function withUnknownCostReason(base: string, reason: string): string {
  return `${base} (Acquisition cost unknown: ${reason})`;
}

/**
 * What the incoming units cost, in cents, or null when nobody knows.
 *
 * There is no branch here that reaches for a catalogue figure, and there is no
 * longer a catalogue figure to reach for — `Product.standardCost` was removed
 * precisely so this function could not have one. A guessed acquisition cost is
 * indistinguishable from a real one the moment it is written.
 */
export function costBasisUnitCostCents(answer: {
  basis: CostBasis | undefined;
  unitCost: number | null | undefined;
}): number | null {
  if (answer.basis !== "KNOWN") return null;
  if (answer.unitCost === null || answer.unitCost === undefined) return null;

  return Math.round(answer.unitCost * 100);
}

/**
 * A cost declaration as the stock engine accepts it, once a form has been
 * parsed and the money has become whole cents.
 *
 * This is the same question `refineCostBasis` asks a form, at the other end of
 * the journey: the form decides whether the operator answered it, and this
 * decides what the engine is allowed to be told. Both inbound routes an
 * operator drives — an opening balance and an upward stock adjustment — now
 * take this one shape, so there is one vocabulary for a declared cost rather
 * than one per entry point.
 *
 * The union is the whole point. Both engine APIs previously took a nullable
 * number, which made the two illegal combinations well-typed calls, and one of
 * them — a null cost carrying no explanation — is precisely the uncosted batch
 * nobody chose that this costing model exists to prevent. There is now no way
 * to spell it: KNOWN carries a cost and cannot carry a reason, UNKNOWN carries
 * a reason and cannot carry a cost.
 */
export type DeclaredCost =
  | { basis: "KNOWN"; unitCostCents: number }
  | { basis: "UNKNOWN"; reason: string };

/**
 * Checks a declaration that has already left the type system's protection.
 *
 * The union is the guarantee for TypeScript callers; this is the guarantee for
 * everyone else. A `JSON.parse`, an `as any`, or a caller compiled against an
 * older signature can still produce `{ basis: "UNKNOWN" }` with no reason or a
 * KNOWN with no number, and those are the states the union exists to forbid.
 *
 * Returns the message rather than throwing, so the engine can raise its own
 * error type and this module stays free of server imports. `subject` names what
 * is being costed, because the same fault reads differently depending on which
 * route produced it.
 */
export function declaredCostError(
  cost: DeclaredCost,
  subject: string,
): string | null {
  if (cost.basis === "KNOWN") {
    if (!Number.isInteger(cost.unitCostCents)) {
      return `${subject} declared a known cost without a whole number of cents to record.`;
    }
    if (cost.unitCostCents < 0) {
      return `${subject} cannot have a negative acquisition cost.`;
    }
    return null;
  }

  if (cost.basis === "UNKNOWN") {
    // Checked as a string before it is trimmed. A caller the type system did
    // not see can omit the field entirely, and reaching straight for `.trim()`
    // would turn a declaration this function exists to reject into a
    // TypeError — the right outcome reported as the wrong kind of fault.
    const reason = typeof cost.reason === "string" ? cost.reason.trim() : "";

    if (reason.length < 3) {
      return `${subject} declared an unknown cost without saying why. These units would report as uncosted with nothing to explain them.`;
    }
    if (reason.length > UNKNOWN_COST_REASON_MAX) {
      return `${subject} gave an explanation longer than ${UNKNOWN_COST_REASON_MAX} characters.`;
    }
    return null;
  }

  return `${subject} must declare whether its acquisition cost is known.`;
}

/**
 * What a declaration means for the two columns a lot actually stores.
 *
 * Derived from what was declared, never from whether a number happened to
 * arrive — and never from a catalogue figure, which no longer exists. The
 * database asserts the same pairing from the other side through the
 * `stock_lots_*_cost_known` check constraints.
 */
export function declaredCostUnitCents(cost: DeclaredCost): number | null {
  return cost.basis === "KNOWN" ? cost.unitCostCents : null;
}
