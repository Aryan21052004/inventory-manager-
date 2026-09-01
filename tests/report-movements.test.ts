import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@clerk/nextjs/server", async () => {
  const { clerkServerMock } = await import("./clerk-mock");
  return clerkServerMock;
});

import { prisma } from "@/lib/prisma";
import {
  parseReportParams,
  REPORT_CONFIG,
  reportRowLabel,
  type ReportParams,
} from "@/lib/report-query";
import { loadMovementSummaryReport } from "@/server/reports";
import { loadMovementStats } from "@/server/stock-movements";
import { cancelOrder, confirmOrder, createOrder } from "@/server/orders";
import { cancelPurchase, createPurchase, receivePurchase } from "@/server/purchases";
import { adjustStock, createProduct } from "@/server/products";

import { signOut } from "./clerk-mock";
import {
  createSupplier,
  resetDatabase,
  seedProduct,
  signInWithRole,
} from "./database";

/**
 * The stock movement summary.
 *
 * Most of what is asserted here is about **direction**, because that is the one
 * thing this report can get wrong while still looking entirely plausible. The
 * ledger stores `quantity` as an unsigned size and carries the direction in
 * `type` for only two of its four types; ADJUSTMENT and REVERSAL carry it in
 * the balance columns alone. A cancelled order's REVERSAL adds stock and a
 * cancelled purchase's REVERSAL removes it — same type, opposite directions —
 * so any implementation that reads the type to decide a sign inverts one of
 * them and produces a table nobody would question.
 *
 * The rest is about not dropping movements. Opening stock and manual
 * adjustments have no document behind them, and a report that joined its way to
 * a supplier or a customer would lose both without saying so.
 */

beforeEach(async () => {
  signOut();
  await resetDatabase();
});

