import "server-only";

import type { Certificate } from "@/generated/prisma/client";
import { AppError, NotFoundError, toSafeError, type SafeError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import {
  certificateMetadataSchema,
  MAX_FILE_BYTES,
  MAX_FILE_LABEL,
  type CertificateFieldErrors,
} from "@/lib/validation/certificate";
import { requireRole, requireUser } from "@/server/auth";
import { certificateStorageKey, fileStorage } from "@/server/storage";
import { ACCEPTED_TYPE_LABELS, sniffFileType } from "@/server/storage/file-type";

/**
 * Everything the certificates module does.
 *
 * Three rules shape this file, and each one is load-bearing:
 *
 *   **Nothing is overwritten.** Replacing a certificate retires the current row
 *   and inserts a new one. The old row keeps pointing at the old file, both
 *   survive, and the batch's history reads as a sequence. An aviation part's
 *   paperwork is the sort of thing someone asks about years later, and "we
 *   replaced it" is not an answer.
 *
 *   **The file is written before the database, never the other way round.** The
 *   two cannot be one transaction — a filesystem does not roll back — so the
 *   order is chosen so that a failure leaves an unreferenced file rather than a
 *   row pointing at nothing. An orphan file is invisible and costs disk; a row
 *   whose file is missing is a broken download and a support ticket.
 *
 *   **Attribution comes from the session.** `uploadedBy` is not a parameter,
 *   for the same reason `createdBy` is not a parameter to the stock engine.
 */

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface CertificateView {
  id: string;
  /** The product the batch belongs to. Carried so callers can revalidate. */
  productId: string;
  /**
   * The batch this paperwork covers. Null only on legacy rows filed before
   * certificates moved to lots — all of which are superseded, so a null here
   * always reads as history rather than as coverage of anything.
   */
  stockLotId: string | null;
  certificateType: string;
  certificateNumber: string;
  issueDate: Date;
  expiryDate: Date | null;
  fileName: string;
  contentType: string;
  fileSize: number;
  createdAt: Date;
  updatedAt: Date;
  supersededAt: Date | null;
  uploadedByName: string | null;
  /**
   * Where the browser fetches the file. Derived, never stored — the storage key
   * stays server-side, and this address means nothing without a session.
   */
  fileUrl: string;
}

export interface CertificateFileResponse {
  body: Buffer;
  contentType: string;
  fileName: string;
  size: number;
}

/** The authenticated route a certificate's bytes are served from. */
export function certificateFileUrl(certificateId: string): string {
  return `/api/certificates/${certificateId}/file`;
}

export function toCertificateView(
  certificate: Certificate & { uploadedByUser?: { name: string } | null },
): CertificateView {
  return {
    id: certificate.id,
    productId: certificate.productId,
    stockLotId: certificate.stockLotId,
    certificateType: certificate.certificateType,
    certificateNumber: certificate.certificateNumber,
    issueDate: certificate.issueDate,
    expiryDate: certificate.expiryDate,
    fileName: certificate.fileName,
    contentType: certificate.contentType,
    fileSize: certificate.fileSize,
    createdAt: certificate.createdAt,
    updatedAt: certificate.updatedAt,
    supersededAt: certificate.supersededAt,
    uploadedByName: certificate.uploadedByUser?.name ?? null,
    fileUrl: certificateFileUrl(certificate.id),
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * The current certificate for one batch, or null if it has none.
 *
 * There is deliberately no product-level equivalent. A product does not have a
 * certificate — its batches do, and they can disagree: one lot released under
 * an 8130-3 that expires next month sitting beside another with no paperwork
 * at all is an ordinary state, not an inconsistency. Any function answering
 * "this product's certificate" would have to pick one of them, and every way
 * of picking is a guess presented as a fact.
 */
export async function getLotCertificate(
  stockLotId: string,
): Promise<CertificateView | null> {
  const certificate = await prisma.certificate.findFirst({
    where: { stockLotId, supersededAt: null },
    include: { uploadedByUser: { select: { name: true } } },
  });

  return certificate ? toCertificateView(certificate) : null;
}

/**
 * Current certificates for several batches at once, keyed by lot id.
 *
 * One query for a page of lots rather than one per lot. Lots with no current
 * paperwork are simply absent from the map, which is what MISSING means.
 */
export async function getLotCertificates(
  stockLotIds: readonly string[],
): Promise<Map<string, CertificateView>> {
  if (stockLotIds.length === 0) return new Map();

  const rows = await prisma.certificate.findMany({
    where: { stockLotId: { in: [...stockLotIds] }, supersededAt: null },
    include: { uploadedByUser: { select: { name: true } } },
  });

  return new Map(
    rows.map((row) => [row.stockLotId!, toCertificateView(row)] as const),
  );
}

/**
 * Every retired certificate for a product, newest first — the audit trail.
 *
 * Scoped to the product rather than to a lot on purpose, so it still surfaces
 * the legacy rows that were filed before certificates moved to batches. Those
 * carry a null `stockLotId` and are readable here and nowhere else; dropping
 * them from this view would quietly erase the only record that the documents
 * were ever filed.
 */
export async function getCertificateHistory(
  productId: string,
): Promise<CertificateView[]> {
  const rows = await prisma.certificate.findMany({
    where: { productId, supersededAt: { not: null } },
    orderBy: { supersededAt: "desc" },
    include: { uploadedByUser: { select: { name: true } } },
  });

  return rows.map(toCertificateView);
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function fieldError(
  code: "BAD_REQUEST" | "CONFLICT" | "NOT_FOUND",
  field: keyof CertificateFieldErrors,
  message: string,
): AppError {
  return new AppError(code, message, { field });
}

function parseMetadata(input: unknown) {
  const parsed = certificateMetadataSchema.safeParse(input);

  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new AppError("BAD_REQUEST", issue.message, {
      field: issue.path[0] as string | undefined,
    });
  }

  return parsed.data;
}

export interface ValidatedUpload {
  body: Buffer;
  contentType: string;
  extension: string;
  fileName: string;
  size: number;
}

/**
 * Turns an uploaded `File` into bytes we are willing to store.
 *
 * The size check happens before the read, so a hostile 400MB upload is refused
 * rather than buffered. Everything after that works on the bytes themselves:
 * the type is determined by `sniffFileType` reading the file's signature, not
 * by its name or the `Content-Type` the browser attached, both of which are
 * client-supplied strings and neither of which is evidence of anything.
 *
 * The original filename is kept only to show to people. It never becomes part
 * of a path, and it never decides the content type.
 */
export async function validateUpload(file: unknown): Promise<ValidatedUpload> {
  if (!(file instanceof File) || file.size === 0) {
    throw fieldError("BAD_REQUEST", "file", "Choose a certificate file.");
  }

  if (file.size > MAX_FILE_BYTES) {
    throw fieldError(
      "BAD_REQUEST",
      "file",
      `That file is larger than ${MAX_FILE_LABEL}. Scan at a lower resolution, or split it.`,
    );
  }

  const body = Buffer.from(await file.arrayBuffer());

  // Re-checked against the bytes actually read, not the size the client
  // declared — the two are not required to agree.
  if (body.byteLength === 0 || body.byteLength > MAX_FILE_BYTES) {
    throw fieldError("BAD_REQUEST", "file", "That file could not be read.");
  }

  const sniffed = sniffFileType(body);

  if (!sniffed) {
    throw fieldError(
      "BAD_REQUEST",
      "file",
      `That file is not a ${ACCEPTED_TYPE_LABELS}. Renaming a file does not change what it is — upload the actual document.`,
    );
  }

  return {
    body,
    contentType: sniffed.contentType,
    extension: sniffed.extension,
    // Trimmed and capped for display. Never used to build a path.
    fileName: sanitiseFileName(file.name),
    size: body.byteLength,
  };
}

/**
 * A filename fit to store and display.
 *
 * Path separators are stripped even though this value never reaches the
 * filesystem, because "never" is a property of today's code and this string is
 * shown in a UI and sent in a `Content-Disposition` header. Control characters
 * go for the same reason — a newline in that header is a response-splitting
 * primitive.
 */
function sanitiseFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "certificate";

  // A code-point filter rather than a regex with a control-character
  // class: the same rule, without an escape sequence that every tool
  // between here and the file has a chance to mangle.
  const cleaned = [...base]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      // Below 32 is a control character — a newline among them, which in a
      // Content-Disposition header is a response-splitting primitive. 127
      // is DEL. The double quote delimits the filename in that same header.
      return code > 31 && code !== 127 && character !== '"';
    })
    .join("")
    .trim();

  return (cleaned || "certificate").slice(0, 200);
}

