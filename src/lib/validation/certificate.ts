import { z } from "zod";

/**
 * Validation for certificate metadata and uploads.
 *
 * Shared by the browser and the server, like the product schemas. The browser's
 * copy catches a mistake before a round-trip; the server's is the one that
 * matters, because everything here arrives from a form the client controls.
 *
 * The file rules in this module are the *cheap* half of the check — extension
 * and size, both of which the client can trivially lie about. A `.pdf` suffix
 * on a shell script and a `Content-Type: application/pdf` header cost nothing
 * to forge. The real check reads the file's leading bytes on the server; see
 * `sniffFileType` in src/server/storage/file-type.ts. Neither half is
 * sufficient alone: sniffing catches a disguised file, and this catches a
 * 400MB one before it is ever read into memory.
 */

/**
 * What may be uploaded, keyed by the content type the server will store and
 * later serve back.
 *
 * Deliberately short. Every additional type is another parser some browser will
 * point at a document it did not write, so the list stays at the three formats
 * a scanned or exported certificate actually arrives as.
 */
export const ACCEPTED_FILE_TYPES = {
  "application/pdf": { extensions: [".pdf"], label: "PDF" },
  "image/jpeg": { extensions: [".jpg", ".jpeg"], label: "JPEG" },
  "image/png": { extensions: [".png"], label: "PNG" },
} as const;

export type AcceptedContentType = keyof typeof ACCEPTED_FILE_TYPES;

/** The `accept` attribute for the file input — a hint to the file picker. */
export const FILE_ACCEPT_ATTRIBUTE = ".pdf,.jpg,.jpeg,.png";

export const ACCEPTED_EXTENSIONS: readonly string[] = Object.values(
  ACCEPTED_FILE_TYPES,
).flatMap((type) => [...type.extensions]);

/**
 * 10 MB. Large enough for a multi-page scan at a readable resolution, small
 * enough that the whole file can be held in memory to check and store it
 * without a streaming pipeline this application does not otherwise need.
 */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

export const MAX_FILE_LABEL = "10 MB";

/** The suggestions offered in the type field. Not a closed set — see below. */
export const COMMON_CERTIFICATE_TYPES = [
  "FAA 8130-3",
  "EASA Form 1",
  "Certificate of Conformity",
  "Airworthiness Certificate",
  "Other",
] as const;

/**
 * A date arriving from a form as `YYYY-MM-DD`.
 *
 * Parsed as UTC midnight rather than through `new Date("2026-08-12")`'s local
 * interpretation, so a certificate issued on the 12th does not become the 11th
 * for anyone west of Greenwich. The column is a `DATE`; the day is the whole
 * value.
 */
const isoDate = (label: string) =>
  z
    .string()
    .trim()
    .min(1, `${label} is required`)
    .regex(/^\d{4}-\d{2}-\d{2}$/, `${label} must be a date`)
    .transform((value) => new Date(`${value}T00:00:00.000Z`))
    .refine(
      (date) => Number.isFinite(date.getTime()),
      `${label} is not a real date`,
    );

const certificateFields = {
  /**
   * Free text with suggestions rather than an enum, for the same reason
   * `Product.category` is: the set is open. A part sourced under Transport
   * Canada or CAAC, or carrying a manufacturer's own form, must be recordable
   * without a migration.
   */
  certificateType: z
    .string()
    .trim()
    .min(1, "Certificate type is required")
    .max(100, "Certificate type must be 100 characters or fewer"),

  certificateNumber: z
    .string()
    .trim()
    .min(1, "Certificate number is required")
    .max(100, "Certificate number must be 100 characters or fewer"),

  issueDate: isoDate("Issue date"),

  /**
   * Optional, and meaningfully so. A blank field means "this document does not
   * expire", which is the normal state for a Certificate of Conformity — not a
   * value someone forgot to fill in.
   */
  expiryDate: z
    .string()
    .trim()
    .optional()
    .transform((value) => (value ? value : null))
    .refine(
      (value) => value === null || /^\d{4}-\d{2}-\d{2}$/.test(value),
      "Expiry date must be a date",
    )
    .transform((value) =>
      value === null ? null : new Date(`${value}T00:00:00.000Z`),
    ),
};

export const certificateMetadataSchema = z
  .object(certificateFields)
  .refine(
    (input) => input.expiryDate === null || input.expiryDate >= input.issueDate,
    {
      path: ["expiryDate"],
      message: "Expiry date cannot be before the issue date",
    },
  );

export type CertificateMetadataInput = z.infer<typeof certificateMetadataSchema>;

export type CertificateFieldErrors = Partial<
  Record<keyof CertificateMetadataInput | "file", string>
>;

export function toCertificateFieldErrors(
  error: z.ZodError,
): CertificateFieldErrors {
  const fieldErrors: CertificateFieldErrors = {};

  for (const issue of error.issues) {
    const field = issue.path[0] as keyof CertificateFieldErrors | undefined;
    if (field && !fieldErrors[field]) {
      fieldErrors[field] = issue.message;
    }
  }

  return fieldErrors;
}

/**
 * The client-side file check: is there a file, is it a plausible size, does it
 * have an extension we accept.
 *
 * Returns a message rather than throwing, so a form can render it under the
 * input. Passing this proves nothing about the file's contents — that is the
 * server's job — but failing it saves an upload that was never going to work.
 */
export function checkFileClientSide(file: File | null): string | null {
  if (!file || file.size === 0) return "Choose a certificate file";

  if (file.size > MAX_FILE_BYTES) {
    return `File must be ${MAX_FILE_LABEL} or smaller`;
  }

  const extension = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();

  if (!ACCEPTED_EXTENSIONS.includes(extension)) {
    return "File must be a PDF, JPG, JPEG or PNG";
  }

  return null;
}

/** `2.4 MB`, for display next to a file name. */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
