import { beforeEach, describe, expect, it } from "vitest";

import { EXPIRING_SOON_DAYS } from "@/lib/certificate-status";
import { prisma } from "@/lib/prisma";
import {
  parseReportParams,
  reportParamsFor,
  type ReportParams,
} from "@/lib/report-query";
import { loadCertificateTypes } from "@/server/certificates";
import { loadCertificateRegisterReport } from "@/server/reports";
import { createPurchase, receivePurchase } from "@/server/purchases";

import { signOutSupabase } from "./supabase-auth-mock";
import {
  createSupplier,
  resetDatabase,
  seedProduct,
  signInWithRole,
} from "./database";

/**
 * The certificate compliance register.
 *
 * A register is read by somebody answering an auditor, so nearly everything
 * asserted here is about what it refuses to do: it does not omit a batch
 * because nothing is filed against it, does not treat a document with no expiry
 * as a problem, does not let a superseded document read as current coverage,
 * does not give a batch a supplier it did not come from, and does not confuse
 * "this batch is quarantined" with "this batch has no paperwork".
 *
 * Lot grain throughout. A part with two batches in different states is two
 * rows, because that is the fact somebody has to act on.
 */

beforeEach(async () => {
  signOutSupabase();
  await resetDatabase();
});

function params(overrides: Partial<ReportParams> = {}): ReportParams {
  return {
    ...parseReportParams(
      { range: "all" },
      {
        groupings: [],
        defaultGrouping: "lot",
        sortKeys: [
          "expiry",
          "sku",
          "name",
          "units",
          "received",
          "status",
          "supplier",
        ],
        defaultSort: "expiry",
        defaultDirection: "asc",
      },
    ),
    ...overrides,
  };
}

/** A fixed "today", so expiry arithmetic is not a race against the clock. */
const NOW = new Date("2026-06-15T12:00:00.000Z");

function daysFromNow(days: number): Date {
  return new Date(NOW.getTime() + days * 86_400_000);
}