/** Prisma's unique-constraint code — matched structurally, as elsewhere. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "P2002"
  );
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * A validated certificate whose file is already in storage but which has no
 * database row yet.
 *
 * `data` is the row to insert, shaped to be handed straight to Prisma.
 * `storageKey` repeats what is inside it so a caller that has to abandon the
 * write can delete the orphaned file without unpacking `data` to find it.
 */
export interface PreparedCertificate {
  storageKey: string;
  data: {
    certificateType: string;
    certificateNumber: string;
    issueDate: Date;
    expiryDate: Date | null;
    fileName: string;
    storageKey: string;
    contentType: string;
    fileSize: number;
  };
}

/**
 * Validates a certificate and puts its file in storage, without writing a row.
 *
 * Split out so the upload can fail before anything is committed. The file and
 * the row cannot be one transaction — a filesystem does not roll back — so the
 * file is written first and the caller deletes it if the transaction that
 * follows does not commit. That leaves the harmless failure rather than the
 * damaging one.
 *
 * The file is written here rather than after the row for the reason stated at
 * the top of this file: a row pointing at bytes that are not there is a broken
 * download; bytes with no row pointing at them are invisible.
 */
export async function prepareCertificate(input: {
  metadata: unknown;
  file: unknown;
}): Promise<PreparedCertificate> {
  const metadata = parseMetadata(input.metadata);
  const upload = await validateUpload(input.file);
  const storageKey = certificateStorageKey(upload.extension);

  await fileStorage.put({
    key: storageKey,
    body: upload.body,
    contentType: upload.contentType,
  });

  return {
    storageKey,
    data: {
      certificateType: metadata.certificateType,
      certificateNumber: metadata.certificateNumber,
      issueDate: metadata.issueDate,
      expiryDate: metadata.expiryDate,
      fileName: upload.fileName,
      storageKey,
      contentType: upload.contentType,
      fileSize: upload.size,
    },
  };
}

