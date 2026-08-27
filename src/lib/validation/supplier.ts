import { z } from "zod";

/**
 * Validation for supplier input.
 *
 * Shared by the browser and the server, like every other schema here. The form
 * parses with these so a mistake is caught before a round-trip, and the server
 * parses with the same ones because the browser's copy is a convenience, not a
 * guard.
 *
 * One field is deliberately absent: `status`. Archiving a supplier is not an
 * edit — it takes a record out of both pickers, it is restricted to ADMIN, and
 * it has a control of its own. Leaving it out of this schema means the edit
 * form cannot carry it even if someone adds the input, and a STAFF user posting
 * `status=INACTIVE` to the update action changes nothing.
 *
 * Duplicate emails are not checked here either. Uniqueness is the database's
 * job — a check followed by an insert has a gap between them, and two people
 * adding the same supplier at once would both find nothing and both proceed.
 * The unique index is the only thing that can actually arbitrate; the server
 * catches its violation and turns it into a field error.
 */

/**
 * An optional free-text field.
 *
 * Empty is not a value. A cleared input means "no phone number", not "a phone
 * number that is the empty string" — the column is nullable and null is what it
 * should hold, or the same supplier ends up looking different depending on
 * whether someone tabbed through the field.
 */
const optionalText = (label: string, max: number) =>
  z
    .string()
    .trim()
    .max(max, `${label} must be ${max} characters or fewer`)
    .optional()
    .transform((value) => (value ? value : null));

/**
 * The email address, when there is one.
 *
 * Lower-cased on the way in, which is what makes the unique index mean
 * something: `Orders@vendor.com` and `orders@vendor.com` are the same mailbox,
 * and without normalising, the index would happily accept both as two
 * suppliers. The blank-to-null transform runs first, so an empty box is a
 * supplier without an email rather than a validation error — Postgres allows
 * any number of NULLs in a unique index, so those never collide.
 */
const optionalEmail = z
  .string()
  .trim()
  .toLowerCase()
  .max(200, "Email must be 200 characters or fewer")
  .refine(
    (value) => value === "" || z.email().safeParse(value).success,
    "Enter a valid email address",
  )
  .optional()
  .transform((value) => (value ? value : null));

/**
 * Typical lead time, in whole days.
 *
 * Checked as a string before converting, for the same reason the product
 * schema does it: `Number("")` is 0, so coercing first would read a field
 * somebody cleared as "arrives the same day" rather than as "we do not know".
 * The upper bound matches the check constraint in the migration — ten years is
 * comfortably past any real lead time and safely inside an `Int`.
 */
const optionalLeadTime = z
  .string()
  .trim()
  .optional()
  .transform((value) => (value === undefined || value === "" ? null : value))
  .refine(
    (value) => value === null || Number.isFinite(Number(value)),
    "Lead time must be a number",
  )
  .transform((value) => (value === null ? null : Number(value)))
  .refine(
    (value) => value === null || Number.isInteger(value),
    "Lead time must be a whole number of days",
  )
  .refine(
    (value) => value === null || value >= 0,
    "Lead time cannot be negative",
  )
  .refine(
    (value) => value === null || value <= 3650,
    "Lead time must be 3650 days or fewer",
  );

/** The fields creating and editing a supplier share — which is all of them. */
const supplierFields = {
  name: z
    .string()
    .trim()
    .min(1, "Supplier name is required")
    .max(200, "Supplier name must be 200 characters or fewer"),
  /*
   * Who to actually speak to. A supplier is an organisation, and the person
   * answering the phone is a different fact from the company's name — which is
   * why suppliers carry this and customers do not.
   */
  contactPerson: optionalText("Contact person", 200),
  email: optionalEmail,
  /*
   * Not pattern-matched. Phone numbers carry country codes, extensions and
   * local conventions this application has no business having an opinion about,
   * and a regex here would reject real numbers to catch typos it cannot
   * identify anyway.
   */
  phone: optionalText("Phone", 32),
  address: optionalText("Address", 500),
  /*
   * Their reference for us, not ours for them. Free text: vendor numbering
   * schemes belong to the vendor, and any format this validated would be wrong
   * for the next supplier onboarded.
   */
  accountNumber: optionalText("Account number", 64),
  typicalLeadTimeDays: optionalLeadTime,
};

export const createSupplierSchema = z.object(supplierFields);

/** Editing carries the same fields. See the note about `status` above. */
export const updateSupplierSchema = z.object(supplierFields);

/** The archive and reactivate controls' only input. */
export const supplierStatusSchema = z.object({
  status: z.enum(["ACTIVE", "INACTIVE"]),
});

export type CreateSupplierInput = z.infer<typeof createSupplierSchema>;
export type UpdateSupplierInput = z.infer<typeof updateSupplierSchema>;

/**
 * Every field either schema can complain about, keyed by the input field name
 * so the form can look up a message by the same string it used for `name`.
 */
export type SupplierFieldErrors = Partial<
  Record<keyof CreateSupplierInput, string>
>;

/**
 * Collapses a Zod error into one message per field. Showing three messages
 * under a single input is noise when fixing the first usually clears the rest.
 */
export function toSupplierFieldErrors(error: z.ZodError): SupplierFieldErrors {
  const fieldErrors: SupplierFieldErrors = {};

  for (const issue of error.issues) {
    const field = issue.path[0] as keyof SupplierFieldErrors | undefined;
    if (field && !fieldErrors[field]) {
      fieldErrors[field] = issue.message;
    }
  }

  return fieldErrors;
}

/** The first message a schema produced, for a toast or an error banner. */
export function firstSupplierIssue(error: z.ZodError): string {
  return error.issues[0]?.message ?? "Check the highlighted fields.";
}
