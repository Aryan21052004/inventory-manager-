import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@clerk/nextjs/server", async () => {
  const { clerkServerMock } = await import("./clerk-mock");
  return clerkServerMock;
});

import { csvField, csvRow, toCsv } from "@/lib/csv";
import { prisma } from "@/lib/prisma";
import {
  parseReportParams,
  REPORT_CONFIG,
  type ReportParams,
} from "@/lib/report-query";
import {
  loadMovementSummaryReport,
  loadPurchaseSpendReport,
  loadSalesReport,
  loadValuationReport,
} from "@/server/reports";
import { GET } from "@/app/api/reports/[report]/csv/route";
import { confirmOrder, createOrder } from "@/server/orders";
import { createPurchase, receivePurchase } from "@/server/purchases";

import { signOut } from "./clerk-mock";
import {
  createSupplier,
  quoted,
  resetDatabase,
  seedProduct,
  signInWithRole,
} from "./database";

/**
 * The CSV export.
 *
 * Two things are being protected. The escaping, because a product name with a
 * comma in it silently shifts every column after it and the spreadsheet opens
 * without complaint. And the guarantee that the export answers the same
 * question the page did — a report and its download disagreeing is the failure
 * that would be hardest to notice and worst to act on.
 */

beforeEach(async () => {
  signOut();
  await resetDatabase();
});

function params(overrides: Partial<ReportParams> = {}): ReportParams {
  return {
    ...parseReportParams(
      { range: "all" },
      {
        groupings: ["period", "product", "category", "customer", "supplier"],
        defaultGrouping: "period",
        sortKeys: ["value", "units", "orders", "purchases", "label"],
        defaultSort: "value",
        defaultDirection: "desc",
      },
    ),
    ...overrides,
  };
}

function request(report: string, query = "range=all") {
  return new Request(`http://localhost/api/reports/${report}/csv?${query}`);
}

function routeParams(report: string) {
  return { params: Promise.resolve({ report }) };
}

/** The data rows, with the preamble and header stripped. */
function bodyRows(csv: string): string[] {
  const lines = csv.replace(/^﻿/, "").split("\r\n").filter(Boolean);
  const headerAt = lines.findIndex((line) => line.startsWith("SKU,") || line.startsWith("Group,"));
  return lines.slice(headerAt + 1);
}

// ---------------------------------------------------------------------------
// Escaping
// ---------------------------------------------------------------------------

describe("escaping", () => {
  it("quotes a field containing a comma", () => {
    expect(csvField("Bracket, 4x6")).toBe('"Bracket, 4x6"');
  });

  it("doubles an embedded quote", () => {
    // `Bracket 4x6" Rev.B` — the inch mark is not hypothetical on a parts list.
    expect(csvField('Bracket 4x6" Rev.B')).toBe('"Bracket 4x6"" Rev.B"');
  });

  it("quotes a field containing a newline", () => {
    expect(csvField("Hangar 4\nFieldgate")).toBe('"Hangar 4\nFieldgate"');
  });

  it("quotes a field with leading or trailing space", () => {
    // Otherwise the space is lost, and two suppliers look like one.
    expect(csvField(" Alpha")).toBe('" Alpha"');
  });

  it("writes null and undefined as empty rather than as words", () => {
    expect(csvField(null)).toBe("");
    expect(csvField(undefined)).toBe("");
    expect(csvRow(["a", null, "b"])).toBe("a,,b");
  });

  it("leaves an ordinary field alone", () => {
    expect(csvField("KES-4471")).toBe("KES-4471");
    expect(csvField(1234.56)).toBe("1234.56");
  });

  it("emits a UTF-8 BOM and CRLF endings", () => {
    const csv = toCsv(["a"], [["b"]]);
    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv).toContain("\r\n");
  });

  it("keeps non-ASCII text intact", () => {
    const csv = toCsv(["Supplier"], [["Kestrel Aeroespaço"]]);
    expect(csv).toContain("Kestrel Aeroespaço");
  });
});

