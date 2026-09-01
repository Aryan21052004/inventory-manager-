import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@clerk/nextjs/server", async () => {
  const { clerkServerMock } = await import("./clerk-mock");
  return clerkServerMock;
});

import { prisma } from "@/lib/prisma";
import { parseReportParams, type ReportParams } from "@/lib/report-query";
import {
  loadPurchaseSpendReport,
  loadSalesReport,
  loadValuationReport,
} from "@/server/reports";
import { loadCosting, loadInventory, loadProcurement, loadSales } from "@/server/dashboard";
import { cancelOrder, completeOrder, confirmOrder, createOrder } from "@/server/orders";
import { cancelPurchase, createPurchase, receivePurchase } from "@/server/purchases";

import { signOut } from "./clerk-mock";
import {
  createSupplier,
  resetDatabase,
  seedProduct,
  signInWithRole,
} from "./database";

/**
 * The three Tier 1 reports.
 *
 * A report is more dangerous than a screen, because it gets exported and
 * forwarded and the caveats do not travel with the spreadsheet. So most of what
 * is asserted here is about refusing to state things:
 *
 *   stock with no recorded cost is never valued at zero and never at
 *   `standardCost`;
 *
 *   drafts and cancellations are never counted as revenue or spend;
 *
 *   the two sales bases are never conflated, and the discount-allocation
 *   problem is answered with null rather than an invented split;
 *
 *   and every figure agrees with the dashboard for an equivalent range,
 *   because two answers to one question is the failure this whole shared
 *   money-basis exists to prevent.
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
        sortKeys: ["value", "units", "orders", "purchases", "label", "revenue"],
        defaultSort: "value",
      },
    ),
    ...overrides,
  };
}

function unwrap<T>(r: { ok: true; data: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error(`expected the report to load: ${JSON.stringify(r)}`);
  return r.data;
}

async function customer(name = "Contoso Aviation") {
  return prisma.customer.create({ data: { name } });
}

async function part(sku: string, sellingPrice = "100.00", category = "Airframe") {
  return seedProduct({
    sku,
    name: `Part ${sku}`,
    stockQuantity: 0,
    minimumStock: 0,
    sellingPrice,
    category,
  });
}

async function receive(
  supplierId: string,
  productId: string,
  quantity: number,
  unitCost: string,
) {
  const purchase = await createPurchase({
    supplierId,
    items: [{ productId, quantity, unitCost }],
  });
  await receivePurchase(purchase.id);
  return purchase;
}

async function sell(
  customerId: string,
  items: { productId: string; quantity: number }[],
  discount = "0",
) {
  const order = await createOrder({ customerId, items, discount });
  await confirmOrder(order.id);
  return order;
}

// ---------------------------------------------------------------------------
// R1 · Stock valuation
// ---------------------------------------------------------------------------

describe("stock valuation", () => {
  it("values costed lots and counts uncosted ones separately", async () => {
    await signInWithRole("STAFF");
    await seedProduct({ sku: "V-1", stockQuantity: 10, lotUnitCost: "80.00" });
    await seedProduct({ sku: "V-2", stockQuantity: 5, lotUnitCost: null });

    const report = unwrap(await loadValuationReport(params()));

    expect(Number(report.totals.valueAtCost)).toBe(800);
    expect(report.totals.costedUnits).toBe(10);
    expect(report.totals.uncostedUnits).toBe(5);
    expect(report.totals.units).toBe(15);
    expect(report.totals.coverage).toBeCloseTo(66.7, 1);
  });

  it("never substitutes the standard cost for an unknown one", async () => {
    // The substitution the whole costing layer exists to prevent, asserted
    // where an exported spreadsheet would carry it furthest.
    await signInWithRole("STAFF");
    await seedProduct({
      sku: "V-1",
      stockQuantity: 10,
      standardCost: "999.00",
      lotUnitCost: null,
    });

    const report = unwrap(await loadValuationReport(params()));
    expect(Number(report.totals.valueAtCost)).toBe(0);
    expect(report.totals.uncostedUnits).toBe(10);
    expect(report.rows[0]!.valueAtCost).not.toContain("999");
  });

  it("reports cost and retail as different bases", async () => {
    await signInWithRole("STAFF");
    await seedProduct({
      sku: "V-1",
      stockQuantity: 10,
      sellingPrice: "150.00",
      lotUnitCost: "80.00",
    });

    const report = unwrap(await loadValuationReport(params()));
    expect(Number(report.totals.valueAtCost)).toBe(800);
    expect(Number(report.totals.valueAtRetail)).toBe(1_500);
  });

  it("omits products holding no stock", async () => {
    await signInWithRole("STAFF");
    await seedProduct({ sku: "HAS-1", stockQuantity: 4, lotUnitCost: "10.00" });
    await seedProduct({ sku: "NONE-1", stockQuantity: 0 });

    const report = unwrap(await loadValuationReport(params()));
    expect(report.rows.map((r) => r.sku)).toEqual(["HAS-1"]);
  });

  it("includes retired products and breaks them out", async () => {
    await signInWithRole("STAFF");
    await seedProduct({ sku: "ACT-1", stockQuantity: 10, lotUnitCost: "50.00" });
    await seedProduct({
      sku: "DIS-1",
      stockQuantity: 4,
      status: "DISCONTINUED",
      lotUnitCost: "25.00",
    });

    const report = unwrap(await loadValuationReport(params()));
    expect(Number(report.totals.valueAtCost)).toBe(600);
    expect(report.totals.retiredProducts).toBe(1);
    expect(report.totals.retiredUnits).toBe(4);
    expect(Number(report.totals.retiredValueAtCost)).toBe(100);
  });

  it("filters by supplier, category and search", async () => {
    await signInWithRole("STAFF");
    const a = await createSupplier("Alpha Supply");
    const b = await createSupplier("Bravo Supply");

    await seedProduct({
      sku: "A-1",
      stockQuantity: 5,
      supplierId: a.id,
      category: "Airframe",
      lotUnitCost: "10.00",
    });
    await seedProduct({
      sku: "B-1",
      stockQuantity: 5,
      supplierId: b.id,
      category: "Avionics",
      lotUnitCost: "20.00",
    });

    const bySupplier = unwrap(
      await loadValuationReport(params({ supplierId: a.id })),
    );
    expect(bySupplier.rows.map((r) => r.sku)).toEqual(["A-1"]);

    const byCategory = unwrap(
      await loadValuationReport(params({ category: "Avionics" })),
    );
    expect(byCategory.rows.map((r) => r.sku)).toEqual(["B-1"]);

    const bySearch = unwrap(await loadValuationReport(params({ search: "B-1" })));
    expect(bySearch.rows.map((r) => r.sku)).toEqual(["B-1"]);
  });

  it("sorts and pages", async () => {
    await signInWithRole("STAFF");
    for (let index = 0; index < 5; index += 1) {
      await seedProduct({
        sku: `P-${index}`,
        stockQuantity: index + 1,
        lotUnitCost: "10.00",
      });
    }

    const desc = unwrap(
      await loadValuationReport(params({ sort: "value", direction: "desc" })),
    );
    expect(desc.rows[0]!.sku).toBe("P-4");

    const asc = unwrap(
      await loadValuationReport(params({ sort: "value", direction: "asc" })),
    );
    expect(asc.rows[0]!.sku).toBe("P-0");

    const paged = unwrap(
      await loadValuationReport(params({ pageSize: 2, page: 2 })),
    );
    expect(paged.rows).toHaveLength(2);
    expect(paged.total).toBe(5);
    expect(paged.pageCount).toBe(3);
  });

  it("refuses an unauthenticated caller", async () => {
    const result = await loadValuationReport(params());
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// R2 · Sales
// ---------------------------------------------------------------------------

describe("sales report", () => {
  it("counts confirmed and completed orders", async () => {
    await signInWithRole("STAFF");
    const supplier = await createSupplier();
    const buyer = await customer();
    const a = await part("A-1", "100.00");
    await receive(supplier.id, a.id, 100, "10.00");

    await sell(buyer.id, [{ productId: a.id, quantity: 3 }]);
    const done = await sell(buyer.id, [{ productId: a.id, quantity: 2 }]);
    await completeOrder(done.id);

    const report = unwrap(await loadSalesReport(params()));
    expect(report.totals.orders).toBe(2);
    expect(report.totals.units).toBe(5);
    expect(Number(report.totals.salesAtListPrice)).toBe(500);
  });

  it("excludes drafts, pending and cancelled orders", async () => {
    await signInWithRole("STAFF");
    const supplier = await createSupplier();
    const buyer = await customer();
    const a = await part("A-1", "100.00");
    await receive(supplier.id, a.id, 100, "10.00");

    // A draft.
    await createOrder({
      customerId: buyer.id,
      items: [{ productId: a.id, quantity: 4 }],
      discount: "0",
    });
    // A cancelled order that was confirmed first.
    const cancelled = await sell(buyer.id, [{ productId: a.id, quantity: 7 }]);
    await cancelOrder(cancelled.id);
    // The only one that counts.
    await sell(buyer.id, [{ productId: a.id, quantity: 3 }]);

    const report = unwrap(await loadSalesReport(params()));
    expect(report.totals.orders).toBe(1);
    expect(report.totals.units).toBe(3);
    expect(Number(report.totals.salesAtListPrice)).toBe(300);
  });

  it("separates realised revenue from sales at list price", async () => {
    /*
     * The two bases, and the gap between them. An order-level discount is not a
     * price change on the lines, so the line total and the order total differ
     * and the report says by how much.
     */
    await signInWithRole("STAFF");
    const supplier = await createSupplier();
    const buyer = await customer();
    const a = await part("A-1", "100.00");
    await receive(supplier.id, a.id, 100, "10.00");

    await sell(buyer.id, [{ productId: a.id, quantity: 10 }], "150");

    const report = unwrap(await loadSalesReport(params()));
    expect(Number(report.totals.salesAtListPrice)).toBe(1_000);
    expect(Number(report.totals.realisedRevenue)).toBe(850);
    expect(Number(report.totals.discounts)).toBe(150);
  });

  it("declines to apportion an order discount across product rows", async () => {
    // Answered with null rather than an invented allocation.
    await signInWithRole("STAFF");
    const supplier = await createSupplier();
    const buyer = await customer();
    const a = await part("A-1", "100.00");
    await receive(supplier.id, a.id, 100, "10.00");
    await sell(buyer.id, [{ productId: a.id, quantity: 5 }], "50");

    const byProduct = unwrap(
      await loadSalesReport(params({ grouping: "product" })),
    );
    expect(byProduct.rows[0]!.realisedRevenue).toBeNull();
    expect(Number(byProduct.rows[0]!.salesAtListPrice)).toBe(500);

    const byPeriod = unwrap(await loadSalesReport(params({ grouping: "period" })));
    expect(byPeriod.rows[0]!.realisedRevenue).not.toBeNull();
  });

  it("counts an order's revenue once when it spans several lines", async () => {
    await signInWithRole("STAFF");
    const supplier = await createSupplier();
    const buyer = await customer();
    const a = await part("A-1", "100.00");
    const b = await part("B-1", "50.00");
    await receive(supplier.id, a.id, 50, "10.00");
    await receive(supplier.id, b.id, 50, "10.00");

    await sell(buyer.id, [
      { productId: a.id, quantity: 2 },
      { productId: b.id, quantity: 2 },
    ]);

    const report = unwrap(await loadSalesReport(params()));
    // 2×100 + 2×50 = 300, counted once, not once per line.
    expect(Number(report.totals.realisedRevenue)).toBe(300);
    expect(report.totals.orders).toBe(1);
  });

  it("groups by product, category and customer", async () => {
    await signInWithRole("STAFF");
    const supplier = await createSupplier();
    const one = await customer("One");
    const two = await customer("Two");
    const a = await part("A-1", "100.00", "Airframe");
    const b = await part("B-1", "100.00", "Avionics");
    await receive(supplier.id, a.id, 50, "10.00");
    await receive(supplier.id, b.id, 50, "10.00");

    await sell(one.id, [{ productId: a.id, quantity: 3 }]);
    await sell(two.id, [{ productId: b.id, quantity: 1 }]);

    const byProduct = unwrap(
      await loadSalesReport(params({ grouping: "product" })),
    );
    expect(byProduct.rows.map((r) => r.sublabel).sort()).toEqual(["A-1", "B-1"]);

    const byCategory = unwrap(
      await loadSalesReport(params({ grouping: "category" })),
    );
    expect(byCategory.rows.map((r) => r.label).sort()).toEqual([
      "Airframe",
      "Avionics",
    ]);

    const byCustomer = unwrap(
      await loadSalesReport(params({ grouping: "customer" })),
    );
    expect(byCustomer.rows.map((r) => r.label).sort()).toEqual(["One", "Two"]);
  });

  it("dates sales by confirmation, not by creation", async () => {
    /*
     * The rule that decides which month a sale belongs to. A draft raised
     * before the window and confirmed inside it is inside the window.
     */
    await signInWithRole("STAFF");
    const supplier = await createSupplier();
    const buyer = await customer();
    const a = await part("A-1", "100.00");
    await receive(supplier.id, a.id, 100, "10.00");

    const order = await sell(buyer.id, [{ productId: a.id, quantity: 4 }]);

    // Created long ago, confirmed today.
    await prisma.order.update({
      where: { id: order.id },
      data: { createdAt: new Date("2020-01-15T10:00:00.000Z") },
    });

    const today = new Date().toISOString().slice(0, 10);
    const inWindow = unwrap(
      await loadSalesReport(params({ from: today, to: today })),
    );
    expect(inWindow.totals.orders).toBe(1);

    const byCreation = unwrap(
      await loadSalesReport(params({ from: "2020-01-01", to: "2020-01-31" })),
    );
    expect(byCreation.totals.orders).toBe(0);
  });

  it("treats period boundaries as inclusive at both ends", async () => {
    await signInWithRole("STAFF");
    const supplier = await createSupplier();
    const buyer = await customer();
    const a = await part("A-1", "100.00");
    await receive(supplier.id, a.id, 100, "10.00");

    const order = await sell(buyer.id, [{ productId: a.id, quantity: 2 }]);

    // Late in the day — the case an exclusive upper bound would silently drop.
    await prisma.order.update({
      where: { id: order.id },
      data: { confirmedAt: new Date("2026-05-20T23:59:59.000Z") },
    });

    const onTheDay = unwrap(
      await loadSalesReport(params({ from: "2026-05-20", to: "2026-05-20" })),
    );
    expect(onTheDay.totals.orders).toBe(1);

    const dayBefore = unwrap(
      await loadSalesReport(params({ from: "2026-05-19", to: "2026-05-19" })),
    );
    expect(dayBefore.totals.orders).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// R3 · Purchase spend
// ---------------------------------------------------------------------------

describe("purchase spend report", () => {
  it("counts received purchases only", async () => {
    await signInWithRole("STAFF");
    const supplier = await createSupplier();
    const a = await part("A-1");

    await receive(supplier.id, a.id, 10, "25.00");

    const report = unwrap(await loadPurchaseSpendReport(params()));
    expect(report.totals.purchases).toBe(1);
    expect(Number(report.totals.receivedSpend)).toBe(250);
  });

  it("excludes drafts and cancellations from spend", async () => {
    await signInWithRole("STAFF");
    const supplier = await createSupplier();
    const a = await part("A-1");

    await createPurchase({
      supplierId: supplier.id,
      items: [{ productId: a.id, quantity: 4, unitCost: "25.00" }],
    });

    const cancelled = await createPurchase({
      supplierId: supplier.id,
      items: [{ productId: a.id, quantity: 4, unitCost: "25.00" }],
    });
    await cancelPurchase(cancelled.id);

    await receive(supplier.id, a.id, 2, "25.00");

    const report = unwrap(await loadPurchaseSpendReport(params()));
    expect(report.totals.purchases).toBe(1);
    expect(Number(report.totals.receivedSpend)).toBe(50);
  });

  it("reports pending purchases as committed, never as spend", async () => {
    await signInWithRole("STAFF");
    const supplier = await createSupplier();
    const a = await part("A-1");

    const pending = await createPurchase({
      supplierId: supplier.id,
      items: [{ productId: a.id, quantity: 8, unitCost: "25.00" }],
    });
    await prisma.purchase.update({
      where: { id: pending.id },
      data: { status: "PENDING" },
    });

    const report = unwrap(await loadPurchaseSpendReport(params()));
    expect(Number(report.totals.receivedSpend)).toBe(0);
    expect(Number(report.totals.committedSpend)).toBe(200);
    expect(report.totals.committedPurchases).toBe(1);
  });

  it("dates spend by receipt, not by when the order was placed", async () => {
    await signInWithRole("STAFF");
    const supplier = await createSupplier();
    const a = await part("A-1");

    const purchase = await receive(supplier.id, a.id, 4, "25.00");
    await prisma.purchase.update({
      where: { id: purchase.id },
      data: { purchaseDate: new Date("2020-03-01T00:00:00.000Z") },
    });

    const byPlacement = unwrap(
      await loadPurchaseSpendReport(
        params({ from: "2020-03-01", to: "2020-03-31" }),
      ),
    );
    expect(Number(byPlacement.totals.receivedSpend)).toBe(0);

    const today = new Date().toISOString().slice(0, 10);
    const byReceipt = unwrap(
      await loadPurchaseSpendReport(params({ from: today, to: today })),
    );
    expect(Number(byReceipt.totals.receivedSpend)).toBe(100);
  });

  it("groups by supplier, product, category and period", async () => {
    await signInWithRole("STAFF");
    const alpha = await createSupplier("Alpha Supply");
    const bravo = await createSupplier("Bravo Supply");
    const a = await part("A-1", "100.00", "Airframe");
    const b = await part("B-1", "100.00", "Avionics");

    await receive(alpha.id, a.id, 4, "25.00");
    await receive(bravo.id, b.id, 2, "50.00");

    const bySupplier = unwrap(
      await loadPurchaseSpendReport(params({ grouping: "supplier" })),
    );
    expect(bySupplier.rows.map((r) => r.label).sort()).toEqual([
      "Alpha Supply",
      "Bravo Supply",
    ]);

    const byCategory = unwrap(
      await loadPurchaseSpendReport(params({ grouping: "category" })),
    );
    expect(byCategory.rows.map((r) => r.label).sort()).toEqual([
      "Airframe",
      "Avionics",
    ]);

    const byProduct = unwrap(
      await loadPurchaseSpendReport(params({ grouping: "product" })),
    );
    expect(byProduct.rows.map((r) => r.sublabel).sort()).toEqual(["A-1", "B-1"]);

    const byPeriod = unwrap(
      await loadPurchaseSpendReport(params({ grouping: "period" })),
    );
    expect(byPeriod.rows).toHaveLength(1);
    expect(Number(byPeriod.totals.receivedSpend)).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Cross-report consistency
// ---------------------------------------------------------------------------

describe("reports agree with the dashboard", () => {
  it("matches on valuation, sales and spend for an unfiltered range", async () => {
    await signInWithRole("STAFF");
    const supplier = await createSupplier();
    const buyer = await customer();
    const a = await part("A-1", "100.00");
    const b = await part("B-1", "60.00");

    await receive(supplier.id, a.id, 30, "40.00");
    await receive(supplier.id, b.id, 10, "20.00");
    await sell(buyer.id, [{ productId: a.id, quantity: 5 }], "25");
    const done = await sell(buyer.id, [{ productId: b.id, quantity: 2 }]);
    await completeOrder(done.id);

    const valuation = unwrap(await loadValuationReport(params()));
    const inventory = unwrap(await loadInventory());
    expect(Number(valuation.totals.valueAtCost)).toBe(
      Number(inventory.stockValue),
    );
    expect(valuation.totals.uncostedUnits).toBe(inventory.uncostedUnits);
    expect(valuation.totals.units).toBe(inventory.totalUnits);

    const sales = unwrap(await loadSalesReport(params()));
    const dashSales = unwrap(await loadSales());
    expect(Number(sales.totals.realisedRevenue)).toBeCloseTo(
      Number(dashSales.realisedRevenue),
      2,
    );

    const costing = unwrap(await loadCosting());
    expect(Number(sales.totals.salesAtListPrice)).toBeCloseTo(
      Number(costing.allSalesAtListPrice),
      2,
    );

    const spend = unwrap(await loadPurchaseSpendReport(params()));
    const dashProcurement = unwrap(await loadProcurement());
    expect(Number(spend.totals.receivedSpend)).toBe(
      Number(dashProcurement.receivedSpend),
    );
    expect(Number(spend.totals.committedSpend)).toBe(
      Number(dashProcurement.committedSpend),
    );
  });

  it("produces no profitability figure anywhere in Tier 1", async () => {
    /*
     * Tier 1 reports no margin at all — not suppressed-and-shown, absent. The
     * only honest figure on data with no cost coverage is a refusal, and a
     * report that gets exported is the wrong place to litigate that.
     */
    await signInWithRole("STAFF");
    const supplier = await createSupplier();
    const buyer = await customer();
    const a = await part("A-1", "100.00");
    await receive(supplier.id, a.id, 20, "40.00");
    await sell(buyer.id, [{ productId: a.id, quantity: 5 }]);

    const sales = unwrap(await loadSalesReport(params()));
    const spend = unwrap(await loadPurchaseSpendReport(params()));

    expect(Object.keys(sales.totals)).not.toContain("margin");
    expect(Object.keys(sales.totals)).not.toContain("profit");
    expect(Object.keys(spend.totals)).not.toContain("margin");
  });
});

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

describe("an empty database", () => {
  it("returns zeroes rather than crashing or producing NaN", async () => {
    await signInWithRole("STAFF");

    const valuation = unwrap(await loadValuationReport(params()));
    const sales = unwrap(await loadSalesReport(params()));
    const spend = unwrap(await loadPurchaseSpendReport(params()));

    expect(valuation.rows).toHaveLength(0);
    expect(Number(valuation.totals.valueAtCost)).toBe(0);
    expect(valuation.totals.coverage).toBe(0);
    expect(sales.rows).toHaveLength(0);
    expect(Number(sales.totals.realisedRevenue)).toBe(0);
    expect(Number(sales.totals.discounts)).toBe(0);
    expect(spend.rows).toHaveLength(0);
    expect(Number(spend.totals.receivedSpend)).toBe(0);
  });
});
