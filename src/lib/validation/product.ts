import { z } from "zod";

import type { Currency } from "@/lib/currency";

import {
  COST_BASES,
  costBasisUnitCostCents,
  optionalCost,
  refineCostBasis,
  unknownCostReason,
  type CostBasis,
} from "@/lib/validation/cost-basis";

/**
 * Validation for product input.
 *
 * Shared by the browser and the server on purpose. The form parses with these
 * schemas so a mistake is caught before a round-trip, and the server action
 * parses with the same ones because the browser's copy is a convenience, not a
 * guard — anything that reaches the server has to be checked there, against
 * rules that cannot have been edited on the way in.
 *
 * One thing is deliberately absent: stock, from the update schema. Editing a
 * product must not be able to overwrite `stockQuantity`; a quantity that
 * changes without a ledger row explaining it is exactly the state this
 * application exists to prevent. Corrections go through a stock adjustment —
 * see validation/adjustment.ts.
 */

/**
 * Money and quantity fields arrive from FormData as strings.
 *
 * The checks run against the string first and only then convert, because
 * `Number("")` is 0 rather than NaN — coercing up front would silently turn a
 * field the user cleared into a valid zero.
 */
const requiredNumber = (label: string) =>
  z
    .string()
    .trim()
    .min(1, `${label} is required`)
    .refine((value) => Number.isFinite(Number(value)), `${label} must be a number`)
    .transform(Number)
    .refine((value) => value >= 0, `${label} cannot be negative`);

const requiredWholeNumber = (label: string) =>
  requiredNumber(label).refine(
    Number.isInteger,
    `${label} must be a whole number`,
  );

/*
 * A required-money helper stood here. Its last caller was `sellingPrice`, which
 * became an optional reference when pricing moved to the order line — a product
 * may have no list price at all now, so nothing on this form requires money.
 * `optionalPrice` below carries the same bounds.
 */

/**
 * Money that may legitimately be absent.
 *
 * A blank field becomes null, not zero — and the difference is the point. Zero
 * is a cost: it says these units were free. Null says nobody knows what they
 * cost, which for stock that predates this system is usually the truth. The
 * whole costing layer is built to carry that distinction all the way to the
 * screen, and it would be undone here if an empty input quietly became 0.00.
 *
 * The parser is the one the cost-basis module owns, because this file's copy
 * and the adjustment form's copy were the same bounds written twice. A price
 * and a cost are different things, but "money that may be absent, and whose
 * absence is not zero" is one rule.
 */
const optionalPrice = optionalCost;

/**
 * A quantity, bounded to a 32-bit integer because the column is an `Int`. Past
 * that Postgres raises an out-of-range error, which the UI would have to report
 * as a generic failure.
 */
const quantity = (label: string) =>
  requiredWholeNumber(label).refine(
    (value) => value <= 2_147_483_647,
    `${label} is too large`,
  );

/**
 * The value a "no supplier" selection carries.
 *
 * Radix's Select refuses an empty string as an item value — it reserves that
 * for "nothing selected" — so the unassigned option needs a sentinel of its
 * own, and the schema turns it back into the null the column wants.
 */
export const NO_SUPPLIER = "__none__";

const supplierId = z
  .string()
  .trim()
  .transform((value) => (value === "" || value === NO_SUPPLIER ? null : value))
  .nullable()
  .default(null);

const productStatus = z
  .enum(["ACTIVE", "INACTIVE", "DISCONTINUED"])
  .default("ACTIVE");