// ---------------------------------------------------------------------------
// The route
// ---------------------------------------------------------------------------

describe("the certificate register export", () => {
  /**
   * The register is the report most likely to be forwarded outside the
   * application — it is what somebody sends an auditor — so the export has to
   * carry its caveats rather than leave them on the screen it came from.
   */
  it("matches the register's rows and order, and states its caveats", async () => {
    await signInWithRole("STAFF");

    const covered = await seedProduct({ sku: "X-COVERED", stockQuantity: 2 });
    await seedProduct({ sku: "X-BARE", stockQuantity: 1 });

    const lot = await prisma.stockLot.findFirstOrThrow({
      where: { productId: covered.id },
    });

    await prisma.certificate.create({
      data: {
        certificateType: "Certificate of Conformity",
        certificateNumber: "CSV-1",
        issueDate: new Date("2026-01-01T00:00:00.000Z"),
        // No expiry — the case the file must not render as a blank.
        expiryDate: null,
        fileName: "coc.pdf",
        storageKey: "k-csv-1",
        contentType: "application/pdf",
        fileSize: 512,
        productId: covered.id,
        stockLotId: lot.id,
      },
    });

    const response = await GET(
      request("certificates", "range=all&sort=sku&dir=asc"),
      routeParams("certificates"),
    );
    expect(response.status).toBe(200);

    const csv = await response.text();
    const rows = bodyRows(csv);

    // Two batches and a totals row, in the screen's order.
    expect(rows).toHaveLength(3);
    expect(rows[0]!.startsWith("X-BARE,")).toBe(true);
    expect(rows[1]!.startsWith("X-COVERED,")).toBe(true);
    expect(rows[2]!.startsWith("TOTAL,")).toBe(true);

    // A batch with nothing filed still exports, and says so.
    expect(rows[0]).toContain("No certificate");
    expect(rows[0]!.endsWith(",No")).toBe(true);

    // A document with no expiry is stated, not blanked.
    expect(rows[1]).toContain("No expiry");
    expect(rows[1]).toContain("Valid");
    expect(rows[1]!.endsWith(",Yes")).toBe(true);

    // The caveats travel with the spreadsheet.
    expect(csv).toContain("One row per batch, not per product");
    expect(csv).toContain("Supplier is lot provenance");
    expect(csv).toContain("Batch status is not compliance");
  });

  it("records the filters it was run under", async () => {
    await signInWithRole("STAFF");
    await seedProduct({ sku: "X-FILTER", stockQuantity: 1 });

    const response = await GET(
      request("certificates", "range=all&cstatus=MISSING&emptied=1&lstatus=SALEABLE"),
      routeParams("certificates"),
    );

    const csv = await response.text();
    expect(csv).toContain("Compliance: No certificate");
    expect(csv).toContain("Batch status: SALEABLE");
    expect(csv).toContain("Includes emptied batches");
  });
});

