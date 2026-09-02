import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@clerk/nextjs/server", async () => {
  const { clerkServerMock } = await import("./clerk-mock");
  return clerkServerMock;
});

import { prisma } from "@/lib/prisma";
import { DEFAULT_PURCHASE_PARAMS } from "@/lib/purchase-query";
import {
  cancelPurchase,
  createPurchase,
  getPurchaseDetail,
  listPurchases,
  receivePurchase,
  setPurchaseStatus,
  updatePurchase,
} from "@/server/purchases";
import { attachCertificate } from "@/server/certificates";
import { confirmOrder, createOrder } from "@/server/orders";

import { signOut } from "./clerk-mock";
import {
  createSupplier,
  resetDatabase,
  seedProduct,
  signInWithRole,
} from "./database";

/**
 * Purchases, and the inventory they bring in.
 *
 * The mirror of the orders suite: most of what matters is failure. A retired
 * product stops the whole delivery, a second receipt adds nothing, a second
 * cancellation takes nothing back, and two requests racing to receive the same
 * purchase cannot both win.
 *
 * Against a real Postgres, because the guarantees *are* Postgres — `FOR
 * UPDATE`, transaction rollback, and a unique index.
 */

beforeEach(async () => {
  signOut();
  await resetDatabase();
});

/**
 * A product with a known balance and a round cost.
 *
 * The opening balance is deliberately uncosted — it was conjured into existence
 * by the fixture, not bought — so anything these tests assert about cost comes
 * from purchases they actually receive.
 */
async function product(sku: string, stockQuantity: number, cost = "10.00") {
  return seedProduct({
    sku,
    name: `Part ${sku}`,
    stockQuantity,
    standardCost: cost,
  });
}

async function draftPurchase(
  supplierId: string,
  items: { productId: string; quantity: number; unitCost?: string }[],
) {
  return createPurchase({
    supplierId,
    items: items.map((item) => ({
      productId: item.productId,
      quantity: item.quantity,
      unitCost: item.unitCost ?? "10.00",
    })),
  });
}

async function stockOf(productId: string): Promise<number> {
  const row = await prisma.product.findUniqueOrThrow({
    where: { id: productId },
  });
  return row.stockQuantity;
}

async function movementsFor(purchaseId: string) {
  return prisma.stockTransaction.findMany({
    where: { referenceType: "PURCHASE", referenceId: purchaseId },
    orderBy: { createdAt: "asc" },
  });
}

// ---------------------------------------------------------------------------
// Tests 1 and 4 — receiving adds stock
// ---------------------------------------------------------------------------

