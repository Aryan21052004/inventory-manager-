import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@clerk/nextjs/server", async () => {
  const { clerkServerMock } = await import("./clerk-mock");
  return clerkServerMock;
});

import { prisma } from "@/lib/prisma";
import { cancelOrder, confirmOrder, createOrder, fulfilOrder } from "@/server/orders";
import { createPurchase, receivePurchase } from "@/server/purchases";
import { setCurrency } from "@/server/settings";

import {
  createSupplier,
  expectConsumptionsReconcile,
  expectLotsReconcile,
  resetDatabase,
  seedCustomer,
  seedProduct,
  signInWithRole,
} from "./database";

/**
 * What a sale costs when its batches disagree about the currency.
 *
 * FIFO draws oldest-first and never reorders to chase a tidier answer, so one
 * order line can legitimately consume a batch bought in dollars and a batch
 * bought in rupees. Their sum is not a number in any currency, and the rule
 * this file exists to pin down is that the line says so rather than adding
 * them.
 *
 * The consumption rows are the other half of that rule. They keep every
 * layer's real rate and real currency, so refusing a single total loses
 * nothing — the cost of the sale is still fully reconstructible, just not as
 * one figure.
 */

/** Receives `quantity` units at `unitCost`, in a purchase raised in `currency`. */
async function receiveStock(params: {
  productId: string;
  supplierId: string;
  quantity: number;
  unitCost: string;
  currency: "USD" | "INR" | "EUR";
}): Promise<void> {
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

  /*
   * No hand-stamping of the currency: `createPurchase` seeds it from the
   * installation default, which `setCurrency` above has just moved. The
   * purchase therefore genuinely carries `params.currency`, and the lots it
   * receives inherit it through the real path rather than a test fixture.
   */
  await receivePurchase(purchase.id);
}

async function lineFor(orderId: string) {
  return prisma.orderItem.findFirstOrThrow({
    where: { orderId },
    select: {
      id: true,
      costTotal: true,
      costCurrency: true,
      costedQuantity: true,
      fulfilledQuantity: true,
    },
  });
}

async function consumptionsFor(orderId: string) {
  return prisma.stockLotConsumption.findMany({
    where: {
      stockTransaction: { referenceType: "ORDER", referenceId: orderId },
    },
    orderBy: { createdAt: "asc" },
    select: { quantity: true, unitCost: true, totalCost: true, costCurrency: true },
  });
}

/**
 * The invariants every one of these cases must leave behind, asserted together
 * so no test can satisfy its own headline while breaking the pairing.
 */
async function expectCostPairingHolds(): Promise<void> {
  const lines = await prisma.orderItem.findMany({
    select: { costTotal: true, costCurrency: true, costedQuantity: true },
  });

  for (const line of lines) {
    if (line.costCurrency !== null) expect(line.costTotal).not.toBeNull();
    if (line.costTotal === null) expect(line.costCurrency).toBeNull();
    if (line.costTotal === null) expect(line.costedQuantity).toBe(0);
  }

  const layers = await prisma.stockLotConsumption.findMany({
    select: { unitCost: true, costCurrency: true },
  });

  for (const layer of layers) {
    if (layer.unitCost === null) expect(layer.costCurrency).toBeNull();
  }
}

beforeEach(async () => {
  await resetDatabase();
});

describe("FIFO in one currency", () => {
  it("sums several same-currency lots and names the currency", async () => {
    await signInWithRole("ADMIN");
    const supplier = await createSupplier();
    const customer = await seedCustomer({ name: "Same currency" });
    const product = await seedProduct({ sku: "FIFO-1", stockQuantity: 0 });

    await receiveStock({
      productId: product.id,
      supplierId: supplier.id,
      quantity: 4,
      unitCost: "10.00",
      currency: "USD",
    });
    await receiveStock({
      productId: product.id,
      supplierId: supplier.id,
      quantity: 4,
      unitCost: "20.00",
      currency: "USD",
    });

    const order = await createOrder({
      customerId: customer.id,
      items: [{ productId: product.id, quantity: 6, unitPrice: "99.00" }],
    });
    await confirmOrder(order.id);

    const line = await lineFor(order.id);
    // 4 @ 10.00 + 2 @ 20.00
    expect(line.costTotal?.toString()).toBe("80");
    expect(line.costCurrency).toBe("USD");
    expect(line.costedQuantity).toBe(6);

    const layers = await consumptionsFor(order.id);
    expect(layers).toHaveLength(2);
    expect(layers.every((l) => l.costCurrency === "USD")).toBe(true);

    await expectCostPairingHolds();
    await expectLotsReconcile();
    await expectConsumptionsReconcile();
  });
});

