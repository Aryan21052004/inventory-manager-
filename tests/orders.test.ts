import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@clerk/nextjs/server", async () => {
  const { clerkServerMock } = await import("./clerk-mock");
  return clerkServerMock;
});

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
import { DEFAULT_ORDER_PARAMS } from "@/lib/order-query";

import { signOut } from "./clerk-mock";
import { resetDatabase, seedProduct, signInWithRole } from "./database";

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
  signOut();
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
    minimumStock: 0,
    sellingPrice: price,
  });
}

async function draftOrder(
  customerId: string,
  items: { productId: string; quantity: number }[],
  discount = "0",
) {
  return createOrder({ customerId, items, discount });
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

  it("refuses an order for one more than the stock on hand", async () => {
    await signInWithRole("STAFF");
    const customer = await createCustomer();
    const part = await product("A-3", 100);

    const order = await draftOrder(customer.id, [
      { productId: part.id, quantity: 101 },
    ]);

    await expect(confirmOrder(order.id)).rejects.toMatchObject({
      code: "INSUFFICIENT_STOCK",
    });

    expect(await stockOf(part.id)).toBe(100);
    expect(await movementsFor(order.id)).toHaveLength(0);
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
// ---------------------------------------------------------------------------

describe("insufficient stock", () => {
  it("fails confirmation and changes nothing", async () => {
    await signInWithRole("STAFF");
    const customer = await createCustomer();
    const part = await product("B-1", 40);

    const order = await draftOrder(customer.id, [
      { productId: part.id, quantity: 60 },
    ]);

    await expect(confirmOrder(order.id)).rejects.toMatchObject({
      code: "INSUFFICIENT_STOCK",
      status: 422,
    });

    expect(await stockOf(part.id)).toBe(40);
    expect(await movementsFor(order.id)).toHaveLength(0);

    // And the order is still where it was — a failed confirmation must not
    // leave it looking confirmed.
    const row = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
    });
    expect(row.status).toBe("DRAFT");
    expect(row.confirmedAt).toBeNull();
  });

  it("names the product, what was asked for, and what is available", async () => {
    await signInWithRole("STAFF");
    const customer = await createCustomer();
    const part = await seedProduct({
      sku: "B-2",
      name: "Hydraulic Actuator",
      stockQuantity: 40,
      minimumStock: 0,
    });

    const order = await draftOrder(customer.id, [
      { productId: part.id, quantity: 60 },
    ]);

    await expect(confirmOrder(order.id)).rejects.toMatchObject({
      message: "Not enough stock for Hydraulic Actuator: 60 requested, 40 available.",
      details: { productName: "Hydraulic Actuator", requested: 60, available: 40 },
    });
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

  it("deducts nothing when one line is short", async () => {
    await signInWithRole("STAFF");
    const customer = await createCustomer();
    const a = await product("M-C", 200);
    const b = await product("M-D", 50);

    const order = await draftOrder(customer.id, [
      { productId: a.id, quantity: 150 },
      { productId: b.id, quantity: 80 },
    ]);

    await expect(confirmOrder(order.id)).rejects.toMatchObject({
      code: "INSUFFICIENT_STOCK",
    });

    // The whole point: A had enough and is still untouched.
    expect(await stockOf(a.id)).toBe(200);
    expect(await stockOf(b.id)).toBe(50);
    expect(await movementsFor(order.id)).toHaveLength(0);
    expect(await prisma.stockTransaction.count()).toBe(0);
  });

  it("deducts nothing when the short line is checked first", async () => {
    // Ordering matters to the implementation — products are locked sorted by
    // id, and the check runs over the whole order before any write. This is the
    // mirror of the case above, with the short product first.
    await signInWithRole("STAFF");
    const customer = await createCustomer();
    const a = await product("M-E", 5);
    const b = await product("M-F", 500);

    const order = await draftOrder(customer.id, [
      { productId: a.id, quantity: 10 },
      { productId: b.id, quantity: 10 },
    ]);

    await expect(confirmOrder(order.id)).rejects.toMatchObject({
      code: "INSUFFICIENT_STOCK",
    });

    expect(await stockOf(a.id)).toBe(5);
    expect(await stockOf(b.id)).toBe(500);
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
        items: [{ productId: part.id, quantity: 99 }],
        discount: "0",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect(await stockOf(part.id)).toBe(90);
  });
});

// ---------------------------------------------------------------------------
// Test 9 — concurrency
// ---------------------------------------------------------------------------

describe("concurrency", () => {
  it("lets exactly one of two competing orders through", async () => {
    await signInWithRole("STAFF");
    const customer = await createCustomer();
    const part = await product("X-1", 100);

    const a = await draftOrder(customer.id, [
      { productId: part.id, quantity: 70 },
    ]);
    const b = await draftOrder(customer.id, [
      { productId: part.id, quantity: 50 },
    ]);

    // Both at once. Without the row lock these both read 100 and both write,
    // leaving −20 on the shelf.
    const results = await Promise.allSettled([
      confirmOrder(a.id),
      confirmOrder(b.id),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: "INSUFFICIENT_STOCK",
    });

    const remaining = await stockOf(part.id);
    // 100 − 70 or 100 − 50, depending on which won. Never negative, and never
    // both.
    expect([30, 50]).toContain(remaining);

    const ledger = await prisma.stockTransaction.findMany();
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.previousStock).toBe(100);
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
      items: [{ productId: part.id, quantity: 10 }],
      discount: "0",
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
    // The local database id, not the Clerk id.
    expect(movement.createdBy).not.toBe(actor.clerkId);
  });

  it("ignores a unit price the client tried to name", async () => {
    await signInWithRole("STAFF");
    const customer = await createCustomer();
    const part = await product("T-2", 100, "250.00");

    const order = await createOrder({
      customerId: customer.id,
      // A price of its own choosing, and a total to match.
      items: [{ productId: part.id, quantity: 2, unitPrice: "0.01", total: "0.02" }],
      discount: "0",
      subtotal: "0.02",
      total: "0.02",
    });

    const row = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      include: { items: true },
    });

    // Read from the product, in the transaction, every time.
    expect(row.items[0]!.unitPrice.toString()).toBe("250");
    expect(row.subtotal.toString()).toBe("500");
    expect(row.total.toString()).toBe("500");
  });

  it("refuses an unauthenticated order", async () => {
    const customer = await createCustomer();
    const part = await product("T-3", 100);

    await expect(
      createOrder({
        customerId: customer.id,
        items: [{ productId: part.id, quantity: 1 }],
        discount: "0",
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

    signOut();

    await expect(confirmOrder(order.id)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(await stockOf(part.id)).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// Test 13 — totals, and the absence of tax
// ---------------------------------------------------------------------------

describe("order totals", () => {
  it("computes grand total as subtotal minus discount", async () => {
    await signInWithRole("STAFF");
    const customer = await createCustomer();
    const part = await product("V-1", 100, "1000.00");

    const order = await createOrder({
      customerId: customer.id,
      items: [{ productId: part.id, quantity: 10 }],
      discount: "500",
    });

    const row = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
    });

    expect(Number(row.subtotal)).toBe(10_000);
    expect(Number(row.discount)).toBe(500);
    expect(Number(row.total)).toBe(9_500);
    // No tax term, and no column that could carry one.
    expect(Object.keys(row)).not.toContain("tax");
    expect(Number(row.total)).toBe(Number(row.subtotal) - Number(row.discount));
  });

  it("sums several lines correctly", async () => {
    await signInWithRole("STAFF");
    const customer = await createCustomer();
    const a = await product("V-2", 100, "19.99");
    const b = await product("V-3", 100, "5.05");

    const order = await createOrder({
      customerId: customer.id,
      items: [
        { productId: a.id, quantity: 3 },
        { productId: b.id, quantity: 7 },
      ],
      discount: "0",
    });

    const row = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
    });

    // 59.97 + 35.35 — computed in integer cents, so nothing drifts.
    expect(row.subtotal.toString()).toBe("95.32");
    expect(row.total.toString()).toBe("95.32");
  });

  it("refuses a discount larger than the subtotal", async () => {
    await signInWithRole("STAFF");
    const customer = await createCustomer();
    const part = await product("V-4", 100, "10.00");

    await expect(
      createOrder({
        customerId: customer.id,
        items: [{ productId: part.id, quantity: 1 }],
        discount: "50",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", details: { field: "discount" } });
  });

  it("refuses a negative discount", async () => {
    await signInWithRole("STAFF");
    const customer = await createCustomer();
    const part = await product("V-5", 100);

    await expect(
      createOrder({
        customerId: customer.id,
        items: [{ productId: part.id, quantity: 1 }],
        discount: "-5",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe("validation", () => {
  it("refuses an order with no items", async () => {
    await signInWithRole("STAFF");
    const customer = await createCustomer();

    await expect(
      createOrder({ customerId: customer.id, items: [], discount: "0" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("refuses duplicate product lines", async () => {
    await signInWithRole("STAFF");
    const customer = await createCustomer();
    const part = await product("W-1", 100);

    await expect(
      createOrder({
        customerId: customer.id,
        items: [
          { productId: part.id, quantity: 1 },
          { productId: part.id, quantity: 2 },
        ],
        discount: "0",
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
          items: [{ productId: part.id, quantity }],
          discount: "0",
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
        items: [{ productId: part.id, quantity: 1 }],
        discount: "0",
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
        items: [{ productId: retired.id, quantity: 1 }],
        discount: "0",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("refuses a product that does not exist", async () => {
    await signInWithRole("STAFF");
    const customer = await createCustomer();

    await expect(
      createOrder({
        customerId: customer.id,
        items: [{ productId: "no-such-product", quantity: 1 }],
        discount: "0",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

// ---------------------------------------------------------------------------
// Test 14 — certificates, referenced not copied
// ---------------------------------------------------------------------------

describe("certificate display", () => {
  it("shows the product's current certificate on the order without copying it", async () => {
    await signInWithRole("ADMIN");
    const customer = await createCustomer();
    const part = await seedProduct({
      sku: "ABC-123",
      name: "Certified Actuator",
      stockQuantity: 100,
      minimumStock: 0,
    });

    await attachCertificate({
      productId: part.id,
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

    const result = await getOrderDetail(order.id);
    if (!result.ok || !result.data) throw new Error("expected an order");

    const line = result.data.lines[0]!;
    expect(line.sku).toBe("ABC-123");
    expect(line.quantity).toBe(5);
    expect(line.certificateType).toBe("FAA 8130-3");
    expect(line.certificateNumber).toBe("8130-9911");
    expect(line.certificateStatus).toBe("VALID");

    // Referenced, not duplicated: still exactly one certificate row, still
    // belonging to the product.
    const certificates = await prisma.certificate.findMany();
    expect(certificates).toHaveLength(1);
    expect(certificates[0]!.productId).toBe(part.id);
  });

  it("reports MISSING for a product with no certificate", async () => {
    await signInWithRole("STAFF");
    const customer = await createCustomer();
    const part = await product("NOCERT-1", 50);

    const order = await draftOrder(customer.id, [
      { productId: part.id, quantity: 1 },
    ]);

    const result = await getOrderDetail(order.id);
    if (!result.ok || !result.data) throw new Error("expected an order");

    expect(result.data.lines[0]!.certificateStatus).toBe("MISSING");
    expect(result.data.lines[0]!.certificateType).toBeNull();
  });

  it("does not touch certificates when an order is confirmed", async () => {
    await signInWithRole("ADMIN");
    const customer = await createCustomer();
    const part = await seedProduct({
      sku: "CERTSAFE-1",
      stockQuantity: 100,
      minimumStock: 0,
    });

    await attachCertificate({
      productId: part.id,
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
      minimumStock: 0,
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
