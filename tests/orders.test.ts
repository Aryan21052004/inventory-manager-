import { beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import {
  cancelOrder,
  completeOrder,
  confirmOrder,
  createOrder,
  getOrderDetail,
  listOrders,
  setOrderStatus,
  updateOrder,
} from "@/server/orders";
import { attachCertificate } from "@/server/certificates";
import { createPurchase, receivePurchase } from "@/server/purchases";
import { DEFAULT_ORDER_PARAMS } from "@/lib/order-query";

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
 * Orders, and the inventory they move.
 *
 * Almost everything worth proving here is about failure: that a short line
 * stops the whole order, that a second confirmation deducts nothing, that a
 * second cancellation restores nothing, and that two orders racing for the last
 * units cannot both win. The happy path is one test; the rest of this file is
 * the guarantees around it.
 *
 * These run against a real Postgres because the guarantees *are* Postgres —
 * `FOR UPDATE`, transaction rollback, and a unique index. A mocked client would
 * only prove the mock had been written to agree.
 */

beforeEach(async () => {
  signOutSupabase();
  await resetDatabase();
});

async function createCustomer(name = "Contoso Aviation") {
  return prisma.customer.create({ data: { name } });
}

/** A product with a known balance and a round price. */
async function product(sku: string, stockQuantity: number, price = "10.00") {
  return seedProduct({
    sku,
    name: `Part ${sku}`,
    stockQuantity,
    sellingPrice: price,
  });
}

async function draftOrder(
  customerId: string,
  items: { productId: string; quantity: number; unitPrice?: string }[],
) {
  return createOrder({ customerId, items: await quoted(items) });
}

async function stockOf(productId: string): Promise<number> {
  const row = await prisma.product.findUniqueOrThrow({
    where: { id: productId },
  });
  return row.stockQuantity;
}

async function movementsFor(orderId: string) {
  return prisma.stockTransaction.findMany({
    where: { referenceType: "ORDER", referenceId: orderId },
    orderBy: { createdAt: "asc" },
  });
}

/** The lines of an order, in a stable order, for fulfilment assertions. */
async function linesOf(orderId: string) {
  return prisma.orderItem.findMany({
    where: { orderId },
    orderBy: { productId: "asc" },
  });
}

/** How many units an order still owes, across every line. */
async function outstandingOf(orderId: string): Promise<number> {
  const lines = await linesOf(orderId);
  return lines.reduce(
    (sum, line) => sum + (line.quantity - line.fulfilledQuantity),
    0,
  );
}

// ---------------------------------------------------------------------------
// Test 1, 3, 4 — deduction on confirmation
// ---------------------------------------------------------------------------

describe("confirming an order deducts stock", () => {
  it("takes 150 from 200 and writes one STOCK_OUT", async () => {
    const user = await signInWithRole("STAFF");
    const customer = await createCustomer();
    const part = await product("A-1", 200);

    const order = await draftOrder(customer.id, [
      { productId: part.id, quantity: 150 },
    ]);

    const outcome = await confirmOrder(order.id);

    expect(outcome.status).toBe("CONFIRMED");
    expect(await stockOf(part.id)).toBe(50);

    const ledger = await movementsFor(order.id);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      productId: part.id,
      type: "STOCK_OUT",
      quantity: 150,
      previousStock: 200,
      newStock: 50,
      referenceType: "ORDER",
      referenceId: order.id,
      createdBy: user.id,
    });
    expect(ledger[0]!.note).toContain(order.orderNumber);
  });

  it("allows an order for exactly the stock on hand", async () => {
    await signInWithRole("STAFF");
    const customer = await createCustomer();
    const part = await product("A-2", 100);

    const order = await draftOrder(customer.id, [
      { productId: part.id, quantity: 100 },
    ]);

    await confirmOrder(order.id);

    expect(await stockOf(part.id)).toBe(0);
    const updated = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
    });
    expect(updated.status).toBe("CONFIRMED");
  });

  it("confirms an order for one more than the stock on hand, owing the extra", async () => {
    await signInWithRole("STAFF");
    const customer = await createCustomer();
    const part = await product("A-3", 100);

    const order = await draftOrder(customer.id, [
      { productId: part.id, quantity: 101 },
    ]);

    // The sale is committed; the warehouse simply cannot finish it today.
    await confirmOrder(order.id);

    expect(await stockOf(part.id)).toBe(0);
    expect(await outstandingOf(order.id)).toBe(1);

    // One movement, for the 100 that actually left — not 101.
    const ledger = await movementsFor(order.id);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.quantity).toBe(100);
    expect(ledger[0]!.newStock).toBe(0);
  });

  it("records the confirmation timestamp", async () => {
    await signInWithRole("STAFF");
    const customer = await createCustomer();
    const part = await product("A-4", 10);

    const order = await draftOrder(customer.id, [
      { productId: part.id, quantity: 1 },
    ]);
    await confirmOrder(order.id);

    const row = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
    });
    expect(row.confirmedAt).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Test 2 — insufficient stock
//
// This block used to prove that a short order could not be confirmed at all.
// It now proves the opposite, and the reason is a business rule rather than a
// relaxation: this company sells parts it does not yet hold, so a shortfall is
// a procurement fact, not an invalid document. What has *not* changed is the
// part that matters — inventory never goes below zero, and no movement is
// written for a unit that did not move.
// ---------------------------------------------------------------------------

describe("confirming against insufficient stock", () => {
  it("takes what is there and leaves the rest outstanding", async () => {
    await signInWithRole("STAFF");
    const customer = await createCustomer();
    const part = await product("B-1", 40);

    const order = await draftOrder(customer.id, [
      { productId: part.id, quantity: 60 },
    ]);

    const outcome = await confirmOrder(order.id);

    expect(outcome.status).toBe("CONFIRMED");
    expect(outcome.unfulfilledUnits).toBe(20);

    // The shelf is emptied, never overdrawn.
    expect(await stockOf(part.id)).toBe(0);

    const [line] = await linesOf(order.id);
    expect(line!.quantity).toBe(60);
    expect(line!.fulfilledQuantity).toBe(40);

    // One movement, sized to what actually left.
    const ledger = await movementsFor(order.id);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.quantity).toBe(40);
    expect(ledger[0]!.previousStock).toBe(40);
    expect(ledger[0]!.newStock).toBe(0);

    const row = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
    });
    expect(row.status).toBe("CONFIRMED");
    // Load-bearing: the sales report dates realised revenue by this column, so
    // a sale that could not be filled must still carry it.
    expect(row.confirmedAt).not.toBeNull();

    await expectLotsReconcile();
    await expectConsumptionsReconcile();
    await expectFulfilmentReconciles();
    await expectFulfilmentMatchesLedger();
  });

  it("confirms an order against an empty shelf without moving anything", async () => {
    await signInWithRole("STAFF");
    const customer = await createCustomer();
    const part = await product("B-2", 0);

    const order = await draftOrder(customer.id, [
      { productId: part.id, quantity: 1 },
    ]);

    const outcome = await confirmOrder(order.id);

    expect(outcome.status).toBe("CONFIRMED");
    expect(outcome.movements).toHaveLength(0);
    expect(outcome.unfulfilledUnits).toBe(1);

    expect(await stockOf(part.id)).toBe(0);
    expect(await outstandingOf(order.id)).toBe(1);

    /*
     * The point of the whole design: nothing moved, so the ledger and the
     * valuation layer say nothing moved. No zero-quantity transaction, no
     * phantom lot, no consumption row costed at a guess.
     */
    expect(await movementsFor(order.id)).toHaveLength(0);
    expect(await prisma.stockTransaction.count()).toBe(0);
    expect(await prisma.stockLotConsumption.count()).toBe(0);

    const [line] = await linesOf(order.id);
    expect(line!.fulfilledQuantity).toBe(0);
    expect(line!.costedQuantity).toBe(0);
    expect(line!.costTotal).toBeNull();

    const row = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
    });
    expect(row.confirmedAt).not.toBeNull();

    await expectLotsReconcile();
    await expectConsumptionsReconcile();
    await expectFulfilmentReconciles();
    await expectFulfilmentMatchesLedger();
  });

  it("costs only the units that actually left", async () => {
    await signInWithRole("STAFF");
    const customer = await createCustomer();
    const part = await seedProduct({
      sku: "B-3",
      name: "Hydraulic Actuator",
      stockQuantity: 40,
      lotUnitCost: "100.00",
    });

    const order = await draftOrder(customer.id, [
      { productId: part.id, quantity: 60 },
    ]);

    await confirmOrder(order.id);

    const [line] = await linesOf(order.id);
    // 40 shipped and costed at ₹100; the 20 outstanding are not "uncosted",
    // they are unacquired, and carry no cost figure of any kind.
    expect(line!.fulfilledQuantity).toBe(40);
    expect(line!.costedQuantity).toBe(40);
    expect(Number(line!.costTotal)).toBe(4000);
  });
});

