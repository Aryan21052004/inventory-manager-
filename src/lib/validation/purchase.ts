import { z } from "zod";

import { CURRENCIES } from "@/lib/currency";
import { COST_BASIS_MESSAGES } from "@/lib/validation/cost-basis";

/**
 * Validation for purchases.
 *
 * One difference from orders is worth stating up front, because it looks like
 * an inconsistency and is not. An order's unit *price* is never accepted from
 * the client — it is copied from the catalogue, because what you charge is your
 * own number. A purchase's unit *cost* **is** accepted, because it is not our
 * number: it is what the supplier invoiced, and it can differ from the
 * catalogue cost price on any given delivery. Refusing it would make the module
 * unable to record what actually happened.
 *
 * What is still never accepted is a *total*. Line totals and the grand total
 * are computed on the server from the quantity and unit cost that were
 * validated here, in integer cents. A total the browser calculated is a total
 * the browser chose.
 */

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
 * What one unit cost from the supplier.
 *
 * Zero is allowed and meaningful — a warranty replacement or a free sample
 * still arrives and still has to be counted into stock. Negative is not: a
 * refund is not a purchase line, and the column's check constraint refuses it
 * anyway.
 *
 * Blank is neither, and used to become zero here. `Number("")` is 0, so
 * coercing an empty box before checking it recorded "nobody entered a cost" as
 * "these units were free" — a cost, and a wrong one. On this route that claim
 * is unfalsifiable afterwards: a PURCHASE lot is the one cost this system
 * treats as proven, and `stock_lots_purchase_cost_known` leaves it nowhere to
 * be null the way an unknown adjustment can be. So an empty cost is refused
 * instead, in the words the opening-stock and adjustment flows already use —
 * one rule about blanks and zeroes, not three.
 */
const unitCost = z
  .union([z.string(), z.number()])
  .transform((value) =>
    typeof value === "number" ? String(value) : value.trim(),
  )
  .refine((value) => value !== "", COST_BASIS_MESSAGES.missingCost)
  .refine((value) => Number.isFinite(Number(value)), "Unit cost must be a number")
  .transform(Number)
  .refine((value) => value >= 0, "Unit cost cannot be negative")
  .refine((value) => value <= 9_999_999_999.99, "Unit cost is too large");

export const purchaseLineSchema = z.object({
  productId: z.string().trim().min(1, "Product is required"),
  quantity: lineQuantity,
  unitCost,
});

export type PurchaseLineInput = z.infer<typeof purchaseLineSchema>;

export const purchaseSchema = z.object({
  supplierId: z.string().trim().min(1, "Choose a supplier"),

  /**
   * The currency this purchase is agreed in. Absent means the installation
   * default on creation, and "leave it alone" on an edit — never a reset to
   * today's default. See the same field on `orderSchema`.
   */
  currency: z.enum(CURRENCIES).optional(),

  /**
   * Confirmation that unit costs carried across a currency change are
   * intended. Request-only, never stored — see `orderSchema`.
   */
  costsConfirmedForCurrencyChange: z.boolean().optional(),

  /** A purchase with nothing on it would receive nothing and look like it had. */
  items: z
    .array(purchaseLineSchema)
    .min(1, "Add at least one product to the purchase")
    .max(200, "A purchase can hold at most 200 lines")
    .superRefine((items, ctx) => {
      /*
       * One line per product. The database agrees — `@@unique([purchaseId,
       * productId])` would reject the write — but catching it here produces a
       * message that names the problem instead of a constraint violation.
       */
      const seen = new Set<string>();

      for (const [index, item] of items.entries()) {
        if (seen.has(item.productId)) {
          ctx.addIssue({
            code: "custom",
            path: [index, "productId"],
            message:
              "This product is already on the purchase. Change the quantity on the existing line instead.",
          });
        }
        seen.add(item.productId);
      }
    }),

  /**
   * When the purchase was placed with the supplier, which is not necessarily
   * when the row was created — someone may be recording a delivery note from
   * last week.
   */
  purchaseDate: z
    .string()
    .trim()
    .optional()
    .transform((value) => (value ? value : null))
    .refine(
      (value) => value === null || /^\d{4}-\d{2}-\d{2}$/.test(value),
      "Purchase date must be a date",
    )
    .transform((value) =>
      value === null ? null : new Date(`${value}T00:00:00.000Z`),
    ),

  note: z
    .string()
    .trim()
    .max(500, "Note must be 500 characters or fewer")
    .optional(),
});

export type PurchaseInput = z.infer<typeof purchaseSchema>;

export type PurchaseFieldErrors = Partial<
  Record<"supplierId" | "items" | "purchaseDate" | "form", string>
>;

export function toPurchaseFieldErrors(error: z.ZodError): PurchaseFieldErrors {
  const fieldErrors: PurchaseFieldErrors = {};

  for (const issue of error.issues) {
    const field = issue.path[0];
    const key =
      field === "supplierId" || field === "items" || field === "purchaseDate"
        ? field
        : "form";

    if (!fieldErrors[key]) fieldErrors[key] = issue.message;
  }

  return fieldErrors;
}

/**
 * The one arithmetic rule: **total = the sum of the line totals**.
 *
 * No discount and no tax. A purchase is what the supplier invoiced, line by
 * line; a negotiated reduction belongs in the unit cost that was agreed, not as
 * a separate subtraction the receiving clerk applies afterwards.
 *
 * Integer cents throughout, because a total is a sum of many numbers and binary
 * floating point drifts once you add enough of them.
 */
export function calculatePurchaseTotal(
  lines: readonly { unitCostCents: number; quantity: number }[],
): number {
  return lines.reduce(
    (sum, line) => sum + line.unitCostCents * line.quantity,
    0,
  );
}

export function toCents(value: number): number {
  return Math.round(value * 100);
}

export function centsToDecimalString(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const absolute = Math.abs(cents);
  return `${sign}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, "0")}`;
}
