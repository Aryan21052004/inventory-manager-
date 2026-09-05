import { z } from "zod";

/**
 * Validation for orders.
 *
 * Note what an order submission does *not* contain: a subtotal, and a total.
 * The client sends a customer and a set of lines; every figure derived from
 * those is computed on the server from prices read out of the database at that
 * moment. A total the browser calculated is a number the browser can choose,
 * and an order is a financial document.
 *
 * The unit price is not accepted from the client either. It is copied from the
 * product when the line is written — an order must not change retrospectively
 * when someone edits the price list, and it must not be settable by whoever
 * submits the form.
 */

/** Quantities arrive from a form as strings; check before converting. */
const lineQuantity = z
  .union([z.string(), z.number()])
  .transform((value) => (typeof value === "number" ? value : value.trim()))
  .refine(
    (value) => value !== "" && Number.isFinite(Number(value)),
    "Quantity must be a number",
  )
  .transform(Number)
  .refine(Number.isInteger, "Quantity must be a whole number")
  .refine((value) => value > 0, "Quantity must be at least 1")
  .refine((value) => value <= 1_000_000, "Quantity is too large");

/**
 * The quoted price on a line, as it arrives from a form.
 *
 * The string is checked before it is converted, for the reason every money
 * field in this codebase is: `Number("")` is 0, so coercing first would read a
 * cleared field as "these units are free" — a price, and a wrong one.
 *
 * Bounded below at zero and above by what `Decimal(12, 2)` can hold. Neither is
 * a commercial rule: the floor mirrors the `order_items_unit_price_non_negative`
 * check constraint, and the ceiling turns a typo into a readable field error
 * rather than a Postgres numeric-overflow nobody can act on. **No minimum or
 * maximum sale price is imposed** — there is no business rule for one, and
 * inventing a threshold here would refuse legitimate quotes.
 *
 * Zero is accepted deliberately. A free-of-charge line is a real commercial
 * decision — a warranty replacement, a goodwill shipment — and it is different
 * from a blank field, which is why the blank is rejected and the zero is not.
 */
const quotedPrice = z
  .union([z.string(), z.number()])
  .transform((value) => (typeof value === "number" ? String(value) : value.trim()))
  .refine((value) => value !== "", "Enter a unit price for every line")
  .refine((value) => Number.isFinite(Number(value)), "Unit price must be a number")
  .refine(
    (value) => /^-?\d*(\.\d{1,2})?$/.test(value),
    "Unit price cannot have more than two decimal places",
  )
  .transform(Number)
  .refine((value) => value >= 0, "Unit price cannot be negative")
  .refine((value) => value <= 9_999_999_999.99, "Unit price is too large");

export const orderLineSchema = z.object({
  productId: z.string().trim().min(1, "Product is required"),
  quantity: lineQuantity,
  /**
   * What this customer is being quoted for one unit.
   *
   * The one money field an order submission carries, and it is a deliberate
   * reversal of what this module used to enforce. The price used to be resolved
   * on the server from `Product.sellingPrice` and a price in the payload was
   * silently stripped, because "the client cannot name its own price" was a
   * security property. It is now a commercial input: the same part is quoted
   * differently to different customers, and that number exists nowhere but here.
   *
   * What replaced the old protection is bounds rather than derivation — see
   * `quotedPrice` — plus attribution, which is unchanged: `Order.createdBy` is
   * resolved from the session and is not an input, so every quote is traceable
   * to a person. Everything *derived* from the price is still computed on the
   * server; a line total or an order total sent from the browser is ignored.
   */
  unitPrice: quotedPrice,
});

export type OrderLineInput = z.infer<typeof orderLineSchema>;

