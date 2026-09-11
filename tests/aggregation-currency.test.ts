import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@clerk/nextjs/server", async () => {
  const { clerkServerMock } = await import("./clerk-mock");
  return clerkServerMock;
});

import {
  DEFAULT_CUSTOMER_PARAMS,
  type CustomerListParams,
} from "@/lib/customer-query";
import { prisma } from "@/lib/prisma";
import { reportParamsFor, type ReportKey } from "@/lib/report-query";
import { loadCustomerStats, listCustomers } from "@/server/customers";
import {
  loadCosting,
  loadInventory,
  loadProcurement,
  loadSales,
} from "@/server/dashboard";
import { loadOrderStats } from "@/server/orders";
import { loadProductStats } from "@/server/products";
import { loadPurchaseStats } from "@/server/purchases";
import {
  loadPurchaseSpendReport,
  loadSalesReport,
  loadValuationReport,
} from "@/server/reports";
import { loadSupplierStats } from "@/server/suppliers";
import { confirmOrder, createOrder } from "@/server/orders";
import { createPurchase, receivePurchase } from "@/server/purchases";
import { setCurrency } from "@/server/settings";

import {
  createSupplier,
  resetDatabase,
  seedCustomer,
  seedProduct,
  signInWithRole,
} from "./database";
import { currenciesOf } from "./money";

/**
 * What every aggregate in the application does when the rows disagree.
 *
 * There is no exchange rate anywhere here, and the whole point of the
 * per-currency shape is that a total spanning two of them cannot be reduced
 * to one number by accident. The tests in the other files check the figures;
 * these check that no figure was invented — that dollars and rupees come back
 * as two entries, that an amount recorded before currencies existed keeps its
 * own bucket rather than borrowing the installation default, and that a
 * margin simply refuses to exist when its two halves are in different money.
 *
 * The counts are the control group. Splitting a total by currency must not
 * change how many units were sold or how many orders were raised, and several
 * of these check exactly that alongside the money.
 */

/**
 * Report parameters built by the application's own parser.
 *
 * `reportParamsFor` is what the report page and the CSV route both call, so
 * a test cannot ask for a grouping or a sort key the real thing would reject,
 * and cannot drift out of shape when `ReportParams` gains a field. The
 * argument is a query string, spelled exactly as a URL would spell it.
 */
function params(
  report: ReportKey,
  query: Record<string, string> = {},
): ReturnType<typeof reportParamsFor> {
  return reportParamsFor(report, { range: "all", ...query });
}

/** Customer list parameters, from the same defaults the page starts on. */
function listParams(
  overrides: Partial<CustomerListParams> = {},
): CustomerListParams {
  return { ...DEFAULT_CUSTOMER_PARAMS, ...overrides };
}

function unwrap<T>(
  result: { ok: true; data: T } | { ok: false; error: unknown },
): T {
  if (!result.ok) throw new Error("expected the loader to succeed");
  return result.data;
}

beforeEach(async () => {
  await resetDatabase();
  await signInWithRole("ADMIN");
});

/**
 * Buys stock through the real path, in whichever currency the installation
 * default is set to at the time.
 *
 * Nothing is hand-stamped: `createPurchase` seeds the purchase from the
 * default, and receiving carries that down onto the lots. Moving the default
 * between calls is how a warehouse comes to hold batches in two currencies,
 * and it is the only way this test file produces one.
 */
async function buy(params: {
  supplierId: string;
  productId: string;
  quantity: number;
  unitCost: string;
  currency: "USD" | "INR" | "EUR";
}) {
  await setCurrency(params.currency);

  const purchase = await createPurchase({
    supplierId: params.supplierId,
    items: [
      {
        productId: params.productId,
        quantity: params.quantity,
        unitCost: params.unitCost,
      },
    ],
  });

  await receivePurchase(purchase.id);
  return purchase;
}

/** Sells through the real path, in the currency the default is set to. */
async function sell(params: {
  customerId: string;
  productId: string;
  quantity: number;
  unitPrice: string;
  currency: "USD" | "INR" | "EUR";
}) {
  await setCurrency(params.currency);

  const order = await createOrder({
    customerId: params.customerId,
    items: [
      {
        productId: params.productId,
        quantity: params.quantity,
        unitPrice: params.unitPrice,
      },
    ],
  });

  await confirmOrder(order.id);
  return order;
}

