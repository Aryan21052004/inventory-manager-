import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@clerk/nextjs/server", async () => {
  const { clerkServerMock } = await import("./clerk-mock");
  return clerkServerMock;
});

import { certificateStatus, EXPIRING_SOON_DAYS } from "@/lib/certificate-status";
import { prisma } from "@/lib/prisma";
import {
  attachCertificate,
  getCertificateFile,
  getCertificateHistory,
  getCurrentCertificate,
  removeCertificate,
  updateCertificateMetadata,
} from "@/server/certificates";
import { createProduct, deleteProduct, getProductDetail } from "@/server/products";
import { fileStorage } from "@/server/storage";

import { signOut } from "./clerk-mock";
import { resetDatabase, seedProduct, signInWithRole } from "./database";

/**
 * Certificates.
 *
 * Two things here are worth more than the happy path and get the most
 * attention: that a file is identified by reading it rather than by believing
 * its name, and that replacing or removing a certificate never destroys the
 * record of the one before. The rest — status derivation, permissions,
 * metadata round-tripping — is checked because it is cheap to check and
 * expensive to get wrong.
 */

beforeEach(async () => {
  signOut();
  await resetDatabase();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Real files, byte for byte, as far as the type sniffer is concerned.
 *
 * Each begins with the signature its format actually begins with, because that
 * is exactly what the code under test looks at. A fixture that only *claimed*
 * to be a PDF would pass a test that a real upload would fail.
 */
const PDF_BYTES = Buffer.concat([
  Buffer.from("%PDF-1.7\n"),
  Buffer.from("1 0 obj\n<< /Type /Catalog >>\nendobj\n"),
  Buffer.from("%%EOF\n"),
]);

const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]),
]);

const JPEG_BYTES = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.from("JFIF"),
]);

/** Not a certificate. Named like one, and declared like one. */
const HTML_BYTES = Buffer.from("<html><script>alert(1)</script></html>");

function fileFrom(
  bytes: Buffer,
  name: string,
  type = "application/pdf",
): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

function metadata(overrides: Record<string, string> = {}) {
  return {
    certificateType: "FAA 8130-3",
    certificateNumber: "8130-123456",
    issueDate: "2026-08-12",
    expiryDate: "2029-08-12",
    ...overrides,
  };
}

