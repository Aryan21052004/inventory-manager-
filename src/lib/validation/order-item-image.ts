/**
 * The rules for a photograph attached to an order line.
 *
 * Shared by the browser and the server, like the product and certificate
 * schemas. The browser's copy stops an obvious mistake before a round-trip; the
 * server's is the one that matters, because everything here arrives from a form
 * the client controls.
 *
 * Everything in this module is the *cheap* half of the check — a declared type,
 * a declared size, a filename — and all three are trivially forged. The real
 * check reads the file's leading bytes on the server; see `sniffImageType` in
 * src/server/order-item-images.ts. Neither half is sufficient alone: sniffing
 * catches a disguised file, and this catches a 400 MB one before it is read
 * into memory.
 *
 * Deliberately separate from `validation/certificate.ts`. That module governs
 * controlled airworthiness documents with issue dates, expiry and supersession;
 * this one governs informal snapshots with none of that. They accept different
 * formats at different sizes for different reasons, and sharing a constant
 * between them would make one feature's limit move when the other's did.
 */

/**
 * What may be uploaded, keyed by the content type the server will store and
 * later serve back.
 *
 * Four raster formats and nothing else. No SVG, deliberately: an SVG is a
 * document that can carry script, and serving one back from our own origin
 * would hand an uploader a way to run code there. No PDF either — a photograph
 * of a part is not a document, and the certificate system already exists for
 * anything that is.
 */
export const ACCEPTED_IMAGE_TYPES = {
  "image/jpeg": { extensions: [".jpg", ".jpeg"], label: "JPEG" },
  "image/png": { extensions: [".png"], label: "PNG" },
  "image/webp": { extensions: [".webp"], label: "WebP" },
  "image/gif": { extensions: [".gif"], label: "GIF" },
} as const;

export type AcceptedImageType = keyof typeof ACCEPTED_IMAGE_TYPES;

export function isAcceptedImageType(
  value: unknown,
): value is AcceptedImageType {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(ACCEPTED_IMAGE_TYPES, value)
  );
}

/** The `accept` attribute for the file input — a hint to the picker, not a check. */
export const IMAGE_ACCEPT_ATTRIBUTE = ".jpg,.jpeg,.png,.webp,.gif";

/** The human-readable list of what is accepted, for an error message. */
export const ACCEPTED_IMAGE_LABELS = Object.values(ACCEPTED_IMAGE_TYPES)
  .map((type) => type.label)
  .join(", ");

/**
 * 5 MB per image.
 *
 * Comfortably more than a phone photograph of a part on a bench, and small
 * enough that the whole file can be held in memory to check and store it
 * without a streaming pipeline this application does not otherwise need.
 *
 * Deliberately *not* the certificate limit. That one is 10 MB and is documented
 * as sized for a multi-page scan at a readable resolution — a different kind of
 * file for a different reason. Reusing it here would tie two unrelated limits
 * together.
 *
 * `order_item_images_file_size_within_limit` in the migration is this same
 * number, and a test asserts the two agree so they cannot drift.
 */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export const MAX_IMAGE_LABEL = "5 MB";

/**
 * How many images one line may carry.
 *
 * Not a business rule anybody asked for — a guard against a single request
 * pinning the server while it reads an unbounded number of 5 MB buffers into
 * memory. Generous enough that no real use hits it.
 */
export const MAX_IMAGES_PER_UPLOAD = 10;

/** Bytes, for display. */
export function formatImageSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * A filename fit to store and display.
 *
 * Path separators are stripped even though this value never reaches a
 * filesystem — these bytes live in Postgres — because "never" is a property of
 * today's code, and this string is rendered in a UI and sent in a
 * `Content-Disposition` header. Control characters go for the same reason: a
 * newline in that header is a response-splitting primitive.
 *
 * The same shape as the certificate sanitiser, written here rather than
 * imported so that this feature's rules cannot move when that one's do.
 */
export function sanitiseImageName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "image";

  // A code-point filter rather than a regex with a control-character class:
  // the same rule, without an escape sequence that every tool between here and
  // the file has a chance to mangle.
  const cleaned = [...base]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code >= 32 && code !== 127;
    })
    .join("")
    .trim();

  if (cleaned.length === 0) return "image";

  // Capped so a pathological name cannot bloat the row or the header.
  return cleaned.length > 120 ? cleaned.slice(0, 120) : cleaned;
}
