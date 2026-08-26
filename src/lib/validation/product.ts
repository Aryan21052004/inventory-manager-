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
 * Two things are deliberately absent:
 *
 *   Stock, from the update schema. Editing a product must not be able to
 *   overwrite `stockQuantity`; a quantity that changes without a ledger row
 *   explaining it is exactly the state this application exists to prevent.
 *   Corrections go through a stock adjustment — see validation/adjustment.ts.
 *
 *   Stock status. It is derived from the quantity and the minimum (see
 *   src/lib/stock-status.ts), so there is nothing to submit.
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

/**
 * Money, bounded to what the column can hold. `Decimal(12, 2)` is ten digits
 * before the point; a larger number would be a typo on the way to a Postgres
 * numeric-overflow error nobody can read.
 */
const price = (label: string) =>
  requiredNumber(label).refine(
    (value) => value <= 9_999_999_999.99,
    `${label} is too large`,
  );

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
  /**
   * A planning figure. Optional, and never treated as what the stock cost.
   *
   * It used to be required, which meant every product form had to produce a
   * cost whether anyone knew one or not — manufacturing the fake data this
   * redesign exists to remove. Actual acquisition cost is recorded per receipt
   * on StockLot; see the note on `Product.standardCost` in the schema.
   */
  standardCost: optionalPrice("Standard cost"),
  sellingPrice: price("Selling price"),
  minimumStock: quantity("Minimum stock"),
  supplierId,
  status: productStatus,
};

/**
 * Creating a product is the one time a stock quantity may be set directly, and
 * even then it is not written directly: the opening balance is recorded as a
 * STOCK_IN transaction so the ledger explains it like every other movement.
 */
export const createProductSchema = z.object({
  ...productFields,
  stockQuantity: quantity("Initial stock"),
  /**
   * What the opening stock actually cost per unit, if it is known.
   *
   * Deliberately a separate field from `standardCost`, and deliberately not
   * defaulted from it. They answer different questions: standard cost is what
   * we expect to pay next time, this is what we paid for the units being
   * entered right now. Filling this in from the planning figure would turn an
   * estimate into a recorded acquisition cost, and once written the two are
   * indistinguishable.
   *
   * Left blank, the opening stock becomes an UNKNOWN lot and reports as
   * uncosted for as long as those units last. That is the honest answer for
   * inventory whose paperwork nobody can find.
   */
  openingStockUnitCost: optionalPrice("Opening stock unit cost"),
});

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