// ---------------------------------------------------------------------------
// One currency — the ordinary case still reads as one figure
// ---------------------------------------------------------------------------

describe("a business trading in one currency", () => {
  it("reports each total as a single labelled entry", async () => {
    const supplier = await createSupplier();
    const customer = await seedCustomer({ name: "Contoso" });
    const product = await seedProduct({ sku: "ONE-1", stockQuantity: 0 });

    await buy({
      supplierId: supplier.id,
      productId: product.id,
      quantity: 10,
      unitCost: "40.00",
      currency: "USD",
    });
    await sell({
      customerId: customer.id,
      productId: product.id,
      quantity: 4,
      unitPrice: "100.00",
      currency: "USD",
    });

    expect(unwrap(await loadInventory()).stockValueByCurrency).toEqual([
      { currency: "USD", amount: "240.00" },
    ]);
    expect(unwrap(await loadSales()).realisedRevenueByCurrency).toEqual([
      { currency: "USD", amount: "400.00" },
    ]);
    expect(unwrap(await loadProcurement()).receivedSpendByCurrency).toEqual([
      { currency: "USD", amount: "400.00" },
    ]);
    expect(unwrap(await loadCustomerStats()).lifetimeValueByCurrency).toEqual([
      { currency: "USD", amount: "400.00" },
    ]);
    expect(unwrap(await loadSupplierStats()).totalPurchasedByCurrency).toEqual([
      { currency: "USD", amount: "400.00" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Two currencies — the totals stay apart
// ---------------------------------------------------------------------------

describe("a business trading in two currencies", () => {
  it("reports stock value once per currency the lots were bought in", async () => {
    const supplier = await createSupplier();
    const product = await seedProduct({ sku: "MIX-1", stockQuantity: 0 });

    await buy({
      supplierId: supplier.id,
      productId: product.id,
      quantity: 10,
      unitCost: "40.00",
      currency: "USD",
    });
    await buy({
      supplierId: supplier.id,
      productId: product.id,
      quantity: 5,
      unitCost: "3000.00",
      currency: "INR",
    });

    const inventory = unwrap(await loadInventory());

    expect(inventory.stockValueByCurrency).toEqual([
      { currency: "USD", amount: "400.00" },
      { currency: "INR", amount: "15000.00" },
    ]);

    // The control: the units are one number however the money splits.
    expect(inventory.totalUnits).toBe(15);
    expect(inventory.costedUnits).toBe(15);
    expect(inventory.uncostedUnits).toBe(0);
  });

  it("never produces a figure that is the two added together", async () => {
    const supplier = await createSupplier();
    const product = await seedProduct({ sku: "MIX-2", stockQuantity: 0 });

    await buy({
      supplierId: supplier.id,
      productId: product.id,
      quantity: 1,
      unitCost: "100.00",
      currency: "USD",
    });
    await buy({
      supplierId: supplier.id,
      productId: product.id,
      quantity: 1,
      unitCost: "200.00",
      currency: "EUR",
    });

    const total = unwrap(await loadInventory()).stockValueByCurrency;
    const amounts = total.map((entry) => entry.amount);

    // 300 is the number this application must never print: it is the sum of
    // a dollar figure and a euro one, and no rate was consulted to produce it.
    expect(amounts).not.toContain("300.00");
    expect(amounts.sort()).toEqual(["100.00", "200.00"]);
  });

  it("splits revenue by the currency each order was raised in", async () => {
    const supplier = await createSupplier();
    const customer = await seedCustomer({ name: "Two Currencies Ltd" });
    const product = await seedProduct({ sku: "MIX-3", stockQuantity: 0 });

    await buy({
      supplierId: supplier.id,
      productId: product.id,
      quantity: 20,
      unitCost: "10.00",
      currency: "USD",
    });
    await sell({
      customerId: customer.id,
      productId: product.id,
      quantity: 2,
      unitPrice: "100.00",
      currency: "USD",
    });
    await sell({
      customerId: customer.id,
      productId: product.id,
      quantity: 3,
      unitPrice: "9000.00",
      currency: "INR",
    });

    const sales = unwrap(await loadSales());

    expect(sales.realisedRevenueByCurrency).toEqual([
      { currency: "USD", amount: "200.00" },
      { currency: "INR", amount: "27000.00" },
    ]);
    // Two orders, whatever they were priced in.
    expect(sales.confirmedCount).toBe(2);

    const stats = unwrap(await loadCustomerStats());
    expect(currenciesOf(stats.lifetimeValueByCurrency)).toEqual(["USD", "INR"]);

    const page = unwrap(
      await listCustomers(listParams({ sort: "name" })),
    );
    expect(currenciesOf(page.items[0]!.lifetimeValueByCurrency)).toEqual([
      "USD",
      "INR",
    ]);
  });

  it("splits spend by the currency each purchase was raised in", async () => {
    const supplier = await createSupplier();
    const product = await seedProduct({ sku: "MIX-4", stockQuantity: 0 });

    await buy({
      supplierId: supplier.id,
      productId: product.id,
      quantity: 4,
      unitCost: "25.00",
      currency: "USD",
    });
    await buy({
      supplierId: supplier.id,
      productId: product.id,
      quantity: 2,
      unitCost: "500.00",
      currency: "INR",
    });

    const procurement = unwrap(await loadProcurement());

    expect(procurement.receivedSpendByCurrency).toEqual([
      { currency: "USD", amount: "100.00" },
      { currency: "INR", amount: "1000.00" },
    ]);
    expect(procurement.receivedCount).toBe(2);

    expect(
      currenciesOf(unwrap(await loadPurchaseStats()).receivedValueByCurrency),
    ).toEqual(["USD", "INR"]);
    expect(
      currenciesOf(unwrap(await loadSupplierStats()).totalPurchasedByCurrency),
    ).toEqual(["USD", "INR"]);
  });
});

// ---------------------------------------------------------------------------
// Currency that was never recorded
// ---------------------------------------------------------------------------

describe("money recorded before currencies were", () => {
  it("keeps the unknown currency in its own bucket, never labelled with the default", async () => {
    const customer = await seedCustomer({ name: "Legacy Buyer" });

    await setCurrency("INR");

    // Written the way the database held it before per-record currency: a real
    // amount with no currency at all. The installation default is INR, and
    // the one thing this must not do is come back saying so.
    await prisma.order.create({
      data: {
        orderNumber: "ORD-LEGACY",
        customerId: customer.id,
        status: "COMPLETED",
        subtotal: "16960.00",
        total: "16960.00",
        currency: null,
      },
    });

    const stats = unwrap(await loadCustomerStats());

    expect(stats.lifetimeValueByCurrency).toEqual([
      { currency: null, amount: "16960.00" },
    ]);
  });

  it("keeps a known historical currency as recorded, whatever the default now is", async () => {
    const customer = await seedCustomer({ name: "Historical Buyer" });

    await prisma.order.create({
      data: {
        orderNumber: "ORD-HIST",
        customerId: customer.id,
        status: "COMPLETED",
        subtotal: "500.00",
        total: "500.00",
        currency: "USD",
      },
    });

    // Changing the default is what used to relabel every historical figure in
    // the application. It must now change nothing that already happened.
    await setCurrency("EUR");

    expect(unwrap(await loadCustomerStats()).lifetimeValueByCurrency).toEqual([
      { currency: "USD", amount: "500.00" },
    ]);

    await setCurrency("INR");

    expect(unwrap(await loadCustomerStats()).lifetimeValueByCurrency).toEqual([
      { currency: "USD", amount: "500.00" },
    ]);
  });

  it("does not merge an unrecorded currency into a recorded one", async () => {
    const customer = await seedCustomer({ name: "Both Kinds" });

    await prisma.order.createMany({
      data: [
        {
          orderNumber: "ORD-K",
          customerId: customer.id,
          status: "COMPLETED",
          subtotal: "100.00",
          total: "100.00",
          currency: "USD",
        },
        {
          orderNumber: "ORD-U",
          customerId: customer.id,
          status: "COMPLETED",
          subtotal: "40.00",
          total: "40.00",
          currency: null,
        },
      ],
    });

    const total = unwrap(await loadCustomerStats()).lifetimeValueByCurrency;

    expect(total).toEqual([
      { currency: "USD", amount: "100.00" },
      { currency: null, amount: "40.00" },
    ]);
    expect(total.map((entry) => entry.amount)).not.toContain("140.00");
  });
});

// ---------------------------------------------------------------------------
// Margin — the subtraction that has to refuse
// ---------------------------------------------------------------------------

describe("margin", () => {
  it("is stated when the sale and its cost are in the same currency", async () => {
    const supplier = await createSupplier();
    const customer = await seedCustomer({ name: "Same Currency Ltd" });
    const product = await seedProduct({ sku: "MAR-1", stockQuantity: 0 });

    await buy({
      supplierId: supplier.id,
      productId: product.id,
      quantity: 10,
      unitCost: "60.00",
      currency: "USD",
    });
    await sell({
      customerId: customer.id,
      productId: product.id,
      quantity: 10,
      unitPrice: "100.00",
      currency: "USD",
    });

    const costing = unwrap(await loadCosting());

    expect(costing.knownCogsByCurrency).toEqual([
      { currency: "USD", amount: "600.00" },
    ]);
    expect(costing.costedRevenueByCurrency).toEqual([
      { currency: "USD", amount: "1000.00" },
    ]);
    expect(costing.marginByCurrency).toEqual([
      { currency: "USD", amount: "400.00" },
    ]);
    expect(costing.marginPercent).toBeCloseTo(40, 5);
  });

  it("refuses when the sale and its cost are in different currencies", async () => {
    const supplier = await createSupplier();
    const customer = await seedCustomer({ name: "Cross Currency Ltd" });
    const product = await seedProduct({ sku: "MAR-2", stockQuantity: 0 });

    // Bought in rupees, sold in dollars — an importer, and an entirely
    // ordinary thing to be. There is no rate here, so the difference between
    // the two figures is not a number this application can state.
    await buy({
      supplierId: supplier.id,
      productId: product.id,
      quantity: 10,
      unitCost: "3000.00",
      currency: "INR",
    });
    await sell({
      customerId: customer.id,
      productId: product.id,
      quantity: 10,
      unitPrice: "100.00",
      currency: "USD",
    });

    const costing = unwrap(await loadCosting());

    // Both halves are still reported — nothing is hidden, and anything that
    // wants to explain the gap can read them.
    expect(costing.knownCogsByCurrency).toEqual([
      { currency: "INR", amount: "30000.00" },
    ]);
    expect(costing.costedRevenueByCurrency).toEqual([
      { currency: "USD", amount: "1000.00" },
    ]);

    // The subtraction is the part that refuses.
    expect(costing.marginByCurrency).toEqual([]);
    expect(costing.marginPercent).toBeNull();
  });

  it("refuses when the cost of the sale spans two currencies", async () => {
    const supplier = await createSupplier();
    const customer = await seedCustomer({ name: "Mixed Batches Ltd" });
    const product = await seedProduct({ sku: "MAR-3", stockQuantity: 0 });

    await buy({
      supplierId: supplier.id,
      productId: product.id,
      quantity: 5,
      unitCost: "60.00",
      currency: "USD",
    });
    await buy({
      supplierId: supplier.id,
      productId: product.id,
      quantity: 5,
      unitCost: "5000.00",
      currency: "INR",
    });

    // One sale, drawing across both batches.
    await sell({
      customerId: customer.id,
      productId: product.id,
      quantity: 10,
      unitPrice: "100.00",
      currency: "USD",
    });

    const costing = unwrap(await loadCosting());

    expect(costing.marginByCurrency).toEqual([]);
    expect(costing.marginPercent).toBeNull();

    // The units are unaffected: what was sold is a count, not a currency.
    expect(costing.unitsSold).toBe(10);
  });

  it("refuses when the cost of the sale has no recorded currency", async () => {
    const supplier = await createSupplier();
    const customer = await seedCustomer({ name: "Unknown Cost Ltd" });
    const product = await seedProduct({
      sku: "MAR-4",
      stockQuantity: 0,
      sellingPrice: "100.00",
    });

    await buy({
      supplierId: supplier.id,
      productId: product.id,
      quantity: 10,
      unitCost: "60.00",
      currency: "USD",
    });
    await sell({
      customerId: customer.id,
      productId: product.id,
      quantity: 10,
      unitPrice: "100.00",
      currency: "USD",
    });

    // Blank the currency the way legacy data carries it, leaving the amount
    // exactly as recorded. An amount with no currency cannot be subtracted
    // from a dollar figure.
    await prisma.orderItem.updateMany({ data: { costCurrency: null } });

    const costing = unwrap(await loadCosting());

    expect(costing.knownCogsByCurrency).toEqual([
      { currency: null, amount: "600.00" },
    ]);
    expect(costing.marginByCurrency).toEqual([]);
    expect(costing.marginPercent).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Valuation — cost and retail are separate concepts
// ---------------------------------------------------------------------------

describe("stock valuation", () => {
  it("keeps cost and retail as separate monetary concepts", async () => {
    const supplier = await createSupplier();
    const product = await seedProduct({
      sku: "VAL-1",
      stockQuantity: 0,
      sellingPrice: "150.00",
    });

    await buy({
      supplierId: supplier.id,
      productId: product.id,
      quantity: 10,
      unitCost: "40.00",
      currency: "USD",
    });

    const report = unwrap(await loadValuationReport(params("valuation")));
    const row = report.rows[0]!;

    // Bought in dollars; priced in whatever the catalogue says, which the
    // fixture quotes in dollars too. Two bases, never netted against each
    // other and never presented as one figure.
    expect(row.valueAtCostByCurrency).toEqual([
      { currency: "USD", amount: "400.00" },
    ]);
    expect(row.valueAtRetailByCurrency).toEqual([
      { currency: "USD", amount: "1500.00" },
    ]);
    expect(report.totals.valueAtCostByCurrency).toEqual([
      { currency: "USD", amount: "400.00" },
    ]);
    expect(report.totals.valueAtRetailByCurrency).toEqual([
      { currency: "USD", amount: "1500.00" },
    ]);
  });

  it("values a product bought in two currencies as two figures", async () => {
    const supplier = await createSupplier();
    const product = await seedProduct({
      sku: "VAL-2",
      stockQuantity: 0,
      sellingPrice: "150.00",
    });

    await buy({
      supplierId: supplier.id,
      productId: product.id,
      quantity: 10,
      unitCost: "40.00",
      currency: "USD",
    });
    await buy({
      supplierId: supplier.id,
      productId: product.id,
      quantity: 5,
      unitCost: "3000.00",
      currency: "INR",
    });

    const report = unwrap(await loadValuationReport(params("valuation")));
    const row = report.rows[0]!;

    expect(row.valueAtCostByCurrency).toEqual([
      { currency: "USD", amount: "400.00" },
      { currency: "INR", amount: "15000.00" },
    ]);
    // Still 15 units on one row, and the coverage still reads against them.
    expect(row.units).toBe(15);
    expect(row.costedUnits).toBe(15);
    expect(row.coverage).toBe(100);
  });

  it("sorts a mixed-currency row last, in both directions", async () => {
    const supplier = await createSupplier();
    const single = await seedProduct({ sku: "SORT-1", stockQuantity: 0 });
    const mixed = await seedProduct({ sku: "SORT-2", stockQuantity: 0 });

    await buy({
      supplierId: supplier.id,
      productId: single.id,
      quantity: 1,
      unitCost: "5.00",
      currency: "USD",
    });
    await buy({
      supplierId: supplier.id,
      productId: mixed.id,
      quantity: 1,
      unitCost: "10.00",
      currency: "USD",
    });
    await buy({
      supplierId: supplier.id,
      productId: mixed.id,
      quantity: 1,
      unitCost: "900.00",
      currency: "INR",
    });

    /*
     * A row with no single defensible figure cannot take a position in a
     * ranking by that figure, so it goes to the end — descending, where it
     * would otherwise sit near the top, and ascending, where it would sit
     * near the bottom for the wrong reason.
     */
    const descending = unwrap(
      await loadValuationReport(params("valuation", { dir: "desc" })),
    );
    expect(descending.rows.map((r) => r.sku)).toEqual(["SORT-1", "SORT-2"]);

    const ascending = unwrap(
      await loadValuationReport(params("valuation", { dir: "asc" })),
    );
    expect(ascending.rows.map((r) => r.sku)).toEqual(["SORT-1", "SORT-2"]);
  });
});

// ---------------------------------------------------------------------------
// The reports, and the counts they must not disturb
// ---------------------------------------------------------------------------

describe("the reports", () => {
  it("splits a sales row by currency without changing its counts", async () => {
    const supplier = await createSupplier();
    const customer = await seedCustomer({ name: "Report Buyer" });
    const product = await seedProduct({ sku: "REP-1", stockQuantity: 0 });

    await buy({
      supplierId: supplier.id,
      productId: product.id,
      quantity: 20,
      unitCost: "10.00",
      currency: "USD",
    });
    await sell({
      customerId: customer.id,
      productId: product.id,
      quantity: 2,
      unitPrice: "100.00",
      currency: "USD",
    });
    await sell({
      customerId: customer.id,
      productId: product.id,
      quantity: 3,
      unitPrice: "9000.00",
      currency: "INR",
    });

    const report = unwrap(
      await loadSalesReport(params("sales", { group: "product" })),
    );
    const row = report.rows[0]!;

    expect(row.revenueByCurrency).toEqual([
      { currency: "USD", amount: "200.00" },
      { currency: "INR", amount: "27000.00" },
    ]);
    // One product, two orders, five units — none of which the split touches.
    expect(report.rows).toHaveLength(1);
    expect(row.orders).toBe(2);
    expect(row.units).toBe(5);
    expect(report.totals.orders).toBe(2);
    expect(report.totals.units).toBe(5);
  });

  it("splits a purchase-spend row by currency without changing its counts", async () => {
    const supplier = await createSupplier();
    const product = await seedProduct({ sku: "REP-2", stockQuantity: 0 });

    await buy({
      supplierId: supplier.id,
      productId: product.id,
      quantity: 4,
      unitCost: "25.00",
      currency: "USD",
    });
    await buy({
      supplierId: supplier.id,
      productId: product.id,
      quantity: 2,
      unitCost: "500.00",
      currency: "INR",
    });

    const report = unwrap(
      await loadPurchaseSpendReport(params("purchases", { group: "product" })),
    );
    const row = report.rows[0]!;

    expect(row.receivedSpendByCurrency).toEqual([
      { currency: "USD", amount: "100.00" },
      { currency: "INR", amount: "1000.00" },
    ]);
    expect(report.rows).toHaveLength(1);
    expect(row.purchases).toBe(2);
    expect(row.units).toBe(6);
    expect(report.totals.purchases).toBe(2);
    expect(report.totals.units).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// Nothing to total
// ---------------------------------------------------------------------------

describe("an aggregate with nothing behind it", () => {
  it("is empty rather than zero in the default currency", async () => {
    await setCurrency("USD");

    expect(unwrap(await loadInventory()).stockValueByCurrency).toEqual([]);
    expect(unwrap(await loadSales()).realisedRevenueByCurrency).toEqual([]);
    expect(unwrap(await loadProcurement()).receivedSpendByCurrency).toEqual([]);
    expect(unwrap(await loadCosting()).marginByCurrency).toEqual([]);
    expect(unwrap(await loadProductStats()).stockValueByCurrency).toEqual([]);
    expect(unwrap(await loadOrderStats()).openValueByCurrency).toEqual([]);
    expect(unwrap(await loadPurchaseStats()).receivedValueByCurrency).toEqual(
      [],
    );
    expect(unwrap(await loadSupplierStats()).totalPurchasedByCurrency).toEqual(
      [],
    );
    expect(unwrap(await loadCustomerStats()).lifetimeValueByCurrency).toEqual(
      [],
    );
  });

  it("does not report a currency that has no rows on the basis asked for", async () => {
    const supplier = await createSupplier();
    const product = await seedProduct({ sku: "BASIS-1", stockQuantity: 0 });

    // Received in dollars; a second purchase left pending in rupees. Spend
    // is the received basis, so it must show dollars only — not a rupee zero.
    await buy({
      supplierId: supplier.id,
      productId: product.id,
      quantity: 2,
      unitCost: "50.00",
      currency: "USD",
    });

    await setCurrency("INR");
    await createPurchase({
      supplierId: supplier.id,
      items: [{ productId: product.id, quantity: 1, unitCost: "700.00" }],
    });

    const procurement = unwrap(await loadProcurement());

    expect(procurement.receivedSpendByCurrency).toEqual([
      { currency: "USD", amount: "100.00" },
    ]);
    // The pending purchase is a draft until it is placed, so neither basis
    // claims it — and no empty rupee bucket appears on either.
    expect(procurement.committedSpendByCurrency).toEqual([]);
  });
});