describe("receiving a purchase adds stock", () => {
  it("takes 50 to 150 and writes one STOCK_IN", async () => {
    const user = await signInWithRole("STAFF");
    const supplier = await createSupplier();
    const part = await product("P-1", 50);

    const purchase = await draftPurchase(supplier.id, [
      { productId: part.id, quantity: 100 },
    ]);

    const outcome = await receivePurchase(purchase.id);

    expect(outcome.status).toBe("RECEIVED");
    expect(await stockOf(part.id)).toBe(150);

    const ledger = await movementsFor(purchase.id);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      productId: part.id,
      type: "STOCK_IN",
      quantity: 100,
      previousStock: 50,
      newStock: 150,
      referenceType: "PURCHASE",
      referenceId: purchase.id,
      createdBy: user.id,
    });
    expect(ledger[0]!.note).toContain(purchase.purchaseNumber);
  });

  it("doubles a balance when the delivery matches it", async () => {
    await signInWithRole("STAFF");
    const supplier = await createSupplier();
    const part = await product("P-2", 100);

    const purchase = await draftPurchase(supplier.id, [
      { productId: part.id, quantity: 100 },
    ]);
    await receivePurchase(purchase.id);

    expect(await stockOf(part.id)).toBe(200);
  });

  it("records the received timestamp", async () => {
    await signInWithRole("STAFF");
    const supplier = await createSupplier();
    const part = await product("P-3", 10);

    const purchase = await draftPurchase(supplier.id, [
      { productId: part.id, quantity: 5 },
    ]);
    await receivePurchase(purchase.id);

    const row = await prisma.purchase.findUniqueOrThrow({
      where: { id: purchase.id },
    });
    expect(row.receivedAt).not.toBeNull();
  });

  it("receives straight from PENDING", async () => {
    await signInWithRole("STAFF");
    const supplier = await createSupplier();
    const part = await product("P-4", 20);

    const purchase = await draftPurchase(supplier.id, [
      { productId: part.id, quantity: 30 },
    ]);
    await setPurchaseStatus(purchase.id, "PENDING");
    await receivePurchase(purchase.id);

    expect(await stockOf(part.id)).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// Tests 2 and 3 — statuses that move nothing
// ---------------------------------------------------------------------------

describe("statuses that move no stock", () => {
  it("leaves stock alone for a draft", async () => {
    await signInWithRole("STAFF");
    const supplier = await createSupplier();
    const part = await product("Q-1", 50);

    await draftPurchase(supplier.id, [{ productId: part.id, quantity: 100 }]);

    expect(await stockOf(part.id)).toBe(50);
    expect(await prisma.stockTransaction.count()).toBe(0);
  });

  it("leaves stock alone for a pending purchase", async () => {
    await signInWithRole("STAFF");
    const supplier = await createSupplier();
    const part = await product("Q-2", 50);

    const purchase = await draftPurchase(supplier.id, [
      { productId: part.id, quantity: 100 },
    ]);
    await setPurchaseStatus(purchase.id, "PENDING");

    expect(await stockOf(part.id)).toBe(50);
    expect(await prisma.stockTransaction.count()).toBe(0);
  });

  it("moves between draft and pending without touching stock", async () => {
    await signInWithRole("STAFF");
    const supplier = await createSupplier();
    const part = await product("Q-3", 50);

    const purchase = await draftPurchase(supplier.id, [
      { productId: part.id, quantity: 100 },
    ]);
    await setPurchaseStatus(purchase.id, "PENDING");
    await setPurchaseStatus(purchase.id, "DRAFT");

    expect(await stockOf(part.id)).toBe(50);
    expect(await prisma.stockTransaction.count()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Test 5 — receiving twice
// ---------------------------------------------------------------------------

describe("receiving twice", () => {
  it("adds stock only once", async () => {
    await signInWithRole("STAFF");
    const supplier = await createSupplier();
    const part = await product("R-1", 50);

    const purchase = await draftPurchase(supplier.id, [
      { productId: part.id, quantity: 100 },
    ]);

    await receivePurchase(purchase.id);
    await expect(receivePurchase(purchase.id)).rejects.toMatchObject({
      code: "CONFLICT",
    });

    expect(await stockOf(part.id)).toBe(150);
    expect(await movementsFor(purchase.id)).toHaveLength(1);
  });

  it("refuses to receive a cancelled purchase", async () => {
    await signInWithRole("STAFF");
    const supplier = await createSupplier();
    const part = await product("R-2", 50);

    const purchase = await draftPurchase(supplier.id, [
      { productId: part.id, quantity: 100 },
    ]);
    await cancelPurchase(purchase.id);

    await expect(receivePurchase(purchase.id)).rejects.toMatchObject({
      code: "CONFLICT",
    });

    expect(await stockOf(part.id)).toBe(50);
    expect(await prisma.stockTransaction.count()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tests 6 and 7 — cancellation and reversal
// ---------------------------------------------------------------------------

describe("cancelling a received purchase", () => {
  it("takes back exactly what was added", async () => {
    const user = await signInWithRole("STAFF");
    const supplier = await createSupplier();
    const part = await product("C-1", 50);

    const purchase = await draftPurchase(supplier.id, [
      { productId: part.id, quantity: 100 },
    ]);

    await receivePurchase(purchase.id);
    expect(await stockOf(part.id)).toBe(150);

    await cancelPurchase(purchase.id);
    expect(await stockOf(part.id)).toBe(50);

    const ledger = await movementsFor(purchase.id);
    expect(ledger).toHaveLength(2);

    const reversal = ledger.find((row) => row.type === "REVERSAL");
    expect(reversal).toMatchObject({
      productId: part.id,
      type: "REVERSAL",
      quantity: 100,
      previousStock: 150,
      newStock: 50,
      referenceType: "PURCHASE",
      referenceId: purchase.id,
      createdBy: user.id,
    });
    expect(reversal?.note).toContain("cancelled");
  });

  it("takes back only once when cancelled twice", async () => {
    await signInWithRole("STAFF");
    const supplier = await createSupplier();
    const part = await product("C-2", 50);

    const purchase = await draftPurchase(supplier.id, [
      { productId: part.id, quantity: 100 },
    ]);
    await receivePurchase(purchase.id);

    const first = await cancelPurchase(purchase.id);
    const second = await cancelPurchase(purchase.id);

    expect(first.alreadyInState).toBe(false);
    // Idempotent: the second call reports there was nothing to do.
    expect(second.alreadyInState).toBe(true);
    expect(second.movements).toEqual([]);

    expect(await stockOf(part.id)).toBe(50);
    expect(
      (await movementsFor(purchase.id)).filter((row) => row.type === "REVERSAL"),
    ).toHaveLength(1);
  });

  it("takes nothing back for a purchase that never arrived", async () => {
    await signInWithRole("STAFF");
    const supplier = await createSupplier();
    const part = await product("C-3", 50);

    const purchase = await draftPurchase(supplier.id, [
      { productId: part.id, quantity: 100 },
    ]);

    // Cancelled straight from DRAFT — nothing ever came in.
    await cancelPurchase(purchase.id);

    expect(await stockOf(part.id)).toBe(50);
    expect(await movementsFor(purchase.id)).toHaveLength(0);
  });

  it("takes back every line of a multi-product purchase", async () => {
    await signInWithRole("STAFF");
    const supplier = await createSupplier();
    const a = await product("C-4", 200);
    const b = await product("C-5", 100);

    const purchase = await draftPurchase(supplier.id, [
      { productId: a.id, quantity: 150 },
      { productId: b.id, quantity: 80 },
    ]);

    await receivePurchase(purchase.id);
    await cancelPurchase(purchase.id);

    expect(await stockOf(a.id)).toBe(200);
    expect(await stockOf(b.id)).toBe(100);
  });

  it("records a reason on the reversal when one is given", async () => {
    await signInWithRole("STAFF");
    const supplier = await createSupplier();
    const part = await product("C-6", 20);

    const purchase = await draftPurchase(supplier.id, [
      { productId: part.id, quantity: 5 },
    ]);
    await receivePurchase(purchase.id);
    await cancelPurchase(purchase.id, "Delivery returned to supplier");

    const reversal = (await movementsFor(purchase.id)).find(
      (row) => row.type === "REVERSAL",
    );
    expect(reversal?.note).toContain("Delivery returned to supplier");
  });

  it("refuses to take back goods that have since been sold", async () => {
    await signInWithRole("STAFF");
    const supplier = await createSupplier();
    const customer = await prisma.customer.create({
      data: { name: "A Customer" },
    });
    const part = await seedProduct({
      sku: "C-7",
      name: "Scarce Part",
      stockQuantity: 0,
      sellingPrice: "50.00",
    });

    const purchase = await draftPurchase(supplier.id, [
      { productId: part.id, quantity: 100 },
    ]);
    await receivePurchase(purchase.id);
    expect(await stockOf(part.id)).toBe(100);

    // Everything that arrived is sold and gone.
    const order = await createOrder({
      customerId: customer.id,
      items: [{ productId: part.id, quantity: 100 }],
      discount: "0",
    });
    await confirmOrder(order.id);
    expect(await stockOf(part.id)).toBe(0);

    /*
     * Cancelling the delivery now would mean un-selling those units.
     *
     * This used to surface as INSUFFICIENT_STOCK, from the reversal being
     * refused for driving the balance negative. It is now caught earlier and
     * more precisely: the lot this purchase created has been drawn from, which
     * is true whether or not the shelf happens to hold enough units — a later
     * delivery could easily have topped the balance back up, and reversing
     * against *that* batch would misstate what it cost.
     */
    await expect(cancelPurchase(purchase.id)).rejects.toMatchObject({
      code: "CONFLICT",
    });

    // And the refusal leaves everything as it was — no half reversal.
    expect(await stockOf(part.id)).toBe(0);
    const row = await prisma.purchase.findUniqueOrThrow({
      where: { id: purchase.id },
    });
    expect(row.status).toBe("RECEIVED");
    expect(
      (await movementsFor(purchase.id)).filter((m) => m.type === "REVERSAL"),
    ).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tests 8 and 9 — multiple products, all or nothing
// ---------------------------------------------------------------------------

describe("purchases with several products", () => {
  it("adds every line", async () => {
    await signInWithRole("STAFF");
    const supplier = await createSupplier();
    const a = await product("M-A", 200);
    const b = await product("M-B", 100);

    const purchase = await draftPurchase(supplier.id, [
      { productId: a.id, quantity: 150 },
      { productId: b.id, quantity: 80 },
    ]);

    await receivePurchase(purchase.id);

    expect(await stockOf(a.id)).toBe(350);
    expect(await stockOf(b.id)).toBe(180);
    expect(await movementsFor(purchase.id)).toHaveLength(2);
  });

  it("adds nothing when one line's product has been retired", async () => {
    await signInWithRole("STAFF");
    const supplier = await createSupplier();
    const a = await product("M-C", 200);
    const b = await product("M-D", 100);

    const purchase = await draftPurchase(supplier.id, [
      { productId: a.id, quantity: 150 },
      { productId: b.id, quantity: 80 },
    ]);

    // Retired after the purchase was raised — the classic way a delivery
    // becomes un-bookable between ordering and arrival.
    await prisma.product.update({
      where: { id: b.id },
      data: { status: "DISCONTINUED" },
    });

    await expect(receivePurchase(purchase.id)).rejects.toMatchObject({
      code: "CONFLICT",
    });

    // The whole point: A was fine and is still untouched.
    expect(await stockOf(a.id)).toBe(200);
    expect(await stockOf(b.id)).toBe(100);
    expect(await prisma.stockTransaction.count()).toBe(0);

    const row = await prisma.purchase.findUniqueOrThrow({
      where: { id: purchase.id },
    });
    expect(row.status).toBe("DRAFT");
    expect(row.receivedAt).toBeNull();
  });

  it("adds nothing when the retired product is checked last", async () => {
    // The mirror of the case above, with the retired product first by id
    // ordering — the check runs over the whole purchase before any write.
    await signInWithRole("STAFF");
    const supplier = await createSupplier();
    const a = await product("M-E", 5);
    const b = await product("M-F", 500);

    const purchase = await draftPurchase(supplier.id, [
      { productId: a.id, quantity: 10 },
      { productId: b.id, quantity: 10 },
    ]);

    await prisma.product.update({
      where: { id: a.id },
      data: { status: "INACTIVE" },
    });

    await expect(receivePurchase(purchase.id)).rejects.toMatchObject({
      code: "CONFLICT",
    });

    expect(await stockOf(a.id)).toBe(5);
    expect(await stockOf(b.id)).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// Test 11 — retired products
// ---------------------------------------------------------------------------

describe("retired products", () => {
  it("cannot be added to a new purchase", async () => {
    await signInWithRole("STAFF");
    const supplier = await createSupplier();
    const retired = await seedProduct({
      sku: "T-1",
      name: "Retired Part",
      stockQuantity: 10,
      status: "DISCONTINUED",
    });

    await expect(
      draftPurchase(supplier.id, [{ productId: retired.id, quantity: 5 }]),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(await prisma.purchase.count()).toBe(0);
  });

  it("stay visible on an existing purchase rather than disappearing", async () => {
    await signInWithRole("STAFF");
    const supplier = await createSupplier();
    const part = await product("T-2", 10);

    const purchase = await draftPurchase(supplier.id, [
      { productId: part.id, quantity: 5 },
    ]);

    await prisma.product.update({
      where: { id: part.id },
      data: { status: "DISCONTINUED" },
    });

    const result = await getPurchaseDetail(purchase.id);
    if (!result.ok || !result.data) throw new Error("expected a purchase");

    // History must remain readable — the line is shown and flagged, not hidden.
    expect(result.data.lines).toHaveLength(1);
    expect(result.data.lines[0]!.productRetired).toBe(true);
    expect(result.data.hasRetiredProducts).toBe(true);
  });

  it("block receiving, naming the product", async () => {
    await signInWithRole("STAFF");
    const supplier = await createSupplier();
    const part = await seedProduct({
      sku: "T-3",
      name: "Obsolete Actuator",
      stockQuantity: 10,
    });

    const purchase = await draftPurchase(supplier.id, [
      { productId: part.id, quantity: 5 },
    ]);

    await prisma.product.update({
      where: { id: part.id },
      data: { status: "DISCONTINUED" },
    });

    await expect(receivePurchase(purchase.id)).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("Obsolete Actuator"),
    });

    expect(await stockOf(part.id)).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Test 10 — concurrency
// ---------------------------------------------------------------------------

describe("concurrency", () => {
  it("receives the same purchase only once when two requests race", async () => {
    await signInWithRole("STAFF");
    const supplier = await createSupplier();
    const part = await product("X-1", 100);

    const purchase = await draftPurchase(supplier.id, [
      { productId: part.id, quantity: 40 },
    ]);

    // The same delivery booked in twice, simultaneously. The purchase row lock
    // is what makes the second wait and then see RECEIVED.
    const results = await Promise.allSettled([
      receivePurchase(purchase.id),
      receivePurchase(purchase.id),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await stockOf(part.id)).toBe(140);
    expect(await movementsFor(purchase.id)).toHaveLength(1);
  });

  it("adds both deliveries when two purchases for one product overlap", async () => {
    await signInWithRole("STAFF");
    const supplier = await createSupplier();
    const part = await product("X-2", 200);

    const a = await draftPurchase(supplier.id, [
      { productId: part.id, quantity: 100 },
    ]);
    const b = await draftPurchase(supplier.id, [
      { productId: part.id, quantity: 50 },
    ]);

    await Promise.all([receivePurchase(a.id), receivePurchase(b.id)]);

    // Neither may be lost: 200 + 100 + 50.
    expect(await stockOf(part.id)).toBe(350);

    const ledger = await prisma.stockTransaction.findMany({
      orderBy: { createdAt: "asc" },
    });
    expect(ledger).toHaveLength(2);

    let balance = 200;
    for (const row of ledger) {
      expect(row.previousStock).toBe(balance);
      balance = row.newStock;
    }
    expect(balance).toBe(350);
  });

  it("keeps the ledger contiguous when several deliveries overlap", async () => {
    await signInWithRole("STAFF");
    const supplier = await createSupplier();
    const part = await product("X-3", 100);

    const purchases = await Promise.all(
      Array.from({ length: 5 }, () =>
        draftPurchase(supplier.id, [{ productId: part.id, quantity: 10 }]),
      ),
    );

    await Promise.all(purchases.map((p) => receivePurchase(p.id)));

    expect(await stockOf(part.id)).toBe(150);

    const ledger = await prisma.stockTransaction.findMany({
      orderBy: { createdAt: "asc" },
    });

    let balance = 100;
    for (const row of ledger) {
      expect(row.previousStock).toBe(balance);
      balance = row.newStock;
    }
    expect(balance).toBe(150);
  });

  it("cannot be raced into a double reversal", async () => {
    await signInWithRole("STAFF");
    const supplier = await createSupplier();
    const part = await product("X-4", 100);

    const purchase = await draftPurchase(supplier.id, [
      { productId: part.id, quantity: 40 },
    ]);
    await receivePurchase(purchase.id);

    await Promise.allSettled([
      cancelPurchase(purchase.id),
      cancelPurchase(purchase.id),
    ]);

    expect(await stockOf(part.id)).toBe(100);
    expect(
      (await movementsFor(purchase.id)).filter((row) => row.type === "REVERSAL"),
    ).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Test 12 — attribution and tampering
// ---------------------------------------------------------------------------

describe("attribution", () => {
  it("takes createdBy from the session, ignoring what the client sent", async () => {
    const actor = await signInWithRole("STAFF");
    const somebodyElse = await prisma.user.create({
      data: {
        clerkId: "user_purchase_victim",
        name: "Victim",
        email: "purchasevictim@example.com",
        role: "ADMIN",
      },
    });

    const supplier = await createSupplier();
    const part = await product("A-1", 100);

    // `createdBy` is not in the schema, so this is what it takes to express it
    // at all — and it reaches nothing.
    const purchase = await createPurchase({
      supplierId: supplier.id,
      items: [{ productId: part.id, quantity: 10, unitCost: "5.00" }],
      createdBy: somebodyElse.id,
      userId: somebodyElse.id,
    });

    const row = await prisma.purchase.findUniqueOrThrow({
      where: { id: purchase.id },
    });
    expect(row.createdBy).toBe(actor.id);
    expect(row.createdBy).not.toBe(somebodyElse.id);

    await receivePurchase(purchase.id);

    const movement = (await movementsFor(purchase.id))[0]!;
    expect(movement.createdBy).toBe(actor.id);
    expect(movement.createdBy).not.toBe(somebodyElse.id);
    // The local database id, not the Clerk id.
    expect(movement.createdBy).not.toBe(actor.clerkId);
  });

  it("refuses an unauthenticated purchase", async () => {
    const supplier = await createSupplier();
    const part = await product("A-2", 100);

    await expect(
      draftPurchase(supplier.id, [{ productId: part.id, quantity: 1 }]),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    expect(await prisma.purchase.count()).toBe(0);
  });

  it("refuses an unauthenticated receipt", async () => {
    await signInWithRole("STAFF");
    const supplier = await createSupplier();
    const part = await product("A-3", 100);
    const purchase = await draftPurchase(supplier.id, [
      { productId: part.id, quantity: 10 },
    ]);

    signOut();

    await expect(receivePurchase(purchase.id)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(await stockOf(part.id)).toBe(100);
  });

  it("refuses an unauthenticated cancellation", async () => {
    await signInWithRole("STAFF");
    const supplier = await createSupplier();
    const part = await product("A-4", 100);
    const purchase = await draftPurchase(supplier.id, [
      { productId: part.id, quantity: 10 },
    ]);
    await receivePurchase(purchase.id);

    signOut();

    await expect(cancelPurchase(purchase.id)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(await stockOf(part.id)).toBe(110);
  });
});

// ---------------------------------------------------------------------------
// Totals and validation
// ---------------------------------------------------------------------------

describe("totals", () => {
  it("is the sum of the line totals, computed server-side", async () => {
    await signInWithRole("STAFF");
    const supplier = await createSupplier();
    const a = await product("V-1", 0);
    const b = await product("V-2", 0);

    const purchase = await createPurchase({
      supplierId: supplier.id,
      items: [
        { productId: a.id, quantity: 3, unitCost: "19.99" },
        { productId: b.id, quantity: 7, unitCost: "5.05" },
      ],
      // Totals of the client's choosing, all ignored.
      total: "0.01",
    });

    const row = await prisma.purchase.findUniqueOrThrow({
      where: { id: purchase.id },
      include: { items: true },
    });

    // 59.97 + 35.35, in integer cents so nothing drifts.
    expect(row.total.toString()).toBe("95.32");
    // No tax and no discount — a purchase is what the supplier invoiced.
    expect(Object.keys(row)).not.toContain("tax");
    expect(Object.keys(row)).not.toContain("discount");

    const sum = row.items.reduce((acc, item) => acc + Number(item.total), 0);
    expect(Number(row.total)).toBe(sum);
  });

  it("uses the unit cost the supplier invoiced, not the catalogue cost", async () => {
    await signInWithRole("STAFF");
    const supplier = await createSupplier();
    // The catalogue says 10.00; this delivery came in at 12.50.
    const part = await product("V-3", 0, "10.00");

    const purchase = await createPurchase({
      supplierId: supplier.id,
      items: [{ productId: part.id, quantity: 4, unitCost: "12.50" }],
    });

    const row = await prisma.purchase.findUniqueOrThrow({
      where: { id: purchase.id },
      include: { items: true },
    });

    expect(row.items[0]!.unitCost.toString()).toBe("12.5");
    expect(row.total.toString()).toBe("50");
  });

  it("accepts a zero unit cost", async () => {
    await signInWithRole("STAFF");
    const supplier = await createSupplier();
    const part = await product("V-4", 0);

    // A warranty replacement still arrives and still has to be counted in.
    const purchase = await createPurchase({
      supplierId: supplier.id,
      items: [{ productId: part.id, quantity: 2, unitCost: "0" }],
    });

    await receivePurchase(purchase.id);

    expect(await stockOf(part.id)).toBe(2);
    const row = await prisma.purchase.findUniqueOrThrow({
      where: { id: purchase.id },
    });
    expect(row.total.toString()).toBe("0");
  });

  it("refuses a negative unit cost", async () => {
    await signInWithRole("STAFF");
    const supplier = await createSupplier();
    const part = await product("V-5", 0);

    await expect(
      createPurchase({
        supplierId: supplier.id,
        items: [{ productId: part.id, quantity: 1, unitCost: "-5" }],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("validation", () => {
  it("refuses a purchase with no items", async () => {
    await signInWithRole("STAFF");
    const supplier = await createSupplier();

    await expect(
      createPurchase({ supplierId: supplier.id, items: [] }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("refuses duplicate product lines", async () => {
    await signInWithRole("STAFF");
    const supplier = await createSupplier();
    const part = await product("W-1", 0);

    await expect(
      createPurchase({
        supplierId: supplier.id,
        items: [
          { productId: part.id, quantity: 1, unitCost: "1.00" },
          { productId: part.id, quantity: 2, unitCost: "1.00" },
        ],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(await prisma.purchase.count()).toBe(0);
  });

  it("refuses zero, negative and fractional quantities", async () => {
    await signInWithRole("STAFF");
    const supplier = await createSupplier();
    const part = await product("W-2", 0);

    for (const quantity of [0, -1, 1.5]) {
      await expect(
        createPurchase({
          supplierId: supplier.id,
          items: [{ productId: part.id, quantity, unitCost: "1.00" }],
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
  });

  it("refuses a supplier that does not exist", async () => {
    await signInWithRole("STAFF");
    const part = await product("W-3", 0);

    await expect(
      createPurchase({
        supplierId: "no-such-supplier",
        items: [{ productId: part.id, quantity: 1, unitCost: "1.00" }],
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      details: { field: "supplierId" },
    });
  });

  it("refuses a product that does not exist", async () => {
    await signInWithRole("STAFF");
    const supplier = await createSupplier();

    await expect(
      createPurchase({
        supplierId: supplier.id,
        items: [{ productId: "no-such-product", quantity: 1, unitCost: "1" }],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("refuses an arbitrary status jump from the client", async () => {
    await signInWithRole("STAFF");
    const supplier = await createSupplier();
    const part = await product("W-4", 100);
    const purchase = await draftPurchase(supplier.id, [
      { productId: part.id, quantity: 10 },
    ]);

    // Receive and cancel each have their own guarded function; the generic
    // setter refuses to be a second route to them.
    await expect(
      setPurchaseStatus(purchase.id, "RECEIVED"),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      setPurchaseStatus(purchase.id, "CANCELLED"),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(await prisma.stockTransaction.count()).toBe(0);
  });

  it("refuses to edit a received purchase", async () => {
    await signInWithRole("STAFF");
    const supplier = await createSupplier();
    const part = await product("W-5", 100);
    const purchase = await draftPurchase(supplier.id, [
      { productId: part.id, quantity: 10 },
    ]);
    await receivePurchase(purchase.id);

    await expect(
      updatePurchase(purchase.id, {
        supplierId: supplier.id,
        items: [{ productId: part.id, quantity: 99, unitCost: "1.00" }],
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect(await stockOf(part.id)).toBe(110);
  });

  it("edits a draft without touching inventory", async () => {
    await signInWithRole("STAFF");
    const supplier = await createSupplier();
    const a = await product("W-6", 100);
    const b = await product("W-7", 100);

    const purchase = await draftPurchase(supplier.id, [
      { productId: a.id, quantity: 10 },
    ]);

    await updatePurchase(purchase.id, {
      supplierId: supplier.id,
      items: [
        { productId: a.id, quantity: 20, unitCost: "2.00" },
        { productId: b.id, quantity: 5, unitCost: "4.00" },
      ],
    });

    const row = await prisma.purchase.findUniqueOrThrow({
      where: { id: purchase.id },
      include: { items: true },
    });

    expect(row.items).toHaveLength(2);
    // 20 × 2.00 + 5 × 4.00
    expect(row.total.toString()).toBe("60");
    expect(await stockOf(a.id)).toBe(100);
    expect(await stockOf(b.id)).toBe(100);
    expect(await prisma.stockTransaction.count()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Certificates — referenced, never touched
// ---------------------------------------------------------------------------

describe("certificates", () => {
  /** The batch a seeded product holds — what paperwork attaches to. */
  async function lotOf(productId: string): Promise<string> {
    const lot = await prisma.stockLot.findFirstOrThrow({
      where: { productId },
      select: { id: true },
    });
    return lot.id;
  }

  it("are not created or changed by receiving a delivery", async () => {
    await signInWithRole("ADMIN");
    const supplier = await createSupplier();
    const part = await seedProduct({
      sku: "CERT-P1",
      name: "Certified Part",
      stockQuantity: 10,
    });

    await attachCertificate({
      stockLotId: await lotOf(part.id),
      metadata: {
        certificateType: "EASA Form 1",
        certificateNumber: "E-77",
        issueDate: "2026-01-01",
        expiryDate: "",
      },
      file: new File(
        [new Uint8Array(Buffer.from("%PDF-1.7\ncert\n"))],
        "c.pdf",
        { type: "application/pdf" },
      ),
    });

    const before = await prisma.certificate.findFirstOrThrow();

    const purchase = await draftPurchase(supplier.id, [
      { productId: part.id, quantity: 25 },
    ]);
    await receivePurchase(purchase.id);
    await cancelPurchase(purchase.id);

    const after = await prisma.certificate.findFirstOrThrow();
    expect(after).toEqual(before);
    expect(await prisma.certificate.count()).toBe(1);
  });

  it("show the paperwork of the batch the delivery created", async () => {
    /*
     * The lot does not exist until the delivery is received, so an unreceived
     * purchase has nothing to show. Inventing coverage for goods that are not
     * here yet would be the same mistake as costing them before they arrive.
     */
    await signInWithRole("ADMIN");
    const supplier = await createSupplier();
    const part = await seedProduct({
      sku: "CERT-P2",
      name: "Certified Actuator",
      stockQuantity: 0,
    });

    const draft = await draftPurchase(supplier.id, [
      { productId: part.id, quantity: 5 },
    ]);

    const before = await getPurchaseDetail(draft.id);
    if (!before.ok || !before.data) throw new Error("expected a purchase");
    expect(before.data.lines[0]!.stockLotId).toBeNull();
    expect(before.data.lines[0]!.certificateStatus).toBe("MISSING");

    await receivePurchase(draft.id);
    const lotId = await lotOf(part.id);

    await attachCertificate({
      stockLotId: lotId,
      metadata: {
        certificateType: "FAA 8130-3",
        certificateNumber: "8130-5150",
        issueDate: "2026-01-01",
        expiryDate: "2030-01-01",
      },
      file: new File(
        [new Uint8Array(Buffer.from("%PDF-1.7\n"))],
        "c.pdf",
        { type: "application/pdf" },
      ),
    });

    const result = await getPurchaseDetail(draft.id);
    if (!result.ok || !result.data) throw new Error("expected a purchase");

    const line = result.data.lines[0]!;
    expect(line.stockLotId).toBe(lotId);
    expect(line.certificateType).toBe("FAA 8130-3");
    expect(line.certificateNumber).toBe("8130-5150");
    expect(line.certificateStatus).toBe("VALID");

    // Referenced, not duplicated.
    expect(await prisma.certificate.count()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The detail page, the list, and supplier history
// ---------------------------------------------------------------------------

describe("inventory impact", () => {
  it("reads the addition and the reversal from the ledger", async () => {
    await signInWithRole("STAFF");
    const supplier = await createSupplier();
    const part = await seedProduct({
      sku: "IMP-1",
      name: "Test Aviation Part",
      stockQuantity: 50,
    });

    const purchase = await draftPurchase(supplier.id, [
      { productId: part.id, quantity: 100 },
    ]);

    await receivePurchase(purchase.id);

    let result = await getPurchaseDetail(purchase.id);
    if (!result.ok || !result.data) throw new Error("expected a purchase");

    expect(result.data.impact).toHaveLength(1);
    expect(result.data.impact[0]).toMatchObject({
      productName: "Test Aviation Part",
      added: 100,
      addedFrom: 50,
      addedTo: 150,
      reversed: 0,
    });

    await cancelPurchase(purchase.id);

    result = await getPurchaseDetail(purchase.id);
    if (!result.ok || !result.data) throw new Error("expected a purchase");

    expect(result.data.impact[0]).toMatchObject({
      added: 100,
      reversed: 100,
      reversedFrom: 150,
      reversedTo: 50,
    });
  });
});

describe("supplier history", () => {
  it("counts purchases and sums what was actually received", async () => {
    await signInWithRole("STAFF");
    const supplier = await createSupplier("Aviation Spares Ltd");
    const part = await product("SUP-1", 0, "10.00");

    const received = await createPurchase({
      supplierId: supplier.id,
      items: [{ productId: part.id, quantity: 10, unitCost: "10.00" }],
    });
    await receivePurchase(received.id);

    // A draft is a plan and a cancelled purchase did not happen — neither
    // counts as money spent.
    await createPurchase({
      supplierId: supplier.id,
      items: [{ productId: part.id, quantity: 5, unitCost: "10.00" }],
    });

    const cancelled = await createPurchase({
      supplierId: supplier.id,
      items: [{ productId: part.id, quantity: 3, unitCost: "10.00" }],
    });
    await cancelPurchase(cancelled.id);

    const result = await getPurchaseDetail(received.id);
    if (!result.ok || !result.data) throw new Error("expected a purchase");

    const { supplier: summary } = result.data;
    expect(summary.name).toBe("Aviation Spares Ltd");
    expect(summary.purchaseCount).toBe(3);
    expect(summary.receivedCount).toBe(1);
    expect(Number(summary.totalPurchased)).toBe(100);
    expect(summary.recentPurchases).toHaveLength(3);
  });
});

describe("the purchases list", () => {
  it("filters by status and by supplier", async () => {
    await signInWithRole("STAFF");
    const one = await createSupplier("Alpha Parts");
    const two = await createSupplier("Bravo Components");
    const part = await product("L-1", 0);

    const receivedPurchase = await draftPurchase(one.id, [
      { productId: part.id, quantity: 1 },
    ]);
    await receivePurchase(receivedPurchase.id);
    await draftPurchase(two.id, [{ productId: part.id, quantity: 2 }]);

    const byStatus = await listPurchases({
      ...DEFAULT_PURCHASE_PARAMS,
      status: "RECEIVED",
    });
    if (!byStatus.ok) throw new Error("expected the list to load");
    expect(byStatus.data.items.map((r) => r.id)).toEqual([receivedPurchase.id]);

    const bySupplier = await listPurchases({
      ...DEFAULT_PURCHASE_PARAMS,
      supplierId: two.id,
    });
    if (!bySupplier.ok) throw new Error("expected the list to load");
    expect(bySupplier.data.items).toHaveLength(1);
    expect(bySupplier.data.items[0]!.supplierName).toBe("Bravo Components");
  });

  it("searches by purchase number and by supplier name", async () => {
    await signInWithRole("STAFF");
    const supplier = await createSupplier("Delta Aerospace");
    const part = await product("L-2", 0);
    const purchase = await draftPurchase(supplier.id, [
      { productId: part.id, quantity: 1 },
    ]);

    const byNumber = await listPurchases({
      ...DEFAULT_PURCHASE_PARAMS,
      search: purchase.purchaseNumber,
    });
    if (!byNumber.ok) throw new Error("expected the list to load");
    expect(byNumber.data.items).toHaveLength(1);

    const byName = await listPurchases({
      ...DEFAULT_PURCHASE_PARAMS,
      search: "delta",
    });
    if (!byName.ok) throw new Error("expected the list to load");
    expect(byName.data.items).toHaveLength(1);
  });

  it("reports who raised each purchase, and its line and unit counts", async () => {
    const user = await signInWithRole("STAFF");
    const supplier = await createSupplier();
    const a = await product("L-3", 0);
    const b = await product("L-4", 0);
    await draftPurchase(supplier.id, [
      { productId: a.id, quantity: 3 },
      { productId: b.id, quantity: 4 },
    ]);

    const result = await listPurchases(DEFAULT_PURCHASE_PARAMS);
    if (!result.ok) throw new Error("expected the list to load");

    expect(result.data.items[0]!.createdByName).toBe(user.name);
    expect(result.data.items[0]!.itemCount).toBe(2);
    expect(result.data.items[0]!.unitCount).toBe(7);
  });

  it("allocates unique numbers when purchases are raised together", async () => {
    await signInWithRole("STAFF");
    const supplier = await createSupplier();
    const part = await product("L-5", 0);

    const purchases = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        draftPurchase(supplier.id, [
          { productId: part.id, quantity: index + 1 },
        ]),
      ),
    );

    expect(new Set(purchases.map((p) => p.purchaseNumber)).size).toBe(5);
  });

  it("returns null for a purchase that does not exist", async () => {
    const result = await getPurchaseDetail("nope");
    expect(result).toEqual({ ok: true, data: null });
  });
});