/**
 * Attaches a certificate to a stock lot, retiring whatever that lot had before.
 *
 * This is both "add" and "replace" — they differ only in whether there was
 * something to retire, which is not a distinction worth two functions or two
 * code paths that can drift apart.
 *
 * **The lot is the subject, not the product.** Paperwork covers the units that
 * arrived, so attaching it to a batch is the only way two deliveries of one
 * part number under two different releases can both be recorded truthfully.
 *
 * The sequence is chosen for what it leaves behind when it fails:
 *
 *   1. Authorise, find the lot, validate metadata, validate and read the file.
 *   2. Write the file under a *new* key. Nothing existing is touched, so a
 *      failure here changes nothing at all.
 *   3. In one database transaction, retire the lot's current row and insert the
 *      new one. Either both happen or neither does, so a lot cannot briefly
 *      have no certificate or two.
 *   4. If the transaction fails, delete the file written in step 2.
 *
 * The old file is never deleted. It belongs to the retired row, which is the
 * history this table exists to keep.
 */
export async function attachCertificate(params: {
  stockLotId: string;
  metadata: unknown;
  file: unknown;
}): Promise<CertificateView> {
  const user = await requireRole("ADMIN");

  /*
   * The lot decides the product; the caller does not get to supply both. A
   * shape that accepted the pair would make a mismatched one expressible, and
   * although the composite foreign key would refuse it, the better place to
   * stop that is here.
   */
  const lot = await prisma.stockLot.findUnique({
    where: { id: params.stockLotId },
    select: { id: true, productId: true },
  });
  if (!lot) throw new NotFoundError("Stock lot");

  const prepared = await prepareCertificate({
    metadata: params.metadata,
    file: params.file,
  });

  try {
    const created = await prisma.$transaction(async (tx) => {
      // Retire whatever is current *for this lot*. `updateMany` rather than
      // find-then-update: one statement, and a no-op when there is nothing to
      // retire, which is the "add" case.
      await tx.certificate.updateMany({
        where: { stockLotId: lot.id, supersededAt: null },
        data: { supersededAt: new Date() },
      });

      return tx.certificate.create({
        data: {
          ...prepared.data,
          stockLotId: lot.id,
          productId: lot.productId,
          // From the session. Not a parameter, so no caller can attribute an
          // upload to somebody else.
          uploadedBy: user.id,
        },
        include: { uploadedByUser: { select: { name: true } } },
      });
    });

    return toCertificateView(created);
  } catch (error) {
    // Step 4: the row was never written, so the file it would have pointed at
    // is unreferenced. Best-effort — a failed cleanup leaves a harmless orphan
    // and must not replace the real error with a second one.
    await fileStorage.delete(prepared.storageKey).catch(() => {});

    if (isUniqueViolation(error)) {
      // The partial unique index caught two uploads racing for the same lot.
      // Neither is wrong; one simply has to go second.
      throw new AppError(
        "CONFLICT",
        "Someone else updated this lot's certificate at the same time. Reload and try again.",
      );
    }

    throw error;
  }
}

/**
 * Corrects the metadata on the current certificate, leaving the file alone.
 *
 * Distinct from replacing on purpose. A typo in a certificate number is a
 * correction to the record of one document; uploading a different file is a
 * different document. Conflating them would either force a re-upload to fix a
 * typo, or quietly rewrite history when someone meant to fix one.
 */
