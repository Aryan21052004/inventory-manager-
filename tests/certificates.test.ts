import { beforeEach, describe, expect, it } from "vitest";

import { certificateStatus, EXPIRING_SOON_DAYS } from "@/lib/certificate-status";
import { prisma } from "@/lib/prisma";
import {
  attachCertificate,
  getCertificateFile,
  getCertificateHistory,
  getLotCertificate,
  removeCertificate,
  updateCertificateMetadata,
} from "@/server/certificates";
import {
  adjustStock,
  createProduct,
  deleteProduct,
  getProductDetail,
} from "@/server/products";
import { createPurchase, receivePurchase } from "@/server/purchases";
import { fileStorage } from "@/server/storage";

import { signOutSupabase } from "./supabase-auth-mock";
import {
  createSupplier,
  resetDatabase,
  seedProduct,
  signInWithRole,
} from "./database";

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
  signOutSupabase();
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
  stockLotId: string,
  overrides: Record<string, string> = {},
  file: File = fileFrom(PDF_BYTES, "certificate.pdf"),
) {
  return attachCertificate({
    stockLotId,
    metadata: metadata(overrides),
    file,
  });
}

/**
 * The batch a seeded product holds.
 *
 * `seedProduct` writes a lot to match the balance it creates, so every fixture
 * product with stock has exactly one — which is what paperwork now attaches to.
 */