describe("the CSV route", () => {
  it("refuses an unauthenticated request", async () => {
    const response = await GET(request("valuation"), routeParams("valuation"));
    expect(response.status).toBe(401);
  });

  it("does not leak whether an unknown report exists", async () => {
    await signInWithRole("STAFF");
    const response = await GET(request("nonsense"), routeParams("nonsense"));
    expect(response.status).toBe(404);
  });

  it("sets the download headers", async () => {
    await signInWithRole("STAFF");
    await seedProduct({ sku: "V-1", stockQuantity: 4, lotUnitCost: "10.00" });

    const response = await GET(request("valuation"), routeParams("valuation"));

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/csv");
    expect(response.headers.get("Content-Disposition")).toContain("attachment");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("escapes a product name containing a comma and a quote", async () => {
    await signInWithRole("STAFF");
    await seedProduct({
      sku: "ODD-1",
      name: 'Bracket, 4x6" Rev.B',
      stockQuantity: 4,
      lotUnitCost: "10.00",
    });

    const response = await GET(request("valuation"), routeParams("valuation"));
    const csv = await response.text();

    expect(csv).toContain('"Bracket, 4x6"" Rev.B"');
    // One data row plus the totals row — the comma did not split the line.
    expect(bodyRows(csv)).toHaveLength(2);
  });

  it("carries the coverage caveat into the file", async () => {
    // The whole point of a preamble: a spreadsheet that gets forwarded still
    // says that uncosted stock was excluded rather than valued at zero.
    await signInWithRole("STAFF");
    await seedProduct({ sku: "U-1", stockQuantity: 5, lotUnitCost: null });

    const response = await GET(request("valuation"), routeParams("valuation"));
    const csv = await response.text();

    expect(csv).toContain("never valued at zero");
    expect(csv).toContain("a different basis");
  });
});

// ---------------------------------------------------------------------------
// The export agrees with the page
// ---------------------------------------------------------------------------

describe("the CSV totals match the page totals", () => {
  async function scenario() {
    const supplier = await createSupplier("Alpha Supply");
    const buyer = await prisma.customer.create({ data: { name: "Contoso" } });
    const a = await seedProduct({
      sku: "A-1",
      stockQuantity: 0,
      sellingPrice: "100.00",
    });

    const purchase = await createPurchase({
      supplierId: supplier.id,
      items: [{ productId: a.id, quantity: 20, unitCost: "40.00" }],
    });
    await receivePurchase(purchase.id);

    const order = await createOrder({
      customerId: buyer.id,
      items: await quoted([{ productId: a.id, quantity: 5 }]),
    });
    await confirmOrder(order.id);
  }

  it("agrees on valuation", async () => {
    await signInWithRole("STAFF");
    await scenario();

    const page = await loadValuationReport(params());
    if (!page.ok) throw new Error("expected the report");

    const csv = await (
      await GET(request("valuation"), routeParams("valuation"))
    ).text();

    expect(csv).toContain(page.data.totals.valueAtCost);
    expect(csv).toContain(String(page.data.totals.uncostedUnits));
  });

  it("agrees on sales", async () => {
    await signInWithRole("STAFF");
    await scenario();

    const page = await loadSalesReport(params());
    if (!page.ok) throw new Error("expected the report");

    const csv = await (await GET(request("sales"), routeParams("sales"))).text();

    expect(csv).toContain(page.data.totals.revenue);
    expect(csv).toContain(String(page.data.totals.units));
  });

  it("agrees on purchase spend", async () => {
    await signInWithRole("STAFF");
    await scenario();

    const page = await loadPurchaseSpendReport(params());
    if (!page.ok) throw new Error("expected the report");

    const csv = await (
      await GET(request("purchases"), routeParams("purchases"))
    ).text();

    expect(csv).toContain(page.data.totals.receivedSpend);
    expect(csv).toContain("Spend is not cost of sales");
  });

  it("honours the same filters the page was given", async () => {
    await signInWithRole("STAFF");
    await scenario();

    // A window that excludes everything must export nothing but the totals.
    const csv = await (
      await GET(
        request("sales", "range=custom&from=2020-01-01&to=2020-01-31"),
        routeParams("sales"),
      )
    ).text();

    expect(csv).toContain("2020-01-01 to 2020-01-31");
    expect(bodyRows(csv)).toHaveLength(1); // the TOTAL row alone
  });

  it("reports revenue when grouped by product", async () => {
    /*
     * This used to assert the opposite — that the export said realised revenue
     * was "not apportioned across lines" for this grouping, because an
     * order-level discount could not be split. With the discount gone (§20)
     * there is nothing to apportion and the figure is simply reported.
     */
    await signInWithRole("STAFF");
    await scenario();

    const csv = await (
      await GET(request("sales", "range=all&group=product"), routeParams("sales"))
    ).text();

    expect(csv).not.toContain("not apportioned");
    expect(csv).toContain("Revenue");
  });
});

// ---------------------------------------------------------------------------
// The stock movement summary export
// ---------------------------------------------------------------------------

describe("the stock movement summary export", () => {
  function movementParams(overrides: Partial<ReportParams> = {}): ReportParams {
    return {
      ...parseReportParams({ range: "all" }, REPORT_CONFIG.movements),
      ...overrides,
    };
  }

  async function movements() {
    const supplier = await createSupplier("Alpha Supply");
    const buyer = await prisma.customer.create({ data: { name: "Contoso" } });
    const a = await seedProduct({
      sku: "M-1",
      name: 'Bracket, 4x6" Rev.B',
      stockQuantity: 0,
      sellingPrice: "100.00",
    });

    const purchase = await createPurchase({
      supplierId: supplier.id,
      items: [{ productId: a.id, quantity: 60, unitCost: "40.00" }],
    });
    await receivePurchase(purchase.id);

    const order = await createOrder({
      customerId: buyer.id,
      items: await quoted([{ productId: a.id, quantity: 14 }]),
    });
    await confirmOrder(order.id);
  }

  it("refuses an unauthenticated request", async () => {
    // The export must not be a weaker path to the data than the page.
    const response = await GET(request("movements"), routeParams("movements"));
    expect(response.status).toBe(401);
  });

  it("agrees with the page on every total", async () => {
    await signInWithRole("STAFF");
    await movements();

    const page = await loadMovementSummaryReport(movementParams());
    if (!page.ok) throw new Error("expected the report");

    const csv = await (
      await GET(request("movements"), routeParams("movements"))
    ).text();

    const totalRow = bodyRows(csv).find((line) => line.startsWith("TOTAL,"));
    expect(totalRow).toBeDefined();
    expect(totalRow).toBe(
      [
        "TOTAL",
        "",
        page.data.totals.movements,
        page.data.totals.products,
        page.data.totals.unitsIn,
        page.data.totals.unitsOut,
        page.data.totals.netChange,
      ].join(","),
    );

    // The reconciliation the screen shows has to survive the export.
    expect(page.data.totals.unitsIn - page.data.totals.unitsOut).toBe(
      page.data.totals.netChange,
    );
  });

  it("carries the direction and quantity-only caveats into the file", async () => {
    await signInWithRole("STAFF");
    await movements();

    const csv = await (
      await GET(request("movements"), routeParams("movements"))
    ).text();

    expect(csv).toContain("Direction is read from the balance");
    expect(csv).toContain("Movement value and cost of sales are deliberately absent");
    expect(csv).toContain("Group,Detail,Movements,Products,Units in,Units out,Net change");
  });

  it("honours the movement type filter it was given", async () => {
    await signInWithRole("STAFF");
    await movements();

    const csv = await (
      await GET(
        request("movements", "range=all&group=type&mtype=STOCK_OUT"),
        routeParams("movements"),
      )
    ).text();

    expect(csv).toContain("Movement type: STOCK_OUT");
    // One grouped row plus the totals row: the inbound movement is filtered out.
    const rows = bodyRows(csv);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain("Stock Out");
    expect(rows[0]).not.toContain("STOCK_OUT");
  });

  it("honours a date window that excludes everything", async () => {
    await signInWithRole("STAFF");
    await movements();

    const csv = await (
      await GET(
        request("movements", "range=custom&from=2020-01-01&to=2020-01-31"),
        routeParams("movements"),
      )
    ).text();

    expect(csv).toContain("2020-01-01 to 2020-01-31");
    expect(bodyRows(csv)).toHaveLength(1); // the TOTAL row alone
  });

  it("escapes a product name containing a comma and a quote", async () => {
    await signInWithRole("STAFF");
    await movements();

    const csv = await (
      await GET(
        request("movements", "range=all&group=product"),
        routeParams("movements"),
      )
    ).text();

    expect(csv).toContain('"Bracket, 4x6"" Rev.B"');
  });
});
