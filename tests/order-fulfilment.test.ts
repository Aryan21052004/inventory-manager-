import { beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { attachCertificate } from "@/server/certificates";
import {
  cancelOrder,
  completeOrder,
  confirmOrder,
  createOrder,
  fulfilOrder,
  getOrderDetail,
} from "@/server/orders";
import { createPurchase, receivePurchase } from "@/server/purchases";

import { signOutSupabase } from "./supabase-auth-mock";
import {
  createSupplier,
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
 * Fulfilment: shipping units an order already owes.
 *
 * The counterpart to the confirmation tests in tests/orders.test.ts. Those
 * prove an order can be confirmed against a shelf that cannot fill it; these
 * prove the obligation that leaves behind can be paid down later, exactly
 * once, at the price the units actually cost.
 *
 * Four properties carry the whole file, and every test here is about one of
 * them:
 *
 *   **Stock never goes negative, and never goes missing.** Fulfilment moves
 *   units through the same engine confirmation uses, so the same guard applies
 *   and the same invariants hold afterwards.
 *
 *   **An outstanding unit is not an uncosted unit.** Until a unit ships it has
 *   no acquisition cost, because nothing has been acquired against this sale.
 *   Once it ships it takes the real cost of the lot it came from — or stays
 *   honestly unknown if that lot's cost was never established.
 *
 *   **The obligation is bounded.** Fulfilment can never exceed what is owed,
 *   never exceed what is on hand, and never run twice for the same units.
 *
 *   **Nothing is allocated automatically.** Receiving a delivery does not
 *   fulfil anything; an operator says what is going in the box.
 */

beforeEach(async () => {
  signOutSupabase();
  await resetDatabase();
});

async function customer(name = "Contoso Aviation") {
  return prisma.customer.create({ data: { name } });
}

/** A part with no stock and no cost history — everything arrives by purchase. */
async function part(sku: string, stockQuantity = 0, sellingPrice = "12000.00") {
  return seedProduct({
    sku,
    name: `Part ${sku}`,
    stockQuantity,
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

async function stockOf(productId: string): Promise<number> {
  const row = await prisma.product.findUniqueOrThrow({
    where: { id: productId },
  });
  return row.stockQuantity;
}

async function lineOf(orderId: string, productId?: string) {
  return prisma.orderItem.findFirstOrThrow({
    where: { orderId, ...(productId ? { productId } : {}) },
  });
}

async function movementsFor(orderId: string) {
  return prisma.stockTransaction.findMany({
    where: { referenceType: "ORDER", referenceId: orderId },
    orderBy: { createdAt: "asc" },
  });
}

/** Everything the invariants require, after any operation that moved stock. */
async function expectEverythingReconciles(): Promise<void> {
  await expectLotsReconcile();
  await expectConsumptionsReconcile();
  await expectFulfilmentReconciles();
  await expectFulfilmentMatchesLedger();
}

/**
 * The worked example from the design: order 5, have 3, receive 2, ship 2.
 *
 * Set up as a helper because half this file starts from it.
 */
async function orderOwingTwo() {
  const supplier = await createSupplier();
  const buyer = await customer();
  const a = await part("A-1");

  await receive(supplier.id, a.id, 3, "8000.00");

  const order = await createOrder({
    customerId: buyer.id,
    items: await quoted([{ productId: a.id, quantity: 5 }]),
  });
  await confirmOrder(order.id);

  return { supplier, buyer, product: a, order };
}

// ---------------------------------------------------------------------------
// Fulfilling from stock that arrives later
// ---------------------------------------------------------------------------

describe("fulfilling outstanding quantity", () => {
  it("ships the remainder once the stock arrives", async () => {
    await signInWithRole("STAFF");
    const { supplier, product, order } = await orderOwingTwo();

    // Confirmation took the 3 that existed and left 2 owed.
    expect(await stockOf(product.id)).toBe(0);
    let line = await lineOf(order.id);
    expect(line.fulfilledQuantity).toBe(3);
    expect(Number(line.costTotal)).toBe(24_000);

    // The delivery arrives through the ordinary purchase flow, untouched.
    await receive(supplier.id, product.id, 2, "9500.00");
    expect(await stockOf(product.id)).toBe(2);

    // Nothing has been allocated to the order by the receipt itself.
    line = await lineOf(order.id);
    expect(line.fulfilledQuantity).toBe(3);

    const outcome = await fulfilOrder(order.id, {
      lines: [{ orderItemId: line.id, quantity: 2 }],
    });

    expect(outcome.unfulfilledUnits).toBe(0);
    expect(await stockOf(product.id)).toBe(0);

    line = await lineOf(order.id);
    expect(line.fulfilledQuantity).toBe(5);
    expect(line.costedQuantity).toBe(5);

    /*
     * The whole argument for doing this later rather than guessing at
     * confirmation: 3 units at ₹8,000 and 2 at ₹9,500 is ₹43,000, which is
     * what these units actually cost. No average, no catalogue figure.
     */
    expect(Number(line.costTotal)).toBe(43_000);

    await expectEverythingReconciles();
  });

  it("leaves the order's status and timestamps alone", async () => {
    await signInWithRole("STAFF");
    const { supplier, product, order } = await orderOwingTwo();

    const before = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
    });

    await receive(supplier.id, product.id, 2, "9500.00");
    await fulfilOrder(order.id, {
      lines: [{ orderItemId: (await lineOf(order.id)).id, quantity: 2 }],
    });

    const after = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
    });

    // Fulfilment is a physical act, not a transition.
    expect(after.status).toBe(before.status);
    expect(after.confirmedAt).toEqual(before.confirmedAt);
    expect(after.completedAt).toEqual(before.completedAt);
    expect(after.cancelledAt).toBeNull();
  });

  it("writes an ordinary STOCK_OUT against the order", async () => {
    await signInWithRole("STAFF");
    const { supplier, product, order } = await orderOwingTwo();

    await receive(supplier.id, product.id, 2, "9500.00");
    await fulfilOrder(order.id, {
      lines: [{ orderItemId: (await lineOf(order.id)).id, quantity: 2 }],
    });

    const ledger = await movementsFor(order.id);
    expect(ledger).toHaveLength(2);

    const [confirmation, fulfilment] = ledger;
    expect(confirmation!.quantity).toBe(3);
    expect(fulfilment!.type).toBe("STOCK_OUT");
    expect(fulfilment!.quantity).toBe(2);
    expect(fulfilment!.previousStock).toBe(2);
    expect(fulfilment!.newStock).toBe(0);
    // The note tells the two events apart in the ledger.
    expect(fulfilment!.note).toContain("fulfilled");
  });

  it("costs a later fulfilment from the lot that was actually consumed", async () => {
    await signInWithRole("STAFF");
    const { supplier, product, order } = await orderOwingTwo();

    await receive(supplier.id, product.id, 2, "9500.00");
    const line = await lineOf(order.id);
    await fulfilOrder(order.id, {
      lines: [{ orderItemId: line.id, quantity: 2 }],
    });

    const consumptions = await prisma.stockLotConsumption.findMany({
      orderBy: { createdAt: "asc" },
    });

    // Two draws, against two different batches, at their two real prices.
    expect(consumptions).toHaveLength(2);
    expect(Number(consumptions[0]!.unitCost)).toBe(8000);
    expect(consumptions[0]!.quantity).toBe(3);
    expect(Number(consumptions[1]!.unitCost)).toBe(9500);
    expect(consumptions[1]!.quantity).toBe(2);
  });

  it("keeps an unknown cost unknown", async () => {
    await signInWithRole("ADMIN");
    const buyer = await customer();

    // Stock that arrived without a provable price — an UNKNOWN lot.
    const a = await seedProduct({ sku: "U-1", stockQuantity: 0 });

    const order = await createOrder({
      customerId: buyer.id,
      items: await quoted([{ productId: a.id, quantity: 4 }]),
    });
    await confirmOrder(order.id);

    // Counted onto the shelf by hand, with no cost anybody can source.
    await prisma.$transaction(async (tx) => {
      const transaction = await tx.stockTransaction.create({
        data: {
          productId: a.id,
          type: "ADJUSTMENT",
          quantity: 4,
          previousStock: 0,
          newStock: 4,
          referenceType: "MANUAL",
          note: "Found on the shelf during a count",
        },
      });
      await tx.product.update({
        where: { id: a.id },
        data: { stockQuantity: 4 },
      });
      await tx.stockLot.create({
        data: {
          productId: a.id,
          unitCost: null,
          costSource: "UNKNOWN",
          quantityReceived: 4,
          quantityRemaining: 4,
          sourceType: "MANUAL",
          sourceId: null,
          receivedAt: new Date(),
          stockTransactionId: transaction.id,
        },
      });
    });

    const line = await lineOf(order.id);
    await fulfilOrder(order.id, {
      lines: [{ orderItemId: line.id, quantity: 4 }],
    });

    const after = await lineOf(order.id);

    /*
     * Fulfilled in full, costed for none of it. Nothing was substituted from
     * the catalogue or the selling price to make the line look complete — an
     * unknown cost that survives to the screen is worth more than a plausible
     * number nobody can source.
     */
    expect(after.fulfilledQuantity).toBe(4);
    expect(after.costedQuantity).toBe(0);
    expect(after.costTotal).toBeNull();

    await expectEverythingReconciles();
  });

  it("fulfils in several steps as stock trickles in", async () => {
    await signInWithRole("STAFF");
    const { supplier, product, order } = await orderOwingTwo();

    await receive(supplier.id, product.id, 1, "9000.00");
    await fulfilOrder(order.id, {
      lines: [{ orderItemId: (await lineOf(order.id)).id, quantity: 1 }],
    });

    let line = await lineOf(order.id);
    expect(line.fulfilledQuantity).toBe(4);
    expect(Number(line.costTotal)).toBe(33_000); // 3 × 8,000 + 1 × 9,000

    await receive(supplier.id, product.id, 1, "10000.00");
    const outcome = await fulfilOrder(order.id, {
      lines: [{ orderItemId: line.id, quantity: 1 }],
    });

    line = await lineOf(order.id);
    expect(line.fulfilledQuantity).toBe(5);
    expect(Number(line.costTotal)).toBe(43_000); // + 1 × 10,000
    expect(outcome.unfulfilledUnits).toBe(0);

    expect(await movementsFor(order.id)).toHaveLength(3);
    await expectEverythingReconciles();
  });

  it("fulfils a multi-line order line by line", async () => {
    await signInWithRole("STAFF");
    const supplier = await createSupplier();
    const buyer = await customer();
    const a = await part("M-A");
    const b = await part("M-B");

    await receive(supplier.id, a.id, 1, "100.00");

    const order = await createOrder({
      customerId: buyer.id,
      items: await quoted([
        { productId: a.id, quantity: 3 },
        { productId: b.id, quantity: 2 },
      ]),
    });
    await confirmOrder(order.id);

    // A took its one unit; B had nothing and moved not at all.
    expect((await lineOf(order.id, a.id)).fulfilledQuantity).toBe(1);
    expect((await lineOf(order.id, b.id)).fulfilledQuantity).toBe(0);
    expect(await movementsFor(order.id)).toHaveLength(1);

    await receive(supplier.id, a.id, 2, "110.00");
    await receive(supplier.id, b.id, 2, "220.00");

    const outcome = await fulfilOrder(order.id, {
      lines: [
        { orderItemId: (await lineOf(order.id, a.id)).id, quantity: 2 },
        { orderItemId: (await lineOf(order.id, b.id)).id, quantity: 2 },
      ],
    });

    expect(outcome.movements).toHaveLength(2);
    expect(outcome.unfulfilledUnits).toBe(0);
    expect((await lineOf(order.id, a.id)).fulfilledQuantity).toBe(3);
    expect((await lineOf(order.id, b.id)).fulfilledQuantity).toBe(2);
    expect(await stockOf(a.id)).toBe(0);
    expect(await stockOf(b.id)).toBe(0);

    await expectEverythingReconciles();
  });

  it("reports what is still outstanding on lines it was not asked about", async () => {
    await signInWithRole("STAFF");
    const supplier = await createSupplier();
    const buyer = await customer();
    const a = await part("P-A");
    const b = await part("P-B");

    const order = await createOrder({
      customerId: buyer.id,
      items: await quoted([
        { productId: a.id, quantity: 2 },
        { productId: b.id, quantity: 3 },
      ]),
    });
    await confirmOrder(order.id);

    await receive(supplier.id, a.id, 2, "100.00");

    const outcome = await fulfilOrder(order.id, {
      lines: [{ orderItemId: (await lineOf(order.id, a.id)).id, quantity: 2 }],
    });

    // B's three units were never mentioned in the request and are still owed.
    expect(outcome.unfulfilledUnits).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// The bounds
// ---------------------------------------------------------------------------

describe("fulfilment is bounded", () => {
  it("refuses more than the line still owes", async () => {
    await signInWithRole("STAFF");
    const { supplier, product, order } = await orderOwingTwo();

    // Plenty on the shelf — the limit being tested is the obligation, not stock.
    await receive(supplier.id, product.id, 50, "9500.00");
    const line = await lineOf(order.id);

    await expect(
      fulfilOrder(order.id, { lines: [{ orderItemId: line.id, quantity: 3 }] }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("only 2 units outstanding"),
    });

    // Refused outright, not trimmed to 2.
    expect((await lineOf(order.id)).fulfilledQuantity).toBe(3);
    expect(await stockOf(product.id)).toBe(50);
    expect(await movementsFor(order.id)).toHaveLength(1);
  });

  it("refuses more than is physically on hand, rather than shipping fewer", async () => {
    await signInWithRole("STAFF");
    const { supplier, product, order } = await orderOwingTwo();

    // Two owed, one arrived.
    await receive(supplier.id, product.id, 1, "9500.00");
    const line = await lineOf(order.id);

    /*
     * The asymmetry with confirmation, asserted. Confirming is a commitment to
     * sell and settles for what exists; fulfilling is an assertion that units
     * are physically going out, so a request for two when one is there is
     * wrong and is refused rather than quietly reduced.
     */
    await expect(
      fulfilOrder(order.id, { lines: [{ orderItemId: line.id, quantity: 2 }] }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_STOCK", status: 422 });

    expect(await stockOf(product.id)).toBe(1);
    expect((await lineOf(order.id)).fulfilledQuantity).toBe(3);
    await expectEverythingReconciles();
  });

  it("never drives stock negative", async () => {
    await signInWithRole("STAFF");
    const { product, order } = await orderOwingTwo();

    const line = await lineOf(order.id);

    // Nothing at all on the shelf.
    await expect(
      fulfilOrder(order.id, { lines: [{ orderItemId: line.id, quantity: 1 }] }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_STOCK" });

    expect(await stockOf(product.id)).toBe(0);
    await expectEverythingReconciles();
  });

  it("refuses a line that is already fulfilled in full", async () => {
    await signInWithRole("STAFF");
    const supplier = await createSupplier();
    const buyer = await customer();
    const a = await part("F-1");

    await receive(supplier.id, a.id, 5, "100.00");

    const order = await createOrder({
      customerId: buyer.id,
      items: await quoted([{ productId: a.id, quantity: 5 }]),
    });
    await confirmOrder(order.id);

    await receive(supplier.id, a.id, 5, "100.00");
    const line = await lineOf(order.id);

    await expect(
      fulfilOrder(order.id, { lines: [{ orderItemId: line.id, quantity: 1 }] }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("already been fulfilled in full"),
    });
  });

  it("refuses a line belonging to another order", async () => {
    await signInWithRole("STAFF");
    const { order } = await orderOwingTwo();

    const buyer = await customer("Someone Else");
    const other = await part("X-9");
    const otherOrder = await createOrder({
      customerId: buyer.id,
      items: await quoted([{ productId: other.id, quantity: 1 }]),
    });
    const foreign = await lineOf(otherOrder.id);

    await expect(
      fulfilOrder(order.id, {
        lines: [{ orderItemId: foreign.id, quantity: 1 }],
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("refuses a draft, a pending order and a cancelled one", async () => {
    await signInWithRole("STAFF");
    const supplier = await createSupplier();
    const buyer = await customer();
    const a = await part("S-1");
    await receive(supplier.id, a.id, 10, "100.00");

    const draft = await createOrder({
      customerId: buyer.id,
      items: await quoted([{ productId: a.id, quantity: 2 }]),
    });

    await expect(
      fulfilOrder(draft.id, {
        lines: [{ orderItemId: (await lineOf(draft.id)).id, quantity: 1 }],
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const cancelled = await createOrder({
      customerId: buyer.id,
      items: await quoted([{ productId: a.id, quantity: 2 }]),
    });
    await confirmOrder(cancelled.id);
    await cancelOrder(cancelled.id);

    await expect(
      fulfilOrder(cancelled.id, {
        lines: [{ orderItemId: (await lineOf(cancelled.id)).id, quantity: 1 }],
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("rejects a zero or negative quantity", async () => {
    await signInWithRole("STAFF");
    const { order } = await orderOwingTwo();
    const line = await lineOf(order.id);

    await expect(
      fulfilOrder(order.id, { lines: [{ orderItemId: line.id, quantity: 0 }] }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      fulfilOrder(order.id, { lines: [{ orderItemId: line.id, quantity: -2 }] }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("rejects the same line named twice in one request", async () => {
    await signInWithRole("STAFF");
    const { supplier, product, order } = await orderOwingTwo();
    await receive(supplier.id, product.id, 10, "100.00");
    const line = await lineOf(order.id);

    /*
     * Two entries of one each would otherwise resolve to a single map key and
     * silently ship one unit instead of two. Refused, because a request that
     * does not mean what it says should not be guessed at.
     */
    await expect(
      fulfilOrder(order.id, {
        lines: [
          { orderItemId: line.id, quantity: 1 },
          { orderItemId: line.id, quantity: 1 },
        ],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("leaves every line alone when one of them cannot be met", async () => {
    await signInWithRole("STAFF");
    const supplier = await createSupplier();
    const buyer = await customer();
    const a = await part("T-A");
    const b = await part("T-B");

    const order = await createOrder({
      customerId: buyer.id,
      items: await quoted([
        { productId: a.id, quantity: 2 },
        { productId: b.id, quantity: 2 },
      ]),
    });
    await confirmOrder(order.id);

    // A can be met; B cannot.
    await receive(supplier.id, a.id, 2, "100.00");

    await expect(
      fulfilOrder(order.id, {
        lines: [
          { orderItemId: (await lineOf(order.id, a.id)).id, quantity: 2 },
          { orderItemId: (await lineOf(order.id, b.id)).id, quantity: 2 },
        ],
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_STOCK" });

    // Atomic: A's units are still on the shelf, not half-shipped.
    expect(await stockOf(a.id)).toBe(2);
    expect((await lineOf(order.id, a.id)).fulfilledQuantity).toBe(0);
    expect(await movementsFor(order.id)).toHaveLength(0);
    await expectEverythingReconciles();
  });
});

// ---------------------------------------------------------------------------
// Completion, and the order that would otherwise be stranded
// ---------------------------------------------------------------------------

describe("completion and fulfilment are independent", () => {
  it("completes an order that still owes units", async () => {
    await signInWithRole("STAFF");
    const { order } = await orderOwingTwo();

    const outcome = await completeOrder(order.id);

    expect(outcome.status).toBe("COMPLETED");
    expect(outcome.movements).toHaveLength(0);

    const line = await lineOf(order.id);
    expect(line.fulfilledQuantity).toBe(3);
    expect(line.quantity - line.fulfilledQuantity).toBe(2);
  });

  it("still fulfils a completed order, so outstanding units are not stranded", async () => {
    await signInWithRole("STAFF");
    const { supplier, product, order } = await orderOwingTwo();

    await completeOrder(order.id);
    await receive(supplier.id, product.id, 2, "9500.00");

    /*
     * The case that forced `canFulfilOutstanding` to include COMPLETED.
     * COMPLETED is terminal and COMPLETED → CANCELLED is refused, so if
     * completion sealed the outstanding quantity there would be no route left
     * to ship it and no route to undo the completion either.
     */
    await fulfilOrder(order.id, {
      lines: [{ orderItemId: (await lineOf(order.id)).id, quantity: 2 }],
    });

    const line = await lineOf(order.id);
    expect(line.fulfilledQuantity).toBe(5);
    expect(Number(line.costTotal)).toBe(43_000);

    const row = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
    });
    expect(row.status).toBe("COMPLETED");

    await expectEverythingReconciles();
  });
});

// ---------------------------------------------------------------------------
// Cancellation across the fulfilment boundary
// ---------------------------------------------------------------------------

describe("cancelling an order that was never fully fulfilled", () => {
  it("restores nothing when nothing was ever fulfilled", async () => {
    await signInWithRole("STAFF");
    const buyer = await customer();
    const a = await part("C-1");

    const order = await createOrder({
      customerId: buyer.id,
      items: await quoted([{ productId: a.id, quantity: 5 }]),
    });
    await confirmOrder(order.id);

    const outcome = await cancelOrder(order.id);

    expect(outcome.movements).toHaveLength(0);
    expect(await movementsFor(order.id)).toHaveLength(0);
    expect(await stockOf(a.id)).toBe(0);

    // No REVERSAL, and emphatically no uncosted shortfall lot invented to
    // account for units that never left.
    expect(await prisma.stockTransaction.count()).toBe(0);
    expect(await prisma.stockLot.count()).toBe(0);

    const line = await lineOf(order.id);
    expect(line.fulfilledQuantity).toBe(0);
    expect(line.costedQuantity).toBe(0);
    expect(line.costTotal).toBeNull();

    await expectEverythingReconciles();
  });

  it("restores exactly the units that were fulfilled, and no more", async () => {
    await signInWithRole("STAFF");
    const { product, order } = await orderOwingTwo();

    const outcome = await cancelOrder(order.id);

    // Three left, so three come back — never the five that were ordered.
    expect(outcome.movements).toHaveLength(1);
    expect(outcome.movements[0]!.quantity).toBe(3);
    expect(await stockOf(product.id)).toBe(3);

    const line = await lineOf(order.id);
    expect(line.fulfilledQuantity).toBe(0);
    expect(line.costedQuantity).toBe(0);
    expect(line.costTotal).toBeNull();

    await expectEverythingReconciles();
  });

  it("restores units fulfilled across two events, to their own lots", async () => {
    await signInWithRole("STAFF");
    const { supplier, product, order } = await orderOwingTwo();

    await receive(supplier.id, product.id, 2, "9500.00");
    await fulfilOrder(order.id, {
      lines: [{ orderItemId: (await lineOf(order.id)).id, quantity: 2 }],
    });

    expect(await stockOf(product.id)).toBe(0);

    await cancelOrder(order.id);

    // All five come back.
    expect(await stockOf(product.id)).toBe(5);

    /*
     * And to the batches they came out of, at the prices those batches cost —
     * three to the ₹8,000 lot and two to the ₹9,500 one. Never pooled into a
     * new lot at today's price, and never as an invented UNKNOWN lot: the
     * consumption rows accounted for every unit, so `returnToLots` had no
     * shortfall to reconcile.
     */
    const lots = await prisma.stockLot.findMany({
      orderBy: [{ receivedAt: "asc" }, { id: "asc" }],
    });
    expect(lots).toHaveLength(2);
    expect(lots[0]!.quantityRemaining).toBe(3);
    expect(Number(lots[0]!.unitCost)).toBe(8000);
    expect(lots[1]!.quantityRemaining).toBe(2);
    expect(Number(lots[1]!.unitCost)).toBe(9500);

    await expectEverythingReconciles();
  });
});

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

describe("concurrent fulfilment", () => {
  it("cannot ship the same outstanding units twice", async () => {
    await signInWithRole("STAFF");
    const { supplier, product, order } = await orderOwingTwo();

    await receive(supplier.id, product.id, 2, "9500.00");
    const line = await lineOf(order.id);

    /*
     * Two operators clicking Fulfil on the same order at the same moment.
     * Without the order row lock both read `fulfilledQuantity = 3`, both
     * believe two units are owed, and four units ship against a line for five.
     */
    const results = await Promise.allSettled([
      fulfilOrder(order.id, { lines: [{ orderItemId: line.id, quantity: 2 }] }),
      fulfilOrder(order.id, { lines: [{ orderItemId: line.id, quantity: 2 }] }),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);

    const after = await lineOf(order.id);
    expect(after.fulfilledQuantity).toBe(5);
    expect(await stockOf(product.id)).toBe(0);
    expect(await movementsFor(order.id)).toHaveLength(2);

    await expectEverythingReconciles();
  });

  it("does not let a fulfilment and a confirmation overdraw one product", async () => {
    await signInWithRole("STAFF");
    const supplier = await createSupplier();
    const buyer = await customer();
    const a = await part("R-1");

    // One order already owing two units.
    await receive(supplier.id, a.id, 3, "8000.00");
    const owing = await createOrder({
      customerId: buyer.id,
      items: await quoted([{ productId: a.id, quantity: 5 }]),
    });
    await confirmOrder(owing.id);

    // Two units arrive, and a brand new order wants both of them too.
    await receive(supplier.id, a.id, 2, "9500.00");
    const rival = await createOrder({
      customerId: buyer.id,
      items: await quoted([{ productId: a.id, quantity: 2 }]),
    });

    const owingLine = await lineOf(owing.id);

    const results = await Promise.allSettled([
      fulfilOrder(owing.id, {
        lines: [{ orderItemId: owingLine.id, quantity: 2 }],
      }),
      confirmOrder(rival.id),
    ]);

    /*
     * The confirmation always succeeds — it settles for whatever is left. The
     * fulfilment may or may not, depending which took the product lock first;
     * what must hold either way is that the two together removed exactly the
     * two units that existed.
     */
    expect(
      results.filter((r) => r.status === "fulfilled").length,
    ).toBeGreaterThanOrEqual(1);
    expect(await stockOf(a.id)).toBe(0);

    await expectEverythingReconciles();
  });
});

// ---------------------------------------------------------------------------
// Authorisation
// ---------------------------------------------------------------------------

describe("who may fulfil", () => {
  it("refuses an unauthenticated caller", async () => {
    await signInWithRole("STAFF");
    const { supplier, product, order } = await orderOwingTwo();
    await receive(supplier.id, product.id, 2, "9500.00");
    const line = await lineOf(order.id);

    signOutSupabase();

    await expect(
      fulfilOrder(order.id, { lines: [{ orderItemId: line.id, quantity: 2 }] }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    expect(await stockOf(product.id)).toBe(2);
  });

  it("lets ordinary staff fulfil — it is warehouse work, not a correction", async () => {
    await signInWithRole("STAFF");
    const { supplier, product, order } = await orderOwingTwo();
    await receive(supplier.id, product.id, 2, "9500.00");

    await fulfilOrder(order.id, {
      lines: [{ orderItemId: (await lineOf(order.id)).id, quantity: 2 }],
    });

    expect((await lineOf(order.id)).fulfilledQuantity).toBe(5);
  });

  it("attributes the movement to the signed-in user", async () => {
    const user = await signInWithRole("STAFF");
    const { supplier, product, order } = await orderOwingTwo();
    await receive(supplier.id, product.id, 2, "9500.00");

    await fulfilOrder(order.id, {
      lines: [{ orderItemId: (await lineOf(order.id)).id, quantity: 2 }],
    });

    const ledger = await movementsFor(order.id);
    expect(ledger[1]!.createdBy).toBe(user.id);
  });
});

// ---------------------------------------------------------------------------
// Certificates follow the units that shipped
// ---------------------------------------------------------------------------

describe("certificates after a later fulfilment", () => {
  it("shows the paperwork of the batch each part of the order consumed", async () => {
    await signInWithRole("ADMIN");
    const supplier = await createSupplier();
    const buyer = await customer();
    const a = await part("CERT-1");

    await receive(supplier.id, a.id, 3, "8000.00");
    const firstLot = await prisma.stockLot.findFirstOrThrow({
      where: { productId: a.id },
    });

    await attachCertificate({
      stockLotId: firstLot.id,
      metadata: {
        certificateType: "FAA 8130-3",
        certificateNumber: "FIRST-BATCH",
        issueDate: "2026-01-01",
        expiryDate: "2030-01-01",
      },
      file: new File(
        [new Uint8Array(Buffer.from("%PDF-1.7\nfirst\n"))],
        "first.pdf",
        { type: "application/pdf" },
      ),
    });

    const order = await createOrder({
      customerId: buyer.id,
      items: await quoted([{ productId: a.id, quantity: 5 }]),
    });
    await confirmOrder(order.id);

    // The second delivery carries its own, different paperwork.
    await receive(supplier.id, a.id, 2, "9500.00");
    const secondLot = await prisma.stockLot.findFirstOrThrow({
      where: { productId: a.id, id: { not: firstLot.id } },
    });

    await attachCertificate({
      stockLotId: secondLot.id,
      metadata: {
        certificateType: "EASA Form 1",
        certificateNumber: "SECOND-BATCH",
        issueDate: "2026-06-01",
        expiryDate: "2030-06-01",
      },
      file: new File(
        [new Uint8Array(Buffer.from("%PDF-1.7\nsecond\n"))],
        "second.pdf",
        { type: "application/pdf" },
      ),
    });

    await fulfilOrder(order.id, {
      lines: [{ orderItemId: (await lineOf(order.id)).id, quantity: 2 }],
    });

    const detail = await getOrderDetail(order.id);
    expect(detail.ok).toBe(true);
    if (!detail.ok || !detail.data) throw new Error("no detail");

    const certificates = detail.data.lines[0]!.lotCertificates;

    /*
     * Both batches, each with its own document — read through
     * StockLotConsumption, so the answer is "what covered the units that
     * shipped" rather than "what covers this part number today". The later
     * fulfilment surfaced the second certificate without a line of new
     * certificate code, which is what the lot-level model bought.
     */
    expect(certificates).toHaveLength(2);

    const numbers = certificates
      .map((certificate) => certificate.certificateNumber)
      .sort();
    expect(numbers).toEqual(["FIRST-BATCH", "SECOND-BATCH"]);

    const first = certificates.find(
      (certificate) => certificate.certificateNumber === "FIRST-BATCH",
    )!;
    const second = certificates.find(
      (certificate) => certificate.certificateNumber === "SECOND-BATCH",
    )!;
    expect(first.quantity).toBe(3);
    expect(second.quantity).toBe(2);
  });

  it("shows no certificate for a line that has not shipped anything", async () => {
    await signInWithRole("ADMIN");
    const buyer = await customer();
    const a = await part("CERT-2");

    const order = await createOrder({
      customerId: buyer.id,
      items: await quoted([{ productId: a.id, quantity: 2 }]),
    });
    await confirmOrder(order.id);

    const detail = await getOrderDetail(order.id);
    if (!detail.ok || !detail.data) throw new Error("no detail");

    // Nothing was consumed, so there is no batch to name — and no fallback to
    // a product-level certificate, which is not a thing this system has.
    expect(detail.data.lines[0]!.lotCertificates).toEqual([]);
    expect(detail.data.lines[0]!.fulfilledQuantity).toBe(0);
  });
});