function unwrap<T>(result: { ok: true; data: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`);
  return result.data;
}

async function load(overrides: Partial<ReportParams> = {}) {
  return unwrap(await loadCertificateRegisterReport(params(overrides), NOW));
}

/** The single lot `seedProduct` created, which is what most tests attach to. */
async function lotOf(productId: string) {
  return prisma.stockLot.findFirstOrThrow({ where: { productId } });
}

async function certificateFor(
  lotId: string,
  productId: string,
  expiryDate: Date | null,
  overrides: {
    certificateType?: string;
    certificateNumber?: string;
    supersededAt?: Date | null;
    stockLotId?: string | null;
  } = {},
) {
  return prisma.certificate.create({
    data: {
      certificateType: overrides.certificateType ?? "FAA 8130-3",
      certificateNumber: overrides.certificateNumber ?? "CERT-001",
      issueDate: new Date("2026-01-01T00:00:00.000Z"),
      expiryDate,
      fileName: "cert.pdf",
      storageKey: `k-${Math.random().toString(36).slice(2, 10)}`,
      contentType: "application/pdf",
      fileSize: 1024,
      productId,
      stockLotId:
        overrides.stockLotId === undefined ? lotId : overrides.stockLotId,
      supersededAt: overrides.supersededAt ?? null,
    },
  });
}

// ---------------------------------------------------------------------------
// The four compliance states
// ---------------------------------------------------------------------------

describe("compliance states", () => {
  it("reports a batch with no certificate as MISSING, and still lists it", async () => {
    await signInWithRole("STAFF");
    await seedProduct({ sku: "CR-MISS", stockQuantity: 5 });

    const page = await load();

    expect(page.rows).toHaveLength(1);
    const row = page.rows[0]!;

    // The lot columns are all present — a missing certificate is not a missing row.
    expect(row.sku).toBe("CR-MISS");
    expect(row.quantityRemaining).toBe(5);
    expect(row.lotStatus).toBe("SALEABLE");
    expect(row.productStatus).toBe("ACTIVE");
    expect(row.status).toBe("MISSING");

    // And nothing is invented on the certificate side.
    expect(row.certificateId).toBeNull();
    expect(row.certificateType).toBeNull();
    expect(row.certificateNumber).toBeNull();
    expect(row.issueDate).toBeNull();
    expect(row.expiryDate).toBeNull();
    expect(row.daysToExpiry).toBeNull();
    expect(row.fileUrl).toBeNull();

    expect(page.totals.missing).toBe(1);
    expect(page.totals.batches).toBe(1);
  });

  it("reports an expired certificate", async () => {
    await signInWithRole("STAFF");
    const product = await seedProduct({ sku: "CR-EXP", stockQuantity: 3 });
    const lot = await lotOf(product.id);
    await certificateFor(lot.id, product.id, daysFromNow(-1));

    const page = await load();

    expect(page.rows[0]!.status).toBe("EXPIRED");
    expect(page.rows[0]!.daysToExpiry).toBe(-1);
    expect(page.totals.expired).toBe(1);
  });

  it("reports a certificate expiring inside the horizon", async () => {
    await signInWithRole("STAFF");
    const product = await seedProduct({ sku: "CR-SOON", stockQuantity: 3 });
    const lot = await lotOf(product.id);
    await certificateFor(lot.id, product.id, daysFromNow(10));

    const page = await load();

    expect(page.rows[0]!.status).toBe("EXPIRING_SOON");
    expect(page.rows[0]!.daysToExpiry).toBe(10);
    expect(page.totals.expiringSoon).toBe(1);
  });

  it("reports a certificate beyond the horizon as VALID", async () => {
    await signInWithRole("STAFF");
    const product = await seedProduct({ sku: "CR-OK", stockQuantity: 3 });
    const lot = await lotOf(product.id);
    await certificateFor(lot.id, product.id, daysFromNow(200));

    const page = await load();

    expect(page.rows[0]!.status).toBe("VALID");
    expect(page.totals.valid).toBe(1);
  });

  it("treats a certificate with no expiry date as VALID", async () => {
    await signInWithRole("STAFF");
    const product = await seedProduct({ sku: "CR-COC", stockQuantity: 3 });
    const lot = await lotOf(product.id);
    await certificateFor(lot.id, product.id, null, {
      certificateType: "Certificate of Conformity",
    });

    const page = await load();
    const row = page.rows[0]!;

    // A CoC typically never expires. Null is a complete answer, not a gap.
    expect(row.status).toBe("VALID");
    expect(row.expiryDate).toBeNull();
    expect(row.daysToExpiry).toBeNull();
    expect(page.totals.valid).toBe(1);
    expect(page.totals.missing).toBe(0);
  });

  it("holds the horizon boundary at exactly 30 and 31 days", async () => {
    await signInWithRole("STAFF");
    expect(EXPIRING_SOON_DAYS).toBe(30);

    const onBoundary = await seedProduct({ sku: "CR-D30", stockQuantity: 1 });
    const pastBoundary = await seedProduct({ sku: "CR-D31", stockQuantity: 1 });

    await certificateFor(
      (await lotOf(onBoundary.id)).id,
      onBoundary.id,
      daysFromNow(EXPIRING_SOON_DAYS),
    );
    await certificateFor(
      (await lotOf(pastBoundary.id)).id,
      pastBoundary.id,
      daysFromNow(EXPIRING_SOON_DAYS + 1),
    );

    const page = await load({ sort: "sku", direction: "asc" });
    const bySku = new Map(page.rows.map((row) => [row.sku, row] as const));

    // Thirty days is inside the warning; thirty-one is not.
    expect(bySku.get("CR-D30")!.status).toBe("EXPIRING_SOON");
    expect(bySku.get("CR-D31")!.status).toBe("VALID");
    expect(page.totals.expiringSoon).toBe(1);
    expect(page.totals.valid).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Which certificate counts
// ---------------------------------------------------------------------------

describe("which certificate is current", () => {
  it("ignores a superseded certificate and reads the current one", async () => {
    await signInWithRole("STAFF");
    const product = await seedProduct({ sku: "CR-SUP", stockQuantity: 2 });
    const lot = await lotOf(product.id);

    await certificateFor(lot.id, product.id, daysFromNow(-90), {
      certificateNumber: "OLD-1",
      supersededAt: new Date("2026-05-01T00:00:00.000Z"),
    });
    await certificateFor(lot.id, product.id, daysFromNow(300), {
      certificateNumber: "NEW-1",
    });

    const page = await load();

    // One row, and the expired predecessor does not drag it down.
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]!.certificateNumber).toBe("NEW-1");
    expect(page.rows[0]!.status).toBe("VALID");
    expect(page.totals.expired).toBe(0);
  });

  it("shows a batch as MISSING when its only certificate was superseded", async () => {
    await signInWithRole("STAFF");
    const product = await seedProduct({ sku: "CR-SUP2", stockQuantity: 2 });
    const lot = await lotOf(product.id);

    await certificateFor(lot.id, product.id, daysFromNow(300), {
      supersededAt: new Date("2026-05-01T00:00:00.000Z"),
    });

    const page = await load();

    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]!.status).toBe("MISSING");
    expect(page.rows[0]!.certificateId).toBeNull();
  });

  it("never shows a legacy certificate with no batch", async () => {
    await signInWithRole("STAFF");
    const product = await seedProduct({ sku: "CR-LEGACY", stockQuantity: 2 });

    /*
     * Product-level paperwork filed before certificates moved to batches. The
     * database only permits it while superseded — `certificates_lot_required_
     * unless_historical` — and the register joins on the lot, so it cannot
     * surface as coverage here. It stays readable as history on the product.
     */
    await certificateFor("", product.id, daysFromNow(300), {
      stockLotId: null,
      supersededAt: new Date("2026-04-01T00:00:00.000Z"),
    });

    const page = await load();

    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]!.status).toBe("MISSING");
    expect(page.rows[0]!.certificateId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Which batches appear
// ---------------------------------------------------------------------------

describe("which batches appear", () => {
  it("excludes emptied batches by default and includes them on request", async () => {
    await signInWithRole("STAFF");
    const product = await seedProduct({ sku: "CR-ZERO", stockQuantity: 4 });
    const lot = await lotOf(product.id);
    await certificateFor(lot.id, product.id, daysFromNow(100));

    await prisma.stockLot.update({
      where: { id: lot.id },
      data: { quantityRemaining: 0 },
    });

    // Nothing on the shelf left to be uncertain about.
    expect((await load()).rows).toHaveLength(0);

    // But the paperwork is still reachable.
    const withEmptied = await load({ includeEmptied: true });
    expect(withEmptied.rows).toHaveLength(1);
    expect(withEmptied.rows[0]!.quantityRemaining).toBe(0);
    expect(withEmptied.rows[0]!.status).toBe("VALID");
  });

  it("includes saleable, quarantined and rejected batches alike", async () => {
    await signInWithRole("STAFF");
    const product = await seedProduct({ sku: "CR-STATUS", stockQuantity: 3 });
    const first = await lotOf(product.id);

    const quarantined = await prisma.stockLot.create({
      data: {
        productId: product.id,
        quantityReceived: 2,
        quantityRemaining: 2,
        costSource: "UNKNOWN",
        sourceType: "MANUAL",
        receivedAt: new Date("2026-02-01T00:00:00.000Z"),
        status: "QUARANTINED",
      },
    });

    const rejected = await prisma.stockLot.create({
      data: {
        productId: product.id,
        quantityReceived: 1,
        quantityRemaining: 1,
        costSource: "UNKNOWN",
        sourceType: "MANUAL",
        receivedAt: new Date("2026-03-01T00:00:00.000Z"),
        status: "REJECTED",
        statusChangedAt: new Date("2026-03-02T00:00:00.000Z"),
        statusNote: "Corroded",
      },
    });

    /*
     * A quarantined batch with a perfectly good certificate. Lot status and
     * compliance status are different questions, and the register must not
     * collapse one into the other.
     */
    await certificateFor(quarantined.id, product.id, daysFromNow(300));

    const page = await load({ sort: "received", direction: "asc" });
    const byStatus = new Map(page.rows.map((row) => [row.lotStatus, row] as const));

    expect(page.rows).toHaveLength(3);
    expect(byStatus.get("SALEABLE")!.status).toBe("MISSING");
    expect(byStatus.get("QUARANTINED")!.status).toBe("VALID");
    expect(byStatus.get("REJECTED")!.status).toBe("MISSING");

    expect(first.status).toBe("SALEABLE");
    expect(rejected.status).toBe("REJECTED");
  });

  it("keeps retired products queryable", async () => {
    await signInWithRole("STAFF");
    await seedProduct({ sku: "CR-ACT", stockQuantity: 1, status: "ACTIVE" });
    await seedProduct({ sku: "CR-INA", stockQuantity: 1, status: "INACTIVE" });
    await seedProduct({ sku: "CR-DIS", stockQuantity: 1, status: "DISCONTINUED" });

    // Unfiltered, the register does not silently discard retired physical stock.
    const all = await load({ sort: "sku", direction: "asc" });
    expect(all.rows.map((row) => row.sku)).toEqual(["CR-ACT", "CR-DIS", "CR-INA"]);

    for (const [status, sku] of [
      ["ACTIVE", "CR-ACT"],
      ["INACTIVE", "CR-INA"],
      ["DISCONTINUED", "CR-DIS"],
    ] as const) {
      const page = await load({ productStatus: status });
      expect(page.rows.map((row) => row.sku)).toEqual([sku]);
    }
  });

  it("represents two batches of one product independently", async () => {
    await signInWithRole("STAFF");
    const product = await seedProduct({ sku: "CR-TWO", stockQuantity: 5 });
    const covered = await lotOf(product.id);
    await certificateFor(covered.id, product.id, daysFromNow(400));

    await prisma.stockLot.create({
      data: {
        productId: product.id,
        quantityReceived: 7,
        quantityRemaining: 7,
        costSource: "UNKNOWN",
        sourceType: "MANUAL",
        receivedAt: new Date("2026-05-01T00:00:00.000Z"),
      },
    });

    const page = await load();

    // One problem and one clean batch — not one product's worth of doubt.
    expect(page.rows).toHaveLength(2);
    expect(page.totals.valid).toBe(1);
    expect(page.totals.missing).toBe(1);
    expect(new Set(page.rows.map((row) => row.sku))).toEqual(new Set(["CR-TWO"]));
  });
});

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

describe("provenance", () => {
  it("names the supplier behind a purchased batch, and nobody otherwise", async () => {
    await signInWithRole("ADMIN");
    const supplier = await createSupplier("Aviation Spares Ltd");
    const product = await seedProduct({ sku: "CR-PROV", stockQuantity: 0 });

    const purchase = await createPurchase({
      supplierId: supplier.id,
      items: [{ productId: product.id, quantity: 4, unitCost: "30.00" }],
    });
    await receivePurchase(purchase.id);

    // A second batch that never came from a purchase.
    await prisma.stockLot.create({
      data: {
        productId: product.id,
        quantityReceived: 2,
        quantityRemaining: 2,
        costSource: "UNKNOWN",
        sourceType: "MANUAL",
        receivedAt: new Date("2026-05-20T00:00:00.000Z"),
      },
    });

    const page = await load({ sort: "received", direction: "asc" });
    const byProvenance = new Map(
      page.rows.map((row) => [row.provenance, row] as const),
    );

    const purchased = byProvenance.get("PURCHASE")!;
    expect(purchased.supplierName).toBe("Aviation Spares Ltd");
    expect(purchased.purchaseNumber).toBe(purchase.purchaseNumber);
    expect(purchased.purchaseId).toBe(purchase.id);

    // Provenance is an acquisition fact. A batch with no purchase behind it has
    // no supplier at all, and must not borrow the product's.
    const manual = byProvenance.get("MANUAL")!;
    expect(manual.supplierName).toBeNull();
    expect(manual.purchaseNumber).toBeNull();
    expect(manual.purchaseId).toBeNull();
  });

  it("filters by supplier without sweeping in supplier-less batches", async () => {
    await signInWithRole("ADMIN");
    const supplier = await createSupplier("Filtered Supply Co");
    const product = await seedProduct({ sku: "CR-SUPFIL", stockQuantity: 3 });

    const purchase = await createPurchase({
      supplierId: supplier.id,
      items: [{ productId: product.id, quantity: 2, unitCost: "10.00" }],
    });
    await receivePurchase(purchase.id);

    const page = await load({ supplierId: supplier.id });

    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]!.provenance).toBe("PURCHASE");
    expect(page.rows[0]!.supplierName).toBe("Filtered Supply Co");
  });
});

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

describe("filters", () => {
  async function scenario() {
    const expired = await seedProduct({
      sku: "F-EXPIRED",
      stockQuantity: 1,
      category: "Avionics",
    });
    const soon = await seedProduct({
      sku: "F-SOON",
      stockQuantity: 1,
      category: "Avionics",
    });
    const valid = await seedProduct({
      sku: "F-VALID",
      stockQuantity: 1,
      category: "Airframe",
    });
    await seedProduct({ sku: "F-MISSING", stockQuantity: 1, category: "Airframe" });

    await certificateFor((await lotOf(expired.id)).id, expired.id, daysFromNow(-5), {
      certificateType: "EASA Form 1",
      certificateNumber: "AAA-111",
    });
    await certificateFor((await lotOf(soon.id)).id, soon.id, daysFromNow(7), {
      certificateType: "FAA 8130-3",
      certificateNumber: "BBB-222",
    });
    await certificateFor((await lotOf(valid.id)).id, valid.id, null, {
      certificateType: "Certificate of Conformity",
      certificateNumber: "CCC-333",
    });
  }

  it("filters by each compliance status", async () => {
    await signInWithRole("STAFF");
    await scenario();

    for (const [status, sku] of [
      ["EXPIRED", "F-EXPIRED"],
      ["EXPIRING_SOON", "F-SOON"],
      ["VALID", "F-VALID"],
      ["MISSING", "F-MISSING"],
    ] as const) {
      const page = await load({ certificateStatus: status });
      expect(page.rows.map((row) => row.sku)).toEqual([sku]);
      expect(page.rows[0]!.status).toBe(status);
      expect(page.total).toBe(1);
    }
  });

  it("filters by certificate type", async () => {
    await signInWithRole("STAFF");
    await scenario();

    const page = await load({ certificateType: "EASA Form 1" });
    expect(page.rows.map((row) => row.sku)).toEqual(["F-EXPIRED"]);
  });

  it("filters by lot status", async () => {
    await signInWithRole("STAFF");
    const product = await seedProduct({ sku: "F-LOT", stockQuantity: 2 });
    await prisma.stockLot.create({
      data: {
        productId: product.id,
        quantityReceived: 1,
        quantityRemaining: 1,
        costSource: "UNKNOWN",
        sourceType: "MANUAL",
        receivedAt: new Date("2026-04-01T00:00:00.000Z"),
        status: "QUARANTINED",
      },
    });

    const page = await load({ lotStatus: "QUARANTINED" });
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]!.lotStatus).toBe("QUARANTINED");
  });

  it("filters by category", async () => {
    await signInWithRole("STAFF");
    await scenario();

    const page = await load({ category: "Avionics", sort: "sku", direction: "asc" });
    expect(page.rows.map((row) => row.sku)).toEqual(["F-EXPIRED", "F-SOON"]);
  });

  it("searches SKU, product name and certificate number", async () => {
    await signInWithRole("STAFF");
    await scenario();

    expect((await load({ search: "F-SOON" })).rows.map((r) => r.sku)).toEqual([
      "F-SOON",
    ]);
    expect((await load({ search: "BBB-222" })).rows.map((r) => r.sku)).toEqual([
      "F-SOON",
    ]);
    expect(
      (await load({ search: "Product F-VALID" })).rows.map((r) => r.sku),
    ).toEqual(["F-VALID"]);
  });
});

// ---------------------------------------------------------------------------
// Sorting and paging
// ---------------------------------------------------------------------------

describe("sorting", () => {
  async function spread() {
    const a = await seedProduct({ sku: "S-A", name: "Zulu part", stockQuantity: 9 });
    const b = await seedProduct({ sku: "S-B", name: "Alpha part", stockQuantity: 1 });
    const c = await seedProduct({ sku: "S-C", name: "Mike part", stockQuantity: 5 });

    await prisma.stockLot.updateMany({
      where: { productId: a.id },
      data: { receivedAt: new Date("2026-01-01T00:00:00.000Z") },
    });
    await prisma.stockLot.updateMany({
      where: { productId: b.id },
      data: { receivedAt: new Date("2026-02-01T00:00:00.000Z") },
    });
    await prisma.stockLot.updateMany({
      where: { productId: c.id },
      data: { receivedAt: new Date("2026-03-01T00:00:00.000Z") },
    });

    await certificateFor((await lotOf(a.id)).id, a.id, daysFromNow(60));
    await certificateFor((await lotOf(b.id)).id, b.id, daysFromNow(5));
    // S-C has no certificate, so it has no expiry date to sort on.
  }

  it("defaults to soonest expiry first, with undated rows last", async () => {
    await signInWithRole("STAFF");
    await spread();

    const page = await load();

    // Soonest problem first; the batch with no paperwork sorts behind the
    // dated ones, which is the order somebody works the list in.
    expect(page.rows.map((row) => row.sku)).toEqual(["S-B", "S-A", "S-C"]);
  });

  it("sorts by every offered key", async () => {
    await signInWithRole("STAFF");
    await spread();

    expect(
      (await load({ sort: "sku", direction: "asc" })).rows.map((r) => r.sku),
    ).toEqual(["S-A", "S-B", "S-C"]);

    expect(
      (await load({ sort: "name", direction: "asc" })).rows.map((r) => r.productName),
    ).toEqual(["Alpha part", "Mike part", "Zulu part"]);

    expect(
      (await load({ sort: "units", direction: "desc" })).rows.map(
        (r) => r.quantityRemaining,
      ),
    ).toEqual([9, 5, 1]);

    expect(
      (await load({ sort: "received", direction: "asc" })).rows.map((r) => r.sku),
    ).toEqual(["S-A", "S-B", "S-C"]);

    expect(
      (await load({ sort: "status", direction: "asc" })).rows.map((r) => r.sku),
    ).toEqual(["S-B", "S-A", "S-C"]);
  });

  it("sorts by supplier, leaving supplier-less batches last", async () => {
    await signInWithRole("ADMIN");
    const supplier = await createSupplier("Zeta Supply");
    const product = await seedProduct({ sku: "S-SUP", stockQuantity: 1 });

    const purchase = await createPurchase({
      supplierId: supplier.id,
      items: [{ productId: product.id, quantity: 2, unitCost: "5.00" }],
    });
    await receivePurchase(purchase.id);

    const page = await load({ sort: "supplier", direction: "asc" });

    expect(page.rows[0]!.supplierName).toBe("Zeta Supply");
    expect(page.rows[page.rows.length - 1]!.supplierName).toBeNull();
  });
});

describe("paging", () => {
  it("pages without changing the totals", async () => {
    await signInWithRole("STAFF");
    for (const suffix of ["a", "b", "c"]) {
      await seedProduct({ sku: `P-${suffix}`, stockQuantity: 1 });
    }

    const first = await load({ sort: "sku", direction: "asc", page: 1, pageSize: 2 });
    expect(first.rows).toHaveLength(2);
    expect(first.total).toBe(3);
    expect(first.pageCount).toBe(2);
    expect(first.totals.batches).toBe(3);

    const second = await load({ sort: "sku", direction: "asc", page: 2, pageSize: 2 });
    expect(second.rows).toHaveLength(1);
    // Totals describe the whole result, never the page.
    expect(second.totals.batches).toBe(3);
    expect(second.totals.missing).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// The file link, and authorisation
// ---------------------------------------------------------------------------

describe("the certificate file", () => {
  it("links through the authenticated route, and only when one is filed", async () => {
    await signInWithRole("STAFF");
    const covered = await seedProduct({ sku: "FILE-YES", stockQuantity: 1 });
    await seedProduct({ sku: "FILE-NO", stockQuantity: 1 });

    const certificate = await certificateFor(
      (await lotOf(covered.id)).id,
      covered.id,
      daysFromNow(90),
    );

    const page = await load({ sort: "sku", direction: "asc" });
    const bySku = new Map(page.rows.map((row) => [row.sku, row] as const));

    // The storage key never leaves the server; the row carries the route.
    expect(bySku.get("FILE-YES")!.fileUrl).toBe(
      `/api/certificates/${certificate.id}/file`,
    );
    expect(bySku.get("FILE-YES")!.fileName).toBe("cert.pdf");
    expect(bySku.get("FILE-NO")!.fileUrl).toBeNull();
    expect(bySku.get("FILE-NO")!.fileName).toBeNull();
  });
});

describe("the certificate-type filter options", () => {
  /*
   * `certificateType` is an open string, deliberately not an enum, so the
   * filter's options are read from what has actually been filed rather than
   * declared anywhere. These assertions are what stop that list drifting into
   * a hard-coded one.
   */
  it("lists the types on file, sorted, without duplicates", async () => {
    await signInWithRole("STAFF");

    const a = await seedProduct({ sku: "T-1", stockQuantity: 1 });
    const b = await seedProduct({ sku: "T-2", stockQuantity: 1 });
    const c = await seedProduct({ sku: "T-3", stockQuantity: 1 });

    await certificateFor((await lotOf(a.id)).id, a.id, null, {
      certificateType: "EASA Form 1",
    });
    await certificateFor((await lotOf(b.id)).id, b.id, null, {
      certificateType: "Certificate of Conformity",
    });
    // The same type twice must appear once.
    await certificateFor((await lotOf(c.id)).id, c.id, null, {
      certificateType: "EASA Form 1",
    });

    expect(await loadCertificateTypes()).toEqual([
      "Certificate of Conformity",
      "EASA Form 1",
    ]);
  });

  it("omits a type that survives only on a superseded document", async () => {
    await signInWithRole("STAFF");
    const product = await seedProduct({ sku: "T-SUP", stockQuantity: 1 });
    const lot = await lotOf(product.id);

    await certificateFor(lot.id, product.id, null, {
      certificateType: "Retired Form",
      certificateNumber: "OLD",
      supersededAt: new Date("2026-05-01T00:00:00.000Z"),
    });
    await certificateFor(lot.id, product.id, null, {
      certificateType: "FAA 8130-3",
      certificateNumber: "NEW",
    });

    // Offering it would be an option that always returns nothing, because the
    // register only ever joins the certificate in force.
    expect(await loadCertificateTypes()).toEqual(["FAA 8130-3"]);
  });

  it("returns nothing when no certificate is on file", async () => {
    await signInWithRole("STAFF");
    await seedProduct({ sku: "T-NONE", stockQuantity: 1 });

    expect(await loadCertificateTypes()).toEqual([]);
  });

  it("round-trips the chosen type through the URL and the query", async () => {
    await signInWithRole("STAFF");
    const covered = await seedProduct({ sku: "T-PICK", stockQuantity: 1 });
    const other = await seedProduct({ sku: "T-OTHER", stockQuantity: 1 });

    await certificateFor((await lotOf(covered.id)).id, covered.id, null, {
      certificateType: "EASA Form 1",
    });
    await certificateFor((await lotOf(other.id)).id, other.id, null, {
      certificateType: "FAA 8130-3",
    });

    // The URL contract the screen writes and the CSV route reads.
    const parsed = reportParamsFor("certificates", { ctype: "EASA Form 1" });
    expect(parsed.certificateType).toBe("EASA Form 1");

    const page = unwrap(
      await loadCertificateRegisterReport({ ...parsed, preset: "all" }, NOW),
    );
    expect(page.rows.map((row) => row.sku)).toEqual(["T-PICK"]);

    // Absent means no filter, not an empty one.
    expect(reportParamsFor("certificates", {}).certificateType).toBeNull();
  });
});

describe("the product-status default", () => {
  /*
   * Retired stock is in the register; what is defaulted is the *filter*. These
   * assertions are about the URL contract, because that contract is what the
   * screen and the CSV export both read.
   */
  it("opens on ACTIVE, and takes `all` as the way to lift it", () => {
    expect(reportParamsFor("certificates", {}).productStatus).toBe("ACTIVE");
    expect(
      reportParamsFor("certificates", { pstatus: "DISCONTINUED" }).productStatus,
    ).toBe("DISCONTINUED");
    expect(reportParamsFor("certificates", { pstatus: "all" }).productStatus).toBeNull();
    // A value that is not a status falls back to the default rather than
    // silently widening the report.
    expect(reportParamsFor("certificates", { pstatus: "nonsense" }).productStatus).toBe(
      "ACTIVE",
    );
  });

  it("leaves every other report showing all product statuses", () => {
    expect(reportParamsFor("valuation", {}).productStatus).toBeNull();
    expect(reportParamsFor("movements", {}).productStatus).toBeNull();
  });

  it("sorts ascending by default, unlike the money reports", () => {
    expect(reportParamsFor("certificates", {}).direction).toBe("asc");
    expect(reportParamsFor("certificates", {}).sort).toBe("expiry");
    expect(reportParamsFor("valuation", {}).direction).toBe("desc");
  });

  it("hides retired stock by default and shows it on request", async () => {
    await signInWithRole("STAFF");
    await seedProduct({ sku: "D-ACT", stockQuantity: 1, status: "ACTIVE" });
    await seedProduct({ sku: "D-DIS", stockQuantity: 1, status: "DISCONTINUED" });

    const defaulted = unwrap(
      await loadCertificateRegisterReport(
        { ...reportParamsFor("certificates", {}), preset: "all" },
        NOW,
      ),
    );
    expect(defaulted.rows.map((row) => row.sku)).toEqual(["D-ACT"]);

    const widened = unwrap(
      await loadCertificateRegisterReport(
        {
          ...reportParamsFor("certificates", { pstatus: "all", sort: "sku", dir: "asc" }),
          preset: "all",
        },
        NOW,
      ),
    );
    expect(widened.rows.map((row) => row.sku)).toEqual(["D-ACT", "D-DIS"]);
  });
});

describe("authorisation", () => {
  it("refuses a signed-out caller", async () => {
    signOutSupabase();

    const result = await loadCertificateRegisterReport(params(), NOW);
    expect(result.ok).toBe(false);
  });

  it("is available to staff as well as admins", async () => {
    await signInWithRole("STAFF");
    await seedProduct({ sku: "AUTH-1", stockQuantity: 1 });
    expect((await load()).rows).toHaveLength(1);

    await signInWithRole("ADMIN");
    expect((await load()).rows).toHaveLength(1);
  });
});
