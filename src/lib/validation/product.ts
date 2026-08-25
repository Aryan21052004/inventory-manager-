import { z } from "zod";

/**
 * Validation for product input.
 *
 * Kept out of the form component so the same rules can be reused by the server
 * action that will eventually persist this. Validating only in the browser
 * would leave the write path unguarded — anything that reaches the server must
 * be checked again there, against this same schema.
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

export const productSchema = z.object({
  sku: z
    .string()
    .trim()
    .min(1, "SKU is required")
    .max(64, "SKU must be 64 characters or fewer"),
  name: z
    .string()
    .trim()
    .min(1, "Name is required")
    .max(200, "Name must be 200 characters or fewer"),
  description: z
    .string()
    .trim()
    .max(1000, "Description must be 1000 characters or fewer")
    .optional(),
  category: z
    .string()
    .trim()
    .min(1, "Category is required")
    .max(64, "Category must be 64 characters or fewer"),
  costPrice: requiredNumber("Cost price"),
  sellingPrice: requiredNumber("Selling price"),
  stockQuantity: requiredWholeNumber("Opening stock"),
  minimumStock: requiredWholeNumber("Minimum stock"),
});

export type ProductInput = z.infer<typeof productSchema>;

export type ProductFieldErrors = Partial<Record<keyof ProductInput, string>>;

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
