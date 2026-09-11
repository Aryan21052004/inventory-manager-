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
import { setCurrency } from "@/server/settings";

import { signOut } from "./clerk-mock";
import { stringIn } from "./money";
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

    expect(csv).toContain(
      stringIn(page.data.totals.valueAtCostByCurrency, "INR"),
    );
    // The amount alone is not enough: it must arrive with its currency.
    expect(csv).toContain("600.00,INR");
    expect(csv).toContain(String(page.data.totals.uncostedUnits));
  });

  it("agrees on sales", async () => {
    await signInWithRole("STAFF");
    await scenario();

    const page = await loadSalesReport(params());
    if (!page.ok) throw new Error("expected the report");

    const csv = await (await GET(request("sales"), routeParams("sales"))).text();

    expect(csv).toContain(stringIn(page.data.totals.revenueByCurrency, "INR"));
    expect(csv).toContain("500.00,INR");
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

    expect(csv).toContain(
      stringIn(page.data.totals.receivedSpendByCurrency, "INR"),
    );
    // Spend is the whole delivery — 20 units at 40.00 — not the 15 still on
    // the shelf that the valuation report reports.
    expect(csv).toContain("800.00,INR");
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

// ---------------------------------------------------------------------------
// Currency
// ---------------------------------------------------------------------------

/**
 * What an export says about the money in it.
 *
 * This block used to assert the opposite of what it now asserts, and the
 * change is the point. The file once carried a single preamble line — reading
 * the installation default and declaring every number below to be in it — and
 * that line was wrong twice over: wrong for history recorded while the setting
 * said something else, and wrong for any business trading in more than one
 * currency at a time. It was also the most convincing thing in the file,
 * because it looked like metadata rather than a guess.
 *
 * So the claim is gone and each amount now carries its own currency in the
 * column beside it. The other half of the old contract survives untouched: the
 * amount itself stays a bare decimal, because a symbol inside a numeric cell
 * turns a number column into a text column and breaks every sort, sum and
 * formula written against the export.
 */
describe("the CSV names the currency of every amount", () => {
  beforeEach(async () => {
    await resetDatabase();
    signOut();
  });

  /** A product with a costed batch, so the money columns are not all zero. */
  async function priced() {
    return seedProduct({
      sku: "CSV-CUR",
      name: "Currency Fixture",
      sellingPrice: "1250.00",
      stockQuantity: 40,
      lotUnitCost: "800.00",
    });
  }

  /** Buys stock through the real path, in whatever the default is set to. */
  async function buy(
    productId: string,
    supplierId: string,
    quantity: number,
    unitCost: string,
    currency: "USD" | "INR" | "EUR",
  ) {
    await setCurrency(currency);
    const purchase = await createPurchase({
      supplierId,
      items: [{ productId, quantity, unitCost }],
    });
    await receivePurchase(purchase.id);
  }

  /** The valuation row for a SKU, split into cells. */
  function valuationRowsFor(csv: string, sku: string): string[][] {
    return bodyRows(csv)
      .map((row) => row.split(","))
      .filter((cells) => cells[0] === sku);
  }

  async function valuationCsv(): Promise<string> {
    return (await GET(request("valuation"), routeParams("valuation"))).text();
  }

  // -------------------------------------------------------------------------
  // The claim that had to go
  // -------------------------------------------------------------------------

  it("no longer declares one currency for the whole file", async () => {
    await signInWithRole("ADMIN");
    await setCurrency("EUR");
    await priced();

    const csv = await valuationCsv();

    /*
     * The old line, in every form it could take. The batch below was bought
     * in dollars; a file headed "Currency: EUR" would have relabelled it.
     */
    for (const currency of ["USD", "INR", "EUR"]) {
      expect(csv).not.toContain(`Currency: ${currency}`);
    }
    expect(csv).not.toContain("unconverted");
  });

  it("says instead that each column carries its own currency", async () => {
    await signInWithRole("ADMIN");
    await priced();

    const csv = await valuationCsv();

    expect(csv).toContain("carry their own currency in the column beside them");
    expect(csv).toContain("converted between currencies");
  });

  it("does not change what it reports when the default setting moves", async () => {
    const admin = await signInWithRole("ADMIN");
    await priced();

    await setCurrency("EUR");
    const underEur = await valuationCsv();

    await setCurrency("INR");
    const underInr = await valuationCsv();

    /*
     * The setting seeds new documents; it says nothing about what has already
     * happened. Two exports of the same unchanged data must agree, whatever
     * the setting was when each was taken.
     */
    expect(valuationRowsFor(underInr, "CSV-CUR")).toEqual(
      valuationRowsFor(underEur, "CSV-CUR"),
    );
    expect(admin.role).toBe("ADMIN");
  });

  // -------------------------------------------------------------------------
  // One currency
  // -------------------------------------------------------------------------

  it("names the currency beside a single-currency amount", async () => {
    await signInWithRole("ADMIN");
    await setCurrency("INR");
    await priced();

    const [row] = valuationRowsFor(await valuationCsv(), "CSV-CUR");
    expect(row).toBeDefined();

    // 40 units at 800.00 cost, at 1250.00 retail. The fixture buys and prices
    // in dollars whatever the installation default says.
    expect(row!.slice(8, 12)).toEqual(["32000.00", "USD", "50000.00", "USD"]);
  });

  // -------------------------------------------------------------------------
  // Several currencies
  // -------------------------------------------------------------------------

  it("refuses a single figure for a product bought in two currencies", async () => {
    await signInWithRole("ADMIN");
    const supplier = await createSupplier("Two Currency Supply");
    const product = await seedProduct({
      sku: "MIXED-1",
      name: "Mixed Batch Part",
      sellingPrice: "100.00",
      stockQuantity: 0,
    });

    await buy(product.id, supplier.id, 10, "40.00", "USD");
    await buy(product.id, supplier.id, 5, "3000.00", "INR");

    const rows = valuationRowsFor(await valuationCsv(), "MIXED-1");

    // The product row: quantities intact, no cost amount, and the currency
    // cell saying why there is none.
    expect(rows[0]!.slice(5, 10)).toEqual(["15", "15", "0", "", "mixed"]);

    // Then one row per currency, each amount with its own code, quantities
    // left blank so summing the units column is still correct.
    expect(rows[1]!.slice(0, 10)).toEqual([
      "MIXED-1",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "400.00",
      "USD",
    ]);
    expect(rows[2]!.slice(8, 10)).toEqual(["15000.00", "INR"]);
  });

  it("never writes the two currencies added together", async () => {
    await signInWithRole("ADMIN");
    const supplier = await createSupplier("No Conversion Supply");
    const product = await seedProduct({
      sku: "NOCONV-1",
      name: "No Conversion Part",
      sellingPrice: "100.00",
      stockQuantity: 0,
    });

    await buy(product.id, supplier.id, 1, "100.00", "USD");
    await buy(product.id, supplier.id, 1, "200.00", "EUR");

    const csv = await valuationCsv();

    // 300 is the number no exchange rate was consulted to produce, so it must
    // appear nowhere — not in a cell, not in a total, not in the preamble.
    expect(csv).not.toContain("300.00");
    expect(csv).toContain("100.00,USD");
    expect(csv).toContain("200.00,EUR");
    expect(csv).not.toContain("300");
  });

  // -------------------------------------------------------------------------
  // A currency that was never recorded
  // -------------------------------------------------------------------------

  it('calls an unrecorded currency "unknown" rather than the default', async () => {
    await signInWithRole("ADMIN");
    await setCurrency("EUR");
    const product = await priced();

    // Legacy-shaped data: a real amount whose currency predates the column.
    await prisma.stockLot.updateMany({
      where: { productId: product.id },
      data: { costCurrency: null },
    });
    await prisma.product.update({
      where: { id: product.id },
      data: { priceCurrency: null },
    });

    const csv = await valuationCsv();
    const [row] = valuationRowsFor(csv, "CSV-CUR");

    expect(row!.slice(8, 12)).toEqual([
      "32000.00",
      "unknown",
      "50000.00",
      "unknown",
    ]);

    // The amounts are untouched and the setting has not been borrowed as a
    // label for them.
    expect(row!.slice(8, 12)).not.toContain("EUR");
    expect(csv).toContain("no currency was ever recorded");
  });

  // -------------------------------------------------------------------------
  // Cost and retail are separate concepts
  // -------------------------------------------------------------------------

  it("keeps cost and retail in their own currencies on one row", async () => {
    await signInWithRole("ADMIN");
    const supplier = await createSupplier("Import Supply");

    // Priced for sale in dollars by the fixture, bought in rupees.
    const product = await seedProduct({
      sku: "IMPORT-1",
      name: "Imported Part",
      sellingPrice: "100.00",
      stockQuantity: 0,
    });
    await buy(product.id, supplier.id, 10, "3000.00", "INR");

    const [row] = valuationRowsFor(await valuationCsv(), "IMPORT-1");

    // Cost in one currency, retail in another, on the same row, neither
    // converted and neither netted against the other.
    expect(row!.slice(8, 12)).toEqual(["30000.00", "INR", "1000.00", "USD"]);
  });

  // -------------------------------------------------------------------------
  // Nothing to total is not a zero
  // -------------------------------------------------------------------------

  it("leaves an uncosted product's value blank rather than zero", async () => {
    await signInWithRole("ADMIN");
    await seedProduct({
      sku: "UNCOSTED-1",
      name: "Uncosted Part",
      sellingPrice: "100.00",
      stockQuantity: 12,
      lotUnitCost: null,
    });

    const [row] = valuationRowsFor(await valuationCsv(), "UNCOSTED-1");

    // No cost was ever recorded, so there is nothing to value — which is a
    // different statement from valuing it at nothing.
    expect(row!.slice(5, 12)).toEqual([
      "12",
      "0",
      "12",
      "",
      "",
      "1200.00",
      "USD",
    ]);
    expect(row!.slice(8, 10)).not.toContain("0.00");
  });

  // -------------------------------------------------------------------------
  // Totals
  // -------------------------------------------------------------------------

  it("gives the totals row its own currency", async () => {
    await signInWithRole("ADMIN");
    await setCurrency("INR");
    await priced();

    const total = bodyRows(await valuationCsv())
      .map((row) => row.split(","))
      .find((cells) => cells[0] === "TOTAL");

    expect(total).toBeDefined();
    expect(total!.slice(8, 12)).toEqual([
      "32000.00",
      "USD",
      "50000.00",
      "USD",
    ]);
  });

  it("splits a mixed total across one row per currency", async () => {
    await signInWithRole("ADMIN");
    const supplier = await createSupplier("Mixed Total Supply");
    const first = await seedProduct({
      sku: "TOT-1",
      sellingPrice: "10.00",
      stockQuantity: 0,
    });
    const second = await seedProduct({
      sku: "TOT-2",
      sellingPrice: "10.00",
      stockQuantity: 0,
    });

    await buy(first.id, supplier.id, 2, "50.00", "USD");
    await buy(second.id, supplier.id, 4, "900.00", "INR");

    const cells = bodyRows(await valuationCsv()).map((row) => row.split(","));
    const totalAt = cells.findIndex((row) => row[0] === "TOTAL");

    expect(totalAt).toBeGreaterThanOrEqual(0);
    // No single figure on the totals row itself...
    expect(cells[totalAt]!.slice(8, 10)).toEqual(["", "mixed"]);
    // ...and both currencies stated separately below it.
    expect(cells[totalAt + 1]!.slice(8, 10)).toEqual(["100.00", "USD"]);
    expect(cells[totalAt + 2]!.slice(8, 10)).toEqual(["3600.00", "INR"]);
  });

  it("names the currency on sales and purchase-spend totals too", async () => {
    await signInWithRole("ADMIN");
    await setCurrency("INR");

    const supplier = await createSupplier("Totals Supply");
    const buyer = await prisma.customer.create({ data: { name: "Contoso" } });
    const product = await seedProduct({
      sku: "TOTC-1",
      sellingPrice: "100.00",
      stockQuantity: 0,
    });

    await buy(product.id, supplier.id, 10, "40.00", "INR");

    const order = await createOrder({
      customerId: buyer.id,
      items: await quoted([{ productId: product.id, quantity: 5 }]),
    });
    await confirmOrder(order.id);

    const sales = await (
      await GET(request("sales"), routeParams("sales"))
    ).text();
    expect(sales).toContain("Group,Detail,Orders,Units,Revenue,Revenue currency");
    expect(sales).toContain("500.00,INR");

    const purchases = await (
      await GET(request("purchases"), routeParams("purchases"))
    ).text();
    expect(purchases).toContain(
      "Group,Detail,Purchases,Units,Received spend,Spend currency",
    );
    expect(purchases).toContain("400.00,INR");
  });

  it("states committed spend per currency, or says there is none", async () => {
    await signInWithRole("ADMIN");
    const supplier = await createSupplier("Committed Supply");
    const product = await seedProduct({
      sku: "COMM-1",
      sellingPrice: "10.00",
      stockQuantity: 0,
    });

    const empty = await (
      await GET(request("purchases"), routeParams("purchases"))
    ).text();
    expect(empty).toContain("Committed (pending, not yet received): none");

    await setCurrency("EUR");
    const purchase = await createPurchase({
      supplierId: supplier.id,
      items: [{ productId: product.id, quantity: 2, unitCost: "25.00" }],
    });
    await prisma.purchase.update({
      where: { id: purchase.id },
      data: { status: "PENDING" },
    });

    const committed = await (
      await GET(request("purchases"), routeParams("purchases"))
    ).text();
    expect(committed).toContain(
      "Committed (pending, not yet received): 50.00 EUR",
    );
  });

  // -------------------------------------------------------------------------
  // The numbers themselves stay arithmetic
  // -------------------------------------------------------------------------

  it("leaves monetary cells as raw decimals", async () => {
    await signInWithRole("ADMIN");
    await setCurrency("INR");
    await priced();

    const csv = await valuationCsv();
    const rows = bodyRows(csv);
    const product = rows.find((row) => row.startsWith("CSV-CUR,"));
    expect(product).toBeDefined();

    // 40 units at 800.00 — a bare number, exactly as the loader produced it.
    expect(product).toContain("32000.00");
    expect(product).not.toContain("₹");
    expect(product).not.toContain("32,000");
  });

  it("puts no currency symbol in any data row, in any currency", async () => {
    await signInWithRole("ADMIN");
    await priced();

    for (const currency of ["USD", "INR", "EUR"] as const) {
      await setCurrency(currency);

      for (const report of ["valuation", "sales", "purchases"]) {
        const csv = await (
          await GET(request(report), routeParams(report))
        ).text();

        for (const row of bodyRows(csv)) {
          expect(row, `${report}/${currency}: ${row}`).not.toMatch(/[$₹€£¥]/);
        }
      }
    }
  });

  /**
   * The column structure grew a currency column beside each money column, and
   * nothing else moved. The quantity columns are in the same places they were.
   */
  it("keeps the existing column structure, plus a currency per money column", async () => {
    await signInWithRole("ADMIN");
    await setCurrency("USD");
    await priced();

    const csv = await valuationCsv();
    const lines = csv.replace(/^﻿/, "").split("\r\n").filter(Boolean);
    const header = lines.find((line) => line.startsWith("SKU,"));

    expect(header).toBe(
      "SKU,Product,Category,Supplier,Status,Units on hand,Costed units," +
        "Uncosted units,Value at cost,Cost currency,Value at retail," +
        "Retail currency,Cost coverage %",
    );
  });
});
