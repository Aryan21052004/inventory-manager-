import { beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import {
  cancelOrder,
  completeOrder,
  confirmOrder,
  createOrder,
  fulfilOrder,
} from "@/server/orders";
import { recordSalesReturn } from "@/server/returns";

import { signOutSupabase } from "./supabase-auth-mock";
import {
  expectConsumptionsReconcile,
  expectFulfilmentMatchesLedger,
  expectFulfilmentReconciles,
  expectLotsReconcile,
  quoted,
  resetDatabase,
  seedProduct,
  signInWithRole,
} from "./database";

/**
 * Sales returns: goods that shipped and came back.
 *
 * The property the whole file exists to protect is that **a returned unit
 * carries the cost it left at**. Not today's price, not the average of the
 * batches it came from, not a catalogue figure — the frozen rate on the
 * `StockLotConsumption` row the original shipment wrote. A shipment drawn from
 * two batches at two prices comes back as two batches at those same two
 * prices, and several tests assert the individual lots rather than the total,
 * because a blended cost produces the correct total and the wrong inventory.
 *
 * The second property is that a return does not corrupt the record of the sale.
 * `fulfilledQuantity` still says what shipped, the ORDER-referenced ledger
 * still agrees with it, and the returned units arrive under their own
 * reference — which is what keeps a later cancellation from netting them.
 */

beforeEach(async () => {
  signOutSupabase();
  await resetDatabase();
});

async function customer(name = "Contoso Aviation") {
  return prisma.customer.create({ data: { name } });
}

/** Adds a batch and moves the product's balance to match. */
async function addLot(
  productId: string,
  quantity: number,
  unitCost: string | null,
  receivedAt: Date,
) {
  const lot = await prisma.stockLot.create({
    data: {
      productId,
      unitCost,
      costCurrency: unitCost === null ? null : "USD",
      costSource: unitCost === null ? "UNKNOWN" : "PURCHASE",
      quantityReceived: quantity,
      quantityRemaining: quantity,
      sourceType: "MANUAL",
      sourceId: null,
      receivedAt,
    },
    select: { id: true },
  });

  await prisma.product.update({
    where: { id: productId },
    data: { stockQuantity: { increment: quantity } },
  });

  return lot.id;
}

const BASE = new Date("2026-03-01T00:00:00.000Z");

/**
 * A part holding two batches at two prices: 2 @ ₹8,000 then 3 @ ₹10,000.
 *
 * The scenario the costing decision was made against, so it is the fixture
 * most of this file is written on.
 */
async function twoLayerPart(sku: string) {
  const product = await seedProduct({ sku, stockQuantity: 0, sellingPrice: "20000.00" });

  const lotA = await addLot(product.id, 2, "8000.00", BASE);
  const lotB = await addLot(product.id, 3, "10000.00", new Date(BASE.getTime() + 1000));

  return { product, lotA, lotB };
}

async function orderFor(productId: string, quantity: number) {
  const buyer = await customer();

  return createOrder({
    customerId: buyer.id,
    items: await quoted([{ productId, quantity }]),
  });
}

async function lineOf(orderId: string) {
  return prisma.orderItem.findFirstOrThrow({ where: { orderId } });
}

/** Return lots for a line, in creation order. */
async function returnLotsFor(orderItemId: string) {
  return prisma.stockLot.findMany({
    where: { orderItemId },
    orderBy: { createdAt: "asc" },
    include: { stockTransaction: true },
  });
}

async function expectInvariants() {
  await expectLotsReconcile();
  await expectConsumptionsReconcile();
  await expectFulfilmentReconciles();
  await expectFulfilmentMatchesLedger();

  const negative = await prisma.product.count({
    where: { stockQuantity: { lt: 0 } },
  });
  expect(negative).toBe(0);

  const overReturned = await prisma.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM order_items
    WHERE returned_quantity > fulfilled_quantity OR returned_quantity < 0
  `;
  expect(overReturned[0]!.n).toBe(0);
}

// ---------------------------------------------------------------------------

describe("recording a return", () => {
  it("brings back a full shipment as its original cost layers", async () => {
    await signInWithRole("ADMIN");
    const { product, lotA, lotB } = await twoLayerPart("RET-FULL");

    const order = await orderFor(product.id, 5);
    await confirmOrder(order.id);
    const line = await lineOf(order.id);

    const outcome = await recordSalesReturn({
      orderId: order.id,
      reason: "Customer cancelled the installation",
      lines: [{ orderItemId: line.id, quantity: "5" }],
    });

    expect(outcome.returnNumber).toMatch(/^RT-\d{4}-\d{4}$/);

    const lots = await returnLotsFor(line.id);
    expect(lots).toHaveLength(2);

    // Exact quantities and costs, not just the total — a blended lot would
    // produce the right total and the wrong inventory.
    expect(lots.map((lot) => [Number(lot.unitCost), lot.quantityReceived])).toEqual([
      [8000, 2],
      [10000, 3],
    ]);
    expect(lots.map((lot) => lot.originLotId)).toEqual([lotA, lotB]);

    await expectInvariants();
  });

  it("splits a partial return across layers in original consumption order", async () => {
    await signInWithRole("ADMIN");
    const { product, lotA, lotB } = await twoLayerPart("RET-PART");

    const order = await orderFor(product.id, 5);
    await confirmOrder(order.id);
    const line = await lineOf(order.id);

    await recordSalesReturn({
      orderId: order.id,
      reason: "Two units surplus to requirements",
      lines: [{ orderItemId: line.id, quantity: "4" }],
    });

    const lots = await returnLotsFor(line.id);

    // 2 from the ₹8,000 batch, then 2 from the ₹10,000 one. Never 4 @ ₹9,000.
    expect(lots.map((lot) => [Number(lot.unitCost), lot.quantityReceived])).toEqual([
      [8000, 2],
      [10000, 2],
    ]);
    expect(lots.map((lot) => lot.originLotId)).toEqual([lotA, lotB]);

    const totals = lots.reduce(
      (sum, lot) => sum + Number(lot.unitCost) * lot.quantityReceived,
      0,
    );
    expect(totals).toBe(36000);

    await expectInvariants();
  });

  it("stamps every return lot with its provenance and quarantine", async () => {
    await signInWithRole("ADMIN");
    const { product } = await twoLayerPart("RET-STAMP");

    const order = await orderFor(product.id, 5);
    await confirmOrder(order.id);
    const line = await lineOf(order.id);

    const outcome = await recordSalesReturn({
      orderId: order.id,
      reason: "Wrong part number supplied",
      lines: [{ orderItemId: line.id, quantity: "3" }],
    });

    for (const lot of await returnLotsFor(line.id)) {
      expect(lot.status).toBe("QUARANTINED");
      expect(lot.costSource).toBe("RETURN");
      expect(lot.orderItemId).toBe(line.id);
      expect(lot.originLotId).not.toBeNull();
      expect(lot.sourceType).toBe("SALES_RETURN");
      expect(lot.sourceId).toBe(outcome.id);

      // The movement that brought them in, and its reference.
      expect(lot.stockTransaction!.type).toBe("STOCK_IN");
      expect(lot.stockTransaction!.referenceType).toBe("SALES_RETURN");
      expect(lot.stockTransaction!.referenceId).toBe(outcome.id);
    }

    // Never REVERSAL, and never referencing the order — that is what keeps a
    // cancellation's netting from seeing a return.
    const byOrder = await prisma.stockTransaction.count({
      where: { referenceType: "ORDER", referenceId: order.id, type: "REVERSAL" },
    });
    expect(byOrder).toBe(0);

    await expectInvariants();
  });

  it("keeps an uncosted shipment uncosted on the way back", async () => {
    await signInWithRole("ADMIN");
    const product = await seedProduct({
      sku: "RET-UNK",
      stockQuantity: 0,
      sellingPrice: "500.00",
    });
    await addLot(product.id, 6, null, BASE);

    const order = await orderFor(product.id, 6);
    await confirmOrder(order.id);
    const line = await lineOf(order.id);

    await recordSalesReturn({
      orderId: order.id,
      reason: "Stock predating the paperwork, sent back",
      lines: [{ orderItemId: line.id, quantity: "4" }],
    });

    const lots = await returnLotsFor(line.id);
    expect(lots).toHaveLength(1);
    expect(lots[0]!.unitCost).toBeNull();
    expect(lots[0]!.costSource).toBe("UNKNOWN");
    expect(lots[0]!.status).toBe("QUARANTINED");

    await expectInvariants();
  });

  it("combines layers across several fulfilment events", async () => {
    await signInWithRole("ADMIN");
    const product = await seedProduct({
      sku: "RET-MULTI",
      stockQuantity: 0,
      sellingPrice: "20000.00",
    });

    const order = await orderFor(product.id, 10);
    await confirmOrder(order.id); // nothing on hand — all outstanding
    const line = await lineOf(order.id);

    // Three deliveries at three prices, shipped as they arrive.
    const lot1 = await addLot(product.id, 3, "100.00", BASE);
    await fulfilOrder(order.id, { lines: [{ orderItemId: line.id, quantity: 3 }] });

    const lot2 = await addLot(product.id, 4, "200.00", new Date(BASE.getTime() + 1000));
    await fulfilOrder(order.id, { lines: [{ orderItemId: line.id, quantity: 4 }] });

    const lot3 = await addLot(product.id, 3, "300.00", new Date(BASE.getTime() + 2000));
    await fulfilOrder(order.id, { lines: [{ orderItemId: line.id, quantity: 3 }] });

    const shipped = await lineOf(order.id);
    expect(shipped.fulfilledQuantity).toBe(10);

    // Return 5: the first three units came from lot1, the next two from lot2.
    await recordSalesReturn({
      orderId: order.id,
      reason: "Five units returned after a design change",
      lines: [{ orderItemId: line.id, quantity: "5" }],
    });

    const lots = await returnLotsFor(line.id);
    expect(lots.map((lot) => [lot.originLotId, Number(lot.unitCost), lot.quantityReceived])).toEqual([
      [lot1, 100, 3],
      [lot2, 200, 2],
    ]);
    expect(lots.every((lot) => lot.originLotId !== lot3)).toBe(true);

    await expectInvariants();
  });

  it("resumes from where an earlier return stopped", async () => {
    await signInWithRole("ADMIN");
    const { product, lotA, lotB } = await twoLayerPart("RET-RESUME");

    const order = await orderFor(product.id, 5);
    await confirmOrder(order.id);
    const line = await lineOf(order.id);

    await recordSalesReturn({
      orderId: order.id,
      reason: "First two units back",
      lines: [{ orderItemId: line.id, quantity: "2" }],
    });

    await recordSalesReturn({
      orderId: order.id,
      reason: "Two more units back",
      lines: [{ orderItemId: line.id, quantity: "2" }],
    });

    const lots = await returnLotsFor(line.id);

    /*
     * The first return exhausted the ₹8,000 layer; the second must continue
     * into the ₹10,000 one rather than drawing the cheap layer twice.
     */
    expect(lots.map((lot) => [lot.originLotId, Number(lot.unitCost), lot.quantityReceived])).toEqual([
      [lotA, 8000, 2],
      [lotB, 10000, 2],
    ]);

    const after = await lineOf(order.id);
    expect(after.returnedQuantity).toBe(4);

    await expectInvariants();
  });
});

describe("quantities and the record of the sale", () => {
  it("increments returnedQuantity and leaves the shipment untouched", async () => {
    await signInWithRole("ADMIN");
    const { product } = await twoLayerPart("RET-QTY");

    const order = await orderFor(product.id, 5);
    await confirmOrder(order.id);
    const before = await lineOf(order.id);

    await recordSalesReturn({
      orderId: order.id,
      reason: "Three units returned",
      lines: [{ orderItemId: before.id, quantity: "3" }],
    });

    const after = await lineOf(order.id);

    expect(after.returnedQuantity).toBe(3);
    // The sale is unchanged: what shipped, what it cost, what was ordered.
    expect(after.fulfilledQuantity).toBe(before.fulfilledQuantity);
    expect(after.quantity).toBe(before.quantity);
    expect(after.costedQuantity).toBe(before.costedQuantity);
    expect(after.costTotal?.toString()).toBe(before.costTotal?.toString());
    expect(after.unitPrice.toString()).toBe(before.unitPrice.toString());
    expect(after.total.toString()).toBe(before.total.toString());

    // Outstanding is untouched too — it is about units never shipped.
    expect(after.quantity - after.fulfilledQuantity).toBe(0);
    // Units still with the customer.
    expect(after.fulfilledQuantity - after.returnedQuantity).toBe(2);

    await expectInvariants();
  });

  it("puts the returned units back into physical stock, quarantined", async () => {
    await signInWithRole("ADMIN");
    const { product } = await twoLayerPart("RET-STOCK");

    const order = await orderFor(product.id, 5);
    await confirmOrder(order.id);
    const line = await lineOf(order.id);

    const sold = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(sold.stockQuantity).toBe(0);

    await recordSalesReturn({
      orderId: order.id,
      reason: "All five back",
      lines: [{ orderItemId: line.id, quantity: "5" }],
    });

    const back = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    // Physical stock counts them; they are simply not saleable yet.
    expect(back.stockQuantity).toBe(5);

    const saleable = await prisma.stockLot.aggregate({
      where: { productId: product.id, status: "SALEABLE" },
      _sum: { quantityRemaining: true },
    });
    expect(saleable._sum.quantityRemaining ?? 0).toBe(0);

    await expectInvariants();
  });

  it("refuses more than was shipped", async () => {
    await signInWithRole("ADMIN");
    const { product } = await twoLayerPart("RET-OVER");

    const order = await orderFor(product.id, 5);
    await confirmOrder(order.id);
    const line = await lineOf(order.id);

    await expect(
      recordSalesReturn({
        orderId: order.id,
        reason: "Trying to return more than shipped",
        lines: [{ orderItemId: line.id, quantity: "6" }],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    const after = await lineOf(order.id);
    expect(after.returnedQuantity).toBe(0);
    expect(await prisma.return.count()).toBe(0);
    expect(await prisma.stockLot.count({ where: { orderItemId: line.id } })).toBe(0);

    await expectInvariants();
  });

  it("caps a second return at what is still returnable", async () => {
    await signInWithRole("ADMIN");
    const { product } = await twoLayerPart("RET-SECOND");

    const order = await orderFor(product.id, 5);
    await confirmOrder(order.id);
    const line = await lineOf(order.id);

    await recordSalesReturn({
      orderId: order.id,
      reason: "Four back",
      lines: [{ orderItemId: line.id, quantity: "4" }],
    });

    await expect(
      recordSalesReturn({
        orderId: order.id,
        reason: "Two more, but only one remains",
        lines: [{ orderItemId: line.id, quantity: "2" }],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    // The last unit is still allowed.
    await recordSalesReturn({
      orderId: order.id,
      reason: "The final unit",
      lines: [{ orderItemId: line.id, quantity: "1" }],
    });

    const after = await lineOf(order.id);
    expect(after.returnedQuantity).toBe(5);

    await expect(
      recordSalesReturn({
        orderId: order.id,
        reason: "Nothing left to return",
        lines: [{ orderItemId: line.id, quantity: "1" }],
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    await expectInvariants();
  });

  it("refuses to over-return under concurrency", async () => {
    await signInWithRole("ADMIN");
    const { product } = await twoLayerPart("RET-RACE");

    const order = await orderFor(product.id, 5);
    await confirmOrder(order.id);
    const line = await lineOf(order.id);

    /*
     * Both ask for four of the five shipped units. The order row lock has to
     * serialise them: whichever commits second sees returnedQuantity already at
     * four and is refused. Eight units must never come back from a shipment of
     * five.
     */
    const results = await Promise.allSettled([
      recordSalesReturn({
        orderId: order.id,
        reason: "Concurrent return A",
        lines: [{ orderItemId: line.id, quantity: "4" }],
      }),
      recordSalesReturn({
        orderId: order.id,
        reason: "Concurrent return B",
        lines: [{ orderItemId: line.id, quantity: "4" }],
      }),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);

    const after = await lineOf(order.id);
    expect(after.returnedQuantity).toBe(4);

    await expectInvariants();
  });
});

describe("returns and cancellation", () => {
  it("refuses to cancel an order that has returned goods", async () => {
    await signInWithRole("ADMIN");
    const { product } = await twoLayerPart("RET-CANCEL");

    const order = await orderFor(product.id, 5);
    await confirmOrder(order.id);
    const line = await lineOf(order.id);

    await recordSalesReturn({
      orderId: order.id,
      reason: "Two units back",
      lines: [{ orderItemId: line.id, quantity: "2" }],
    });

    await expect(cancelOrder(order.id)).rejects.toMatchObject({
      code: "CONFLICT",
    });

    const after = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.status).toBe("CONFIRMED");

    await expectInvariants();
  });

  it("refuses a return against a cancelled order", async () => {
    await signInWithRole("ADMIN");
    const { product } = await twoLayerPart("RET-AFTER-CANCEL");

    const order = await orderFor(product.id, 5);
    await confirmOrder(order.id);
    const line = await lineOf(order.id);

    await cancelOrder(order.id);

    await expect(
      recordSalesReturn({
        orderId: order.id,
        reason: "Returning against a cancelled order",
        lines: [{ orderItemId: line.id, quantity: "1" }],
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect(await prisma.return.count()).toBe(0);

    await expectInvariants();
  });

  it("accepts a return against a completed order", async () => {
    await signInWithRole("ADMIN");
    const { product } = await twoLayerPart("RET-COMPLETED");

    const order = await orderFor(product.id, 5);
    await confirmOrder(order.id);
    await completeOrder(order.id);
    const line = await lineOf(order.id);

    await recordSalesReturn({
      orderId: order.id,
      reason: "Returned after delivery was completed",
      lines: [{ orderItemId: line.id, quantity: "2" }],
    });

    const after = await lineOf(order.id);
    expect(after.returnedQuantity).toBe(2);

    await expectInvariants();
  });

  it("refuses a return against an order that has not shipped", async () => {
    await signInWithRole("ADMIN");
    const { product } = await twoLayerPart("RET-DRAFT");

    const order = await orderFor(product.id, 5);
    const line = await lineOf(order.id);

    await expect(
      recordSalesReturn({
        orderId: order.id,
        reason: "Nothing has shipped yet",
        lines: [{ orderItemId: line.id, quantity: "1" }],
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    await expectInvariants();
  });
});

describe("what a return leaves alone", () => {
  it("does not touch certificates", async () => {
    await signInWithRole("ADMIN");
    const { product } = await twoLayerPart("RET-CERT");

    const order = await orderFor(product.id, 5);
    await confirmOrder(order.id);
    const line = await lineOf(order.id);

    const before = await prisma.certificate.count();

    await recordSalesReturn({
      orderId: order.id,
      reason: "Returned, paperwork not yet reviewed",
      lines: [{ orderItemId: line.id, quantity: "5" }],
    });

    // No certificate was created, copied or moved onto the returned batches.
    expect(await prisma.certificate.count()).toBe(before);

    for (const lot of await returnLotsFor(line.id)) {
      const covering = await prisma.certificate.count({
        where: { stockLotId: lot.id },
      });
      expect(covering).toBe(0);
    }
  });

  it("leaves quarantined returns invisible to FIFO", async () => {
    await signInWithRole("ADMIN");
    const { product } = await twoLayerPart("RET-FIFO");

    const first = await orderFor(product.id, 5);
    await confirmOrder(first.id);
    const line = await lineOf(first.id);

    await recordSalesReturn({
      orderId: first.id,
      reason: "All five back",
      lines: [{ orderItemId: line.id, quantity: "5" }],
    });

    // Five physical units are on the shelf, none of them saleable.
    const second = await orderFor(product.id, 5);
    await confirmOrder(second.id);

    const secondLine = await lineOf(second.id);
    expect(secondLine.fulfilledQuantity).toBe(0);
    expect(secondLine.costTotal).toBeNull();

    const stock = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(stock.stockQuantity).toBe(5);

    await expectInvariants();
  });

  it("leaves order pricing and revenue basis untouched", async () => {
    await signInWithRole("ADMIN");
    const { product } = await twoLayerPart("RET-REV");

    const order = await orderFor(product.id, 5);
    await confirmOrder(order.id);
    const line = await lineOf(order.id);

    const beforeOrder = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
    });

    await recordSalesReturn({
      orderId: order.id,
      reason: "Four back",
      lines: [{ orderItemId: line.id, quantity: "4" }],
    });

    const afterOrder = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
    });

    // Revenue recognition is deliberately unchanged in this phase.
    expect(afterOrder.total.toString()).toBe(beforeOrder.total.toString());
    expect(afterOrder.subtotal.toString()).toBe(beforeOrder.subtotal.toString());
    expect(afterOrder.status).toBe(beforeOrder.status);
  });
});
