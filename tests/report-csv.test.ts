import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@clerk/nextjs/server", async () => {
  const { clerkServerMock } = await import("./clerk-mock");
  return clerkServerMock;
});

import { csvField, csvRow, toCsv } from "@/lib/csv";
import { prisma } from "@/lib/prisma";
import { parseReportParams, type ReportParams } from "@/lib/report-query";
import {
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
      items: [{ productId: a.id, quantity: 5 }],
      discount: "25",
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

  it("agrees on sales, including the discount gap", async () => {
    await signInWithRole("STAFF");
    await scenario();

    const page = await loadSalesReport(params());
    if (!page.ok) throw new Error("expected the report");

    const csv = await (await GET(request("sales"), routeParams("sales"))).text();

    expect(csv).toContain(page.data.totals.salesAtListPrice);
    expect(csv).toContain(page.data.totals.discounts);
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

  it("says when realised revenue is not apportioned", async () => {
    await signInWithRole("STAFF");
    await scenario();

    const csv = await (
      await GET(request("sales", "range=all&group=product"), routeParams("sales"))
    ).text();

    expect(csv).toContain("not apportioned across lines");
  });
});