export const orderSchema = z.object({
  customerId: z.string().trim().min(1, "Choose a customer"),

  /**
   * At least one line. An order with nothing on it is not a document anyone
   * has a use for, and confirming one would deduct nothing while looking like
   * it had done something.
   */
  items: z
    .array(orderLineSchema)
    .min(1, "Add at least one product to the order")
    .max(200, "An order can hold at most 200 lines")
    .superRefine((items, ctx) => {
      /*
       * One line per product. Two lines for the same product are an editing
       * mistake rather than a scenario — the quantity belongs on one line —
       * and the database agrees: `@@unique([orderId, productId])` would reject
       * the write anyway. Catching it here produces a message that names the
       * problem instead of a constraint violation.
       */
      const seen = new Set<string>();

      for (const [index, item] of items.entries()) {
        if (seen.has(item.productId)) {
          ctx.addIssue({
            code: "custom",
            path: [index, "productId"],
            message:
              "This product is already on the order. Change the quantity on the existing line instead.",
          });
        }
        seen.add(item.productId);
      }
    }),

  note: z.string().trim().max(500, "Note must be 500 characters or fewer").optional(),
});

export type OrderInput = z.infer<typeof orderSchema>;

export type OrderFieldErrors = Partial<
  Record<"customerId" | "items" | "form", string>
>;

export function toOrderFieldErrors(error: z.ZodError): OrderFieldErrors {
  const fieldErrors: OrderFieldErrors = {};

  for (const issue of error.issues) {
    const field = issue.path[0];
    const key = field === "customerId" || field === "items" ? field : "form";

    if (!fieldErrors[key]) fieldErrors[key] = issue.message;
  }

  return fieldErrors;
}

/**
 * The one arithmetic rule in the module: **grand total = subtotal**.
 *
 * There is no tax term, no discount term, and no place to add either. Both were
 * removed rather than left at zero — see §20 — and the check constraint on
 * `orders` enforces the equality, so a total that implies anything else is
 * refused by the database whatever wrote it.
 *
 * This still returns both figures rather than one. `total` is a real column
 * that every list, report and export reads; the function exists to compute the
 * pair together so no caller has to remember they are the same number.
 *
 * Everything works in integer cents because money in floating point drifts —
 * 0.1 + 0.2 is famously not 0.3, and a subtotal is a sum of many such numbers.
 * The caller converts to a decimal string once, at the edge.
 */
export interface OrderTotals {
  subtotalCents: number;
  totalCents: number;
}

export function calculateTotals(
  lines: readonly { unitPriceCents: number; quantity: number }[],
): OrderTotals {
  const subtotalCents = lines.reduce(
    (sum, line) => sum + line.unitPriceCents * line.quantity,
    0,
  );

  return { subtotalCents, totalCents: subtotalCents };
}

/**
 * What an operator says they are physically shipping against an order.
 *
 * Deliberately *not* the same shape as an order line. An order line is a
 * commercial intention and its quantity is what was sold; this is a statement
 * about the warehouse — "I am putting these units in a box today" — and the
 * two can legitimately differ for as long as stock is short.
 *
 * The line is addressed by `orderItemId` rather than by product. An order
 * holds at most one line per product, so either would resolve, but the line id
 * is what the operator's screen is actually showing them, and resolving by
 * product would silently retarget if the order were edited between the page
 * rendering and the form being submitted.
 *
 * No upper bound is expressed here beyond sanity. What may actually be
 * fulfilled depends on the line's outstanding quantity and on stock on hand,
 * neither of which this schema can see — both are checked on the server under
 * the row locks, which is the only place the answer is stable.
 */
export const fulfilmentLineSchema = z.object({
  orderItemId: z.string().trim().min(1, "Order line is required"),
  quantity: lineQuantity,
});

export const fulfilmentSchema = z.object({
  lines: z
    .array(fulfilmentLineSchema)
    .min(1, "Choose at least one line to fulfil")
    .max(200, "An order can hold at most 200 lines")
    .superRefine((lines, ctx) => {
      const seen = new Set<string>();

      for (const line of lines) {
        if (seen.has(line.orderItemId)) {
          ctx.addIssue({
            code: "custom",
            message:
              "The same order line appears twice. Put the whole quantity on one entry.",
          });
          return;
        }
        seen.add(line.orderItemId);
      }
    }),
});

export type FulfilmentLineInput = z.infer<typeof fulfilmentLineSchema>;
export type FulfilmentInput = z.infer<typeof fulfilmentSchema>;

/** A decimal string in cents, without going through a float. */
export function toCents(value: number): number {
  return Math.round(value * 100);
}

/** Cents back to the `12.34` string a Decimal column takes. */
export function centsToDecimalString(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const absolute = Math.abs(cents);
  return `${sign}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, "0")}`;
}
