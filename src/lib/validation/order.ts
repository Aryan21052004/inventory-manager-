import { z } from "zod";

/**
 * Validation for orders.
 *
 * Note what an order submission does *not* contain: a subtotal, and a total.
 * The client sends a customer, a set of lines, and a discount; every figure
 * derived from those is computed on the server from prices read out of the
 * database at that moment. A total the browser calculated is a number the
 * browser can choose, and an order is a financial document.
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

export const orderLineSchema = z.object({
  productId: z.string().trim().min(1, "Product is required"),
  quantity: lineQuantity,
});

export type OrderLineInput = z.infer<typeof orderLineSchema>;

/**
 * Money from a form. Same treatment as the product schema: the string is
 * checked before conversion, because `Number("")` is 0 and coercing first would
 * read a cleared field as a valid zero.
 */
const money = (label: string) =>
  z
    .union([z.string(), z.number()])
    .transform((value) => (typeof value === "number" ? String(value) : value.trim()))
    .transform((value) => (value === "" ? "0" : value))
    .refine((value) => Number.isFinite(Number(value)), `${label} must be a number`)
    .transform(Number)
    .refine((value) => value >= 0, `${label} cannot be negative`)
    .refine((value) => value <= 9_999_999_999.99, `${label} is too large`)
    .refine(
      (value) => Number.isInteger(Math.round(value * 100)),
      `${label} must be a valid amount`,
    );

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

  discount: money("Discount"),

  note: z.string().trim().max(500, "Note must be 500 characters or fewer").optional(),
});

export type OrderInput = z.infer<typeof orderSchema>;

export type OrderFieldErrors = Partial<
  Record<"customerId" | "items" | "discount" | "form", string>
>;

export function toOrderFieldErrors(error: z.ZodError): OrderFieldErrors {
  const fieldErrors: OrderFieldErrors = {};

  for (const issue of error.issues) {
    const field = issue.path[0];
    const key =
      field === "customerId" || field === "discount" || field === "items"
        ? field
        : "form";

    if (!fieldErrors[key]) fieldErrors[key] = issue.message;
  }

  return fieldErrors;
}

/**
 * The one arithmetic rule in the module: **grand total = subtotal − discount**.
 *
 * There is no tax term and no place to add one. Everything works in integer
 * cents because money in floating point drifts — 0.1 + 0.2 is famously not 0.3,
 * and a subtotal is a sum of many such numbers. The caller converts to a
 * decimal string once, at the edge.
 */
export interface OrderTotals {
  subtotalCents: number;
  discountCents: number;
  totalCents: number;
}

export function calculateTotals(
  lines: readonly { unitPriceCents: number; quantity: number }[],
  discountCents: number,
): OrderTotals {
  const subtotalCents = lines.reduce(
    (sum, line) => sum + line.unitPriceCents * line.quantity,
    0,
  );

  return {
    subtotalCents,
    discountCents,
    totalCents: subtotalCents - discountCents,
  };
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
