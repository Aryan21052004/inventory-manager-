import { z } from "zod";

/**
 * Validation for customer input.
 *
 * Shared by the browser and the server, like every other schema here. The form
 * parses with these so a mistake is caught before a round-trip, and the server
 * parses with the same ones because the browser's copy is a convenience, not a
 * guard.
 *
 * One field is deliberately absent: `status`. Archiving a customer is not an
 * edit — it takes a record out of circulation, it is restricted to ADMIN, and
 * it has a control of its own. Leaving it out of this schema means the edit
 * form cannot carry it even if someone adds the input, and a STAFF user posting
 * `status=INACTIVE` to the update action changes nothing.
 */

/**
 * An optional free-text field.
 *
 * Empty is not a value. A cleared input means "no phone number", not "a phone
 * number that is the empty string" — the column is nullable and null is what it
 * should hold, or the same customer ends up looking different depending on
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
 * something: `Buyer@example.com` and `buyer@example.com` are the same mailbox,
 * and without normalising, the index would happily accept both as two
 * customers. The blank-to-null transform runs first, so an empty box is a
 * customer without an email rather than a validation error — Postgres allows
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

/** The fields creating and editing a customer share — which is all of them. */
const customerFields = {
  name: z
    .string()
    .trim()
    .min(1, "Customer name is required")
    .max(200, "Customer name must be 200 characters or fewer"),
  email: optionalEmail,
  /*
   * Not pattern-matched. Phone numbers carry country codes, extensions and
   * local conventions this application has no business having an opinion about,
   * and a regex here would reject real numbers to catch typos it cannot
   * identify anyway.
   */
  phone: optionalText("Phone", 32),
  address: optionalText("Address", 500),
};

export const createCustomerSchema = z.object(customerFields);

/** Editing carries the same fields. See the note about `status` above. */
export const updateCustomerSchema = z.object(customerFields);

/** The archive control's only input. */
export const customerStatusSchema = z.object({
  status: z.enum(["ACTIVE", "INACTIVE"]),
});

export type CreateCustomerInput = z.infer<typeof createCustomerSchema>;
export type UpdateCustomerInput = z.infer<typeof updateCustomerSchema>;

/**
 * Every field either schema can complain about, keyed by the input field name
 * so the form can look up a message by the same string it used for `name`.
 */
export type CustomerFieldErrors = Partial<
  Record<keyof CreateCustomerInput, string>
>;

/**
 * Collapses a Zod error into one message per field. Showing three messages
 * under a single input is noise when fixing the first usually clears the rest.
 */
export function toCustomerFieldErrors(error: z.ZodError): CustomerFieldErrors {
  const fieldErrors: CustomerFieldErrors = {};

  for (const issue of error.issues) {
    const field = issue.path[0] as keyof CustomerFieldErrors | undefined;
    if (field && !fieldErrors[field]) {
      fieldErrors[field] = issue.message;
    }
  }

  return fieldErrors;
}

/** The first message a schema produced, for a toast or an error banner. */
export function firstCustomerIssue(error: z.ZodError): string {
  return error.issues[0]?.message ?? "Check the highlighted fields.";
}