async function lotOf(productId: string): Promise<string> {
  const lot = await prisma.stockLot.findFirstOrThrow({
    where: { productId },
    select: { id: true },
  });
  return lot.id;
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
      openingStockCostBasis: "KNOWN",
      openingStockUnitCost: "1200.00",
      status: "ACTIVE",
    });

    const result = await getProductDetail(created.id);
    if (!result.ok || !result.data) throw new Error("expected a product");

    // Opening stock created one batch, and it carries no paperwork.
    expect(result.data.lots).toHaveLength(1);
    expect(result.data.lots[0]!.certificate).toBeNull();
    expect(result.data.lots[0]!.certificateStatus).toBe("MISSING");
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

    await attach(await lotOf(product.id), {
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
      await lotOf(product.id),
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
        name: "Somebody Else",
        email: "other@example.com",
        role: "ADMIN",
      },
    });

    await attachCertificate({
      stockLotId: await lotOf(product.id),
      // Extra fields a tampered request might carry. None are in the schema.
      metadata: {
        ...metadata(),
        uploadedBy: other.id,
        productId: "elsewhere",
        stockLotId: "elsewhere",
      },
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
    await attach(await lotOf(png.id), {}, fileFrom(PNG_BYTES, "scan.png", "image/png"));

    const jpeg = await seedProduct({ sku: "CERT-JPG" });
    await attach(await lotOf(jpeg.id), {}, fileFrom(JPEG_BYTES, "scan.jpg", "image/jpeg"));

    const types = await prisma.certificate.findMany({
      select: { contentType: true },
      orderBy: { contentType: "asc" },
    });

    expect(types.map((row) => row.contentType)).toEqual([
      "image/jpeg",
      "image/png",
    ]);
  });

  it("attaches to the batch opening stock created, after the fact", async () => {
    /*
     * Creation deliberately takes no certificate any more: paperwork covers a
     * batch, and at creation there may not be one. Opening stock produces a
     * lot, and the document is filed against it afterwards.
     */
    await signInWithRole("ADMIN");

    const created = await createProduct({
      name: "Landing Gear Pin",
      sku: "LGP-001",
      category: "Airframe",
      sellingPrice: "480.00",
      stockQuantity: "2",
      openingStockCostBasis: "KNOWN",
      openingStockUnitCost: "300.00",
      status: "ACTIVE",
    });

    const lotId = await lotOf(created.id);
    await attach(lotId);

    const certificate = await getLotCertificate(lotId);
    expect(certificate?.certificateNumber).toBe("8130-123456");
    expect(certificate?.stockLotId).toBe(lotId);

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
        await lotOf(product.id),
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
      attach(await lotOf(product.id), {}, fileFrom(Buffer.alloc(0), "empty.pdf")),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("refuses a missing file", async () => {
    await signInWithRole("ADMIN");
    const product = await seedProduct({ sku: "CERT-NOFILE" });

    await expect(
      attachCertificate({
        stockLotId: await lotOf(product.id),
        metadata: metadata(),
        file: null,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", details: { field: "file" } });
  });

  it("requires a certificate number", async () => {
    await signInWithRole("ADMIN");
    const product = await seedProduct({ sku: "CERT-NONUM" });

    await expect(
      attach(await lotOf(product.id), { certificateNumber: "   " }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      details: { field: "certificateNumber" },
    });
  });

  it("refuses an expiry date before the issue date", async () => {
    await signInWithRole("ADMIN");
    const product = await seedProduct({ sku: "CERT-BACKWARDS" });

    await expect(
      attach(await lotOf(product.id), { issueDate: "2026-08-12", expiryDate: "2020-01-01" }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      details: { field: "expiryDate" },
    });
  });

  it("leaves no file behind when the metadata is rejected", async () => {
    await signInWithRole("ADMIN");
    const product = await seedProduct({ sku: "CERT-CLEANUP" });

    await expect(
      attach(await lotOf(product.id), { certificateNumber: "" }),
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

    const first = await attach(await lotOf(product.id), { certificateNumber: "FIRST-001" });
    const second = await attach(await lotOf(product.id), { certificateNumber: "SECOND-002" });

    const current = await getLotCertificate(await lotOf(product.id));
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

    const first = await attach(await lotOf(product.id), { certificateNumber: "OLD-1" });
    await attach(await lotOf(product.id), { certificateNumber: "NEW-1" });

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

    await attach(await lotOf(product.id), { certificateNumber: "A" });
    await attach(await lotOf(product.id), { certificateNumber: "B" });
    await attach(await lotOf(product.id), { certificateNumber: "C" });

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

    const certificate = await attach(await lotOf(product.id));
    await removeCertificate(certificate.id);

    expect(await getLotCertificate(await lotOf(product.id))).toBeNull();

    const result = await getProductDetail(product.id);
    if (!result.ok || !result.data) throw new Error("expected a product");
    expect(result.data.lots[0]!.certificateStatus).toBe("MISSING");
  });

  it("keeps the record as history rather than destroying it", async () => {
    await signInWithRole("ADMIN");
    const product = await seedProduct({ sku: "CERT-REMOVE-HIST" });

    const certificate = await attach(await lotOf(product.id), {
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

    const certificate = await attach(await lotOf(product.id));
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

    const certificate = await attach(await lotOf(product.id), {
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

    const first = await attach(await lotOf(product.id), { certificateNumber: "OLD" });
    await attach(await lotOf(product.id), { certificateNumber: "NEW" });

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
    await attach(await lotOf(expired.id), {
      issueDate: "2020-01-01",
      expiryDate: isoDaysFromNow(-1),
    });

    const noExpiry = await seedProduct({ sku: "CERT-NOEXPIRY" });
    await attach(await lotOf(noExpiry.id), { expiryDate: "" });

    const soon = await seedProduct({ sku: "CERT-SOON" });
    await attach(await lotOf(soon.id), { issueDate: "2020-01-01", expiryDate: isoDaysFromNow(5) });

    for (const [id, expected] of [
      [expired.id, "EXPIRED"],
      [noExpiry.id, "VALID"],
      [soon.id, "EXPIRING_SOON"],
    ] as const) {
      const result = await getProductDetail(id);
      if (!result.ok || !result.data) throw new Error("expected a product");
      expect(result.data.lots[0]!.certificateStatus).toBe(expected);
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
    const certificate = await attach(await lotOf(product.id));

    signOutSupabase();

    await expect(getCertificateFile(certificate.id)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      status: 401,
    });
  });

  it("refuses an unauthenticated request even for an id that does not exist", async () => {
    signOutSupabase();

    // 401 rather than 404: a signed-out visitor must not be able to map which
    // certificate ids exist by watching which ones come back differently.
    await expect(getCertificateFile("made-up-id")).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  it("lets STAFF read one — viewing is part of the job", async () => {
    await signInWithRole("ADMIN");
    const product = await seedProduct({ sku: "CERT-STAFFREAD" });
    const certificate = await attach(await lotOf(product.id));

    signOutSupabase();
    await signInWithRole("STAFF");

    const file = await getCertificateFile(certificate.id);
    expect(file.contentType).toBe("application/pdf");
    expect(file.body.equals(PDF_BYTES)).toBe(true);
  });

  it("reports a row whose stored bytes have gone, rather than failing opaquely", async () => {
    await signInWithRole("ADMIN");
    const product = await seedProduct({ sku: "CERT-LOSTBYTES" });
    const certificate = await attach(await lotOf(product.id));

    const row = await prisma.certificate.findUniqueOrThrow({
      where: { id: certificate.id },
      select: { storageKey: true },
    });

    /*
     * The state a storage migration can leave behind: the metadata came across
     * and the object did not. It is worth its own message because nothing the
     * user did caused it and retrying will not fix it — and because this is
     * exactly the failure to expect if the six existing local files are not
     * carried over when the driver is switched.
     *
     * The driver reports a missing object as null rather than throwing, which
     * is what lets this surface as NOT_FOUND instead of a 500.
     */
    await fileStorage.delete(row.storageKey);
    expect(await fileStorage.exists(row.storageKey)).toBe(false);

    await expect(getCertificateFile(certificate.id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });

    // The certificate itself is untouched — the compliance record survives the
    // loss of the document, which is the honest outcome.
    expect(
      await prisma.certificate.count({ where: { id: certificate.id } }),
    ).toBe(1);
  });
});

describe("who may change a certificate", () => {
  it("refuses STAFF an upload", async () => {
    await signInWithRole("STAFF");
    const product = await seedProduct({ sku: "CERT-STAFFUP" });

    await expect(attach(await lotOf(product.id))).rejects.toMatchObject({
      code: "FORBIDDEN",
      status: 403,
    });

    expect(await prisma.certificate.count()).toBe(0);
  });

  it("refuses STAFF a metadata edit", async () => {
    await signInWithRole("ADMIN");
    const product = await seedProduct({ sku: "CERT-STAFFEDIT" });
    const certificate = await attach(await lotOf(product.id), {
      certificateNumber: "UNTOUCHED",
    });

    signOutSupabase();
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
    const certificate = await attach(await lotOf(product.id));

    signOutSupabase();
    await signInWithRole("STAFF");

    await expect(removeCertificate(certificate.id)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });

    expect(await getLotCertificate(await lotOf(product.id))).not.toBeNull();
  });

  it("refuses an unauthenticated upload", async () => {
    const product = await seedProduct({ sku: "CERT-ANONUP" });

    await expect(attach(await lotOf(product.id))).rejects.toMatchObject({
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
      openingStockCostBasis: "KNOWN",
      openingStockUnitCost: "12.00",
      status: "ACTIVE",
    });

    await attach(await lotOf(created.id), { certificateNumber: "FIRST" });
    await attach(await lotOf(created.id), { certificateNumber: "SECOND" });

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

// ---------------------------------------------------------------------------
// Paperwork belongs to the batch
// ---------------------------------------------------------------------------

describe("certificates belong to lots", () => {
  /** A second batch of an existing product, received from a supplier. */
  async function secondLot(productId: string, quantity = 5) {
    const supplier = await createSupplier("Second Source");
    const purchase = await createPurchase({
      supplierId: supplier.id,
      items: [{ productId, quantity, unitCost: "10.00" }],
    });
    await receivePurchase(purchase.id);

    const lot = await prisma.stockLot.findFirstOrThrow({
      where: { sourceType: "PURCHASE", sourceId: purchase.id },
      select: { id: true },
    });
    return lot.id;
  }

  it("lets two batches of one part hold different paperwork at once", async () => {
    /*
     * The reason the model moved off the product. A part whose catalogue entry
     * reads "certified" can still have units on the shelf that arrived under a
     * different release, or none at all — and now the system can say so.
     */
    await signInWithRole("ADMIN");
    const product = await seedProduct({ sku: "TWO-LOTS", stockQuantity: 10 });

    const openingLot = await lotOf(product.id);
    const deliveredLot = await secondLot(product.id);

    // Only the newer batch gets paperwork.
    await attach(deliveredLot, { certificateNumber: "COVERED-1" });

    const result = await getProductDetail(product.id);
    if (!result.ok || !result.data) throw new Error("expected a product");

    const byLot = new Map(result.data.lots.map((lot) => [lot.id, lot]));
    expect(byLot.size).toBe(2);

    expect(byLot.get(openingLot)!.certificate).toBeNull();
    expect(byLot.get(openingLot)!.certificateStatus).toBe("MISSING");

    expect(byLot.get(deliveredLot)!.certificate?.certificateNumber).toBe(
      "COVERED-1",
    );
    expect(byLot.get(deliveredLot)!.certificateStatus).toBe("VALID");
  });

  it("allows only one current certificate per batch, not per product", async () => {
    await signInWithRole("ADMIN");
    const product = await seedProduct({ sku: "ONE-PER-LOT", stockQuantity: 10 });

    const first = await lotOf(product.id);
    const second = await secondLot(product.id);

    // Two current certificates on one product is now perfectly legal, because
    // they cover different units.
    await attach(first, { certificateNumber: "LOT-A" });
    await attach(second, { certificateNumber: "LOT-B" });

    expect(
      await prisma.certificate.count({
        where: { productId: product.id, supersededAt: null },
      }),
    ).toBe(2);

    // A second one on the *same* batch retires the first.
    await attach(second, { certificateNumber: "LOT-B-REPLACED" });

    const current = await getLotCertificate(second);
    expect(current?.certificateNumber).toBe("LOT-B-REPLACED");
    expect(
      await prisma.certificate.count({ where: { stockLotId: second } }),
    ).toBe(2);
    expect(
      await prisma.certificate.count({
        where: { stockLotId: second, supersededAt: null },
      }),
    ).toBe(1);
  });

  it("refuses a certificate whose product disagrees with its lot", async () => {
    /*
     * Enforced by the composite foreign key onto stock_lots (id, product_id)
     * rather than by application code, so no write path can get it wrong.
     */
    await signInWithRole("ADMIN");
    const a = await seedProduct({ sku: "MISMATCH-A", stockQuantity: 5 });
    const b = await seedProduct({ sku: "MISMATCH-B", stockQuantity: 5 });

    await expect(
      prisma.certificate.create({
        data: {
          productId: b.id,
          stockLotId: await lotOf(a.id),
          certificateType: "FAA 8130-3",
          certificateNumber: "WRONG-1",
          issueDate: new Date("2026-01-01"),
          expiryDate: null,
          fileName: "c.pdf",
          storageKey: "key-mismatch",
          contentType: "application/pdf",
          fileSize: 10,
        },
      }),
    ).rejects.toThrow();

    expect(await prisma.certificate.count()).toBe(0);
  });

  it("refuses a new certificate that names no batch", async () => {
    /*
     * The check constraint. A row with no lot is history by definition, so a
     * current one without a lot cannot be written at all — which is what stops
     * product-level coverage coming back through a side door.
     */
    await signInWithRole("ADMIN");
    const product = await seedProduct({ sku: "NO-LOT", stockQuantity: 5 });

    await expect(
      prisma.certificate.create({
        data: {
          productId: product.id,
          certificateType: "FAA 8130-3",
          certificateNumber: "ORPHAN-1",
          issueDate: new Date("2026-01-01"),
          expiryDate: null,
          fileName: "c.pdf",
          storageKey: "key-orphan",
          contentType: "application/pdf",
          fileSize: 10,
        },
      }),
    ).rejects.toThrow();

    expect(await prisma.certificate.count()).toBe(0);
  });

  it("keeps legacy product-level history readable", async () => {
    /*
     * Certificates filed before paperwork moved to batches carry no lot. The
     * migration retires them rather than guessing which units they covered, and
     * they stay readable as the record that the documents were ever filed.
     */
    await signInWithRole("ADMIN");
    const product = await seedProduct({ sku: "LEGACY-1", stockQuantity: 5 });

    const legacy = await prisma.certificate.create({
      data: {
        productId: product.id,
        stockLotId: null,
        supersededAt: new Date("2026-02-01"),
        certificateType: "Certificate of Conformity",
        certificateNumber: "LEGACY-0001",
        issueDate: new Date("2025-06-01"),
        expiryDate: null,
        fileName: "legacy.pdf",
        storageKey: "key-legacy",
        contentType: "application/pdf",
        fileSize: 10,
      },
    });

    const history = await getCertificateHistory(product.id);
    expect(history.map((entry) => entry.id)).toContain(legacy.id);
    expect(history[0]!.stockLotId).toBeNull();

    // It covers nothing: the batch on the shelf still reads as MISSING.
    const result = await getProductDetail(product.id);
    if (!result.ok || !result.data) throw new Error("expected a product");
    expect(result.data.lots[0]!.certificateStatus).toBe("MISSING");
  });

  it("keeps a batch's paperwork after its units are gone", async () => {
    await signInWithRole("ADMIN");
    const product = await seedProduct({ sku: "DRAWN-DOWN", stockQuantity: 4 });
    const lotId = await lotOf(product.id);

    const certificate = await attach(lotId, { certificateNumber: "SOLD-OUT" });

    await adjustStock({
      productId: product.id,
      quantity: "4",
      direction: "DECREASE",
      reason: "Consumed for a test",
    });

    const lot = await prisma.stockLot.findUniqueOrThrow({
      where: { id: lotId },
      select: { quantityRemaining: true },
    });
    expect(lot.quantityRemaining).toBe(0);

    // The document survives the units it covered.
    const still = await getLotCertificate(lotId);
    expect(still?.id).toBe(certificate.id);
  });

  it("deletes a never-traded product's certificates before its lots", async () => {
    /*
     * The lot foreign key is RESTRICT, so `deleteProduct` has to remove the
     * paperwork first. Without that ordering this delete fails outright.
     */
    await signInWithRole("ADMIN");
    const created = await createProduct({
      name: "Untraded Part",
      sku: "UNTRADED-1",
      category: "Airframe",
      sellingPrice: "20.00",
      stockQuantity: "3",
      openingStockCostBasis: "KNOWN",
      openingStockUnitCost: "12.00",
      status: "ACTIVE",
    });

    const lotId = await lotOf(created.id);
    await attach(lotId, { certificateNumber: "BYE-1" });

    // The storage key never leaves the server, so it is read from the row
    // rather than from the view the UI gets.
    const { storageKey } = await prisma.certificate.findFirstOrThrow({
      where: { productId: created.id },
      select: { storageKey: true },
    });
    expect(await fileStorage.exists(storageKey)).toBe(true);

    await deleteProduct(created.id);

    expect(await prisma.certificate.count()).toBe(0);
    expect(await prisma.stockLot.count({ where: { id: lotId } })).toBe(0);
    expect(await fileStorage.exists(storageKey)).toBe(false);
  });
});
