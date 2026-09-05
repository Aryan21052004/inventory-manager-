import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@clerk/nextjs/server", async () => {
  const { clerkServerMock } = await import("./clerk-mock");
  return clerkServerMock;
});

import { prisma } from "@/lib/prisma";
import {
  loadAttention,
  loadCosting,
  loadInventory,
  loadProcurement,
  loadRecentMovements,
  loadSales,
} from "@/server/dashboard";
import { loadOrderStats } from "@/server/orders";
import { loadProductStats } from "@/server/products";
import { loadPurchaseStats, receivePurchase, createPurchase, cancelPurchase } from "@/server/purchases";
import { cancelOrder, completeOrder, confirmOrder, createOrder } from "@/server/orders";

import { signOut } from "./clerk-mock";
import {
  createSupplier,
  quoted,
  resetDatabase,
  seedProduct,
  signInWithRole,
} from "./database";

/**
 * The dashboard, and the one number it must never print.
 *
 * `revenue - knownCost` is not margin when some of the units sold have no
 * recorded acquisition cost. It is an upper bound reached only if those units
 * were free — and on a database carrying any history from before cost tracking,
 * it reports the entire revenue as profit. A hundred per cent margin, in the
 * most prominent place in the application, looking entirely plausible.
 *
 * Most of this file is about that. The rest is about the other way a dashboard
 * misleads: counting things that have not happened. A draft is not revenue, a
 * cancelled purchase is not spend, and an unfinished document is not work
 * queued up.
 */

beforeEach(async () => {
  signOut();
  await resetDatabase();
});

async function customer(name = "Contoso Aviation") {
  return prisma.customer.create({ data: { name } });
}

async function part(sku: string, sellingPrice = "100.00") {
  return seedProduct({
    sku,
    name: `Part ${sku}`,
    stockQuantity: 0,
    sellingPrice,
  });
}

/** Stock that arrived with a known cost, the way real stock does. */
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

async function sell(customerId: string, productId: string, quantity: number) {
  const order = await createOrder({
    customerId,
    items: await quoted([{ productId, quantity }]),
  });
  await confirmOrder(order.id);
  return order;
}