/** The fields shared by creating and editing a product. */
const productFields = {
  sku: z
    .string()
    .trim()
    .min(1, "SKU is required")
    .max(64, "SKU must be 64 characters or fewer"),
  name: z
    .string()
    .trim()
    .min(1, "Product name is required")
    .max(200, "Product name must be 200 characters or fewer"),
  description: z
    .string()
    .trim()
    .max(1000, "Description must be 1000 characters or fewer")
    .optional()
    // An empty textarea is no description, not a description that is empty.
    .transform((value) => (value ? value : null)),
  category: z
    .string()
    .trim()
    .min(1, "Category is required")
    .max(64, "Category must be 64 characters or fewer"),
  /*
   * No product cost field, and there must not be one again.
   *
   * `standardCost` stood here — a planning figure that prefilled purchase lines
   * and sorted the catalogue — and the column behind it is gone. The business
   * buys the same part at several prices, so a catalogue-level cost could only
   * ever be stale, absent, or wrong, and it read exactly like a real cost to
   * everything downstream. Acquisition cost is recorded per receipt on
   * StockLot; a purchase line's helpful starting figure is read at query time
   * from the most recent PURCHASE lot and labelled as what was last paid.
   */
  /**
   * A reference price, and nothing more.
   *
   * The business quotes per customer, so a part may have no list price at all —
   * requiring one would manufacture a number nobody stands behind. What the
   * customer actually pays is captured on `OrderItem.unitPrice` when the line
   * is quoted.
   */
  sellingPrice: optionalPrice("Selling price"),
  supplierId,
  status: productStatus,
};

/**
 * Whether the operator can say what the opening stock cost.
 *
 * The same two answers a stock adjustment asks for, and for the same reason:
 * opening stock creates a batch, and a batch has an acquisition cost or
 * honestly does not.
 *
 * This used to be inferred from whether the cost field happened to be filled
 * in — blank meant UNKNOWN, silently — so a product created without one
 * produced an uncosted lot nobody had consciously chosen. That is where the
 * uncosted opening units in this system came from: not from operators
 * declaring a cost unrecoverable, but from a form that never asked.
 *
 * The question and the rule joining its answers are shared with the adjustment
 * form — see validation/cost-basis.ts. These aliases are kept so this module
 * still reads in its own vocabulary.
 */
export const OPENING_STOCK_COST_BASES = COST_BASES;

export type OpeningStockCostBasis = CostBasis;

/*
 * The note's wording used to live here. It moved to src/server/stock.ts, beside
 * the code that writes it to the ledger: this module decides what a valid
 * declaration *is*, and the stock engine decides how the ledger records it.
 */

/**
 * Creating a product is the one time a stock quantity may be set directly, and
 * even then it is not written directly: the opening balance is recorded as a
 * STOCK_IN transaction so the ledger explains it like every other movement.
 *
 * The costing fields sit on the object as optional and are required
 * conditionally below. A product created holding nothing has no batch and so
 * nothing to cost; asking every catalogue entry that opens at zero about
 * acquisition cost would be a question with no subject.
 */
export const createProductSchema = z
  .object({
    ...productFields,
    stockQuantity: quantity("Initial stock"),
    openingStockCostBasis: z.enum(OPENING_STOCK_COST_BASES).optional(),
    /**
     * What the opening stock actually cost per unit.
     *
     * There is no catalogue figure left to default this from, and there was
     * never a defensible one: what we expect to pay next time and what we paid
     * for the units being entered right now are different facts, and writing
     * the first into the second turns an estimate into a recorded acquisition
     * cost no later reader can tell apart from a real one.
     */
    openingStockUnitCost: optionalPrice("Opening stock unit cost"),
    openingStockUnknownReason: unknownCostReason,
  })
  .superRefine((input, ctx) => {
    // No units, no batch, nothing to cost.
    if (input.stockQuantity <= 0) return;

    /*
     * The same rule the adjustment form applies, from the same module.
     *
     * No `extraReasonCheck` here, unlike the adjustment: this note is a fixed
     * 50-character prefix plus an explanation capped at 200, so it cannot
     * approach the 500 the ledger allows. It is bounded by construction rather
     * than by a check.
     */
    refineCostBasis(
      ctx,
      {
        basis: input.openingStockCostBasis,
        unitCost: input.openingStockUnitCost,
        reason: input.openingStockUnknownReason,
      },
      {
        paths: {
          basis: "openingStockCostBasis",
          unitCost: "openingStockUnitCost",
          reason: "openingStockUnknownReason",
        },
        subject: "the opening stock",
      },
    );
  });