export async function updateCertificateMetadata(
  certificateId: string,
  input: unknown,
): Promise<CertificateView> {
  await requireRole("ADMIN");
  const metadata = parseMetadata(input);

  const existing = await prisma.certificate.findUnique({
    where: { id: certificateId },
    select: { id: true, supersededAt: true },
  });

  if (!existing) throw new NotFoundError("Certificate");

  if (existing.supersededAt !== null) {
    // Retired rows are the audit trail. Editing one would make the history a
    // record of what we currently believe rather than of what happened.
    throw new AppError(
      "CONFLICT",
      "This certificate has been superseded and cannot be edited. Its record is kept as history.",
    );
  }

  const updated = await prisma.certificate.update({
    where: { id: certificateId },
    data: {
      certificateType: metadata.certificateType,
      certificateNumber: metadata.certificateNumber,
      issueDate: metadata.issueDate,
      expiryDate: metadata.expiryDate,
    },
    include: { uploadedByUser: { select: { name: true } } },
  });

  return toCertificateView(updated);
}

/**
 * Withdraws a lot's current certificate.
 *
 * A retirement, not a deletion. The row is marked superseded and the file stays
 * where it is, so the batch reads as having no certificate — status MISSING,
 * nothing to view or download — while the record of the document that once
 * covered it survives in the history.
 *
 * That is a deliberate reading of "remove". For an aviation part, the fact that
 * a certificate existed and was withdrawn is itself information, and a system
 * that could be made to forget it on request would not be much of an audit
 * trail. Purging the bytes is a separate operation, for a separate reason
 * (a retention policy, a legal request), and does not exist yet.
 */
export async function removeCertificate(
  certificateId: string,
): Promise<{
  productId: string;
  stockLotId: string | null;
  certificateNumber: string;
}> {
  await requireRole("ADMIN");

  const certificate = await prisma.certificate.findUnique({
    where: { id: certificateId },
    select: {
      id: true,
      productId: true,
      stockLotId: true,
      certificateNumber: true,
      supersededAt: true,
    },
  });

  if (!certificate) throw new NotFoundError("Certificate");

  if (certificate.supersededAt !== null) {
    throw new AppError(
      "CONFLICT",
      "That certificate has already been withdrawn.",
    );
  }

  await prisma.certificate.update({
    where: { id: certificateId },
    data: { supersededAt: new Date() },
  });

  return {
    productId: certificate.productId,
    stockLotId: certificate.stockLotId,
    certificateNumber: certificate.certificateNumber,
  };
}

// ---------------------------------------------------------------------------
// File access
// ---------------------------------------------------------------------------

/**
 * The bytes of a certificate, for an authenticated user.
 *
 * `requireUser` and not `requireRole`: viewing a certificate is part of doing
 * the job, and STAFF need it as much as ADMIN do. What matters is that
 * *somebody* is asking — an unauthenticated request gets a 401 here, before the
 * storage layer is touched and before the existence of a certificate id is
 * confirmed one way or the other.
 *
 * This is the only path from a browser to a stored file. There is no public URL
 * to guess, share, or leak into a referrer header, because the storage key
 * never leaves the server.
 */
export async function getCertificateFile(
  certificateId: string,
): Promise<CertificateFileResponse> {
  // Authorisation before lookup, deliberately: a signed-out visitor should not
  // be able to learn which certificate ids exist by watching which ones 404.
  await requireUser();

  const certificate = await prisma.certificate.findUnique({
    where: { id: certificateId },
    select: {
      storageKey: true,
      contentType: true,
      fileName: true,
      fileSize: true,
    },
  });

  if (!certificate) throw new NotFoundError("Certificate");

  const object = await fileStorage.get(certificate.storageKey);

  if (!object) {
    // The row survived but the bytes did not — storage was cleared, or a
    // restore missed it. Worth its own message: nothing the user did caused it
    // and retrying will not fix it.
    throw new AppError(
      "NOT_FOUND",
      "The stored file for this certificate could not be found. It may need to be uploaded again.",
    );
  }

  return {
    body: object.body,
    // The type recorded when the file was inspected on upload — never the one
    // the storage layer guessed, and never one derived from the filename.
    contentType: certificate.contentType,
    fileName: certificate.fileName,
    size: certificate.fileSize,
  };
}

/**
 * Every storage key belonging to a product, so a delete can clean up after
 * itself. A foreign key cascade removes the rows; nothing but this removes the
 * files.
 */
export async function certificateKeysForProduct(
  productId: string,
): Promise<string[]> {
  const rows = await prisma.certificate.findMany({
    where: { productId },
    select: { storageKey: true },
  });

  return rows.map((row) => row.storageKey);
}

/** Best-effort cleanup of files whose rows have gone. Never throws. */
export async function deleteStoredFiles(keys: readonly string[]): Promise<void> {
  await Promise.all(
    keys.map((key) =>
      fileStorage.delete(key).catch((error) => {
        toSafeError(error, "deleteStoredFiles");
      }),
    ),
  );
}

export type CertificateResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: SafeError };