function params(overrides: Partial<ReportParams> = {}): ReportParams {
  return {
    ...parseReportParams({ range: "all" }, REPORT_CONFIG.movements),
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

/** A catalogue row with no stock and, deliberately, no opening movement. */
async function part(sku: string, category = "Airframe") {
  return seedProduct({
    sku,
    name: `Part ${sku}`,
    stockQuantity: 0,
    sellingPrice: "100.00",
    category,
  });
}

async function receive(
  supplierId: string,
  productId: string,
  quantity: number,
  unitCost = "10.00",
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
) {
  const order = await createOrder({ customerId, items, discount: "0" });
  await confirmOrder(order.id);
  return order;
}

/** Moves every ledger row for a product onto a fixed day. */
async function dateMovements(productId: string, iso: string) {
  await prisma.stockTransaction.updateMany({
    where: { productId },
    data: { createdAt: new Date(iso) },
  });
}

function row<Row extends { label: string }>(
  data: { rows: Row[] },
  label: string,
): Row | undefined {
  return data.rows.find((r) => r.label === label);
}

// ---------------------------------------------------------------------------
// Direction
// ---------------------------------------------------------------------------

describe("movement direction", () => {
  it("reads a cancelled order's reversal as stock coming back in", async () => {
    /*
     * The headline case. The reversal is type REVERSAL and its `quantity` is
     * positive, exactly like the reversal of a cancelled purchase below — only
     * the balance columns say which way the stock actually went.
     */
    await signInWithRole("ADMIN");
    const supplier = await createSupplier();
    const buyer = await customer();
    const a = await part("A-1");

    await receive(supplier.id, a.id, 100);
    const order = await sell(buyer.id, [{ productId: a.id, quantity: 30 }]);
    await cancelOrder(order.id, "Customer changed their mind");

    const data = unwrap(
      await loadMovementSummaryReport(params({ grouping: "type" })),
    );

    const reversal = row(data, "REVERSAL");
    expect(reversal).toBeDefined();
    expect(reversal!.unitsIn).toBe(30);
    expect(reversal!.unitsOut).toBe(0);
    expect(reversal!.netChange).toBe(30);

    // And the three movements net to the stock actually on the shelf.
    expect(data.totals.netChange).toBe(100);
  });

  it("reads a cancelled purchase's reversal as stock going back out", async () => {
    // Same type as the test above, opposite direction. Reading `type` to decide
    // a sign gets one of these two wrong whichever way it is written.
    await signInWithRole("ADMIN");
    const supplier = await createSupplier();
    const a = await part("A-1");

    const purchase = await receive(supplier.id, a.id, 40);
    await cancelPurchase(purchase.id, "Wrong part shipped");

    const data = unwrap(
      await loadMovementSummaryReport(params({ grouping: "type" })),
    );

    const reversal = row(data, "REVERSAL");
    expect(reversal).toBeDefined();
    expect(reversal!.unitsIn).toBe(0);
    expect(reversal!.unitsOut).toBe(40);
    expect(reversal!.netChange).toBe(-40);

    expect(data.totals.netChange).toBe(0);
  });

  it("reads an adjustment's direction from the balance it left behind", async () => {
    await signInWithRole("ADMIN");
    const supplier = await createSupplier();
    const a = await part("A-1");
    await receive(supplier.id, a.id, 50);

    await adjustStock({
      productId: a.id,
      quantity: "12",
      direction: "DECREASE",
      reason: "Breakage found during a count",
    });
    await adjustStock({
      productId: a.id,
      quantity: "3",
      direction: "INCREASE",
      reason: "Units found behind the rack",
    });

    const data = unwrap(
      await loadMovementSummaryReport(params({ grouping: "type" })),
    );

    const adjustments = row(data, "ADJUSTMENT");
    expect(adjustments).toBeDefined();
    expect(adjustments!.movements).toBe(2);
    expect(adjustments!.unitsIn).toBe(3);
    expect(adjustments!.unitsOut).toBe(12);
    expect(adjustments!.netChange).toBe(-9);
  });

  it("keeps a confirmation and its cancellation as two movements", async () => {
    // They net to nothing, and that is the point: the report says stock moved
    // out and came back rather than pretending neither happened.
    await signInWithRole("ADMIN");
    const supplier = await createSupplier();
    const buyer = await customer();
    const a = await part("A-1");

    await receive(supplier.id, a.id, 20);
    const order = await sell(buyer.id, [{ productId: a.id, quantity: 5 }]);
    await cancelOrder(order.id, "Cancelled");

    const data = unwrap(await loadMovementSummaryReport(params()));

    expect(data.totals.movements).toBe(3);
    expect(data.totals.unitsIn).toBe(25);
    expect(data.totals.unitsOut).toBe(5);
    expect(data.totals.netChange).toBe(20);
  });

  it("reconciles units in minus units out against net change", async () => {
    await signInWithRole("ADMIN");
    const supplier = await createSupplier();
    const buyer = await customer();
    const a = await part("A-1");
    const b = await part("B-1", "Avionics");

    await receive(supplier.id, a.id, 100);
    await receive(supplier.id, b.id, 60);
    await sell(buyer.id, [{ productId: a.id, quantity: 15 }]);
    await adjustStock({
      productId: b.id,
      quantity: "4",
      direction: "DECREASE",
      reason: "Damaged in the store",
    });

    for (const grouping of REPORT_CONFIG.movements.groupings) {
      const data = unwrap(await loadMovementSummaryReport(params({ grouping })));

      expect(data.totals.unitsIn - data.totals.unitsOut).toBe(
        data.totals.netChange,
      );

      for (const r of data.rows) {
        expect(r.unitsIn - r.unitsOut).toBe(r.netChange);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// What counts as a movement
// ---------------------------------------------------------------------------

describe("what the report counts", () => {
  it("includes the opening stock recorded when a product is created", async () => {
    /*
     * Opening stock is a real STOCK_IN with no document behind it. A report
     * that reached a supplier or a customer through a join would lose it
     * silently, which is why this one joins nothing but the catalogue.
     */
    await signInWithRole("ADMIN");

    await createProduct({
      name: "Opening Widget",
      sku: "OPEN-001",
      category: "Airframe",
      standardCost: "5.00",
      sellingPrice: "12.50",
      stockQuantity: "42",
      status: "ACTIVE",
    });

    const data = unwrap(
      await loadMovementSummaryReport(params({ grouping: "type" })),
    );

    const stockIn = row(data, "STOCK_IN");
    expect(stockIn).toBeDefined();
    expect(stockIn!.movements).toBe(1);
    expect(stockIn!.unitsIn).toBe(42);
    expect(data.totals.netChange).toBe(42);
  });

  it("includes a manual adjustment even though it has no document", async () => {
    await signInWithRole("ADMIN");
    const a = await seedProduct({ sku: "ADJ-1", stockQuantity: 30 });

    await adjustStock({
      productId: a.id,
      quantity: "7",
      direction: "DECREASE",
      reason: "Count corrected after a stocktake",
    });

    const data = unwrap(await loadMovementSummaryReport(params()));

    expect(data.totals.movements).toBe(1);
    expect(data.totals.unitsOut).toBe(7);
    expect(data.totals.netChange).toBe(-7);
  });

  it("reports nothing for stock that has no ledger row behind it", async () => {
    /*
     * `seedProduct` writes the balance and a lot directly, the way the lot
     * backfill did for stock that predated this system. There is no movement,
     * and the report must not invent one from the quantity or the lot.
     */
    await signInWithRole("STAFF");
    await seedProduct({ sku: "PRE-1", stockQuantity: 500 });

    const data = unwrap(await loadMovementSummaryReport(params()));

    expect(data.rows).toHaveLength(0);
    expect(data.totals.movements).toBe(0);
    expect(data.totals.netChange).toBe(0);
  });

  it("counts a reversal that points at another transaction", async () => {
    /*
     * `STOCK_TRANSACTION` is a reference type the seed writes and no
     * application path does. It exists in the development database, so the
     * report has to handle it — which it does by not joining to references at
     * all.
     */
    await signInWithRole("ADMIN");
    const a = await seedProduct({ sku: "REF-1", stockQuantity: 10 });

    const original = await prisma.stockTransaction.create({
      data: {
        productId: a.id,
        type: "STOCK_IN",
        quantity: 10,
        previousStock: 0,
        newStock: 10,
        referenceType: "MANUAL",
        note: "Counted in",
      },
    });

    await prisma.stockTransaction.create({
      data: {
        productId: a.id,
        type: "REVERSAL",
        quantity: 10,
        previousStock: 10,
        newStock: 0,
        referenceType: "STOCK_TRANSACTION",
        referenceId: original.id,
        note: "Counted in error",
      },
    });

    const data = unwrap(
      await loadMovementSummaryReport(params({ grouping: "type" })),
    );

    expect(row(data, "STOCK_IN")!.unitsIn).toBe(10);
    expect(row(data, "REVERSAL")!.unitsOut).toBe(10);
    expect(data.totals.netChange).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

describe("date semantics", () => {
  it("dates a movement by when the ledger row was written", async () => {
    /*
     * Not by the document. A purchase raised long ago and received today is a
     * movement today, because the ledger row is written in the same transaction
     * as the balance change.
     */
    await signInWithRole("ADMIN");
    const supplier = await createSupplier();
    const a = await part("A-1");
    const purchase = await receive(supplier.id, a.id, 25);

    await prisma.purchase.update({
      where: { id: purchase.id },
      data: { purchaseDate: new Date("2020-03-01T10:00:00.000Z") },
    });
    await dateMovements(a.id, "2026-05-20T09:00:00.000Z");

    const onTheDay = unwrap(
      await loadMovementSummaryReport(
        params({ from: "2026-05-20", to: "2026-05-20" }),
      ),
    );
    expect(onTheDay.totals.movements).toBe(1);

    const byDocument = unwrap(
      await loadMovementSummaryReport(
        params({ from: "2020-03-01", to: "2020-03-31" }),
      ),
    );
    expect(byDocument.totals.movements).toBe(0);
  });

  it("treats period boundaries as inclusive at both ends", async () => {
    await signInWithRole("ADMIN");
    const supplier = await createSupplier();
    const a = await part("A-1");
    await receive(supplier.id, a.id, 8);

    // Late in the day — the case an exclusive upper bound would silently drop.
    await dateMovements(a.id, "2026-05-20T23:59:59.000Z");

    const onTheDay = unwrap(
      await loadMovementSummaryReport(
        params({ from: "2026-05-20", to: "2026-05-20" }),
      ),
    );
    expect(onTheDay.totals.movements).toBe(1);
    expect(onTheDay.totals.unitsIn).toBe(8);

    const dayBefore = unwrap(
      await loadMovementSummaryReport(
        params({ from: "2026-05-19", to: "2026-05-19" }),
      ),
    );
    expect(dayBefore.totals.movements).toBe(0);

    // And the lower bound covers the whole of its own day.
    await dateMovements(a.id, "2026-05-20T00:00:00.000Z");
    const fromMidnight = unwrap(
      await loadMovementSummaryReport(params({ from: "2026-05-20", to: null })),
    );
    expect(fromMidnight.totals.movements).toBe(1);
  });

  it("applies no date predicate at all for an all-time range", async () => {
    await signInWithRole("ADMIN");
    const supplier = await createSupplier();
    const a = await part("A-1");
    await receive(supplier.id, a.id, 12);
    await dateMovements(a.id, "2001-07-04T12:00:00.000Z");

    const allTime = unwrap(await loadMovementSummaryReport(params()));
    expect(allTime.totals.movements).toBe(1);
    expect(allTime.totals.unitsIn).toBe(12);

    // The same movement is outside a bounded window, which is what proves the
    // all-time case is unbounded rather than merely very wide.
    const bounded = unwrap(
      await loadMovementSummaryReport(
        params({ from: "2026-01-01", to: "2026-12-31" }),
      ),
    );
    expect(bounded.totals.movements).toBe(0);
  });

  it("buckets by calendar month when grouped by period", async () => {
    await signInWithRole("ADMIN");
    const supplier = await createSupplier();
    const a = await part("A-1");
    const b = await part("B-1");

    await receive(supplier.id, a.id, 10);
    await receive(supplier.id, b.id, 20);
    await dateMovements(a.id, "2026-04-30T22:00:00.000Z");
    await dateMovements(b.id, "2026-05-01T02:00:00.000Z");

    const data = unwrap(
      await loadMovementSummaryReport(params({ grouping: "period" })),
    );

    expect(data.rows.map((r) => r.label).sort()).toEqual(["2026-04", "2026-05"]);
    expect(row(data, "2026-04")!.unitsIn).toBe(10);
    expect(row(data, "2026-05")!.unitsIn).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// Grouping and filtering
// ---------------------------------------------------------------------------

describe("grouping and filtering", () => {
  async function fixture() {
    await signInWithRole("ADMIN");
    const supplier = await createSupplier();
    const buyer = await customer();
    const airframe = await part("AF-1", "Airframe");
    const avionics = await part("AV-1", "Avionics");

    await receive(supplier.id, airframe.id, 100);
    await receive(supplier.id, avionics.id, 40);
    await sell(buyer.id, [{ productId: airframe.id, quantity: 25 }]);

    return { airframe, avionics };
  }

  it("groups by product, with the SKU as the detail", async () => {
    const { airframe } = await fixture();

    const data = unwrap(
      await loadMovementSummaryReport(params({ grouping: "product" })),
    );

    expect(data.rows).toHaveLength(2);
    const af = row(data, `Part AF-1`)!;
    expect(af.sublabel).toBe(airframe.sku);
    expect(af.movements).toBe(2);
    expect(af.unitsIn).toBe(100);
    expect(af.unitsOut).toBe(25);
    expect(af.products).toBe(1);
  });

  it("groups by category", async () => {
    await fixture();

    const data = unwrap(
      await loadMovementSummaryReport(params({ grouping: "category" })),
    );

    expect(data.rows.map((r) => r.label).sort()).toEqual([
      "Airframe",
      "Avionics",
    ]);
    expect(row(data, "Airframe")!.netChange).toBe(75);
    expect(row(data, "Avionics")!.netChange).toBe(40);
  });

  it("groups by movement type and labels the enum for a reader", async () => {
    await fixture();

    const data = unwrap(
      await loadMovementSummaryReport(params({ grouping: "type" })),
    );

    expect(data.rows.map((r) => r.label).sort()).toEqual([
      "STOCK_IN",
      "STOCK_OUT",
    ]);
    // The raw enum travels; the shared helper is what turns it into words, so
    // the page and the CSV cannot spell it differently.
    expect(reportRowLabel("type", "STOCK_IN")).toBe("Stock In");
    expect(reportRowLabel("period", "2026-05")).toBe("2026-05");
  });

  it("filters by movement type", async () => {
    await fixture();

    const inbound = unwrap(
      await loadMovementSummaryReport(params({ movementType: "STOCK_IN" })),
    );
    expect(inbound.totals.movements).toBe(2);
    expect(inbound.totals.unitsIn).toBe(140);
    expect(inbound.totals.unitsOut).toBe(0);

    const outbound = unwrap(
      await loadMovementSummaryReport(params({ movementType: "STOCK_OUT" })),
    );
    expect(outbound.totals.movements).toBe(1);
    expect(outbound.totals.unitsOut).toBe(25);

    const none = unwrap(
      await loadMovementSummaryReport(params({ movementType: "ADJUSTMENT" })),
    );
    expect(none.totals.movements).toBe(0);
  });

  it("ignores an unrecognised movement type in the query string", async () => {
    await fixture();

    const parsed = parseReportParams(
      { range: "all", mtype: "NONSENSE" },
      REPORT_CONFIG.movements,
    );
    expect(parsed.movementType).toBeNull();

    const data = unwrap(await loadMovementSummaryReport(parsed));
    expect(data.totals.movements).toBe(3);
  });

  it("filters by category and by product search", async () => {
    await fixture();

    const byCategory = unwrap(
      await loadMovementSummaryReport(params({ category: "Avionics" })),
    );
    expect(byCategory.totals.movements).toBe(1);
    expect(byCategory.totals.unitsIn).toBe(40);

    const bySku = unwrap(
      await loadMovementSummaryReport(params({ search: "AF-1" })),
    );
    expect(bySku.totals.movements).toBe(2);

    const byName = unwrap(
      await loadMovementSummaryReport(params({ search: "part av" })),
    );
    expect(byName.totals.movements).toBe(1);
  });

  it("returns an empty page with zero totals when nothing matches", async () => {
    await fixture();

    const data = unwrap(
      await loadMovementSummaryReport(params({ category: "Nothing Here" })),
    );

    expect(data.rows).toHaveLength(0);
    expect(data.total).toBe(0);
    expect(data.totals).toEqual({
      movements: 0,
      products: 0,
      unitsIn: 0,
      unitsOut: 0,
      netChange: 0,
    });
    // A page count of zero would make the pagination render "page 1 of 0".
    expect(data.pageCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Sorting, paging, and agreement with the ledger
// ---------------------------------------------------------------------------

describe("sorting and paging", () => {
  it("pages deterministically without repeating a row", async () => {
    await signInWithRole("ADMIN");
    const supplier = await createSupplier();

    for (const sku of ["P-1", "P-2", "P-3", "P-4", "P-5"]) {
      const product = await part(sku);
      await receive(supplier.id, product.id, 10);
    }

    const first = unwrap(
      await loadMovementSummaryReport(
        params({ grouping: "product", pageSize: 25, page: 1 }),
      ),
    );
    expect(first.total).toBe(5);

    const pageOne = unwrap(
      await loadMovementSummaryReport(
        params({ grouping: "product", pageSize: 2, page: 1 }),
      ),
    );
    const pageTwo = unwrap(
      await loadMovementSummaryReport(
        params({ grouping: "product", pageSize: 2, page: 2 }),
      ),
    );
    const pageThree = unwrap(
      await loadMovementSummaryReport(
        params({ grouping: "product", pageSize: 2, page: 3 }),
      ),
    );

    expect(pageOne.pageCount).toBe(3);
    const keys = [...pageOne.rows, ...pageTwo.rows, ...pageThree.rows].map(
      (r) => r.key,
    );
    expect(new Set(keys).size).toBe(5);
  });

  it("sorts by each whitelisted key and falls back for an unknown one", async () => {
    await signInWithRole("ADMIN");
    const supplier = await createSupplier();
    const buyer = await customer();
    const heavy = await part("HEAVY-1");
    const light = await part("LIGHT-1");

    await receive(supplier.id, heavy.id, 200);
    await sell(buyer.id, [{ productId: heavy.id, quantity: 50 }]);
    await receive(supplier.id, light.id, 5);

    const byNet = unwrap(
      await loadMovementSummaryReport(
        params({ grouping: "product", sort: "net", direction: "desc" }),
      ),
    );
    expect(byNet.rows[0]!.label).toBe("Part HEAVY-1");

    const byNetAsc = unwrap(
      await loadMovementSummaryReport(
        params({ grouping: "product", sort: "net", direction: "asc" }),
      ),
    );
    expect(byNetAsc.rows[0]!.label).toBe("Part LIGHT-1");

    // An unrecognised sort key never reaches the query — the parser drops it.
    const parsed = parseReportParams(
      { range: "all", group: "product", sort: "; DROP TABLE products" },
      REPORT_CONFIG.movements,
    );
    expect(parsed.sort).toBe(REPORT_CONFIG.movements.defaultSort);
    const safe = unwrap(await loadMovementSummaryReport(parsed));
    expect(safe.rows).toHaveLength(2);
  });

  it("agrees with the ledger's own statistics over an unfiltered range", async () => {
    /*
     * Two answers to one question is the failure the shared report
     * architecture exists to prevent. `loadMovementStats` powers the tiles on
     * /stock-movements and computes its net change independently.
     */
    await signInWithRole("ADMIN");
    const supplier = await createSupplier();
    const buyer = await customer();
    const a = await part("A-1");
    const b = await part("B-1", "Avionics");

    await receive(supplier.id, a.id, 90);
    await receive(supplier.id, b.id, 30);
    const order = await sell(buyer.id, [{ productId: a.id, quantity: 20 }]);
    await cancelOrder(order.id, "Cancelled");
    await adjustStock({
      productId: b.id,
      quantity: "6",
      direction: "DECREASE",
      reason: "Damaged on the shelf",
    });

    const report = unwrap(await loadMovementSummaryReport(params()));
    const stats = unwrap(await loadMovementStats());

    expect(report.totals.movements).toBe(stats.total);
    expect(report.totals.netChange).toBe(stats.netChange);

    // And the net movement equals the stock actually on the shelf, because
    // every unit here arrived through the ledger.
    const onHand = await prisma.product.aggregate({
      _sum: { stockQuantity: true },
    });
    expect(report.totals.netChange).toBe(onHand._sum.stockQuantity);
  });
});

// ---------------------------------------------------------------------------
// Empty database and access
// ---------------------------------------------------------------------------

describe("empty database and access", () => {
  it("returns zeroes rather than crashing or producing NaN", async () => {
    await signInWithRole("STAFF");

    for (const grouping of REPORT_CONFIG.movements.groupings) {
      const data = unwrap(await loadMovementSummaryReport(params({ grouping })));

      expect(data.rows).toHaveLength(0);
      expect(data.total).toBe(0);
      expect(data.pageCount).toBe(1);
      expect(data.totals.movements).toBe(0);
      expect(data.totals.products).toBe(0);
      expect(data.totals.unitsIn).toBe(0);
      expect(data.totals.unitsOut).toBe(0);
      expect(data.totals.netChange).toBe(0);
      expect(Number.isNaN(data.totals.netChange)).toBe(false);
    }
  });

  it("refuses an unauthenticated caller", async () => {
    signOut();

    const result = await loadMovementSummaryReport(params());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("UNAUTHORIZED");
  });
});