function unwrap<T>(result: { ok: true; data: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw new Error("expected the section to load");
  return result.data;
}

// ---------------------------------------------------------------------------
// Empty database
// ---------------------------------------------------------------------------

describe("an empty database", () => {
  it("loads every section without crashing or producing NaN", async () => {
    await signInWithRole("STAFF");

    const attention = unwrap(await loadAttention());
    const inventory = unwrap(await loadInventory());
    const sales = unwrap(await loadSales());
    const procurement = unwrap(await loadProcurement());
    const costing = unwrap(await loadCosting());
    const movements = unwrap(await loadRecentMovements());

    expect(attention.certificates.expiredCount).toBe(0);
    expect(attention.uncostedUnits).toBe(0);
    expect(inventory.productCount).toBe(0);
    expect(Number(inventory.stockValue)).toBe(0);
    expect(Number(sales.realisedRevenue)).toBe(0);
    expect(Number(procurement.receivedSpend)).toBe(0);
    expect(movements).toHaveLength(0);

    // No sales means no margin — not zero, and certainly not a percentage.
    expect(costing.unitsSold).toBe(0);
    expect(costing.margin).toBeNull();
    expect(costing.marginPercent).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Cost coverage — the heart of it
// ---------------------------------------------------------------------------

describe("cost coverage", () => {
  /**
   * An order in the shape migrated data has: stock deducted for real, but with
   * the lot bookkeeping stripped so it looks confirmed before costing existed.
   */
  async function sellWithoutCost(
    customerId: string,
    productId: string,
    quantity: number,
  ) {
    const order = await sell(customerId, productId, quantity);

    const outbound = await prisma.stockTransaction.findMany({
      where: { referenceType: "ORDER", referenceId: order.id, type: "STOCK_OUT" },
      select: { id: true },
    });

    await prisma.stockLotConsumption.deleteMany({
      where: { stockTransactionId: { in: outbound.map((row) => row.id) } },
    });

    /*
     * Close the lots up behind the deleted consumption rows, so the product is
     * left in the shape migrated data is actually in.
     *
     * The backfill attributed the *remaining* balance, so it has no record of
     * units already sold — and it never created a lot for a batch that was
     * entirely gone. A fully drained lot is therefore deleted rather than
     * zeroed; the check constraint refuses `quantity_received = 0`, and it is
     * right to.
     */
    const lots = await prisma.stockLot.findMany({
      where: { productId },
      select: { id: true, quantityRemaining: true },
    });

    for (const lot of lots) {
      if (lot.quantityRemaining === 0) {
        await prisma.stockLot.delete({ where: { id: lot.id } });
        continue;
      }

      await prisma.stockLot.update({
        where: { id: lot.id },
        data: { quantityReceived: lot.quantityRemaining },
      });
    }

    await prisma.orderItem.updateMany({
      where: { orderId: order.id },
      data: { costTotal: null, costedQuantity: 0 },
    });

    return order;
  }

  it("reports no margin at all when nothing sold has a known cost", async () => {
    /*
     * The regression that matters most. Revenue is real, cost is entirely
     * unknown, and the naive subtraction would report the whole revenue as
     * profit at one hundred per cent.
     */
    await signInWithRole("STAFF");
    const supplier = await createSupplier();
    const buyer = await customer();
    const a = await part("A-1", "100.00");

    await receive(supplier.id, a.id, 20, "60.00");
    await sellWithoutCost(buyer.id, a.id, 10);

    const costing = unwrap(await loadCosting());

    expect(costing.unitsSold).toBe(10);
    expect(costing.costedUnits).toBe(0);
    expect(Number(costing.allRevenue)).toBe(1_000);

    // Nothing. Not zero, not the revenue, not a percentage.
    expect(costing.margin).toBeNull();
    expect(costing.marginPercent).toBeNull();
    expect(costing.knownCogs).toBeNull();
    expect(costing.costedRevenue).toBeNull();
  });

  it("never reports a hundred per cent margin on uncosted sales", async () => {
    // Stated as its own assertion because it is the specific wrong number.
    await signInWithRole("STAFF");
    const supplier = await createSupplier();
    const buyer = await customer();
    const a = await part("A-1", "100.00");

    await receive(supplier.id, a.id, 20, "60.00");
    await sellWithoutCost(buyer.id, a.id, 10);

    const costing = unwrap(await loadCosting());
    expect(costing.marginPercent).not.toBe(100);
    expect(costing.margin).not.toBe(costing.allRevenue);
  });

  it("apportions revenue to the costed units at partial coverage", async () => {
    /*
     * 10 units sold with no cost, then 10 with a known one. Revenue is 2,000
     * across 20 units; only half of it may be set against the 600 of cost.
     *
     * The wrong answer is 2,000 - 600 = 1,400. The right one is 1,000 - 600.
     */
    await signInWithRole("STAFF");
    const supplier = await createSupplier();
    const buyer = await customer();
    const a = await part("A-1", "100.00");

    await receive(supplier.id, a.id, 10, "60.00");
    await sellWithoutCost(buyer.id, a.id, 10);

    await receive(supplier.id, a.id, 10, "60.00");
    await sell(buyer.id, a.id, 10);

    const costing = unwrap(await loadCosting());

    expect(costing.unitsSold).toBe(20);
    expect(costing.costedUnits).toBe(10);
    expect(Number(costing.allRevenue)).toBe(2_000);
    expect(Number(costing.costedRevenue)).toBe(1_000);
    expect(Number(costing.knownCogs)).toBe(600);
    expect(Number(costing.margin)).toBe(400);
    expect(Number(costing.margin)).not.toBe(1_400);
    expect(costing.marginPercent).toBeCloseTo(40, 5);
  });

  it("covers the whole business at full coverage", async () => {
    await signInWithRole("STAFF");
    const supplier = await createSupplier();
    const buyer = await customer();
    const a = await part("A-1", "100.00");

    await receive(supplier.id, a.id, 20, "60.00");
    await sell(buyer.id, a.id, 15);

    const costing = unwrap(await loadCosting());

    expect(costing.unitsSold).toBe(15);
    expect(costing.costedUnits).toBe(15);
    expect(Number(costing.knownCogs)).toBe(900);
    expect(Number(costing.costedRevenue)).toBe(1_500);
    expect(Number(costing.margin)).toBe(600);
    expect(costing.marginPercent).toBeCloseTo(40, 5);
  });

  it("counts a completed order's cost as realised", async () => {
    await signInWithRole("STAFF");
    const supplier = await createSupplier();
    const buyer = await customer();
    const a = await part("A-1", "100.00");

    await receive(supplier.id, a.id, 20, "60.00");
    const order = await sell(buyer.id, a.id, 5);
    await completeOrder(order.id);

    const costing = unwrap(await loadCosting());
    expect(costing.costedUnits).toBe(5);
    expect(Number(costing.knownCogs)).toBe(300);
  });

  it("drops a cancelled order's cost out of the figures entirely", async () => {
    await signInWithRole("STAFF");
    const supplier = await createSupplier();
    const buyer = await customer();
    const a = await part("A-1", "100.00");

    await receive(supplier.id, a.id, 20, "60.00");
    const order = await sell(buyer.id, a.id, 5);
    await cancelOrder(order.id);

    const costing = unwrap(await loadCosting());
    expect(costing.unitsSold).toBe(0);
    expect(costing.margin).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

describe("inventory value", () => {
  it("values only the units whose cost is known, and counts the rest", async () => {
    await signInWithRole("STAFF");
    await seedProduct({ sku: "V-1", stockQuantity: 10, lotUnitCost: "80.00" });
    await seedProduct({
      sku: "V-2",
      stockQuantity: 5,
      lotUnitCost: null,
    });

    const inventory = unwrap(await loadInventory());

    expect(Number(inventory.stockValue)).toBe(800);
    expect(inventory.costedUnits).toBe(10);
    expect(inventory.uncostedUnits).toBe(5);
    expect(inventory.totalUnits).toBe(15);
  });

  it("never falls back to the standard cost for uncosted stock", async () => {
    await signInWithRole("STAFF");
    await seedProduct({
      sku: "V-1",
      stockQuantity: 10,
      lotUnitCost: null,
    });

    const inventory = unwrap(await loadInventory());
    expect(Number(inventory.stockValue)).toBe(0);
    expect(inventory.uncostedUnits).toBe(10);
  });

  it("includes inactive and discontinued stock, and breaks it out", async () => {
    /*
     * Stock in a retired product is still capital. The previous dashboard
     * filtered it out of the valuation entirely, which understated the
     * warehouse — but leaving it indistinguishable from sellable stock would
     * overstate what can actually be sold.
     */
    await signInWithRole("STAFF");
    await seedProduct({ sku: "ACT-1", stockQuantity: 10, lotUnitCost: "50.00" });
    await seedProduct({
      sku: "INA-1",
      stockQuantity: 4,
      status: "INACTIVE",
      lotUnitCost: "25.00",
    });
    await seedProduct({
      sku: "DIS-1",
      stockQuantity: 2,
      status: "DISCONTINUED",
      lotUnitCost: "30.00",
    });

    const inventory = unwrap(await loadInventory());

    // 10×50 + 4×25 + 2×30 = 660
    expect(Number(inventory.stockValue)).toBe(660);
    expect(inventory.totalUnits).toBe(16);

    // 4×25 + 2×30 = 160, across two products.
    expect(inventory.retired.productCount).toBe(2);
    expect(inventory.retired.units).toBe(6);
    expect(Number(inventory.retired.value)).toBe(160);
  });

  it("reports no retired stock when everything is active", async () => {
    await signInWithRole("STAFF");
    await seedProduct({ sku: "ACT-1", stockQuantity: 10, lotUnitCost: "50.00" });

    const inventory = unwrap(await loadInventory());
    expect(inventory.retired.productCount).toBe(0);
    expect(inventory.retired.units).toBe(0);
    expect(Number(inventory.retired.value)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Needs attention
// ---------------------------------------------------------------------------

describe("needs attention", () => {
  it("reports uncosted units, and classifies no stock at all", async () => {
    // This figure used to ride inside a raw query over `products` whose only
    // reason to exist was hosting the two threshold counts. It aggregates the
    // lots directly now, so an empty catalogue can no longer decide how many
    // rows come back — and a product holding nothing is simply a product
    // holding nothing.
    await signInWithRole("STAFF");
    await seedProduct({ sku: "T-1", stockQuantity: 40, lotUnitCost: "2.00" });
    await seedProduct({ sku: "T-2", stockQuantity: 25 });
    await seedProduct({ sku: "T-3", stockQuantity: 0 });

    const attention = unwrap(await loadAttention());

    expect(attention.uncostedUnits).toBe(25);
    expect(attention).not.toHaveProperty("lowStockCount");
    expect(attention).not.toHaveProperty("outOfStockCount");
  });

  it("excludes drafts from the orders needing action", async () => {
    // A draft is a document somebody has not finished writing, not work queued
    // up. Counting it overstates the one figure meant to prompt action.
    await signInWithRole("STAFF");
    const supplier = await createSupplier();
    const buyer = await customer();
    const a = await part("A-1");
    await receive(supplier.id, a.id, 50, "10.00");

    await createOrder({
      customerId: buyer.id,
      items: await quoted([{ productId: a.id, quantity: 1 }]),
    });
    await sell(buyer.id, a.id, 2);

    const attention = unwrap(await loadAttention());
    expect(attention.actionableOrderCount).toBe(1);
  });

  it("counts drafts among the outstanding deliveries", async () => {
    // The deliberate asymmetry: as money a draft purchase commits nothing, but
    // as work it is a document sitting on somebody's desk.
    await signInWithRole("STAFF");
    const supplier = await createSupplier();
    const a = await part("A-1");

    await createPurchase({
      supplierId: supplier.id,
      items: [{ productId: a.id, quantity: 5, unitCost: "10.00" }],
    });

    const attention = unwrap(await loadAttention());
    expect(attention.outstandingPurchaseCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Certificates
// ---------------------------------------------------------------------------

describe("certificate attention", () => {
  /**
   * Paperwork for a product's batch.
   *
   * Certificates belong to lots now, so the fixture finds the one `seedProduct`
   * created for the balance it wrote. Attention is counted per open lot: a part
   * with two batches, one covered and one not, is one problem rather than one
   * product's worth of doubt over both.
   */
  async function certificateFor(
    productId: string,
    expiryDate: Date | null,
    uploadedBy: string,
    stockLotId?: string,
  ) {
    const lotId =
      stockLotId ??
      (
        await prisma.stockLot.findFirstOrThrow({
          where: { productId },
          select: { id: true },
        })
      ).id;

    return prisma.certificate.create({
      data: {
        productId,
        stockLotId: lotId,
        certificateType: "EASA Form 1",
        certificateNumber: `C-${Math.random().toString(36).slice(2, 8)}`,
        issueDate: new Date("2026-01-01"),
        expiryDate,
        fileName: "cert.pdf",
        storageKey: `key-${Math.random().toString(36).slice(2, 10)}`,
        contentType: "application/pdf",
        fileSize: 1024,
        uploadedBy,
      },
    });
  }

  function daysFromNow(days: number): Date {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() + days);
    return date;
  }

  it("counts an open batch with no certificate as missing", async () => {
    await signInWithRole("ADMIN");
    await seedProduct({ sku: "NO-CERT" });

    const attention = unwrap(await loadAttention());
    expect(attention.certificates.missingCount).toBe(1);
    expect(attention.certificates.lots[0]!.status).toBe("MISSING");
    expect(attention.certificates.lots[0]!.expiryDate).toBeNull();
  });

  it("counts an expired certificate", async () => {
    const user = await signInWithRole("ADMIN");
    const product = await seedProduct({ sku: "EXPIRED-1" });
    await certificateFor(product.id, daysFromNow(-5), user.id);

    const attention = unwrap(await loadAttention());
    expect(attention.certificates.expiredCount).toBe(1);
    expect(attention.certificates.missingCount).toBe(0);

    const flagged = attention.certificates.lots[0]!;
    expect(flagged.status).toBe("EXPIRED");
    expect(flagged.daysRemaining).toBeLessThan(0);
  });

  it("counts a certificate expiring within thirty days", async () => {
    const user = await signInWithRole("ADMIN");
    const product = await seedProduct({ sku: "SOON-1" });
    await certificateFor(product.id, daysFromNow(10), user.id);

    const attention = unwrap(await loadAttention());
    expect(attention.certificates.expiringSoonCount).toBe(1);
    expect(attention.certificates.expiredCount).toBe(0);
    expect(attention.certificates.lots[0]!.status).toBe("EXPIRING_SOON");
    expect(attention.certificates.lots[0]!.daysRemaining).toBe(10);
  });

  it("leaves a certificate expiring beyond thirty days alone", async () => {
    const user = await signInWithRole("ADMIN");
    const product = await seedProduct({ sku: "FINE-1" });
    await certificateFor(product.id, daysFromNow(90), user.id);

    const attention = unwrap(await loadAttention());
    expect(attention.certificates.expiringSoonCount).toBe(0);
    expect(attention.certificates.lots).toHaveLength(0);
  });

  it("treats a certificate with no expiry date as valid", async () => {
    /*
     * A Certificate of Conformity typically never expires. Flagging a null
     * expiry would raise an alarm about a large share of legitimate documents.
     */
    const user = await signInWithRole("ADMIN");
    const product = await seedProduct({ sku: "NO-EXPIRY" });
    await certificateFor(product.id, null, user.id);

    const attention = unwrap(await loadAttention());
    expect(attention.certificates.expiredCount).toBe(0);
    expect(attention.certificates.expiringSoonCount).toBe(0);
    expect(attention.certificates.missingCount).toBe(0);
  });

  it("ignores a superseded certificate and reads the current one", async () => {
    const user = await signInWithRole("ADMIN");
    const product = await seedProduct({ sku: "REPLACED-1" });

    const old = await certificateFor(product.id, daysFromNow(-40), user.id);
    await prisma.certificate.update({
      where: { id: old.id },
      data: { supersededAt: new Date() },
    });
    await certificateFor(product.id, daysFromNow(200), user.id);

    const attention = unwrap(await loadAttention());
    expect(attention.certificates.expiredCount).toBe(0);
    expect(attention.certificates.lots).toHaveLength(0);
  });

  it("does not chase paperwork on retired products", async () => {
    await signInWithRole("ADMIN");
    await seedProduct({ sku: "GONE-1", status: "DISCONTINUED" });

    const attention = unwrap(await loadAttention());
    expect(attention.certificates.missingCount).toBe(0);
  });

  it("orders expired before expiring, soonest first", async () => {
    const user = await signInWithRole("ADMIN");
    const expiring = await seedProduct({ sku: "B-SOON" });
    const expired = await seedProduct({ sku: "A-EXPIRED" });
    await seedProduct({ sku: "C-MISSING" });

    await certificateFor(expiring.id, daysFromNow(20), user.id);
    await certificateFor(expired.id, daysFromNow(-10), user.id);

    const attention = unwrap(await loadAttention());
    const order = attention.certificates.lots.map((lot) => lot.status);

    expect(order[0]).toBe("EXPIRED");
    expect(order[1]).toBe("EXPIRING_SOON");
    // Missing has no date, so it sorts last — behind the dated problems.
    expect(order[2]).toBe("MISSING");
  });
});

// ---------------------------------------------------------------------------
// Sales
// ---------------------------------------------------------------------------

describe("sales figures", () => {
  it("counts confirmed and completed orders as revenue", async () => {
    await signInWithRole("STAFF");
    const supplier = await createSupplier();
    const buyer = await customer();
    const a = await part("A-1", "100.00");
    await receive(supplier.id, a.id, 100, "10.00");

    await sell(buyer.id, a.id, 3);
    const completed = await sell(buyer.id, a.id, 2);
    await completeOrder(completed.id);

    const sales = unwrap(await loadSales());
    expect(sales.confirmedCount).toBe(1);
    expect(sales.completedCount).toBe(1);
    expect(Number(sales.realisedRevenue)).toBe(500);
  });

  it("excludes drafts from realised revenue", async () => {
    await signInWithRole("STAFF");
    const buyer = await customer();
    const a = await part("A-1", "100.00");

    await createOrder({
      customerId: buyer.id,
      items: await quoted([{ productId: a.id, quantity: 4 }]),
    });

    const sales = unwrap(await loadSales());
    expect(sales.draftCount).toBe(1);
    expect(Number(sales.realisedRevenue)).toBe(0);
  });

  it("excludes cancelled orders from realised revenue", async () => {
    await signInWithRole("STAFF");
    const supplier = await createSupplier();
    const buyer = await customer();
    const a = await part("A-1", "100.00");
    await receive(supplier.id, a.id, 50, "10.00");

    const order = await sell(buyer.id, a.id, 4);
    await cancelOrder(order.id);

    const sales = unwrap(await loadSales());
    expect(sales.cancelledCount).toBe(1);
    expect(Number(sales.realisedRevenue)).toBe(0);
  });

  it("counts only confirmed orders as open value", async () => {
    await signInWithRole("STAFF");
    const supplier = await createSupplier();
    const buyer = await customer();
    const a = await part("A-1", "100.00");
    await receive(supplier.id, a.id, 100, "10.00");

    await sell(buyer.id, a.id, 3);
    const completed = await sell(buyer.id, a.id, 2);
    await completeOrder(completed.id);

    const sales = unwrap(await loadSales());
    // Confirmed 300 is open; the completed 200 is revenue but not a commitment.
    expect(Number(sales.openOrderValue)).toBe(300);
  });

  it("lists recent orders newest first", async () => {
    await signInWithRole("STAFF");
    const buyer = await customer();
    const a = await part("A-1", "100.00");

    for (let index = 0; index < 3; index += 1) {
      await createOrder({
        customerId: buyer.id,
        items: await quoted([{ productId: a.id, quantity: 1 }]),
      });
    }

    const sales = unwrap(await loadSales());
    expect(sales.recentOrders).toHaveLength(3);
    expect(sales.recentOrders[0]!.customerName).toBe("Contoso Aviation");
  });
});

// ---------------------------------------------------------------------------
// Procurement
// ---------------------------------------------------------------------------

describe("procurement figures", () => {
  it("counts received purchases as spend", async () => {
    await signInWithRole("STAFF");
    const supplier = await createSupplier();
    const a = await part("A-1");

    await receive(supplier.id, a.id, 10, "25.00");

    const procurement = unwrap(await loadProcurement());
    expect(procurement.receivedCount).toBe(1);
    expect(Number(procurement.receivedSpend)).toBe(250);
  });

  it("excludes drafts from spend", async () => {
    await signInWithRole("STAFF");
    const supplier = await createSupplier();
    const a = await part("A-1");

    await createPurchase({
      supplierId: supplier.id,
      items: [{ productId: a.id, quantity: 10, unitCost: "25.00" }],
    });

    const procurement = unwrap(await loadProcurement());
    expect(procurement.draftCount).toBe(1);
    expect(Number(procurement.receivedSpend)).toBe(0);
    expect(Number(procurement.committedSpend)).toBe(0);
  });

  it("excludes cancelled purchases from spend", async () => {
    await signInWithRole("STAFF");
    const supplier = await createSupplier();
    const a = await part("A-1");

    const purchase = await createPurchase({
      supplierId: supplier.id,
      items: [{ productId: a.id, quantity: 10, unitCost: "25.00" }],
    });
    await cancelPurchase(purchase.id);

    const procurement = unwrap(await loadProcurement());
    expect(procurement.cancelledCount).toBe(1);
    expect(Number(procurement.receivedSpend)).toBe(0);
  });

  it("counts pending purchases as committed, not spent", async () => {
    await signInWithRole("STAFF");
    const supplier = await createSupplier();
    const a = await part("A-1");

    const purchase = await createPurchase({
      supplierId: supplier.id,
      items: [{ productId: a.id, quantity: 10, unitCost: "25.00" }],
    });
    await prisma.purchase.update({
      where: { id: purchase.id },
      data: { status: "PENDING" },
    });

    const procurement = unwrap(await loadProcurement());
    expect(Number(procurement.committedSpend)).toBe(250);
    expect(Number(procurement.receivedSpend)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Agreement with the module stats
// ---------------------------------------------------------------------------

describe("the dashboard agrees with the module figures", () => {
  it("matches loadOrderStats, loadPurchaseStats and loadProductStats", async () => {
    await signInWithRole("STAFF");
    const supplier = await createSupplier();
    const buyer = await customer();
    const a = await part("A-1", "100.00");

    await receive(supplier.id, a.id, 50, "10.00");
    await sell(buyer.id, a.id, 5);
    await createOrder({
      customerId: buyer.id,
      items: await quoted([{ productId: a.id, quantity: 1 }]),
    });

    const sales = unwrap(await loadSales());
    const orderStats = unwrap(await loadOrderStats());
    expect(sales.draftCount).toBe(orderStats.draft);
    expect(sales.confirmedCount).toBe(orderStats.confirmed);
    expect(Number(sales.openOrderValue)).toBe(Number(orderStats.openValue));

    const procurement = unwrap(await loadProcurement());
    const purchaseStats = unwrap(await loadPurchaseStats());
    expect(procurement.draftCount).toBe(purchaseStats.draft);
    expect(Number(procurement.receivedSpend)).toBe(
      Number(purchaseStats.receivedValue),
    );

    const inventory = unwrap(await loadInventory());
    const productStats = unwrap(await loadProductStats());
    expect(inventory.productCount).toBe(productStats.total);
    expect(Number(inventory.stockValue)).toBe(Number(productStats.stockValue));
    expect(inventory.uncostedUnits).toBe(productStats.uncostedUnits);
  });
});

// ---------------------------------------------------------------------------
// Recent activity and failure
// ---------------------------------------------------------------------------

describe("recent activity", () => {
  it("returns movements newest first, with the signed change", async () => {
    await signInWithRole("STAFF");
    const supplier = await createSupplier();
    const buyer = await customer();
    const a = await part("A-1");

    await receive(supplier.id, a.id, 20, "10.00");
    await sell(buyer.id, a.id, 5);

    const movements = unwrap(await loadRecentMovements());

    expect(movements[0]!.type).toBe("STOCK_OUT");
    expect(movements[0]!.change).toBe(-5);
    expect(movements[0]!.newStock).toBe(15);
    expect(movements[1]!.type).toBe("STOCK_IN");
    expect(movements[1]!.change).toBe(20);
  });

  it("caps the list", async () => {
    await signInWithRole("ADMIN");
    const supplier = await createSupplier();
    const a = await part("A-1");

    for (let index = 0; index < 7; index += 1) {
      await receive(supplier.id, a.id, 1, "1.00");
    }

    const movements = unwrap(await loadRecentMovements());
    expect(movements).toHaveLength(5);
  });
});

describe("when the database cannot be reached", () => {
  it("returns a safe error rather than throwing", async () => {
    await signInWithRole("STAFF");

    const failing = vi
      .spyOn(prisma, "$queryRaw")
      .mockRejectedValueOnce(new Error("connection refused"));

    const result = await loadInventory();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // The message is one we wrote, never the driver's.
      expect(result.error.message).toBeTruthy();
      expect(result.error.message).not.toContain("connection refused");
    }

    failing.mockRestore();
  });
});