describe("FIFO across currencies", () => {
  it("ships the goods but refuses a single cost figure", async () => {
    await signInWithRole("ADMIN");
    const supplier = await createSupplier();
    const customer = await seedCustomer({ name: "Mixed currency" });
    const product = await seedProduct({ sku: "FIFO-2", stockQuantity: 0 });

    await receiveStock({
      productId: product.id,
      supplierId: supplier.id,
      quantity: 4,
      unitCost: "10.00",
      currency: "USD",
    });
    await receiveStock({
      productId: product.id,
      supplierId: supplier.id,
      quantity: 4,
      unitCost: "700.00",
      currency: "INR",
    });

    const order = await createOrder({
      customerId: customer.id,
      items: [{ productId: product.id, quantity: 6, unitPrice: "99.00" }],
    });

    // The sale is physical and must not be blocked by a bookkeeping problem.
    await confirmOrder(order.id);

    const line = await lineFor(order.id);
    expect(line.fulfilledQuantity).toBe(6);
    expect(line.costTotal).toBeNull();
    expect(line.costCurrency).toBeNull();
    expect(line.costedQuantity).toBe(0);

    // Nothing was lost: both layers survive at their own rate and currency.
    const layers = await consumptionsFor(order.id);
    expect(layers).toHaveLength(2);
    expect(
      layers.map((l) => [l.unitCost?.toString(), l.costCurrency]),
    ).toEqual([
      ["10", "USD"],
      ["700", "INR"],
    ]);

    await expectCostPairingHolds();
    await expectLotsReconcile();
    await expectConsumptionsReconcile();
  });

  it("treats a costed layer with no recorded currency the same way", async () => {
    await signInWithRole("ADMIN");
    const supplier = await createSupplier();
    const customer = await seedCustomer({ name: "Legacy layer" });
    const product = await seedProduct({ sku: "FIFO-3", stockQuantity: 0 });

    await receiveStock({
      productId: product.id,
      supplierId: supplier.id,
      quantity: 5,
      unitCost: "10.00",
      currency: "USD",
    });

    /*
     * A legacy batch: a real cost whose currency predates the column. Written
     * directly because no application path can produce one any more, which is
     * the point — production has them and the costing layer has to cope.
     */
    await prisma.stockLot.updateMany({
      where: { productId: product.id },
      data: { costCurrency: null },
    });

    const order = await createOrder({
      customerId: customer.id,
      items: [{ productId: product.id, quantity: 3, unitPrice: "99.00" }],
    });
    await confirmOrder(order.id);

    const line = await lineFor(order.id);
    expect(line.fulfilledQuantity).toBe(3);
    expect(line.costTotal).toBeNull();
    expect(line.costCurrency).toBeNull();
    expect(line.costedQuantity).toBe(0);

    const layers = await consumptionsFor(order.id);
    expect(layers).toHaveLength(1);
    expect(layers[0]?.unitCost?.toString()).toBe("10");
    expect(layers[0]?.costCurrency).toBeNull();

    await expectCostPairingHolds();
  });
});

