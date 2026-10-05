import { beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { coverageNote, marginOf } from "@/lib/cost-coverage";
import { cancelOrder, confirmOrder, createOrder } from "@/server/orders";
import {
  cancelPurchase,
  createPurchase,
  receivePurchase,
} from "@/server/purchases";
import { createProduct as createCatalogueProduct } from "@/server/products";
import { adjustStock } from "@/server/products";
import { loadProductStats } from "@/server/products";

import { signOutSupabase } from "./supabase-auth-mock";
import { amountIn } from "./money";
import {
  createSupplier,
  expectConsumptionsReconcile,
  expectLotsReconcile,
  quoted,
  resetDatabase,
  seedProduct,
  signInWithRole,
} from "./database";

/**
 * FIFO costing, and the honesty of a partial answer.
 *
 * The premise this file exists to prove: a product does not have one cost. The
 * same aviation part is bought at ₹8,000, then ₹9,500, then ₹7,800, and the
 * question "what did the units we just sold cost us" has a real answer that no
 * single column on the catalogue row could ever hold.
 *
 * Two properties are load-bearing throughout, and most of these tests are about
 * one or the other:
 *
 *   **Quantity and cost are separate concerns.** Stock with no known
 *   acquisition cost is still stock. It can be sold, and the sale must confirm.
 *   What comes back is a partial cost, not a refusal and not a fabricated
 *   number.
 *
 *   **The lots are an index over the ledger, never a rival to it.**
 *   `SUM(quantityRemaining) = stockQuantity` holds after every operation, which
 *   is why nearly every test here ends by asserting it.
 */

beforeEach(async () => {
  signOutSupabase();
  await resetDatabase();
});

async function customer(name = "Contoso Aviation") {
  return prisma.customer.create({ data: { name } });
}

/** A part with no stock and no cost history — everything arrives by purchase. */
async function part(sku: string, sellingPrice = "12000.00") {
  return seedProduct({
    sku,
    name: `Part ${sku}`,
    stockQuantity: 0,
    sellingPrice,
  });
}

/** Receives `quantity` units at `unitCost`, the way real stock arrives. */
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

async function lotsOf(productId: string) {
  return prisma.stockLot.findMany({
    where: { productId },
    orderBy: [{ receivedAt: "asc" }, { id: "asc" }],
  });
}

async function lineOf(orderId: string) {
  return prisma.orderItem.findFirstOrThrow({ where: { orderId } });
}

async function stockOf(productId: string) {
  const row = await prisma.product.findUniqueOrThrow({
    where: { id: productId },
  });
  return row.stockQuantity;
}

// ---------------------------------------------------------------------------
// Receiving: cost attaches to the batch
// ---------------------------------------------------------------------------

describe("receiving a purchase records what it cost", () => {
  it("creates one lot per line at the price actually paid", async () => {
    await signInWithRole("STAFF");
    const supplier = await createSupplier();
    const a = await part("A-1");

    await receive(supplier.id, a.id, 10, "8000.00");

    const lots = await lotsOf(a.id);
    expect(lots).toHaveLength(1);
    expect(lots[0]!.unitCost?.toString()).toBe("8000");
    expect(lots[0]!.costSource).toBe("PURCHASE");
    expect(lots[0]!.quantityReceived).toBe(10);
    expect(lots[0]!.quantityRemaining).toBe(10);
    // The lot hangs off the movement that created it — never floating free.
    expect(lots[0]!.stockTransactionId).not.toBeNull();

    await expectLotsReconcile();
  });

  it("keeps three purchases of one part at three prices apart", async () => {
    await signInWithRole("STAFF");
    const supplier = await createSupplier();
    const a = await part("A-1");

    await receive(supplier.id, a.id, 10, "8000.00");
    await receive(supplier.id, a.id, 10, "9500.00");
    await receive(supplier.id, a.id, 10, "7800.00");

    const lots = await lotsOf(a.id);
    expect(lots.map((lot) => lot.unitCost?.toString())).toEqual([
      "8000",
      "9500",
      "7800",
    ]);
    expect(await stockOf(a.id)).toBe(30);
    await expectLotsReconcile();
  });

  it("does not merge two deliveries that happen to share a price", async () => {
    // Never merged, even when nothing about the cost distinguishes them: two
    // deliveries are two batches with two sets of paperwork, and collapsing
    // them would destroy the distinction certificates will need.
    await signInWithRole("STAFF");
    const supplier = await createSupplier();
    const a = await part("A-1");

    await receive(supplier.id, a.id, 5, "8000.00");
    await receive(supplier.id, a.id, 5, "8000.00");

    expect(await lotsOf(a.id)).toHaveLength(2);
  });

  it("writes nothing back to the catalogue row", async () => {
    /*
     * Receiving records a cost on the batch and nowhere else.
     *
     * There is no catalogue cost left to overwrite, and this guards against one
     * being reintroduced by the back door — a `lastPurchaseCost` or an
     * `averageCost` quietly maintained on the product would be the same column
     * again under a better name, drifting from the lots on the next delivery.
     * The reference price is the only money on this row, and receiving stock is
     * not an opinion about what it sells for.
     */
    await signInWithRole("STAFF");
    const supplier = await createSupplier();
    const a = await seedProduct({
      sku: "A-1",
      stockQuantity: 0,
      sellingPrice: "12000.00",
    });

    await receive(supplier.id, a.id, 10, "9500.00");

    const after = await prisma.product.findUniqueOrThrow({ where: { id: a.id } });

    // The quantity moved, because that is what receiving is for.
    expect(after.stockQuantity).toBe(10);
    // Nothing about money did.
    expect(after.sellingPrice?.toString()).toBe("12000");
    // And there is no cost column for a receipt to write to, by construction.
    expect(Object.keys(after)).not.toContain("standardCost");

    // The ₹9,500 went to the batch instead.
    const lots = await lotsOf(a.id);
    expect(lots[0]!.unitCost?.toString()).toBe("9500");
  });
});

// ---------------------------------------------------------------------------
// FIFO consumption
// ---------------------------------------------------------------------------

describe("confirming an order costs it FIFO", () => {
  it("draws 15 units across the ₹8,000 and ₹9,500 batches", async () => {
    /*
     * The worked example the architecture was designed around.
     *
     *   10 @ ₹8,000 + 10 @ ₹9,500 + 10 @ ₹7,800, then sell 15.
     *
     * FIFO takes the oldest first: all ten at ₹8,000 and five at ₹9,500, for
     * ₹127,500. The ₹7,800 batch is untouched — it arrived last.
     */
    await signInWithRole("STAFF");
    const supplier = await createSupplier();
    const buyer = await customer();
    const a = await part("A-1");

    await receive(supplier.id, a.id, 10, "8000.00");
    await receive(supplier.id, a.id, 10, "9500.00");
    await receive(supplier.id, a.id, 10, "7800.00");

    const order = await createOrder({
      customerId: buyer.id,
      items: await quoted([{ productId: a.id, quantity: 15 }]),
    });

    const outcome = await confirmOrder(order.id);
    expect(outcome.uncostedUnits).toBe(0);

    const line = await lineOf(order.id);
    expect(Number(line.costTotal)).toBe(127_500);
    expect(line.costedQuantity).toBe(15);

    const lots = await lotsOf(a.id);
    expect(lots.map((lot) => lot.quantityRemaining)).toEqual([0, 5, 10]);

    // Two lots touched, so two consumption rows, each at its own rate.
    const consumptions = await prisma.stockLotConsumption.findMany({
      where: { lotId: { in: lots.map((lot) => lot.id) } },
      orderBy: { createdAt: "asc" },
    });
    expect(consumptions).toHaveLength(2);
    expect(consumptions.map((c) => c.quantity)).toEqual([10, 5]);
    expect(consumptions.map((c) => c.unitCost?.toString())).toEqual([
      "8000",
      "9500",
    ]);

    await expectLotsReconcile();
    await expectConsumptionsReconcile();
  });

  it("reports the margin on the costed units, not revenue minus known cost", async () => {
    // The single most likely bug in this feature: revenue ₹180,000 less a known
    // cost of ₹127,500 is ₹52,500 here only because coverage is complete. The
    // partial case below is where the two answers diverge.
    await signInWithRole("STAFF");
    const supplier = await createSupplier();
    const buyer = await customer();
    const a = await part("A-1", "12000.00");

    await receive(supplier.id, a.id, 10, "8000.00");
    await receive(supplier.id, a.id, 10, "9500.00");

    const order = await createOrder({
      customerId: buyer.id,
      items: await quoted([{ productId: a.id, quantity: 15 }]),
    });
    await confirmOrder(order.id);

    const line = await lineOf(order.id);
    const margin = marginOf({
      quantity: line.quantity,
      fulfilledQuantity: line.fulfilledQuantity,
      unitPrice: Number(line.unitPrice),
      costTotal: Number(line.costTotal),
      costedQuantity: line.costedQuantity,
    });

    expect(margin.cost).toBe(127_500);
    expect(margin.revenue).toBe(180_000);
    expect(margin.margin).toBe(52_500);
    expect(margin.complete).toBe(true);
    expect(coverageNote(margin)).toBeNull();
  });

  it("spans as many batches as the line needs", async () => {
    await signInWithRole("STAFF");
    const supplier = await createSupplier();
    const buyer = await customer();
    const a = await part("A-1");

    await receive(supplier.id, a.id, 2, "100.00");
    await receive(supplier.id, a.id, 2, "200.00");
    await receive(supplier.id, a.id, 2, "300.00");

    const order = await createOrder({
      customerId: buyer.id,
      items: await quoted([{ productId: a.id, quantity: 5 }]),
    });
    await confirmOrder(order.id);

    // 2×100 + 2×200 + 1×300 = 900
    const line = await lineOf(order.id);
    expect(Number(line.costTotal)).toBe(900);
    expect(line.costedQuantity).toBe(5);
    expect((await lotsOf(a.id)).map((l) => l.quantityRemaining)).toEqual([
      0, 0, 1,
    ]);
    await expectLotsReconcile();
  });
});

// ---------------------------------------------------------------------------
// Uncosted stock
// ---------------------------------------------------------------------------

describe("stock with no known cost", () => {
  it("confirms an order that outruns the costed batches", async () => {
    /*
     * The case the whole partial-cost design exists for.
     *
     *   10 units @ ₹8,000, 10 units of unknown cost, order 15.
     *
     * FIFO consumes the uncosted stock first — it is genuinely older — so the
     * sale takes 10 uncosted and 5 costed. Quantity is available, so the order
     * confirms. What comes back is a cost covering 5 of 15 units, and it says
     * so rather than presenting itself as the whole.
     */
    await signInWithRole("STAFF");
    const supplier = await createSupplier();
    const buyer = await customer();

    // Pre-existing stock, no acquisition cost — as after the backfill.
    const a = await seedProduct({
      sku: "A-1",
      stockQuantity: 10,
      sellingPrice: "12000.00",
      lotUnitCost: null,
    });

    await receive(supplier.id, a.id, 10, "8000.00");

    const order = await createOrder({
      customerId: buyer.id,
      items: await quoted([{ productId: a.id, quantity: 15 }]),
    });

    // Confirms. Cost being partially unknown is not a reason to refuse a sale.
    const outcome = await confirmOrder(order.id);
    expect(outcome.status).toBe("CONFIRMED");
    expect(outcome.uncostedUnits).toBe(10);

    const line = await lineOf(order.id);
    expect(line.costedQuantity).toBe(5);
    expect(Number(line.costTotal)).toBe(40_000);
    expect(await stockOf(a.id)).toBe(5);

    await expectLotsReconcile();
    await expectConsumptionsReconcile();
  });

  it("describes a partial margin as partial", async () => {
    await signInWithRole("STAFF");
    const supplier = await createSupplier();
    const buyer = await customer();

    const a = await seedProduct({
      sku: "A-1",
      stockQuantity: 5,
      sellingPrice: "12000.00",
      lotUnitCost: null,
    });
    await receive(supplier.id, a.id, 10, "8000.00");

    const order = await createOrder({
      customerId: buyer.id,
      items: await quoted([{ productId: a.id, quantity: 15 }]),
    });
    await confirmOrder(order.id);

    const line = await lineOf(order.id);
    const margin = marginOf({
      quantity: line.quantity,
      fulfilledQuantity: line.fulfilledQuantity,
      unitPrice: Number(line.unitPrice),
      costTotal: Number(line.costTotal),
      costedQuantity: line.costedQuantity,
    });

    // 5 uncosted, 10 costed at ₹8,000.
    expect(margin.costedQuantity).toBe(10);
    expect(margin.uncostedQuantity).toBe(5);
    expect(margin.complete).toBe(false);

    /*
     * Revenue is apportioned to the ten costed units — ₹120,000 — not charged
     * whole against a partial cost. The tempting calculation, ₹180,000 less
     * ₹80,000, yields ₹100,000 and would only be true if the five uncosted
     * units had been free.
     */
    expect(margin.revenue).toBe(120_000);
    expect(margin.margin).toBe(40_000);
    expect(margin.margin).not.toBe(100_000);

    expect(coverageNote(margin)).toBe(
      "Margin calculated for 10 of 15 units; 5 units have unknown acquisition cost.",
    );
  });

  it("never fills an unknown cost in from the standard cost", async () => {
    // The substitution the entire redesign exists to prevent. A planning figure
    // is present and plausible; the sale still records no cost for the units it
    // could not price.
    await signInWithRole("STAFF");
    const buyer = await customer();

    // A reference price is set and the stock is uncosted. The price must not
    // stand in for a cost nobody knows.
    const a = await seedProduct({
      sku: "A-1",
      stockQuantity: 10,
      sellingPrice: "12000.00",
      lotUnitCost: null,
    });

    const order = await createOrder({
      customerId: buyer.id,
      items: await quoted([{ productId: a.id, quantity: 4 }]),
    });
    await confirmOrder(order.id);

    const line = await lineOf(order.id);
    expect(line.costTotal).toBeNull();
    expect(line.costedQuantity).toBe(0);

    const consumptions = await prisma.stockLotConsumption.findMany();
    expect(consumptions).toHaveLength(1);
    expect(consumptions[0]!.unitCost).toBeNull();
    expect(consumptions[0]!.totalCost).toBeNull();
  });

  it("excludes uncosted units from stock value and counts them instead", async () => {
    await signInWithRole("STAFF");
    await seedProduct({ sku: "V-1", stockQuantity: 10, lotUnitCost: "8000.00" });
    await seedProduct({
      sku: "V-2",
      stockQuantity: 5,
      // Priced for sale, but nobody knows what it cost. Valuation must count
      // these units as uncosted rather than reaching for the price.
      sellingPrice: "9999.00",
      lotUnitCost: null,
    });

    const stats = await loadProductStats();
    if (!stats.ok) throw new Error("expected stats");

    expect(amountIn(stats.data.stockValueByCurrency, "USD")).toBe(80_000);
    expect(stats.data.uncostedUnits).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Cancelling an order
// ---------------------------------------------------------------------------

describe("cancelling an order returns stock to its original batches", () => {
  it("puts units back in the lots they came from, at their original cost", async () => {
    await signInWithRole("STAFF");
    const supplier = await createSupplier();
    const buyer = await customer();
    const a = await part("A-1");

    await receive(supplier.id, a.id, 10, "8000.00");
    await receive(supplier.id, a.id, 10, "9500.00");

    const order = await createOrder({
      customerId: buyer.id,
      items: await quoted([{ productId: a.id, quantity: 15 }]),
    });
    await confirmOrder(order.id);
    expect((await lotsOf(a.id)).map((l) => l.quantityRemaining)).toEqual([0, 5]);

    await cancelOrder(order.id, "Customer withdrew");

    // Exactly where they started — not pooled into the newest batch.
    expect((await lotsOf(a.id)).map((l) => l.quantityRemaining)).toEqual([
      10, 10,
    ]);
    expect(await stockOf(a.id)).toBe(20);

    // And the sale carries no cost of sale, because it did not happen.
    const line = await lineOf(order.id);
    expect(line.costTotal).toBeNull();
    expect(line.costedQuantity).toBe(0);

    await expectLotsReconcile();
    await expectConsumptionsReconcile();
  });

  it("does not revalue returned stock at a later purchase price", async () => {
    await signInWithRole("STAFF");
    const supplier = await createSupplier();
    const buyer = await customer();
    const a = await part("A-1");

    await receive(supplier.id, a.id, 10, "8000.00");

    const order = await createOrder({
      customerId: buyer.id,
      items: await quoted([{ productId: a.id, quantity: 10 }]),
    });
    await confirmOrder(order.id);

    // Prices move while the units are out.
    await receive(supplier.id, a.id, 10, "9500.00");
    await cancelOrder(order.id);

    const lots = await lotsOf(a.id);
    const restored = lots.find((lot) => lot.unitCost?.toString() === "8000");
    expect(restored?.quantityRemaining).toBe(10);
    // The ₹9,500 batch is untouched by somebody else's cancellation.
    const newer = lots.find((lot) => lot.unitCost?.toString() === "9500");
    expect(newer?.quantityRemaining).toBe(10);

    await expectLotsReconcile();
  });

  it("cancelling twice restores nothing the second time", async () => {
    await signInWithRole("STAFF");
    const supplier = await createSupplier();
    const buyer = await customer();
    const a = await part("A-1");

    await receive(supplier.id, a.id, 10, "8000.00");
    const order = await createOrder({
      customerId: buyer.id,
      items: await quoted([{ productId: a.id, quantity: 6 }]),
    });
    await confirmOrder(order.id);
    await cancelOrder(order.id);

    const outcome = await cancelOrder(order.id);
    expect(outcome.alreadyInState).toBe(true);

    expect((await lotsOf(a.id))[0]!.quantityRemaining).toBe(10);
    await expectLotsReconcile();
    await expectConsumptionsReconcile();
  });
});

// ---------------------------------------------------------------------------
// Stock that predates cost tracking
// ---------------------------------------------------------------------------

describe("cancelling an order confirmed before cost tracking existed", () => {
  /**
   * The regression this block exists to prevent happening twice.
   *
   * The backfill deliberately did not cost historical orders — FIFO was not the
   * policy when they happened, so a COGS for them would have been assumed
   * rather than proven. But those orders can still be cancelled, and when one
   * is, `returnToLots` finds no consumption rows to return the units to.
   *
   * It used to return zero and say nothing. The stock went back on the shelf,
   * `stockQuantity` rose, the ledger recorded a REVERSAL, and no lot changed —
   * so SUM(quantityRemaining) stopped equalling stockQuantity, silently, on a
   * live database.
   *
   * The units are real and their cost is genuinely unknown, so they come back
   * as an UNKNOWN lot.
   */

  /**
   * An order in the shape migrated data has: confirmed, stock deducted through
   * the real engine, but with the lot bookkeeping stripped out afterwards so it
   * looks like it was confirmed before costing existed.
   */
  async function preCostingConfirmedOrder(productId: string, quantity: number) {
    const buyer = await customer();
    const order = await createOrder({
      customerId: buyer.id,
      items: await quoted([{ productId, quantity }]),
    });
    await confirmOrder(order.id);

    const outbound = await prisma.stockTransaction.findMany({
      where: {
        referenceType: "ORDER",
        referenceId: order.id,
        type: "STOCK_OUT",
      },
      select: { id: true },
    });

    const ids = outbound.map((row) => row.id);

    /*
     * Drop the consumption rows, then close the lots up behind them.
     *
     * A backfilled lot was created with `quantityReceived` equal to whatever
     * was still on the shelf — the backfill attributed the *remaining* balance,
     * so it has no record of units that had already been sold. Deleting the
     * consumption rows without also closing `quantityReceived` down to match
     * would leave a lot claiming it received more than anything can account
     * for, which is a state migrated data is never in and which the
     * consumption reconciliation would rightly reject.
     */
    await prisma.stockLotConsumption.deleteMany({
      where: { stockTransactionId: { in: ids } },
    });

    const drawn = await prisma.stockLot.findMany({
      where: { productId },
      select: { id: true, quantityRemaining: true },
    });

    for (const lot of drawn) {
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

  it("returns the stock as an uncosted lot rather than losing it", async () => {
    await signInWithRole("STAFF");
    const supplier = await createSupplier();
    const a = await part("A-1");

    await receive(supplier.id, a.id, 10, "8000.00");
    const order = await preCostingConfirmedOrder(a.id, 6);

    // The state migrated data is in: stock down, lots down, no consumptions.
    expect(await stockOf(a.id)).toBe(4);
    expect(await prisma.stockLotConsumption.count()).toBe(0);
    await expectLotsReconcile();

    await cancelOrder(order.id, "Customer withdrew");

    // Stock is back...
    expect(await stockOf(a.id)).toBe(10);

    // ...and so are the lots. This is the assertion that used to fail.
    await expectLotsReconcile();
    await expectConsumptionsReconcile();

    // The six returned units are uncosted, because nothing knows what they
    // cost — and emphatically not valued at the 8,000 of the batch they happen
    // to sit beside.
    const lots = await lotsOf(a.id);
    const uncosted = lots.filter((lot) => lot.unitCost === null);
    expect(uncosted).toHaveLength(1);
    expect(uncosted[0]!.quantityRemaining).toBe(6);
    expect(uncosted[0]!.costSource).toBe("UNKNOWN");
  });

  it("does not invent a cost for the returned units", async () => {
    await signInWithRole("STAFF");
    const supplier = await createSupplier();
    const a = await seedProduct({
      sku: "A-1",
      stockQuantity: 0,
      sellingPrice: "12000.00",
    });

    await receive(supplier.id, a.id, 10, "8000.00");
    const order = await preCostingConfirmedOrder(a.id, 4);
    await cancelOrder(order.id);

    const lots = await lotsOf(a.id);
    const returned = lots.find((lot) => lot.costSource === "UNKNOWN");

    // Not the standard cost, not the lot rate beside it, not zero. Null.
    expect(returned?.unitCost).toBeNull();
    await expectLotsReconcile();
  });

  it("dates the returned units to when they left, not to now", async () => {
    /*
     * The returned units are dated to the moment they originally left, which
     * puts them ahead of anything received since — but still behind whatever
     * was already on the shelf when they went. FIFO then does the obvious
     * thing, and the ordering here is the proof:
     *
     *   lot A   10 @ 8,000, received first        → 4 left after the sale
     *   lot B    6 uncosted, returned by the cancel
     *   lot C   10 @ 9,500, received afterwards
     *
     * A sale of 6 takes A's remaining 4 first, then 2 from the returned batch,
     * and never touches C. Dating the returned units to *now* would have put
     * them behind C and left the newest stock selling before the oldest.
     */
    await signInWithRole("STAFF");
    const supplier = await createSupplier();
    const buyer = await customer();
    const a = await part("A-1");

    await receive(supplier.id, a.id, 10, "8000.00");
    const order = await preCostingConfirmedOrder(a.id, 6);
    await cancelOrder(order.id);

    await receive(supplier.id, a.id, 10, "9500.00");

    const sale = await createOrder({
      customerId: buyer.id,
      items: await quoted([{ productId: a.id, quantity: 6 }]),
    });
    const outcome = await confirmOrder(sale.id);

    // 4 costed at 8,000, then 2 from the uncosted batch.
    expect(outcome.uncostedUnits).toBe(2);
    const line = await lineOf(sale.id);
    expect(line.costedQuantity).toBe(4);
    expect(Number(line.costTotal)).toBe(32_000);

    // The 9,500 delivery is untouched — it is the newest thing on the shelf.
    const lots = await lotsOf(a.id);
    const newest = lots.find((lot) => lot.unitCost?.toString() === "9500");
    expect(newest?.quantityRemaining).toBe(10);

    await expectLotsReconcile();
    await expectConsumptionsReconcile();
  });

  it("leaves a normally-costed cancellation alone", async () => {
    // The fix must not create a spurious uncosted lot on the ordinary path.
    await signInWithRole("STAFF");
    const supplier = await createSupplier();
    const buyer = await customer();
    const a = await part("A-1");

    await receive(supplier.id, a.id, 10, "8000.00");
    const order = await createOrder({
      customerId: buyer.id,
      items: await quoted([{ productId: a.id, quantity: 6 }]),
    });
    await confirmOrder(order.id);
    await cancelOrder(order.id);

    const lots = await lotsOf(a.id);
    expect(lots).toHaveLength(1);
    expect(lots[0]!.unitCost?.toString()).toBe("8000");
    expect(lots[0]!.quantityRemaining).toBe(10);
    await expectLotsReconcile();
  });
});

// ---------------------------------------------------------------------------
// Cancelling a purchase
// ---------------------------------------------------------------------------

describe("cancelling a received purchase", () => {
  it("reverses a delivery nothing has been taken from", async () => {
    await signInWithRole("STAFF");
    const supplier = await createSupplier();
    const a = await part("A-1");

    const purchase = await receive(supplier.id, a.id, 10, "8000.00");
    await cancelPurchase(purchase.id, "Wrong part shipped");

    expect(await stockOf(a.id)).toBe(0);

    // The lot is emptied, not deleted — the delivery still happened.
    const lots = await lotsOf(a.id);
    expect(lots).toHaveLength(1);
    expect(lots[0]!.quantityRemaining).toBe(0);
    expect(lots[0]!.quantityReceived).toBe(10);

    await expectLotsReconcile();
    await expectConsumptionsReconcile();
  });

  it("refuses once any of its units have been sold", async () => {
    await signInWithRole("STAFF");
    const supplier = await createSupplier();
    const buyer = await customer();
    const a = await part("A-1");

    const purchase = await receive(supplier.id, a.id, 10, "8000.00");

    const order = await createOrder({
      customerId: buyer.id,
      items: await quoted([{ productId: a.id, quantity: 3 }]),
    });
    await confirmOrder(order.id);

    await expect(cancelPurchase(purchase.id)).rejects.toMatchObject({
      code: "CONFLICT",
    });

    // Nothing moved: not the stock, not the lot, not the purchase status.
    expect(await stockOf(a.id)).toBe(7);
    expect((await lotsOf(a.id))[0]!.quantityRemaining).toBe(7);
    const after = await prisma.purchase.findUniqueOrThrow({
      where: { id: purchase.id },
    });
    expect(after.status).toBe("RECEIVED");
    await expectLotsReconcile();
  });

  it("refuses even when a later delivery has topped the balance back up", async () => {
    /*
     * The case a quantity check alone would wave through, and the reason the
     * guard is written against lots rather than against stock on hand.
     *
     * Ten units arrive at ₹8,000 and are sold. Ten more arrive at ₹9,500, so
     * the shelf holds ten again — enough, arithmetically, to reverse the first
     * delivery. Doing so would consume the ₹9,500 batch to undo an ₹8,000 one
     * and silently corrupt the cost of stock that had nothing to do with it.
     */
    await signInWithRole("STAFF");
    const supplier = await createSupplier();
    const buyer = await customer();
    const a = await part("A-1");

    const first = await receive(supplier.id, a.id, 10, "8000.00");

    const order = await createOrder({
      customerId: buyer.id,
      items: await quoted([{ productId: a.id, quantity: 10 }]),
    });
    await confirmOrder(order.id);

    await receive(supplier.id, a.id, 10, "9500.00");
    expect(await stockOf(a.id)).toBe(10);

    await expect(cancelPurchase(first.id)).rejects.toMatchObject({
      code: "CONFLICT",
    });

    // The later batch is intact and still costed at what it cost.
    const lots = await lotsOf(a.id);
    const newer = lots.find((lot) => lot.unitCost?.toString() === "9500");
    expect(newer?.quantityRemaining).toBe(10);
    await expectLotsReconcile();
  });

  it("names what was consumed so the refusal can be acted on", async () => {
    await signInWithRole("STAFF");
    const supplier = await createSupplier();
    const buyer = await customer();
    const a = await part("A-1");

    const purchase = await receive(supplier.id, a.id, 10, "8000.00");
    const order = await createOrder({
      customerId: buyer.id,
      items: await quoted([{ productId: a.id, quantity: 4 }]),
    });
    await confirmOrder(order.id);

    await expect(cancelPurchase(purchase.id)).rejects.toThrow(/4 of 10/);
  });
});

// ---------------------------------------------------------------------------
// Manual movements and opening stock
// ---------------------------------------------------------------------------

describe("manual stock movements", () => {
  it("creates an uncosted lot when stock is adjusted in", async () => {
    await signInWithRole("ADMIN");
    const a = await part("A-1");

    await adjustStock({
      productId: a.id,
      quantity: "12",
      direction: "INCREASE",
      costBasis: "UNKNOWN",
      unknownCostReason: "No paperwork came with them",
      reason: "Found in the stockroom",
    });

    const lots = await lotsOf(a.id);
    expect(lots).toHaveLength(1);
    expect(lots[0]!.unitCost).toBeNull();
    expect(lots[0]!.costSource).toBe("UNKNOWN");
    await expectLotsReconcile();
  });

  it("consumes FIFO when stock is adjusted out", async () => {
    await signInWithRole("ADMIN");
    const supplier = await createSupplier();
    const a = await part("A-1");

    await receive(supplier.id, a.id, 5, "100.00");
    await receive(supplier.id, a.id, 5, "200.00");

    await adjustStock({
      productId: a.id,
      quantity: "7",
      direction: "DECREASE",
      reason: "Damaged in the stockroom",
    });

    expect((await lotsOf(a.id)).map((l) => l.quantityRemaining)).toEqual([0, 3]);
    await expectLotsReconcile();
    await expectConsumptionsReconcile();
  });
});

describe("opening stock", () => {
  it("records the cost when the operator knows it", async () => {
    await signInWithRole("ADMIN");

    const created = await createCatalogueProduct({
      name: "Bracket",
      sku: "OP-1",
      category: "Airframe",
      sellingPrice: "12000.00",
      stockQuantity: "50",
      openingStockCostBasis: "KNOWN",
      openingStockUnitCost: "7500.00",
      status: "ACTIVE",
    });

    const lots = await lotsOf(created.id);
    expect(lots).toHaveLength(1);
    // What was paid, not the ₹12,000 it is priced at.
    expect(lots[0]!.unitCost?.toString()).toBe("7500");
    expect(lots[0]!.costSource).toBe("OPENING");
    expect(lots[0]!.quantityRemaining).toBe(50);
    await expectLotsReconcile();
  });

  it("records it as unknown only when the operator says so, with a reason", async () => {
    await signInWithRole("ADMIN");

    const created = await createCatalogueProduct({
      name: "Bracket",
      sku: "OP-2",
      category: "Airframe",
      sellingPrice: "12000.00",
      stockQuantity: "50",
      openingStockCostBasis: "UNKNOWN",
      openingStockUnknownReason: "Predates this system; no purchase paperwork.",
      status: "ACTIVE",
    });

    const lots = await lotsOf(created.id);
    expect(lots[0]!.unitCost).toBeNull();
    expect(lots[0]!.costSource).toBe("UNKNOWN");

    // The reason travels into the ledger, which is the only place it can
    // outlive the form and explain the uncosted sales this batch will produce.
    const movement = await prisma.stockTransaction.findFirstOrThrow({
      where: { productId: created.id, type: "STOCK_IN" },
    });
    expect(movement.note).toContain("Predates this system");

    await expectLotsReconcile();
  });
});

// ---------------------------------------------------------------------------
// Historical COGS is frozen
// ---------------------------------------------------------------------------

describe("historical cost of sale", () => {
  it("does not move when later purchases arrive at a different price", async () => {
    await signInWithRole("STAFF");
    const supplier = await createSupplier();
    const buyer = await customer();
    const a = await part("A-1");

    await receive(supplier.id, a.id, 10, "8000.00");

    const order = await createOrder({
      customerId: buyer.id,
      items: await quoted([{ productId: a.id, quantity: 10 }]),
    });
    await confirmOrder(order.id);

    const before = await lineOf(order.id);
    expect(Number(before.costTotal)).toBe(80_000);

    // The world moves on: two more deliveries at quite different prices.
    await receive(supplier.id, a.id, 10, "9500.00");
    await receive(supplier.id, a.id, 10, "7800.00");

    const after = await lineOf(order.id);
    expect(after.costTotal?.toString()).toBe(before.costTotal?.toString());
    expect(after.costedQuantity).toBe(10);
  });

  it("does not move when the catalogue's reference price is edited", async () => {
    await signInWithRole("ADMIN");
    const supplier = await createSupplier();
    const buyer = await customer();
    const a = await part("A-1");

    await receive(supplier.id, a.id, 10, "8000.00");
    const order = await createOrder({
      customerId: buyer.id,
      items: await quoted([{ productId: a.id, quantity: 10 }]),
    });
    await confirmOrder(order.id);

    await prisma.product.update({
      where: { id: a.id },
      data: { sellingPrice: "1.00" },
    });

    // COGS is a fact about the units consumed, frozen on the consumption rows.
    // Nothing on the catalogue row can restate it.
    const line = await lineOf(order.id);
    expect(Number(line.costTotal)).toBe(80_000);
  });
});

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

describe("concurrent confirmations", () => {
  it("cannot draw the same lot units twice", async () => {
    /*
     * Two orders for six units against a single batch of ten, sent together.
     * Both succeed now — one takes its six, the other takes the four that are
     * left and owes two — because a shortfall no longer refuses a sale. What
     * must never happen is unchanged and is what this proves: the lot must not
     * hand out twelve units it never had, and the product row lock is what
     * prevents that, since lots are only ever reached through it.
     */
    await signInWithRole("STAFF");
    const supplier = await createSupplier();
    const buyer = await customer();
    const a = await part("A-1");

    await receive(supplier.id, a.id, 10, "8000.00");

    const first = await createOrder({
      customerId: buyer.id,
      items: await quoted([{ productId: a.id, quantity: 6 }]),
    });
    const second = await createOrder({
      customerId: buyer.id,
      items: await quoted([{ productId: a.id, quantity: 6 }]),
    });

    const results = await Promise.allSettled([
      confirmOrder(first.id),
      confirmOrder(second.id),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);

    // Ten units existed and ten were drawn — never eleven, never twelve.
    expect(await stockOf(a.id)).toBe(0);

    const lots = await lotsOf(a.id);
    expect(lots[0]!.quantityRemaining).toBe(0);

    const drawn = await prisma.stockLotConsumption.aggregate({
      where: { lotId: lots[0]!.id },
      _sum: { quantity: true },
    });
    expect(drawn._sum.quantity).toBe(10);

    // Twelve sold, ten shipped: two are owed.
    const lines = await prisma.orderItem.findMany({
      where: { orderId: { in: [first.id, second.id] } },
    });
    const outstanding = lines.reduce(
      (sum, line) => sum + (line.quantity - line.fulfilledQuantity),
      0,
    );
    expect(outstanding).toBe(2);

    await expectLotsReconcile();
    await expectConsumptionsReconcile();
  });
});

// ---------------------------------------------------------------------------
// The invariant, stated directly
// ---------------------------------------------------------------------------

describe("the valuation layer stays an index over the ledger", () => {
  it("reconciles after a full lifecycle of receipts, sales and reversals", async () => {
    await signInWithRole("ADMIN");
    const supplier = await createSupplier();
    const buyer = await customer();
    const a = await part("A-1");
    const b = await part("B-1");

    await receive(supplier.id, a.id, 10, "8000.00");
    await receive(supplier.id, a.id, 10, "9500.00");
    await receive(supplier.id, b.id, 20, "300.00");

    const sold = await createOrder({
      customerId: buyer.id,
      items: await quoted([
        { productId: a.id, quantity: 12 },
        { productId: b.id, quantity: 5 },
      ]),
    });
    await confirmOrder(sold.id);
    await expectLotsReconcile();

    const cancelled = await createOrder({
      customerId: buyer.id,
      items: await quoted([{ productId: a.id, quantity: 3 }]),
    });
    await confirmOrder(cancelled.id);
    await cancelOrder(cancelled.id, "Changed their mind");
    await expectLotsReconcile();

    await adjustStock({
      productId: b.id,
      quantity: "4",
      direction: "DECREASE",
      reason: "Damaged",
    });
    await adjustStock({
      productId: b.id,
      quantity: "2",
      direction: "INCREASE",
      costBasis: "UNKNOWN",
      unknownCostReason: "Miscount — original batch cannot be identified",
      reason: "Recount",
    });

    await expectLotsReconcile();
    await expectConsumptionsReconcile();

    // And every lot with no originating movement is one a fixture wrote, never
    // one the application invented.
    const orphans = await prisma.stockLot.findMany({
      where: { stockTransactionId: null },
    });
    expect(orphans).toHaveLength(0);
  });
});
