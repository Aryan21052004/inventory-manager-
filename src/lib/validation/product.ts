import { z } from "zod";

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
 */
const optionalPrice = (label: string) =>
  z
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
 * There is no default here, and that is the whole mechanism. UNKNOWN stays
 * fully available, because stock that predates the paperwork genuinely has no
 * provable cost and demanding a number would guarantee an invented one. What
 * changes is that unknown becomes something the operator *said*.
 */
export const OPENING_STOCK_COST_BASES = ["KNOWN", "UNKNOWN"] as const;

export type OpeningStockCostBasis = (typeof OPENING_STOCK_COST_BASES)[number];

/** The longest an unknown-cost explanation may be, on its own. */
const UNKNOWN_COST_REASON_MAX = 200;

/** What the ledger says about an opening movement before any explanation. */
const OPENING_STOCK_NOTE = "Opening stock recorded when the product was created";

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
    openingStockUnknownReason: z
      .string()
      .trim()
      .optional()
      .transform((value) => (value === undefined || value === "" ? null : value)),
  })
  .superRefine((input, ctx) => {
    // No units, no batch, nothing to cost.
    if (input.stockQuantity <= 0) return;

    if (!input.openingStockCostBasis) {
      ctx.addIssue({
        code: "custom",
        path: ["openingStockCostBasis"],
        message:
          "Say whether the acquisition cost of the opening stock is known. Leaving it unanswered is what used to record a cost as unknown by accident.",
      });
      return;
    }

    if (input.openingStockCostBasis === "KNOWN") {
      if (input.openingStockUnitCost === null) {
        ctx.addIssue({
          code: "custom",
          path: ["openingStockUnitCost"],
          message:
            "Enter what one unit cost, or say the cost is unknown — never a placeholder.",
        });
      }
      return;
    }

    /*
     * Unknown, and it has to be justified.
     *
     * The same asymmetry the adjustment form rests on. A known cost is
     * evidenced by the number itself; an unknown one leaves a permanent hole in
     * the valuation of every sale that later draws on this batch, and the only
     * thing that will ever explain that hole is what the operator writes here.
     */
    const explanation = input.openingStockUnknownReason ?? "";

    if (explanation.length < 3) {
      ctx.addIssue({
        code: "custom",
        path: ["openingStockUnknownReason"],
        message:
          "Say why the cost is unknown — these units will report as uncosted for as long as they last.",
      });
      return;
    }

    if (explanation.length > UNKNOWN_COST_REASON_MAX) {
      ctx.addIssue({
        code: "custom",
        path: ["openingStockUnknownReason"],
        message: `That explanation must be ${UNKNOWN_COST_REASON_MAX} characters or fewer.`,
      });
    }
  });

/**
 * What the ledger records as the reason for the opening movement.
 *
 * An opening balance whose cost is unknown carries both halves: that these
 * units are the product's opening stock, and why nobody can price them. The
 * second explains every uncosted sale that batch will produce, and this note is
 * the only durable place it can live.
 *
 * Bounded by construction rather than by a check: a 50-character prefix and an
 * explanation capped at 200 cannot approach the 500 the ledger allows.
 */
export function openingStockNote(input: {
  stockQuantity: number;
  openingStockCostBasis?: OpeningStockCostBasis | undefined;
  openingStockUnknownReason?: string | null | undefined;
}): string {
  const declaresUnknown =
    input.stockQuantity > 0 && input.openingStockCostBasis === "UNKNOWN";

  const explanation = declaresUnknown
    ? (input.openingStockUnknownReason ?? null)
    : null;

  return explanation === null
    ? OPENING_STOCK_NOTE
    : `${OPENING_STOCK_NOTE} (Acquisition cost unknown: ${explanation})`;
}

/**
 * What the opening units cost, in cents, or null when nobody knows.
 *
 * There is no branch here that reaches for a catalogue figure, and there is no
 * longer a catalogue figure to reach for. A guessed acquisition cost is
 * indistinguishable from a real one the moment it is written.
 */
export function openingStockUnitCostCents(input: {
  stockQuantity: number;
  openingStockCostBasis?: OpeningStockCostBasis | undefined;
  openingStockUnitCost?: number | null | undefined;
}): number | null {
  if (input.stockQuantity <= 0) return null;
  if (input.openingStockCostBasis !== "KNOWN") return null;
  if (
    input.openingStockUnitCost === null ||
    input.openingStockUnitCost === undefined
  ) {
    return null;
  }

  return Math.round(input.openingStockUnitCost * 100);
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