/**
 * The operator's declaration, in the shape the stock engine accepts.
 *
 * The form speaks in three loose fields — a basis, a maybe-cost, a maybe-reason
 * — because that is what a `<form>` can produce. The ledger accepts only the
 * two shapes that are actually legal. This is the one place the first becomes
 * the second, and it exists so that neither side has to know about the other's
 * vocabulary: nothing downstream reads a field called `openingStockUnitCost`,
 * and nothing on the form has to know a `LotCostSource` exists.
 *
 * It throws rather than returning a fallback. Every branch here is already
 * guaranteed by `createProductSchema`, so reaching one of these means the
 * schema was bypassed — and the correct response to that is to stop, not to
 * invent the missing half. A fallback here would quietly re-open exactly the
 * hole this workstream closed.
 *
 * Only call it for a product that opens with stock; one that opens at zero has
 * no batch and therefore nothing to declare.
 */
export function openingStockCost(
  input: {
    openingStockCostBasis?: OpeningStockCostBasis | undefined;
    openingStockUnitCost?: number | null | undefined;
    openingStockUnknownReason?: string | null | undefined;
  },
  /**
   * What a declared opening cost is denominated in.
   *
   * A separate argument rather than a field on the form shape, because it does
   * not come from the form: opening stock is a new entry, so the caller passes
   * the installation default. That is the one legitimate use of the default —
   * seeding something being created now, never labelling something already
   * stored. It is ignored entirely when the basis is UNKNOWN.
   */
  currency: Currency,
):
  | { basis: "KNOWN"; unitCostCents: number; currency: Currency }
  | { basis: "UNKNOWN"; reason: string } {
  if (input.openingStockCostBasis === "KNOWN") {
    const cents = costBasisUnitCostCents({
      basis: "KNOWN",
      unitCost: input.openingStockUnitCost,
    });

    if (cents === null) {
      throw new Error(
        "Opening stock declared a known cost with no unit cost to record.",
      );
    }

    return { basis: "KNOWN", unitCostCents: cents, currency };
  }

  if (input.openingStockCostBasis === "UNKNOWN") {
    const reason = input.openingStockUnknownReason ?? "";

    if (reason.trim().length < 3) {
      throw new Error(
        "Opening stock declared an unknown cost with no reason to record.",
      );
    }

    return { basis: "UNKNOWN", reason };
  }

  throw new Error(
    "Opening stock must declare whether its acquisition cost is known.",
  );
}

/** Editing deliberately cannot touch stock. See the note at the top. */
export const updateProductSchema = z.object(productFields);

export type CreateProductInput = z.infer<typeof createProductSchema>;
export type UpdateProductInput = z.infer<typeof updateProductSchema>;

/**
 * Every field either schema can complain about. Keyed by the input field name
 * so the form can look up a message by the same string it used for `name`.
 */
export type ProductFieldErrors = Partial<
  Record<keyof CreateProductInput, string>
>;

/**
 * Collapses a Zod error into one message per field. Showing three messages
 * under a single input is noise when fixing the first usually clears the rest.
 */
export function toFieldErrors(error: z.ZodError): ProductFieldErrors {
  const fieldErrors: ProductFieldErrors = {};

  for (const issue of error.issues) {
    const field = issue.path[0] as keyof ProductFieldErrors | undefined;
    if (field && !fieldErrors[field]) {
      fieldErrors[field] = issue.message;
    }
  }

  return fieldErrors;
}

/**
 * The first message a schema produced, for a toast or an error banner. Falls
 * back to something generic rather than to `undefined`, so a caller can always
 * show *something*.
 */
export function firstIssueMessage(error: z.ZodError): string {
  return error.issues[0]?.message ?? "Check the highlighted fields.";
}