describe("fulfilling a line in stages", () => {
  it("accumulates while the currency holds", async () => {
    await signInWithRole("ADMIN");
    const supplier = await createSupplier();
    const customer = await seedCustomer({ name: "Staged same" });
    const product = await seedProduct({ sku: "FIFO-4", stockQuantity: 0 });

    await receiveStock({
      productId: product.id,
      supplierId: supplier.id,
      quantity: 3,
      unitCost: "10.00",
      currency: "USD",
    });

    const order = await createOrder({
      customerId: customer.id,
      items: [{ productId: product.id, quantity: 6, unitPrice: "99.00" }],
    });
    await confirmOrder(order.id);

    const first = await lineFor(order.id);
    expect(first.costTotal?.toString()).toBe("30");
    expect(first.costCurrency).toBe("USD");
    expect(first.costedQuantity).toBe(3);

    // A second delivery, same currency, then the rest of the line ships.
    await receiveStock({
      productId: product.id,
      supplierId: supplier.id,
      quantity: 3,
      unitCost: "12.00",
      currency: "USD",
    });

    await fulfilOrder(order.id, { lines: [{ orderItemId: first.id, quantity: 3 }] });

    const after = await lineFor(order.id);
    expect(after.costTotal?.toString()).toBe("66"); // 30 + 36
    expect(after.costCurrency).toBe("USD");
    expect(after.costedQuantity).toBe(6);

    await expectCostPairingHolds();
    await expectLotsReconcile();
    await expectConsumptionsReconcile();
  });

  it("gives up the total when a later stage arrives in another currency", async () => {
    await signInWithRole("ADMIN");
    const supplier = await createSupplier();
    const customer = await seedCustomer({ name: "Staged mixed" });
    const product = await seedProduct({ sku: "FIFO-5", stockQuantity: 0 });

    await receiveStock({
      productId: product.id,
      supplierId: supplier.id,
      quantity: 3,
      unitCost: "10.00",
      currency: "USD",
    });

    const order = await createOrder({
      customerId: customer.id,
      items: [{ productId: product.id, quantity: 6, unitPrice: "99.00" }],
    });
    await confirmOrder(order.id);

    const first = await lineFor(order.id);
    expect(first.costTotal?.toString()).toBe("30");
    expect(first.costCurrency).toBe("USD");

    await receiveStock({
      productId: product.id,
      supplierId: supplier.id,
      quantity: 3,
      unitCost: "800.00",
      currency: "INR",
    });

    await fulfilOrder(order.id, { lines: [{ orderItemId: first.id, quantity: 3 }] });

    const after = await lineFor(order.id);
    // Emphatically not 30 + 2400, and not 30 either.
    expect(after.costTotal).toBeNull();
    expect(after.costCurrency).toBeNull();
    expect(after.costedQuantity).toBe(0);
    expect(after.fulfilledQuantity).toBe(6);

    // Both stages survive intact on their own rows.
    const layers = await consumptionsFor(order.id);
    expect(
      layers.map((l) => [l.unitCost?.toString(), l.costCurrency]),
    ).toEqual([
      ["10", "USD"],
      ["800", "INR"],
    ]);

    await expectCostPairingHolds();
    await expectLotsReconcile();
    await expectConsumptionsReconcile();
  });

  it("does not resurrect a total once the line has gone indeterminate", async () => {
    await signInWithRole("ADMIN");
    const supplier = await createSupplier();
    const customer = await seedCustomer({ name: "Stays refused" });
    const product = await seedProduct({ sku: "FIFO-6", stockQuantity: 0 });

    await receiveStock({
      productId: product.id,
      supplierId: supplier.id,
      quantity: 2,
      unitCost: "10.00",
      currency: "USD",
    });
    await receiveStock({
      productId: product.id,
      supplierId: supplier.id,
      quantity: 2,
      unitCost: "900.00",
      currency: "INR",
    });

    const order = await createOrder({
      customerId: customer.id,
      items: [{ productId: product.id, quantity: 6, unitPrice: "99.00" }],
    });
    await confirmOrder(order.id);

    const mixed = await lineFor(order.id);
    expect(mixed.costTotal).toBeNull();
    expect(mixed.costedQuantity).toBe(0);

    /*
     * A third delivery, in the currency the line started in. The naive fix —
     * "the aggregate is null, so treat this as the first costed draw" — would
     * quietly produce a total covering two of six units and call the line
     * costed. It must stay refused: the earlier layers have not gone away.
     */
    await receiveStock({
      productId: product.id,
      supplierId: supplier.id,
      quantity: 2,
      unitCost: "11.00",
      currency: "USD",
    });

    await fulfilOrder(order.id, { lines: [{ orderItemId: mixed.id, quantity: 2 }] });

    const after = await lineFor(order.id);
    expect(after.costTotal).toBeNull();
    expect(after.costCurrency).toBeNull();
    expect(after.costedQuantity).toBe(0);
    expect(after.fulfilledQuantity).toBe(6);

    await expectCostPairingHolds();
  });
});

describe("cancellation", () => {
  it("clears the currency along with the total", async () => {
    await signInWithRole("ADMIN");
    const supplier = await createSupplier();
    const customer = await seedCustomer({ name: "Cancelled" });
    const product = await seedProduct({ sku: "FIFO-7", stockQuantity: 0 });

    await receiveStock({
      productId: product.id,
      supplierId: supplier.id,
      quantity: 5,
      unitCost: "10.00",
      currency: "USD",
    });

    const order = await createOrder({
      customerId: customer.id,
      items: [{ productId: product.id, quantity: 5, unitPrice: "99.00" }],
    });
    await confirmOrder(order.id);

    const before = await lineFor(order.id);
    expect(before.costTotal?.toString()).toBe("50");
    expect(before.costCurrency).toBe("USD");

    await cancelOrder(order.id, "Customer changed their mind");

    const after = await lineFor(order.id);
    expect(after.costTotal).toBeNull();
    expect(after.costCurrency).toBeNull();
    expect(after.costedQuantity).toBe(0);
    expect(after.fulfilledQuantity).toBe(0);

    await expectCostPairingHolds();
    await expectLotsReconcile();
  });

  it("gives the units back at the currency they left at", async () => {
    await signInWithRole("ADMIN");
    const supplier = await createSupplier();
    const customer = await seedCustomer({ name: "Reversed" });
    const product = await seedProduct({ sku: "FIFO-8", stockQuantity: 0 });

    await receiveStock({
      productId: product.id,
      supplierId: supplier.id,
      quantity: 5,
      unitCost: "10.00",
      currency: "USD",
    });

    const order = await createOrder({
      customerId: customer.id,
      items: [{ productId: product.id, quantity: 5, unitPrice: "99.00" }],
    });
    await confirmOrder(order.id);

    // The setting moves before the reversal: the negative rows must follow the
    // layer they reverse, not the default.
    await setCurrency("EUR");
    await cancelOrder(order.id, "Reversal currency check");

    const negatives = await prisma.stockLotConsumption.findMany({
      where: { quantity: { lt: 0 } },
      select: { unitCost: true, costCurrency: true },
    });

    expect(negatives.length).toBeGreaterThan(0);
    expect(negatives.every((row) => row.costCurrency === "USD")).toBe(true);

    await expectCostPairingHolds();
    await expectConsumptionsReconcile();
  });
});