// ---------------------------------------------------------------------------
// Tests 7 and 8 — multiple products, all or nothing
// ---------------------------------------------------------------------------

describe("orders with several products", () => {
  it("deducts every line", async () => {
    await signInWithRole("STAFF");
    const customer = await createCustomer();
    const a = await product("M-A", 200);
    const b = await product("M-B", 100);

    const order = await draftOrder(customer.id, [
      { productId: a.id, quantity: 150 },
      { productId: b.id, quantity: 80 },
    ]);

    await confirmOrder(order.id);

    expect(await stockOf(a.id)).toBe(50);
    expect(await stockOf(b.id)).toBe(20);
    expect(await movementsFor(order.id)).toHaveLength(2);
  });

  it("fulfils each line independently when one is short", async () => {
    await signInWithRole("STAFF");
    const customer = await createCustomer();
    const a = await product("M-C", 200);
    const b = await product("M-D", 50);

    const order = await draftOrder(customer.id, [
      { productId: a.id, quantity: 150 },
      { productId: b.id, quantity: 80 },
    ]);

    const outcome = await confirmOrder(order.id);

    /*
     * The line that could be filled is filled. A short line no longer holds
     * the rest of the order hostage — but it also does not borrow from
     * anywhere, so B stops at the 50 it had.
     */
    expect(await stockOf(a.id)).toBe(50);
    expect(await stockOf(b.id)).toBe(0);
    expect(outcome.unfulfilledUnits).toBe(30);

    const lines = await linesOf(order.id);
    const lineA = lines.find((line) => line.productId === a.id)!;
    const lineB = lines.find((line) => line.productId === b.id)!;
    expect(lineA.fulfilledQuantity).toBe(150);
    expect(lineB.fulfilledQuantity).toBe(50);

    expect(await movementsFor(order.id)).toHaveLength(2);

    await expectLotsReconcile();
    await expectFulfilmentReconciles();
    await expectFulfilmentMatchesLedger();
  });

  it("fulfils the long line when the short one is locked first", async () => {
    // Ordering matters to the implementation — products are locked sorted by
    // id, and each line is settled against its own locked balance. This is the
    // mirror of the case above, with the short product first, and it proves a
    // shortfall early in the loop does not abort the lines after it.
    await signInWithRole("STAFF");
    const customer = await createCustomer();
    const a = await product("M-E", 5);
    const b = await product("M-F", 500);

    const order = await draftOrder(customer.id, [
      { productId: a.id, quantity: 10 },
      { productId: b.id, quantity: 10 },
    ]);

    await confirmOrder(order.id);

    expect(await stockOf(a.id)).toBe(0);
    expect(await stockOf(b.id)).toBe(490);
    expect(await outstandingOf(order.id)).toBe(5);

    await expectLotsReconcile();
    await expectFulfilmentMatchesLedger();
  });

  it("writes no movement for a line with nothing on hand, and fulfils the other", async () => {
    await signInWithRole("STAFF");
    const customer = await createCustomer();
    const a = await product("M-G", 100);
    const b = await product("M-H", 0);

    const order = await draftOrder(customer.id, [
      { productId: a.id, quantity: 10 },
      { productId: b.id, quantity: 10 },
    ]);

    await confirmOrder(order.id);

    expect(await stockOf(a.id)).toBe(90);
    expect(await stockOf(b.id)).toBe(0);

    // Exactly one movement: the empty line produced none at all.
    const ledger = await movementsFor(order.id);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.productId).toBe(a.id);

    await expectLotsReconcile();
    await expectFulfilmentReconciles();
    await expectFulfilmentMatchesLedger();
  });
});

// ---------------------------------------------------------------------------
// Tests 5 and 6 — cancellation and reversal
// ---------------------------------------------------------------------------

describe("cancelling a confirmed order", () => {
  it("restores exactly what was deducted", async () => {
    const user = await signInWithRole("STAFF");
    const customer = await createCustomer();
    const part = await product("C-1", 200);

    const order = await draftOrder(customer.id, [
      { productId: part.id, quantity: 50 },
    ]);

    await confirmOrder(order.id);
    expect(await stockOf(part.id)).toBe(150);

    await cancelOrder(order.id);
    expect(await stockOf(part.id)).toBe(200);

    const ledger = await movementsFor(order.id);
    expect(ledger).toHaveLength(2);

    const reversal = ledger.find((row) => row.type === "REVERSAL");
    expect(reversal).toMatchObject({
      productId: part.id,
      type: "REVERSAL",
      quantity: 50,
      previousStock: 150,
      newStock: 200,
      referenceType: "ORDER",
      referenceId: order.id,
      createdBy: user.id,
    });
    expect(reversal?.note).toContain("cancelled");
  });

  it("restores only once when cancelled twice", async () => {
    await signInWithRole("STAFF");
    const customer = await createCustomer();
    const part = await product("C-2", 200);

    const order = await draftOrder(customer.id, [
      { productId: part.id, quantity: 50 },
    ]);
    await confirmOrder(order.id);

    const first = await cancelOrder(order.id);
    const second = await cancelOrder(order.id);

    expect(first.alreadyInState).toBe(false);
    // Idempotent: the second call reports that there was nothing to do.
    expect(second.alreadyInState).toBe(true);
    expect(second.movements).toEqual([]);

    expect(await stockOf(part.id)).toBe(200);
    expect(
      (await movementsFor(order.id)).filter((row) => row.type === "REVERSAL"),
    ).toHaveLength(1);
  });

  it("restores nothing for an order that never deducted", async () => {
    await signInWithRole("STAFF");
    const customer = await createCustomer();
    const part = await product("C-3", 200);

    const order = await draftOrder(customer.id, [
      { productId: part.id, quantity: 50 },
    ]);

    // Cancelled straight from DRAFT — nothing ever left.
    await cancelOrder(order.id);

    expect(await stockOf(part.id)).toBe(200);
    expect(await movementsFor(order.id)).toHaveLength(0);
  });

  it("restores every line of a multi-product order", async () => {
    await signInWithRole("STAFF");
    const customer = await createCustomer();
    const a = await product("C-4", 200);
    const b = await product("C-5", 100);

    const order = await draftOrder(customer.id, [
      { productId: a.id, quantity: 150 },
      { productId: b.id, quantity: 80 },
    ]);

    await confirmOrder(order.id);
    await cancelOrder(order.id);

    expect(await stockOf(a.id)).toBe(200);
    expect(await stockOf(b.id)).toBe(100);
  });

  it("records a reason on the reversal when one is given", async () => {
    await signInWithRole("STAFF");
    const customer = await createCustomer();
    const part = await product("C-6", 20);

    const order = await draftOrder(customer.id, [
      { productId: part.id, quantity: 5 },
    ]);
    await confirmOrder(order.id);
    await cancelOrder(order.id, "Customer withdrew the request");

    const reversal = (await movementsFor(order.id)).find(
      (row) => row.type === "REVERSAL",
    );
    expect(reversal?.note).toContain("Customer withdrew the request");
  });
});

// ---------------------------------------------------------------------------
// Tests 11 and 12 — repeated and invalid transitions
// ---------------------------------------------------------------------------