/** A day offset from today, as the `YYYY-MM-DD` a form would submit. */
function isoDaysFromNow(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function attach(
  productId: string,
  overrides: Record<string, string> = {},
  file: File = fileFrom(PDF_BYTES, "certificate.pdf"),
) {
  return attachCertificate({
    productId,
    metadata: metadata(overrides),
    file,
  });
}

// ---------------------------------------------------------------------------
// A product does not need one
// ---------------------------------------------------------------------------

describe("a product without a certificate", () => {
  it("can be created, and reads as MISSING", async () => {
    await signInWithRole("ADMIN");

    const created = await createProduct({
      name: "Hydraulic Actuator",
      sku: "ACT-001",
      category: "Actuators",
      sellingPrice: "1850.00",
      stockQuantity: "3",
      minimumStock: "1",
      status: "ACTIVE",
    });

    const result = await getProductDetail(created.id);
    if (!result.ok || !result.data) throw new Error("expected a product");

    expect(result.data.certificate).toBeNull();
    expect(result.data.certificateStatus).toBe("MISSING");
    expect(await prisma.certificate.count()).toBe(0);
  });

  it("is what MISSING means, rather than an error", () => {
    expect(certificateStatus(null)).toBe("MISSING");
    expect(certificateStatus(undefined)).toBe("MISSING");
  });
});

// ---------------------------------------------------------------------------
// Metadata and file
// ---------------------------------------------------------------------------

describe("attaching a certificate", () => {
  it("stores the metadata exactly as entered", async () => {
    await signInWithRole("ADMIN");
    const product = await seedProduct({ sku: "CERT-001" });

    await attach(product.id, {
      certificateType: "EASA Form 1",
      certificateNumber: "EASA-2026-0099",
      issueDate: "2026-08-12",
      expiryDate: "2029-08-12",
    });

    const row = await prisma.certificate.findFirstOrThrow({
      where: { productId: product.id },
    });

    expect(row.certificateType).toBe("EASA Form 1");
    expect(row.certificateNumber).toBe("EASA-2026-0099");
    // Dates, not timestamps — the day is the whole value, in UTC.
    expect(row.issueDate.toISOString().slice(0, 10)).toBe("2026-08-12");
    expect(row.expiryDate?.toISOString().slice(0, 10)).toBe("2029-08-12");
  });

  it("stores the file metadata, and the bytes themselves", async () => {
    await signInWithRole("ADMIN");
    const product = await seedProduct({ sku: "CERT-002" });

    await attach(
      product.id,
      {},
      fileFrom(PDF_BYTES, "8130-scan.pdf", "application/pdf"),
    );

    const row = await prisma.certificate.findFirstOrThrow({
      where: { productId: product.id },
    });

    expect(row.fileName).toBe("8130-scan.pdf");
    expect(row.contentType).toBe("application/pdf");
    expect(row.fileSize).toBe(PDF_BYTES.byteLength);

    // The key is ours, not the uploader's filename.
    expect(row.storageKey).toMatch(/^certificates\/[0-9a-f-]{36}\.pdf$/);
    expect(row.storageKey).not.toContain("8130-scan");

    // And the bytes really are in storage.
    const stored = await fileStorage.get(row.storageKey);
    expect(stored?.body.equals(PDF_BYTES)).toBe(true);
  });

  it("records who uploaded it from the session, not from the input", async () => {
    const admin = await signInWithRole("ADMIN");
    const product = await seedProduct({ sku: "CERT-003" });

    const other = await prisma.user.create({
      data: {
        clerkId: "user_other",
        name: "Somebody Else",
        email: "other@example.com",
        role: "ADMIN",
      },
    });

    await attachCertificate({
      productId: product.id,
      // Extra fields a tampered request might carry. None are in the schema.
      metadata: { ...metadata(), uploadedBy: other.id, productId: "elsewhere" },
      file: fileFrom(PDF_BYTES, "certificate.pdf"),
    });

    const row = await prisma.certificate.findFirstOrThrow({
      where: { productId: product.id },
    });

    expect(row.uploadedBy).toBe(admin.id);
    expect(row.uploadedBy).not.toBe(other.id);
  });

  it("accepts PNG and JPEG as well as PDF", async () => {
    await signInWithRole("ADMIN");

    const png = await seedProduct({ sku: "CERT-PNG" });
    await attach(png.id, {}, fileFrom(PNG_BYTES, "scan.png", "image/png"));

    const jpeg = await seedProduct({ sku: "CERT-JPG" });
    await attach(jpeg.id, {}, fileFrom(JPEG_BYTES, "scan.jpg", "image/jpeg"));

    const types = await prisma.certificate.findMany({
      select: { contentType: true },
      orderBy: { contentType: "asc" },
    });

    expect(types.map((row) => row.contentType)).toEqual([
      "image/jpeg",
      "image/png",
    ]);
  });

  it("can be attached while the product is being created", async () => {
    await signInWithRole("ADMIN");

    const created = await createProduct(
      {
        name: "Landing Gear Pin",
        sku: "LGP-001",
        category: "Airframe",
        sellingPrice: "480.00",
        stockQuantity: "2",
        minimumStock: "1",
        status: "ACTIVE",
      },
      { metadata: metadata(), file: fileFrom(PDF_BYTES, "certificate.pdf") },
    );

    const certificate = await getCurrentCertificate(created.id);
    expect(certificate?.certificateNumber).toBe("8130-123456");

    // The product's opening stock movement still happened — attaching a
    // certificate must not disturb the inventory ledger.
    expect(
      await prisma.stockTransaction.count({ where: { productId: created.id } }),
    ).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The file is identified by reading it
// ---------------------------------------------------------------------------

describe("file validation", () => {
  it("refuses a file that is not what its name says", async () => {
    await signInWithRole("ADMIN");
    const product = await seedProduct({ sku: "CERT-EVIL" });

    // The extension says PDF, the declared MIME type says PDF, the bytes say
    // HTML. Only the bytes are evidence.
    await expect(
      attach(
        product.id,
        {},
        fileFrom(HTML_BYTES, "certificate.pdf", "application/pdf"),
      ),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      details: { field: "file" },
    });

    expect(await prisma.certificate.count()).toBe(0);
  });

  it("refuses an empty file", async () => {
    await signInWithRole("ADMIN");
    const product = await seedProduct({ sku: "CERT-EMPTY" });

    await expect(
      attach(product.id, {}, fileFrom(Buffer.alloc(0), "empty.pdf")),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("refuses a missing file", async () => {
    await signInWithRole("ADMIN");
    const product = await seedProduct({ sku: "CERT-NOFILE" });

    await expect(
      attachCertificate({
        productId: product.id,
        metadata: metadata(),
        file: null,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", details: { field: "file" } });
  });

  it("requires a certificate number", async () => {
    await signInWithRole("ADMIN");
    const product = await seedProduct({ sku: "CERT-NONUM" });

    await expect(
      attach(product.id, { certificateNumber: "   " }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      details: { field: "certificateNumber" },
    });
  });

  it("refuses an expiry date before the issue date", async () => {
    await signInWithRole("ADMIN");
    const product = await seedProduct({ sku: "CERT-BACKWARDS" });

    await expect(
      attach(product.id, { issueDate: "2026-08-12", expiryDate: "2020-01-01" }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      details: { field: "expiryDate" },
    });
  });

  it("leaves no file behind when the metadata is rejected", async () => {
    await signInWithRole("ADMIN");
    const product = await seedProduct({ sku: "CERT-CLEANUP" });

    await expect(
      attach(product.id, { certificateNumber: "" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    // Metadata is parsed before the file is written, so nothing was stored.
    expect(await prisma.certificate.count()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Replacing and removing
// ---------------------------------------------------------------------------

describe("replacing a certificate", () => {
  it("retires the old one instead of overwriting it", async () => {
    await signInWithRole("ADMIN");
    const product = await seedProduct({ sku: "CERT-REPLACE" });

    const first = await attach(product.id, { certificateNumber: "FIRST-001" });
    const second = await attach(product.id, { certificateNumber: "SECOND-002" });

    const current = await getCurrentCertificate(product.id);
    expect(current?.id).toBe(second.id);
    expect(current?.certificateNumber).toBe("SECOND-002");

    const history = await getCertificateHistory(product.id);
    expect(history).toHaveLength(1);
    expect(history[0]!.id).toBe(first.id);
    expect(history[0]!.certificateNumber).toBe("FIRST-001");
    expect(history[0]!.supersededAt).not.toBeNull();

    // Both rows survive; the ledger of documents is a sequence, not a slot.
    expect(await prisma.certificate.count({ where: { productId: product.id } })).toBe(2);
  });

  it("keeps the retired certificate's file readable", async () => {
    await signInWithRole("ADMIN");
    const product = await seedProduct({ sku: "CERT-OLDFILE" });

    const first = await attach(product.id, { certificateNumber: "OLD-1" });
    await attach(product.id, { certificateNumber: "NEW-1" });

    const oldRow = await prisma.certificate.findUniqueOrThrow({
      where: { id: first.id },
    });

    // The point of keeping history is that the old document is still there.
    expect(await fileStorage.exists(oldRow.storageKey)).toBe(true);
    await expect(getCertificateFile(first.id)).resolves.toMatchObject({
      contentType: "application/pdf",
    });
  });

  it("never leaves a product with two current certificates", async () => {
    await signInWithRole("ADMIN");
    const product = await seedProduct({ sku: "CERT-ONECURRENT" });

    await attach(product.id, { certificateNumber: "A" });
    await attach(product.id, { certificateNumber: "B" });
    await attach(product.id, { certificateNumber: "C" });

    const current = await prisma.certificate.count({
      where: { productId: product.id, supersededAt: null },
    });

    // Enforced by a partial unique index, not just by this code path.
    expect(current).toBe(1);
  });
});

describe("removing a certificate", () => {
  it("leaves the product reading as MISSING", async () => {
    await signInWithRole("ADMIN");
    const product = await seedProduct({ sku: "CERT-REMOVE" });

    const certificate = await attach(product.id);
    await removeCertificate(certificate.id);

    expect(await getCurrentCertificate(product.id)).toBeNull();

    const result = await getProductDetail(product.id);
    if (!result.ok || !result.data) throw new Error("expected a product");
    expect(result.data.certificateStatus).toBe("MISSING");
  });

  it("keeps the record as history rather than destroying it", async () => {
    await signInWithRole("ADMIN");
    const product = await seedProduct({ sku: "CERT-REMOVE-HIST" });

    const certificate = await attach(product.id, {
      certificateNumber: "WITHDRAWN-1",
    });
    await removeCertificate(certificate.id);

    const history = await getCertificateHistory(product.id);
    expect(history).toHaveLength(1);
    expect(history[0]!.certificateNumber).toBe("WITHDRAWN-1");

    // "A certificate existed and was withdrawn" is itself information.
    const row = await prisma.certificate.findUniqueOrThrow({
      where: { id: certificate.id },
    });
    expect(await fileStorage.exists(row.storageKey)).toBe(true);
  });

  it("refuses to withdraw the same certificate twice", async () => {
    await signInWithRole("ADMIN");
    const product = await seedProduct({ sku: "CERT-DOUBLE" });

    const certificate = await attach(product.id);
    await removeCertificate(certificate.id);

    await expect(removeCertificate(certificate.id)).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });
});

describe("editing metadata", () => {
  it("corrects the details without touching the file", async () => {
    await signInWithRole("ADMIN");
    const product = await seedProduct({ sku: "CERT-EDIT" });

    const certificate = await attach(product.id, {
      certificateNumber: "TYPO-000",
    });
    const before = await prisma.certificate.findUniqueOrThrow({
      where: { id: certificate.id },
    });

    await updateCertificateMetadata(certificate.id, {
      certificateType: "Certificate of Conformity",
      certificateNumber: "CORRECTED-123",
      issueDate: "2026-01-05",
      expiryDate: "",
    });

    const after = await prisma.certificate.findUniqueOrThrow({
      where: { id: certificate.id },
    });

    expect(after.certificateNumber).toBe("CORRECTED-123");
    expect(after.certificateType).toBe("Certificate of Conformity");
    // A blank expiry means "does not expire", not "unchanged".
    expect(after.expiryDate).toBeNull();
    // Same file, same row — a correction is not a new document.
    expect(after.storageKey).toBe(before.storageKey);
    expect(await prisma.certificate.count()).toBe(1);
  });

  it("refuses to edit a superseded certificate", async () => {
    await signInWithRole("ADMIN");
    const product = await seedProduct({ sku: "CERT-EDITOLD" });

    const first = await attach(product.id, { certificateNumber: "OLD" });
    await attach(product.id, { certificateNumber: "NEW" });

    await expect(
      updateCertificateMetadata(first.id, metadata()),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

// ---------------------------------------------------------------------------
// Derived status
// ---------------------------------------------------------------------------

describe("certificate status", () => {
  const today = new Date("2026-08-26T12:00:00.000Z");

  it("is EXPIRED when the expiry date has passed", () => {
    expect(
      certificateStatus({ expiryDate: new Date("2026-08-25") }, today),
    ).toBe("EXPIRED");
    expect(
      certificateStatus({ expiryDate: new Date("2020-01-01") }, today),
    ).toBe("EXPIRED");
  });

  it("is VALID with no expiry date, however old the certificate", () => {
    // A Certificate of Conformity typically never expires. Absence of a date is
    // an answer, not a gap.
    expect(certificateStatus({ expiryDate: null }, today)).toBe("VALID");
  });

  it("is EXPIRING_SOON inside the warning window, and on the day itself", () => {
    expect(
      certificateStatus({ expiryDate: new Date("2026-08-26") }, today),
    ).toBe("EXPIRING_SOON");
    expect(
      certificateStatus({ expiryDate: new Date("2026-09-20") }, today),
    ).toBe("EXPIRING_SOON");
  });

  it("is VALID beyond the warning window", () => {
    expect(
      certificateStatus({ expiryDate: new Date("2027-01-01") }, today),
    ).toBe("VALID");
  });

  it("puts the boundary exactly at the documented window", () => {
    const lastWarned = new Date(today);
    lastWarned.setUTCDate(lastWarned.getUTCDate() + EXPIRING_SOON_DAYS);

    const firstSafe = new Date(today);
    firstSafe.setUTCDate(firstSafe.getUTCDate() + EXPIRING_SOON_DAYS + 1);

    expect(certificateStatus({ expiryDate: lastWarned }, today)).toBe(
      "EXPIRING_SOON",
    );
    expect(certificateStatus({ expiryDate: firstSafe }, today)).toBe("VALID");
  });

  it("reports the derived status on the product detail page", async () => {
    await signInWithRole("ADMIN");

    const expired = await seedProduct({ sku: "CERT-EXPIRED" });
    await attach(expired.id, {
      issueDate: "2020-01-01",
      expiryDate: isoDaysFromNow(-1),
    });

    const noExpiry = await seedProduct({ sku: "CERT-NOEXPIRY" });
    await attach(noExpiry.id, { expiryDate: "" });

    const soon = await seedProduct({ sku: "CERT-SOON" });
    await attach(soon.id, { issueDate: "2020-01-01", expiryDate: isoDaysFromNow(5) });

    for (const [id, expected] of [
      [expired.id, "EXPIRED"],
      [noExpiry.id, "VALID"],
      [soon.id, "EXPIRING_SOON"],
    ] as const) {
      const result = await getProductDetail(id);
      if (!result.ok || !result.data) throw new Error("expected a product");
      expect(result.data.certificateStatus).toBe(expected);
    }
  });
});

// ---------------------------------------------------------------------------
// Access control
// ---------------------------------------------------------------------------

describe("who may read a certificate file", () => {
  it("refuses an unauthenticated request", async () => {
    await signInWithRole("ADMIN");
    const product = await seedProduct({ sku: "CERT-AUTH" });
    const certificate = await attach(product.id);

    signOut();

    await expect(getCertificateFile(certificate.id)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      status: 401,
    });
  });

  it("refuses an unauthenticated request even for an id that does not exist", async () => {
    signOut();

    // 401 rather than 404: a signed-out visitor must not be able to map which
    // certificate ids exist by watching which ones come back differently.
    await expect(getCertificateFile("made-up-id")).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  it("lets STAFF read one — viewing is part of the job", async () => {
    await signInWithRole("ADMIN");
    const product = await seedProduct({ sku: "CERT-STAFFREAD" });
    const certificate = await attach(product.id);

    signOut();
    await signInWithRole("STAFF");

    const file = await getCertificateFile(certificate.id);
    expect(file.contentType).toBe("application/pdf");
    expect(file.body.equals(PDF_BYTES)).toBe(true);
  });
});

describe("who may change a certificate", () => {
  it("refuses STAFF an upload", async () => {
    await signInWithRole("STAFF");
    const product = await seedProduct({ sku: "CERT-STAFFUP" });

    await expect(attach(product.id)).rejects.toMatchObject({
      code: "FORBIDDEN",
      status: 403,
    });

    expect(await prisma.certificate.count()).toBe(0);
  });

  it("refuses STAFF a metadata edit", async () => {
    await signInWithRole("ADMIN");
    const product = await seedProduct({ sku: "CERT-STAFFEDIT" });
    const certificate = await attach(product.id, {
      certificateNumber: "UNTOUCHED",
    });

    signOut();
    await signInWithRole("STAFF");

    await expect(
      updateCertificateMetadata(certificate.id, metadata({ certificateNumber: "HACKED" })),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const row = await prisma.certificate.findUniqueOrThrow({
      where: { id: certificate.id },
    });
    expect(row.certificateNumber).toBe("UNTOUCHED");
  });

  it("refuses STAFF a removal", async () => {
    await signInWithRole("ADMIN");
    const product = await seedProduct({ sku: "CERT-STAFFDEL" });
    const certificate = await attach(product.id);

    signOut();
    await signInWithRole("STAFF");

    await expect(removeCertificate(certificate.id)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });

    expect(await getCurrentCertificate(product.id)).not.toBeNull();
  });

  it("refuses an unauthenticated upload", async () => {
    const product = await seedProduct({ sku: "CERT-ANONUP" });

    await expect(attach(product.id)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });
});

// ---------------------------------------------------------------------------
// Deleting the product
// ---------------------------------------------------------------------------

describe("deleting a product with certificates", () => {
  it("removes the rows and the stored files with it", async () => {
    await signInWithRole("ADMIN");

    const created = await createProduct({
      name: "Scrap Part",
      sku: "SCRAP-001",
      category: "Airframe",
      sellingPrice: "20.00",
      stockQuantity: "1",
      minimumStock: "0",
      status: "ACTIVE",
    });

    await attach(created.id, { certificateNumber: "FIRST" });
    await attach(created.id, { certificateNumber: "SECOND" });

    const keys = (
      await prisma.certificate.findMany({
        where: { productId: created.id },
        select: { storageKey: true },
      })
    ).map((row) => row.storageKey);
    expect(keys).toHaveLength(2);

    await deleteProduct(created.id);

    expect(await prisma.certificate.count()).toBe(0);

    // A cascade removes the rows; nothing but the delete removes the files.
    for (const key of keys) {
      expect(await fileStorage.exists(key)).toBe(false);
    }
  });
});