describe("state transitions", () => {
  it("deducts only once when confirmed twice", async () => {
    await signInWithRole("STAFF");
    const customer = await createCustomer();
    const part = await product("S-1", 200);

    const order = await draftOrder(customer.id, [
      { productId: part.id, quantity: 30 },
    ]);

    await confirmOrder(order.id);
    await expect(confirmOrder(order.id)).rejects.toMatchObject({
      code: "CONFLICT",
    });

    expect(await stockOf(part.id)).toBe(170);
    expect(await movementsFor(order.id)).toHaveLength(1);
  });

  it("refuses to confirm a cancelled order", async () => {
    await signInWithRole("STAFF");
    const customer = await createCustomer();
    const part = await product("S-2", 100);

    const order = await draftOrder(customer.id, [
      { productId: part.id, quantity: 10 },
    ]);
    await cancelOrder(order.id);

    await expect(confirmOrder(order.id)).rejects.toMatchObject({
      code: "CONFLICT",
    });

    expect(await stockOf(part.id)).toBe(100);
    expect(await prisma.stockTransaction.count()).toBe(0);
  });

  it("completes a confirmed order without moving stock again", async () => {
    await signInWithRole("STAFF");
    const customer = await createCustomer();
    const part = await product("S-3", 200);

    const order = await draftOrder(customer.id, [
      { productId: part.id, quantity: 60 },
    ]);
    await confirmOrder(order.id);
    expect(await stockOf(part.id)).toBe(140);

    await completeOrder(order.id);

    // The units left on confirmation. Completing must not take them twice.
    expect(await stockOf(part.id)).toBe(140);
    expect(await movementsFor(order.id)).toHaveLength(1);
  });

  it("refuses to cancel a completed order, and explains why", async () => {
    await signInWithRole("STAFF");
    const customer = await createCustomer();
    const part = await product("S-4", 200);

    const order = await draftOrder(customer.id, [
      { productId: part.id, quantity: 60 },
    ]);
    await confirmOrder(order.id);
    await completeOrder(order.id);

    await expect(cancelOrder(order.id)).rejects.toMatchObject({
      code: "CONFLICT",
    });

    // The goods have shipped: putting them back would invent inventory.
    expect(await stockOf(part.id)).toBe(140);
  });

  it("moves a draft to pending and back without touching stock", async () => {
    await signInWithRole("STAFF");
    const customer = await createCustomer();
    const part = await product("S-5", 100);

    const order = await draftOrder(customer.id, [
      { productId: part.id, quantity: 10 },
    ]);

    await setOrderStatus(order.id, "PENDING");
    await setOrderStatus(order.id, "DRAFT");

    expect(await stockOf(part.id)).toBe(100);
    expect(await prisma.stockTransaction.count()).toBe(0);
  });

  it("refuses an arbitrary status jump from the client", async () => {
    await signInWithRole("STAFF");
    const customer = await createCustomer();
    const part = await product("S-6", 100);

    const order = await draftOrder(customer.id, [
      { productId: part.id, quantity: 10 },
    ]);

    // Confirm, complete and cancel each have their own guarded function; the
    // generic setter refuses to be a second route to them.
    await expect(setOrderStatus(order.id, "CONFIRMED")).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(setOrderStatus(order.id, "CANCELLED")).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });

    expect(await prisma.stockTransaction.count()).toBe(0);
  });

  it("refuses to edit an order that has been confirmed", async () => {
    await signInWithRole("STAFF");
    const customer = await createCustomer();
    const part = await product("S-7", 100);

    const order = await draftOrder(customer.id, [
      { productId: part.id, quantity: 10 },
    ]);
    await confirmOrder(order.id);

    await expect(
      updateOrder(order.id, {
        customerId: customer.id,
        items: await quoted([{ productId: part.id, quantity: 99 }]),
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect(await stockOf(part.id)).toBe(90);
  });
});

// ---------------------------------------------------------------------------
// Test 9 — concurrency
// ---------------------------------------------------------------------------

describe("concurrency", () => {
  it("lets two competing orders share the last units without overdrawing", async () => {
    await signInWithRole("STAFF");
    const customer = await createCustomer();
    const part = await product("X-1", 100);

    const a = await draftOrder(customer.id, [
      { productId: part.id, quantity: 70 },
    ]);
    const b = await draftOrder(customer.id, [
      { productId: part.id, quantity: 50 },
    ]);

    /*
     * Both at once. Without the row lock these both read 100 and both write,
     * leaving −20 on the shelf.
     *
     * The assertion changed shape when confirmation stopped refusing a
     * shortfall: previously one order won and the other was rejected, and now
     * both succeed — the first takes what it asked for, the second takes
     * whatever the first left and owes the difference. The guarantee the lock
     * provides is unchanged and is what this still proves: the two are
     * serialised, so together they cannot remove more than existed.
     */
    const results = await Promise.allSettled([
      confirmOrder(a.id),
      confirmOrder(b.id),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);

    const remaining = await stockOf(part.id);
    expect(remaining).toBe(0);

    const deducted = (await linesOf(a.id))[0]!.fulfilledQuantity +
      (await linesOf(b.id))[0]!.fulfilledQuantity;
    const outstanding =
      (await outstandingOf(a.id)) + (await outstandingOf(b.id));

    // 100 units existed, 120 were sold: all 100 left, 20 are owed.
    expect(deducted).toBe(100);
    expect(outstanding).toBe(20);

    // Whichever went first got its full quantity.
    const fulfilments = [
      (await linesOf(a.id))[0]!.fulfilledQuantity,
      (await linesOf(b.id))[0]!.fulfilledQuantity,
    ].sort((x, y) => x - y);
    expect([
      [30, 70],
      [50, 50],
    ]).toContainEqual(fulfilments);

    await expectLotsReconcile();
    await expectFulfilmentReconciles();
    await expectFulfilmentMatchesLedger();

    /*
     * Two movements now, not one, and their balances chain: the second reads
     * the balance the first wrote. That chaining is the observable proof the
     * lock held — interleaved reads would produce two rows both starting from
     * 100.
     */
    const ledger = await prisma.stockTransaction.findMany({
      orderBy: { createdAt: "asc" },
    });
    expect(ledger).toHaveLength(2);
    expect(ledger[0]!.previousStock).toBe(100);
    expect(ledger[1]!.previousStock).toBe(ledger[0]!.newStock);
    expect(ledger[1]!.newStock).toBe(0);
  });

  it("keeps the ledger contiguous when several orders overlap", async () => {
    await signInWithRole("STAFF");
    const customer = await createCustomer();
    const part = await product("X-2", 100);

    const orders = await Promise.all(
      Array.from({ length: 5 }, () =>
        draftOrder(customer.id, [{ productId: part.id, quantity: 10 }]),
      ),
    );

    await Promise.all(orders.map((order) => confirmOrder(order.id)));

    expect(await stockOf(part.id)).toBe(50);

    const ledger = await prisma.stockTransaction.findMany({
      orderBy: { createdAt: "asc" },
    });

    let balance = 100;
    for (const row of ledger) {
      expect(row.previousStock).toBe(balance);
      balance = row.newStock;
    }
    expect(balance).toBe(50);
  });

  it("cannot be raced into a double deduction of one order", async () => {
    await signInWithRole("STAFF");
    const customer = await createCustomer();
    const part = await product("X-3", 100);

    const order = await draftOrder(customer.id, [
      { productId: part.id, quantity: 40 },
    ]);

    // The same order confirmed twice, simultaneously. The order row lock is
    // what makes the second wait and then see CONFIRMED.
    const results = await Promise.allSettled([
      confirmOrder(order.id),
      confirmOrder(order.id),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await stockOf(part.id)).toBe(60);
    expect(await movementsFor(order.id)).toHaveLength(1);
  });

  it("cannot be raced into a double restore", async () => {
    await signInWithRole("STAFF");
    const customer = await createCustomer();
    const part = await product("X-4", 100);

    const order = await draftOrder(customer.id, [
      { productId: part.id, quantity: 40 },
    ]);
    await confirmOrder(order.id);

    await Promise.allSettled([cancelOrder(order.id), cancelOrder(order.id)]);

    expect(await stockOf(part.id)).toBe(100);
    expect(
      (await movementsFor(order.id)).filter((row) => row.type === "REVERSAL"),
    ).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Test 10 — attribution and tampering
// ---------------------------------------------------------------------------

describe("attribution", () => {
  it("takes createdBy from the session, ignoring what the client sent", async () => {
    const actor = await signInWithRole("STAFF");
    const somebodyElse = await prisma.user.create({
      data: {
        clerkId: "user_victim",
        name: "Victim",
        email: "victim@example.com",
        role: "ADMIN",
      },
    });

    const customer = await createCustomer();
    const part = await product("T-1", 100);

    // What a tampered request looks like. `createdBy` is not in the schema, so
    // this is what it takes to express it at all — and it reaches nothing.
    const order = await createOrder({
      customerId: customer.id,
      items: await quoted([{ productId: part.id, quantity: 10 }]),
      createdBy: somebodyElse.id,
      userId: somebodyElse.id,
    });

    const row = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
    });
    expect(row.createdBy).toBe(actor.id);
    expect(row.createdBy).not.toBe(somebodyElse.id);

    await confirmOrder(order.id);

    const movement = (await movementsFor(order.id))[0]!;
    expect(movement.createdBy).toBe(actor.id);
    expect(movement.createdBy).not.toBe(somebodyElse.id);
    // The local database id, not the Auth id.
    expect(movement.createdBy).not.toBe(actor.clerkId);
  });

  it("honours the quoted price but computes every total from it", async () => {
    /*
     * This test used to assert the opposite of its first half: that a price
     * from the client was ignored and the catalogue's read instead, because
     * "the client cannot name its own price" was a security property.
     *
     * Per-customer quoting inverts that. The price is now a commercial input —
     * it exists nowhere but the submission — so it is honoured. What is *not*
     * honoured is anything derived from it: the line total, the subtotal and
     * the grand total are still computed on the server, so a client that sends
     * a believable price and an invented total gets the price and none of the
     * total. That half of the protection is what this now pins.
     */
    await signInWithRole("STAFF");
    const customer = await createCustomer();
    const part = await product("T-2", 100, "250.00");

    const order = await createOrder({
      customerId: customer.id,
      // A real quote, and totals of the client's choosing.
      items: [
        { productId: part.id, quantity: 2, unitPrice: "180.00", total: "0.02" },
      ],
      subtotal: "0.02",
      total: "0.02",
    });

    const row = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      include: { items: true },
    });

    expect(row.items[0]!.unitPrice.toString()).toBe("180");
    expect(row.items[0]!.total.toString()).toBe("360");
    expect(row.subtotal.toString()).toBe("360");
    expect(row.total.toString()).toBe("360");
  });

  it("refuses an unauthenticated order", async () => {
    const customer = await createCustomer();
    const part = await product("T-3", 100);

    await expect(
      createOrder({
        customerId: customer.id,
        items: await quoted([{ productId: part.id, quantity: 1 }]),
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    expect(await prisma.order.count()).toBe(0);
  });

  it("refuses an unauthenticated confirmation", async () => {
    await signInWithRole("STAFF");
    const customer = await createCustomer();
    const part = await product("T-4", 100);
    const order = await draftOrder(customer.id, [
      { productId: part.id, quantity: 10 },
    ]);

    signOutSupabase();

    await expect(confirmOrder(order.id)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(await stockOf(part.id)).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// Test 13 — totals, and the absence of tax and discount
// ---------------------------------------------------------------------------

describe("order totals", () => {
  it("computes grand total as the subtotal, with nothing in between", async () => {
    await signInWithRole("STAFF");
    const customer = await createCustomer();
    const part = await product("V-1", 100, "1000.00");

    const order = await createOrder({
      customerId: customer.id,
      items: await quoted([{ productId: part.id, quantity: 10 }]),
    });

    const row = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
    });

    expect(Number(row.subtotal)).toBe(10_000);
    expect(Number(row.total)).toBe(10_000);

    // No tax term and no discount term, and no column that could carry either.
    expect(Object.keys(row)).not.toContain("tax");
    expect(Object.keys(row)).not.toContain("discount");
  });

  it("sums several lines correctly", async () => {
    await signInWithRole("STAFF");
    const customer = await createCustomer();
    const a = await product("V-2", 100, "19.99");
    const b = await product("V-3", 100, "5.05");

    const order = await createOrder({
      customerId: customer.id,
      items: await quoted([
        { productId: a.id, quantity: 3 },
        { productId: b.id, quantity: 7 },
      ]),
    });

    const row = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
    });

    // 59.97 + 35.35 — computed in integer cents, so nothing drifts.
    expect(row.subtotal.toString()).toBe("95.32");
    expect(row.total.toString()).toBe("95.32");
  });

  /*
   * Two tests stood here refusing a discount larger than the subtotal and a
   * negative one. Both went with the feature (§20): there is no field to
   * refuse, and a test asserting that an absent input is rejected would pass
   * for the wrong reason forever.
   */
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe("validation", () => {
  it("refuses an order with no items", async () => {
    await signInWithRole("STAFF");
    const customer = await createCustomer();

    await expect(
      createOrder({ customerId: customer.id, items: await quoted([]) }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("refuses duplicate product lines", async () => {
    await signInWithRole("STAFF");
    const customer = await createCustomer();
    const part = await product("W-1", 100);

    await expect(
      createOrder({
        customerId: customer.id,
        items: await quoted([
          { productId: part.id, quantity: 1 },
          { productId: part.id, quantity: 2 },
        ]),
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(await prisma.order.count()).toBe(0);
  });

  it("refuses a zero or negative quantity", async () => {
    await signInWithRole("STAFF");
    const customer = await createCustomer();
    const part = await product("W-2", 100);

    for (const quantity of [0, -1, 1.5]) {
      await expect(
        createOrder({
          customerId: customer.id,
          items: await quoted([{ productId: part.id, quantity }]),
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
  });

  it("refuses a customer that does not exist", async () => {
    await signInWithRole("STAFF");
    const part = await product("W-3", 100);

    await expect(
      createOrder({
        customerId: "no-such-customer",
        items: await quoted([{ productId: part.id, quantity: 1 }]),
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      details: { field: "customerId" },
    });
  });

  it("refuses a product that is not active", async () => {
    await signInWithRole("STAFF");
    const customer = await createCustomer();
    const retired = await seedProduct({
      sku: "W-4",
      name: "Retired Part",
      status: "DISCONTINUED",
      stockQuantity: 100,
    });

    await expect(
      createOrder({
        customerId: customer.id,
        items: await quoted([{ productId: retired.id, quantity: 1 }]),
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("refuses a product that does not exist", async () => {
    await signInWithRole("STAFF");
    const customer = await createCustomer();

    await expect(
      createOrder({
        customerId: customer.id,
        items: await quoted([{ productId: "no-such-product", quantity: 1 }]),
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

// ---------------------------------------------------------------------------
// Test 14 — certificates, from the batches the order actually drew from
// ---------------------------------------------------------------------------

describe("certificate display", () => {
  /** The batch a seeded product holds — what paperwork attaches to. */
  async function lotOf(productId: string): Promise<string> {
    const lot = await prisma.stockLot.findFirstOrThrow({
      where: { productId },
      select: { id: true },
    });
    return lot.id;
  }

  it("shows the paperwork of the batch the order consumed, without copying it", async () => {
    await signInWithRole("ADMIN");
    const customer = await createCustomer();
    const part = await seedProduct({
      sku: "ABC-123",
      name: "Certified Actuator",
      stockQuantity: 100,
    });

    await attachCertificate({
      stockLotId: await lotOf(part.id),
      metadata: {
        certificateType: "FAA 8130-3",
        certificateNumber: "8130-9911",
        issueDate: "2026-01-01",
        expiryDate: "2030-01-01",
      },
      file: new File(
        [new Uint8Array(Buffer.from("%PDF-1.7\ncert\n"))],
        "cert.pdf",
        { type: "application/pdf" },
      ),
    });

    const order = await draftOrder(customer.id, [
      { productId: part.id, quantity: 5 },
    ]);

    // A draft has drawn nothing, so there is no batch to report yet.
    const draft = await getOrderDetail(order.id);
    if (!draft.ok || !draft.data) throw new Error("expected an order");
    expect(draft.data.lines[0]!.lotCertificates).toHaveLength(0);

    await confirmOrder(order.id);

    const result = await getOrderDetail(order.id);
    if (!result.ok || !result.data) throw new Error("expected an order");

    const line = result.data.lines[0]!;
    expect(line.sku).toBe("ABC-123");
    expect(line.quantity).toBe(5);
    expect(line.lotCertificates).toHaveLength(1);
    expect(line.lotCertificates[0]!.quantity).toBe(5);
    expect(line.lotCertificates[0]!.certificateType).toBe("FAA 8130-3");
    expect(line.lotCertificates[0]!.certificateNumber).toBe("8130-9911");
    expect(line.lotCertificates[0]!.certificateStatus).toBe("VALID");

    // Referenced, not duplicated: still exactly one certificate row, still
    // belonging to the batch it was filed against.
    const certificates = await prisma.certificate.findMany();
    expect(certificates).toHaveLength(1);
    expect(certificates[0]!.productId).toBe(part.id);
    expect(certificates[0]!.stockLotId).toBe(await lotOf(part.id));
  });

  it("reports MISSING for a consumed batch with no certificate", async () => {
    await signInWithRole("STAFF");
    const customer = await createCustomer();
    const part = await product("NOCERT-1", 50);

    const order = await draftOrder(customer.id, [
      { productId: part.id, quantity: 1 },
    ]);
    await confirmOrder(order.id);

    const result = await getOrderDetail(order.id);
    if (!result.ok || !result.data) throw new Error("expected an order");

    const line = result.data.lines[0]!;
    expect(line.lotCertificates).toHaveLength(1);
    expect(line.lotCertificates[0]!.certificateStatus).toBe("MISSING");
    expect(line.lotCertificates[0]!.certificateType).toBeNull();
  });

  it("does not touch certificates when an order is confirmed", async () => {
    await signInWithRole("ADMIN");
    const customer = await createCustomer();
    const part = await seedProduct({
      sku: "CERTSAFE-1",
      stockQuantity: 100,
    });

    await attachCertificate({
      stockLotId: await lotOf(part.id),
      metadata: {
        certificateType: "EASA Form 1",
        certificateNumber: "E-1",
        issueDate: "2026-01-01",
        expiryDate: "",
      },
      file: new File(
        [new Uint8Array(Buffer.from("%PDF-1.7\n"))],
        "c.pdf",
        { type: "application/pdf" },
      ),
    });

    const before = await prisma.certificate.findFirstOrThrow();

    const order = await draftOrder(customer.id, [
      { productId: part.id, quantity: 10 },
    ]);
    await confirmOrder(order.id);
    await cancelOrder(order.id);

    const after = await prisma.certificate.findFirstOrThrow();
    expect(after).toEqual(before);
    expect(await prisma.certificate.count()).toBe(1);
  });

  /** A second batch of an existing product, delivered by a supplier. */
  async function secondLot(productId: string, quantity: number) {
    const supplier = await createSupplier(`Source ${productId.slice(-6)}`);
    const purchase = await createPurchase({
      supplierId: supplier.id,
      items: [{ productId, quantity, unitCost: "10.00" }],
    });
    await receivePurchase(purchase.id);

    const lot = await prisma.stockLot.findFirstOrThrow({
      where: { sourceType: "PURCHASE", sourceId: purchase.id },
      select: { id: true },
    });
    return lot.id;
  }

  /** Files a document against one batch. */
  async function attachTo(
    stockLotId: string,
    metadata: {
      certificateType: string;
      certificateNumber: string;
      issueDate: string;
      expiryDate: string;
    },
  ) {
    await attachCertificate({
      stockLotId,
      metadata,
      file: new File(
        [new Uint8Array(Buffer.from("%PDF-1.7\ncert\n"))],
        "cert.pdf",
        { type: "application/pdf" },
      ),
    });
  }

  it("lists every batch an order drew from, not one of them", async () => {
    /*
     * The case the whole model exists for. An order that crosses a batch
     * boundary shipped units under two different documents in two different
     * states, and answering "what covered this line" with either one alone
     * would be presenting a guess as the answer.
     */
    await signInWithRole("ADMIN");
    const customer = await createCustomer();
    const part = await seedProduct({
      sku: "MULTI-LOT",
      name: "Cross-Batch Actuator",
      stockQuantity: 4,
      sellingPrice: "10.00",
    });

    const openingLot = await prisma.stockLot
      .findFirstOrThrow({ where: { productId: part.id }, select: { id: true } })
      .then((lot) => lot.id);
    const deliveredLot = await secondLot(part.id, 10);

    // Deliberately different documents in deliberately different states.
    await attachTo(openingLot, {
      certificateType: "FAA 8130-3",
      certificateNumber: "LOT-A-8130",
      issueDate: "2026-01-01",
      expiryDate: "",
    });
    await attachTo(deliveredLot, {
      certificateType: "EASA Form 1",
      certificateNumber: "LOT-B-E1",
      issueDate: "2020-01-01",
      expiryDate: "2020-06-01",
    });

    // 9 units against 4 + 10: FIFO empties the older batch and dips into the
    // newer one, so the line spans both.
    const order = await draftOrder(customer.id, [
      { productId: part.id, quantity: 9 },
    ]);
    await confirmOrder(order.id);

    const result = await getOrderDetail(order.id);
    if (!result.ok || !result.data) throw new Error("expected an order");

    const line = result.data.lines[0]!;
    expect(line.lotCertificates).toHaveLength(2);

    const byLot = new Map(line.lotCertificates.map((lot) => [lot.lotId, lot]));
    expect(byLot.size).toBe(2);

    // Each batch reports the units *it* gave up, and they add to the line.
    expect(byLot.get(openingLot)!.quantity).toBe(4);
    expect(byLot.get(deliveredLot)!.quantity).toBe(5);
    expect(
      line.lotCertificates.reduce((total, lot) => total + lot.quantity, 0),
    ).toBe(9);

    // Distinguishable: different documents, different states, and only the
    // delivered batch has a purchase behind it.
    expect(byLot.get(openingLot)!.certificateType).toBe("FAA 8130-3");
    expect(byLot.get(openingLot)!.certificateNumber).toBe("LOT-A-8130");
    expect(byLot.get(openingLot)!.certificateStatus).toBe("VALID");
    expect(byLot.get(openingLot)!.purchaseNumber).toBeNull();

    expect(byLot.get(deliveredLot)!.certificateType).toBe("EASA Form 1");
    expect(byLot.get(deliveredLot)!.certificateNumber).toBe("LOT-B-E1");
    expect(byLot.get(deliveredLot)!.certificateStatus).toBe("EXPIRED");
    expect(byLot.get(deliveredLot)!.purchaseNumber).not.toBeNull();

    // Nothing was collapsed to a single representative document.
    expect(
      new Set(line.lotCertificates.map((lot) => lot.certificateNumber)),
    ).toEqual(new Set(["LOT-A-8130", "LOT-B-E1"]));
  });

  it("stops reporting a batch once a cancellation nets its draws to zero", async () => {
    /*
     * Consumption quantities are signed, so a cancellation does not delete the
     * draw — it writes the opposite of it. The line must read the sum, not the
     * presence of rows, or a cancelled order would go on claiming it consumed
     * units it gave back.
     */
    await signInWithRole("ADMIN");
    const customer = await createCustomer();
    const part = await seedProduct({
      sku: "CANCEL-NETS-TO-ZERO",
      stockQuantity: 20,
      sellingPrice: "10.00",
    });

    const lot = await prisma.stockLot
      .findFirstOrThrow({ where: { productId: part.id }, select: { id: true } })
      .then((row) => row.id);

    await attachTo(lot, {
      certificateType: "Certificate of Conformity",
      certificateNumber: "CANCELLED-COC",
      issueDate: "2026-01-01",
      expiryDate: "",
    });

    const order = await draftOrder(customer.id, [
      { productId: part.id, quantity: 6 },
    ]);
    await confirmOrder(order.id);

    // While it holds stock, the batch is reported with the units it gave up.
    const confirmed = await getOrderDetail(order.id);
    if (!confirmed.ok || !confirmed.data) throw new Error("expected an order");
    expect(confirmed.data.lines[0]!.lotCertificates).toHaveLength(1);
    expect(confirmed.data.lines[0]!.lotCertificates[0]!.quantity).toBe(6);

    await cancelOrder(order.id);

    const cancelled = await getOrderDetail(order.id);
    if (!cancelled.ok || !cancelled.data) throw new Error("expected an order");
    expect(cancelled.data.lines[0]!.lotCertificates).toHaveLength(0);

    // Both rows survive in the ledger — the draw and its reversal. They net.
    const consumptions = await prisma.stockLotConsumption.findMany({
      where: { lotId: lot },
      select: { quantity: true },
    });
    expect(consumptions).toHaveLength(2);
    expect(consumptions.reduce((total, row) => total + row.quantity, 0)).toBe(0);

    // The paperwork is untouched. It is simply not covering anything shipped.
    expect(
      await prisma.certificate.count({
        where: { stockLotId: lot, supersededAt: null },
      }),
    ).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The inventory impact panel and the list
// ---------------------------------------------------------------------------

describe("inventory impact", () => {
  it("reads the deduction and the restore from the ledger", async () => {
    await signInWithRole("STAFF");
    const customer = await createCustomer();
    const part = await seedProduct({
      sku: "IMP-1",
      name: "Test Aviation Part",
      stockQuantity: 200,
    });

    const order = await draftOrder(customer.id, [
      { productId: part.id, quantity: 150 },
    ]);

    await confirmOrder(order.id);

    let result = await getOrderDetail(order.id);
    if (!result.ok || !result.data) throw new Error("expected an order");

    expect(result.data.impact).toHaveLength(1);
    expect(result.data.impact[0]).toMatchObject({
      productName: "Test Aviation Part",
      deducted: 150,
      deductedFrom: 200,
      deductedTo: 50,
      restored: 0,
    });

    await cancelOrder(order.id);

    result = await getOrderDetail(order.id);
    if (!result.ok || !result.data) throw new Error("expected an order");

    expect(result.data.impact[0]).toMatchObject({
      deducted: 150,
      restored: 150,
      restoredFrom: 50,
      restoredTo: 200,
    });
  });
});

describe("the orders list", () => {
  it("filters by status and by customer", async () => {
    await signInWithRole("STAFF");
    const one = await createCustomer("Alpha Airlines");
    const two = await createCustomer("Bravo Charter");
    const part = await product("L-1", 500);

    const confirmed = await draftOrder(one.id, [
      { productId: part.id, quantity: 1 },
    ]);
    await confirmOrder(confirmed.id);
    await draftOrder(two.id, [{ productId: part.id, quantity: 2 }]);

    const byStatus = await listOrders({
      ...DEFAULT_ORDER_PARAMS,
      status: "CONFIRMED",
    });
    if (!byStatus.ok) throw new Error("expected the list to load");
    expect(byStatus.data.items.map((row) => row.id)).toEqual([confirmed.id]);

    const byCustomer = await listOrders({
      ...DEFAULT_ORDER_PARAMS,
      customerId: two.id,
    });
    if (!byCustomer.ok) throw new Error("expected the list to load");
    expect(byCustomer.data.items).toHaveLength(1);
    expect(byCustomer.data.items[0]!.customerName).toBe("Bravo Charter");
  });

  it("searches by order number and by customer name", async () => {
    await signInWithRole("STAFF");
    const customer = await createCustomer("Delta Freight");
    const part = await product("L-2", 100);
    const order = await draftOrder(customer.id, [
      { productId: part.id, quantity: 1 },
    ]);

    const byNumber = await listOrders({
      ...DEFAULT_ORDER_PARAMS,
      search: order.orderNumber,
    });
    if (!byNumber.ok) throw new Error("expected the list to load");
    expect(byNumber.data.items).toHaveLength(1);

    const byName = await listOrders({
      ...DEFAULT_ORDER_PARAMS,
      search: "delta",
    });
    if (!byName.ok) throw new Error("expected the list to load");
    expect(byName.data.items).toHaveLength(1);
  });

  it("reports who raised each order", async () => {
    const user = await signInWithRole("STAFF");
    const customer = await createCustomer();
    const part = await product("L-3", 100);
    await draftOrder(customer.id, [{ productId: part.id, quantity: 1 }]);

    const result = await listOrders(DEFAULT_ORDER_PARAMS);
    if (!result.ok) throw new Error("expected the list to load");

    expect(result.data.items[0]!.createdByName).toBe(user.name);
    expect(result.data.items[0]!.unitCount).toBe(1);
    expect(result.data.items[0]!.itemCount).toBe(1);
  });

  it("allocates sequential order numbers", async () => {
    await signInWithRole("STAFF");
    const customer = await createCustomer();
    const part = await product("L-4", 100);

    const first = await draftOrder(customer.id, [
      { productId: part.id, quantity: 1 },
    ]);
    const second = await draftOrder(customer.id, [
      { productId: part.id, quantity: 2 },
    ]);

    expect(first.orderNumber).not.toBe(second.orderNumber);
    expect(second.orderNumber > first.orderNumber).toBe(true);
  });

  it("allocates unique numbers when orders are raised together", async () => {
    await signInWithRole("STAFF");
    const customer = await createCustomer();
    const part = await product("L-5", 500);

    const orders = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        draftOrder(customer.id, [{ productId: part.id, quantity: index + 1 }]),
      ),
    );

    const numbers = new Set(orders.map((order) => order.orderNumber));
    expect(numbers.size).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Editing an order
// ---------------------------------------------------------------------------

describe("editing an order", () => {
  it("rewrites the lines of a DRAFT order", async () => {
    await signInWithRole("STAFF");
    const customer = await createCustomer();
    const a = await product("E-1", 100, "10.00");
    const b = await product("E-2", 100, "25.00");

    const order = await draftOrder(customer.id, [
      { productId: a.id, quantity: 2 },
    ]);

    await updateOrder(order.id, {
      customerId: customer.id,
      items: await quoted([
        // Quantity changed on the line that stays…
        { productId: a.id, quantity: 5 },
        // …and a product added.
        { productId: b.id, quantity: 3 },
      ]),
    });

    const row = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      include: { items: true },
    });

    expect(row.items).toHaveLength(2);
    expect(
      Object.fromEntries(row.items.map((i) => [i.productId, i.quantity])),
    ).toEqual({ [a.id]: 5, [b.id]: 3 });

    // 5 × 10.00 + 3 × 25.00
    expect(row.subtotal.toString()).toBe("125");
    expect(row.total.toString()).toBe("125");
    expect(row.status).toBe("DRAFT");
  });

  it("removes a product when it is left off", async () => {
    await signInWithRole("STAFF");
    const customer = await createCustomer();
    const a = await product("E-3", 100, "10.00");
    const b = await product("E-4", 100, "10.00");

    const order = await draftOrder(customer.id, [
      { productId: a.id, quantity: 1 },
      { productId: b.id, quantity: 1 },
    ]);

    await updateOrder(order.id, {
      customerId: customer.id,
      items: await quoted([{ productId: a.id, quantity: 1 }]),
    });

    const row = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      include: { items: true },
    });

    expect(row.items).toHaveLength(1);
    expect(row.items[0]!.productId).toBe(a.id);
    expect(row.subtotal.toString()).toBe("10");
  });

  it("edits a PENDING order", async () => {
    await signInWithRole("STAFF");
    const customer = await createCustomer();
    const part = await product("E-5", 100, "10.00");

    const order = await draftOrder(customer.id, [
      { productId: part.id, quantity: 1 },
    ]);
    await setOrderStatus(order.id, "PENDING");

    await updateOrder(order.id, {
      customerId: customer.id,
      items: await quoted([{ productId: part.id, quantity: 4 }]),
    });

    const row = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      include: { items: true },
    });

    expect(row.status).toBe("PENDING");
    expect(row.items[0]!.quantity).toBe(4);
    expect(row.subtotal.toString()).toBe("40");
  });

  it("changes the customer and the lines", async () => {
    await signInWithRole("STAFF");
    const first = await createCustomer("First Customer");
    const second = await createCustomer("Second Customer");
    const part = await product("E-6", 100, "100.00");

    const order = await draftOrder(first.id, [
      { productId: part.id, quantity: 10 },
    ]);

    await updateOrder(order.id, {
      customerId: second.id,
      items: await quoted([{ productId: part.id, quantity: 10 }]),
    });

    const row = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
    });

    expect(row.customerId).toBe(second.id);
    expect(row.subtotal.toString()).toBe("1000");
    // The subtotal, with nothing at all in between.
    expect(row.total.toString()).toBe("1000");
    expect(Object.keys(row)).not.toContain("tax");
    expect(Object.keys(row)).not.toContain("discount");
  });

  it("refuses a customer that does not exist", async () => {
    await signInWithRole("STAFF");
    const customer = await createCustomer();
    const part = await product("E-7", 100);
    const order = await draftOrder(customer.id, [
      { productId: part.id, quantity: 1 },
    ]);

    await expect(
      updateOrder(order.id, {
        customerId: "no-such-customer",
        items: await quoted([{ productId: part.id, quantity: 1 }]),
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      details: { field: "customerId" },
    });

    const row = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
    });
    expect(row.customerId).toBe(customer.id);
  });
});

describe("editing recalculates money on the server", () => {
  it("recomputes the totals from the quote, ignoring the ones sent", async () => {
    /*
     * The other half of the split described above, on the edit path. This test
     * used to move the catalogue price to 30 and assert the line followed —
     * which was the re-pricing defect written down as a requirement. What
     * survives is the part that is still true: derived money is server money.
     */
    await signInWithRole("STAFF");
    const customer = await createCustomer();
    const part = await product("R-1", 100, "10.00");

    const order = await draftOrder(customer.id, [
      { productId: part.id, quantity: 2 },
    ]);

    await updateOrder(order.id, {
      customerId: customer.id,
      items: [
        { productId: part.id, quantity: 2, unitPrice: "10.00", total: "0.02" },
      ],
      subtotal: "0.02",
      total: "0.02",
    });

    const row = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      include: { items: true },
    });

    expect(row.items[0]!.unitPrice.toString()).toBe("10");
    expect(row.items[0]!.total.toString()).toBe("20");
    expect(row.subtotal.toString()).toBe("20");
    expect(row.total.toString()).toBe("20");
  });

  it("ignores a createdBy the client tried to send", async () => {
    const actor = await signInWithRole("STAFF");
    const somebodyElse = await prisma.user.create({
      data: {
        clerkId: "user_edit_victim",
        name: "Victim",
        email: "editvictim@example.com",
        role: "ADMIN",
      },
    });
    const customer = await createCustomer();
    const part = await product("R-2", 100);

    const order = await draftOrder(customer.id, [
      { productId: part.id, quantity: 1 },
    ]);

    await updateOrder(order.id, {
      customerId: customer.id,
      items: await quoted([{ productId: part.id, quantity: 2 }]),
      createdBy: somebodyElse.id,
    });

    const row = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
    });

    // Authorship belongs to whoever raised it, and is not an editable field.
    expect(row.createdBy).toBe(actor.id);
    expect(row.createdBy).not.toBe(somebodyElse.id);
  });
});

describe("editing never touches inventory", () => {
  it("leaves stock and the ledger alone", async () => {
    await signInWithRole("STAFF");
    const customer = await createCustomer();
    const a = await product("N-1", 200);
    const b = await product("N-2", 200);

    const order = await draftOrder(customer.id, [
      { productId: a.id, quantity: 10 },
    ]);

    await updateOrder(order.id, {
      customerId: customer.id,
      items: await quoted([
        { productId: a.id, quantity: 150 },
        { productId: b.id, quantity: 75 },
      ]),
    });

    // Nothing is committed until the order is confirmed, so the quantities on
    // the lines are just numbers on a document.
    expect(await stockOf(a.id)).toBe(200);
    expect(await stockOf(b.id)).toBe(200);
    expect(await prisma.stockTransaction.count()).toBe(0);
  });

  it("lets a draft ask for more than exists, and confirms it as an obligation", async () => {
    await signInWithRole("STAFF");
    const customer = await createCustomer();
    const part = await product("N-3", 5);

    const order = await draftOrder(customer.id, [
      { productId: part.id, quantity: 1 },
    ]);

    // A draft may plan for stock that has not arrived; editing checks no
    // balances because it commits nothing.
    await updateOrder(order.id, {
      customerId: customer.id,
      items: await quoted([{ productId: part.id, quantity: 500 }]),
    });

    expect(await stockOf(part.id)).toBe(5);
    expect(await prisma.stockTransaction.count()).toBe(0);

    /*
     * Confirmation is where stock is consulted, and it now settles rather than
     * refuses: the 5 on the shelf leave, and 495 units are owed. The draft
     * planning for stock that has not arrived was always legitimate; what has
     * changed is that committing to it is legitimate too.
     */
    await confirmOrder(order.id);

    expect(await stockOf(part.id)).toBe(0);
    expect(await outstandingOf(order.id)).toBe(495);

    await expectFulfilmentReconciles();
    await expectFulfilmentMatchesLedger();
  });
});

describe("orders that cannot be edited", () => {
  async function orderInState(
    sku: string,
    state: "CONFIRMED" | "COMPLETED" | "CANCELLED",
  ) {
    const customer = await createCustomer();
    const part = await product(sku, 200, "10.00");
    const order = await draftOrder(customer.id, [
      { productId: part.id, quantity: 10 },
    ]);

    if (state === "CANCELLED") {
      await cancelOrder(order.id);
    } else {
      await confirmOrder(order.id);
      if (state === "COMPLETED") await completeOrder(order.id);
    }

    return { order, part, customer };
  }

  for (const state of ["CONFIRMED", "COMPLETED", "CANCELLED"] as const) {
    it(`refuses to edit a ${state} order`, async () => {
      await signInWithRole("STAFF");
      const { order, part, customer } = await orderInState(`X-${state}`, state);

      const stockBefore = await stockOf(part.id);
      const ledgerBefore = await prisma.stockTransaction.count();

      await expect(
        updateOrder(order.id, {
          customerId: customer.id,
          items: await quoted([{ productId: part.id, quantity: 999 }]),
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });

      // The lines are untouched…
      const row = await prisma.order.findUniqueOrThrow({
        where: { id: order.id },
        include: { items: true },
      });
      expect(row.items[0]!.quantity).toBe(10);
      expect(row.subtotal.toString()).toBe("100");

      // …and so is inventory.
      expect(await stockOf(part.id)).toBe(stockBefore);
      expect(await prisma.stockTransaction.count()).toBe(ledgerBefore);
    });
  }

  it("refuses an unauthenticated edit", async () => {
    await signInWithRole("STAFF");
    const customer = await createCustomer();
    const part = await product("X-ANON", 100);
    const order = await draftOrder(customer.id, [
      { productId: part.id, quantity: 1 },
    ]);

    signOutSupabase();

    await expect(
      updateOrder(order.id, {
        customerId: customer.id,
        items: await quoted([{ productId: part.id, quantity: 9 }]),
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    const row = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      include: { items: true },
    });
    expect(row.items[0]!.quantity).toBe(1);
  });
});

describe("editing rejects the same bad input as creating", () => {
  async function editableOrder(sku: string, price = "10.00") {
    const customer = await createCustomer();
    const part = await product(sku, 100, price);
    const order = await draftOrder(customer.id, [
      { productId: part.id, quantity: 1 },
    ]);
    return { order, part, customer };
  }

  it("rejects duplicate product lines", async () => {
    await signInWithRole("STAFF");
    const { order, part, customer } = await editableOrder("D-1");

    await expect(
      updateOrder(order.id, {
        customerId: customer.id,
        items: await quoted([
          { productId: part.id, quantity: 1 },
          { productId: part.id, quantity: 2 },
        ]),
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    const row = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      include: { items: true },
    });
    expect(row.items).toHaveLength(1);
  });

  it("rejects zero, negative and fractional quantities", async () => {
    await signInWithRole("STAFF");
    const { order, part, customer } = await editableOrder("D-2");

    for (const quantity of [0, -3, 2.5]) {
      await expect(
        updateOrder(order.id, {
          customerId: customer.id,
          items: await quoted([{ productId: part.id, quantity }]),
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }

    const row = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      include: { items: true },
    });
    expect(row.items[0]!.quantity).toBe(1);
  });

  it("rejects an empty order", async () => {
    await signInWithRole("STAFF");
    const { order, customer } = await editableOrder("D-3");

    await expect(
      updateOrder(order.id, {
        customerId: customer.id,
        items: await quoted([]),
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    const row = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      include: { items: true },
    });
    expect(row.items).toHaveLength(1);
  });

  it("rejects a product that is no longer active", async () => {
    await signInWithRole("STAFF");
    const customer = await createCustomer();
    const active = await product("D-6", 100);
    const retired = await seedProduct({
      sku: "D-7",
      name: "Retired Part",
      stockQuantity: 100,
    });

    const order = await draftOrder(customer.id, [
      { productId: active.id, quantity: 1 },
    ]);

    // Retired after the order was raised — the edit must not save it.
    await prisma.product.update({
      where: { id: retired.id },
      data: { status: "DISCONTINUED" },
    });

    await expect(
      updateOrder(order.id, {
        customerId: customer.id,
        items: await quoted([
          { productId: active.id, quantity: 1 },
          { productId: retired.id, quantity: 1 },
        ]),
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    const row = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      include: { items: true },
    });
    expect(row.items).toHaveLength(1);
  });

  it("rejects a product that no longer exists", async () => {
    await signInWithRole("STAFF");
    const { order, part, customer } = await editableOrder("D-8");

    await expect(
      updateOrder(order.id, {
        customerId: customer.id,
        items: await quoted([
          { productId: part.id, quantity: 1 },
          { productId: "no-such-product", quantity: 1 },
        ]),
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("the quoted price is historical, not catalogue-derived", () => {
  /*
   * The invariant this whole workstream exists to hold:
   *
   *   reference ₹15,000  →  quoted ₹12,500  →  reference moves to ₹16,000
   *                      →  the order still says ₹12,500
   *
   * The same product is quoted differently to different customers, so the
   * price on a line is a commercial fact about that order and nothing else.
   * `Product.sellingPrice` is a default someone may accept, never the history.
   */

  it("stores the quoted price rather than the reference price", async () => {
    await signInWithRole("STAFF");
    const customer = await createCustomer();
    const part = await product("Q-1", 100, "15000.00");

    const order = await createOrder({
      customerId: customer.id,
      items: [{ productId: part.id, quantity: 2, unitPrice: "12500.00" }],
    });

    const row = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      include: { items: true },
    });

    expect(row.items[0]!.unitPrice.toString()).toBe("12500");
    expect(row.items[0]!.total.toString()).toBe("25000");
    expect(row.subtotal.toString()).toBe("25000");
    expect(row.total.toString()).toBe("25000");
  });

  it("quotes one product at three prices to three customers", async () => {
    await signInWithRole("STAFF");
    const a = await createCustomer("Customer A");
    const b = await createCustomer("Customer B");
    const c = await createCustomer("Customer C");
    const part = await product("Q-2", 100, "15000.00");

    const quotes = [
      [a.id, "12000.00"],
      [b.id, "13500.00"],
      [c.id, "11800.00"],
    ] as const;

    for (const [customerId, unitPrice] of quotes) {
      await createOrder({
        customerId,
        items: [{ productId: part.id, quantity: 1, unitPrice }],
      });
    }

    const lines = await prisma.orderItem.findMany({
      where: { productId: part.id },
      orderBy: { unitPrice: "asc" },
    });

    expect(lines.map((line) => line.unitPrice.toString())).toEqual([
      "11800",
      "12000",
      "13500",
    ]);
  });

  it("keeps the quoted price when only the quantity is edited", async () => {
    /*
     * The defect. `updateOrder` replaced every line at the *current* catalogue
     * price, so changing a quantity silently re-priced a quote that had
     * already been agreed — and the order was still a draft, so nothing said
     * it had happened.
     */
    await signInWithRole("STAFF");
    const customer = await createCustomer();
    const part = await product("Q-3", 100, "15000.00");

    const order = await createOrder({
      customerId: customer.id,
      items: [{ productId: part.id, quantity: 2, unitPrice: "12500.00" }],
    });

    // The reference price moves after the quote was agreed.
    await prisma.product.update({
      where: { id: part.id },
      data: { sellingPrice: "16000.00" },
    });

    // Only the quantity changes; the quote travels back untouched.
    await updateOrder(order.id, {
      customerId: customer.id,
      items: [{ productId: part.id, quantity: 5, unitPrice: "12500.00" }],
    });

    const row = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      include: { items: true },
    });

    expect(row.items[0]!.quantity).toBe(5);
    expect(row.items[0]!.unitPrice.toString()).toBe("12500");
    expect(row.items[0]!.total.toString()).toBe("62500");
    expect(row.total.toString()).toBe("62500");
  });

  it("keeps the quoted price when another permitted field is edited", async () => {
    await signInWithRole("STAFF");
    const first = await createCustomer("First");
    const second = await createCustomer("Second");
    const part = await product("Q-4", 100, "15000.00");

    const order = await createOrder({
      customerId: first.id,
      items: [{ productId: part.id, quantity: 3, unitPrice: "11800.00" }],
    });

    await prisma.product.update({
      where: { id: part.id },
      data: { sellingPrice: "16000.00" },
    });

    await updateOrder(order.id, {
      customerId: second.id,
      items: [{ productId: part.id, quantity: 3, unitPrice: "11800.00" }],
    });

    const row = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      include: { items: true },
    });

    expect(row.customerId).toBe(second.id);
    expect(row.items[0]!.unitPrice.toString()).toBe("11800");
  });

  it("stores a deliberate re-quote", async () => {
    await signInWithRole("STAFF");
    const customer = await createCustomer();
    const part = await product("Q-5", 100, "15000.00");

    const order = await createOrder({
      customerId: customer.id,
      items: [{ productId: part.id, quantity: 2, unitPrice: "12500.00" }],
    });

    await updateOrder(order.id, {
      customerId: customer.id,
      items: [{ productId: part.id, quantity: 2, unitPrice: "13250.00" }],
    });

    const row = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      include: { items: true },
    });

    expect(row.items[0]!.unitPrice.toString()).toBe("13250");
    expect(row.items[0]!.total.toString()).toBe("26500");
  });

  it("leaves a confirmed order's price alone when the reference moves", async () => {
    await signInWithRole("STAFF");
    const customer = await createCustomer();
    const part = await product("Q-6", 100, "15000.00");

    const order = await createOrder({
      customerId: customer.id,
      items: [{ productId: part.id, quantity: 2, unitPrice: "12500.00" }],
    });
    await confirmOrder(order.id);

    await prisma.product.update({
      where: { id: part.id },
      data: { sellingPrice: "16000.00" },
    });

    const row = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      include: { items: true },
    });

    expect(row.items[0]!.unitPrice.toString()).toBe("12500");

    // And a confirmed order cannot be edited at all, so there is no route back.
    await expect(
      updateOrder(order.id, {
        customerId: customer.id,
        items: [{ productId: part.id, quantity: 2, unitPrice: "1.00" }],
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("keeps the quoted price through partial fulfilment", async () => {
    await signInWithRole("STAFF");
    const customer = await createCustomer();
    // Two on the shelf against an order for five.
    const part = await product("Q-7", 2, "15000.00");

    const order = await createOrder({
      customerId: customer.id,
      items: [{ productId: part.id, quantity: 5, unitPrice: "12500.00" }],
    });
    await confirmOrder(order.id);

    const afterConfirm = await prisma.orderItem.findFirstOrThrow({
      where: { orderId: order.id },
    });
    expect(afterConfirm.fulfilledQuantity).toBe(2);
    expect(afterConfirm.unitPrice.toString()).toBe("12500");

    // The line's value is still the whole order, not the shipped part.
    expect(afterConfirm.total.toString()).toBe("62500");
  });

  it("keeps the quoted price through cancellation", async () => {
    await signInWithRole("STAFF");
    const customer = await createCustomer();
    const part = await product("Q-8", 100, "15000.00");

    const order = await createOrder({
      customerId: customer.id,
      items: [{ productId: part.id, quantity: 2, unitPrice: "12500.00" }],
    });
    await confirmOrder(order.id);
    await cancelOrder(order.id);

    const line = await prisma.orderItem.findFirstOrThrow({
      where: { orderId: order.id },
    });

    // Cost is cleared because the sale did not happen; the price is not, because
    // it records what was quoted rather than what was earned.
    expect(line.costTotal).toBeNull();
    expect(line.costedQuantity).toBe(0);
    expect(line.unitPrice.toString()).toBe("12500");
  });

  it("allows a manual quote for a product with no reference price", async () => {
    await signInWithRole("STAFF");
    const customer = await createCustomer();
    const part = await seedProduct({
      sku: "Q-9",
      stockQuantity: 100,
      sellingPrice: null,
    });

    const order = await createOrder({
      customerId: customer.id,
      items: [{ productId: part.id, quantity: 1, unitPrice: "9750.00" }],
    });

    const line = await prisma.orderItem.findFirstOrThrow({
      where: { orderId: order.id },
    });
    expect(line.unitPrice.toString()).toBe("9750");
  });
});

describe("quoted price validation", () => {
  async function quoting(sku: string) {
    await signInWithRole("STAFF");
    const customer = await createCustomer();
    const part = await product(sku, 100, "15000.00");
    return { customer, part };
  }

  it("requires a price on every line", async () => {
    const { customer, part } = await quoting("V-Q1");

    await expect(
      createOrder({
        customerId: customer.id,
        items: [{ productId: part.id, quantity: 1 }],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("refuses a negative price", async () => {
    const { customer, part } = await quoting("V-Q2");

    await expect(
      createOrder({
        customerId: customer.id,
        items: [{ productId: part.id, quantity: 1, unitPrice: "-1.00" }],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("refuses a price that is not a number", async () => {
    const { customer, part } = await quoting("V-Q3");

    await expect(
      createOrder({
        customerId: customer.id,
        items: [{ productId: part.id, quantity: 1, unitPrice: "nine" }],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("refuses a blank price rather than reading it as free", async () => {
    const { customer, part } = await quoting("V-Q4");

    await expect(
      createOrder({
        customerId: customer.id,
        items: [{ productId: part.id, quantity: 1, unitPrice: "" }],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("refuses more than two decimal places", async () => {
    const { customer, part } = await quoting("V-Q5");

    await expect(
      createOrder({
        customerId: customer.id,
        items: [{ productId: part.id, quantity: 1, unitPrice: "12.345" }],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("refuses a price beyond what the column can hold", async () => {
    const { customer, part } = await quoting("V-Q6");

    await expect(
      createOrder({
        customerId: customer.id,
        items: [{ productId: part.id, quantity: 1, unitPrice: "99999999999.00" }],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("accepts zero, which is a real commercial decision", async () => {
    const { customer, part } = await quoting("V-Q7");

    const order = await createOrder({
      customerId: customer.id,
      items: [{ productId: part.id, quantity: 1, unitPrice: "0.00" }],
    });

    const line = await prisma.orderItem.findFirstOrThrow({
      where: { orderId: order.id },
    });
    expect(line.unitPrice.toString()).toBe("0");
  });

  it("still computes the totals itself, whatever the client sends", async () => {
    const { customer, part } = await quoting("V-Q8");

    const order = await createOrder({
      customerId: customer.id,
      items: [
        // A believable price, and line/order totals of the client's choosing.
        { productId: part.id, quantity: 4, unitPrice: "100.00", total: "1.00" },
      ],
      subtotal: "1.00",
      total: "1.00",
    });

    const row = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      include: { items: true },
    });

    // The quote is honoured; every figure derived from it is recomputed.
    expect(row.items[0]!.unitPrice.toString()).toBe("100");
    expect(row.items[0]!.total.toString()).toBe("400");
    expect(row.subtotal.toString()).toBe("400");
    expect(row.total.toString()).toBe("400");
  });

  it("refuses an unauthenticated quote", async () => {
    await signInWithRole("STAFF");
    const customer = await createCustomer();
    const part = await product("V-Q9", 100, "15000.00");
    signOutSupabase();

    await expect(
      createOrder({
        customerId: customer.id,
        items: [{ productId: part.id, quantity: 1, unitPrice: "12500.00" }],
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("attributes the quote to the signed-in user, not to whoever the client names", async () => {
    const actor = await signInWithRole("STAFF");
    const customer = await createCustomer();
    const part = await product("V-Q10", 100, "15000.00");

    const order = await createOrder({
      customerId: customer.id,
      items: [{ productId: part.id, quantity: 1, unitPrice: "12500.00" }],
      createdBy: "somebody-else",
    });

    const row = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(row.createdBy).toBe(actor.id);
  });
});
