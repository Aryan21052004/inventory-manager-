import { beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import {
  cancelOrder,
  confirmOrder,
  createOrder,
  fulfilOrder,
  getOrderDetail,
} from "@/server/orders";
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

// ---------------------------------------------------------------------------
// What the order detail exposes about the cost side
// ---------------------------------------------------------------------------

/**
 * The cost currency reaching the order page.
 *
 * `OrderItem` already refuses to blend currencies — a line drawing from lots
 * that disagree degrades to uncosted rather than summing them — so the value
 * here is always at most one currency. What was missing was the *label*:
 * `OrderDetailLine` carried the total and not what it was denominated in, so
 * the page fell back on the installation default and asserted a currency it
 * had no grounds for.
 *
 * These tests pin the label, and pin the two facts that must stay independent:
 * the currency an order was *sold* in and the currency its stock was *bought*
 * in are unrelated, and physical fulfilment is unaffected by either.
 */
describe("the cost currency on an order line", () => {
  async function detailLines(orderId: string) {
    const result = await getOrderDetail(orderId);
    if (!result.ok || !result.data) throw new Error("expected the order");
    return result.data;
  }

  it("names the currency when the sale and the stock agree", async () => {
    await signInWithRole("ADMIN");
    const supplier = await createSupplier();
    const customer = await seedCustomer({ name: "Same Currency Ltd" });
    const part = await seedProduct({
      sku: "OC-SAME",
      sellingPrice: "100.00",
      stockQuantity: 0,
    });

    await receiveStock({
      productId: part.id,
      supplierId: supplier.id,
      quantity: 10,
      unitCost: "40.00",
      currency: "USD",
    });

    await setCurrency("USD");
    const order = await createOrder({
      customerId: customer.id,
      items: [{ productId: part.id, quantity: 5, unitPrice: "100.00" }],
    });
    await confirmOrder(order.id);

    const detail = await detailLines(order.id);
    const line = detail.lines[0]!;

    expect(detail.currency).toBe("USD");
    expect(line.costTotal).toBe("200");
    expect(line.costCurrency).toBe("USD");
    expect(line.costedQuantity).toBe(5);

    // Physical facts, unchanged by any of this.
    expect(line.quantity).toBe(5);
    expect(line.fulfilledQuantity).toBe(5);

    await expectCostPairingHolds();
  });

  it("keeps the sale and the stock currencies independent", async () => {
    await signInWithRole("ADMIN");
    const supplier = await createSupplier();
    const customer = await seedCustomer({ name: "Importer Ltd" });
    const part = await seedProduct({
      sku: "OC-DIFF",
      sellingPrice: "9000.00",
      stockQuantity: 0,
    });

    // Bought in dollars, sold in rupees — an ordinary importer.
    await receiveStock({
      productId: part.id,
      supplierId: supplier.id,
      quantity: 10,
      unitCost: "40.00",
      currency: "USD",
    });

    await setCurrency("INR");
    const order = await createOrder({
      customerId: customer.id,
      items: [{ productId: part.id, quantity: 4, unitPrice: "9000.00" }],
    });
    await confirmOrder(order.id);

    const detail = await detailLines(order.id);
    const line = detail.lines[0]!;

    /*
     * Both facts survive, separately. Neither is blended into the other, and
     * the page has everything it needs to refuse a margin rather than invent
     * one by subtracting across them.
     */
    expect(detail.currency).toBe("INR");
    expect(line.total).toBe("36000");
    expect(line.costTotal).toBe("160");
    expect(line.costCurrency).toBe("USD");
    expect(line.costedQuantity).toBe(4);
    expect(line.fulfilledQuantity).toBe(4);

    await expectCostPairingHolds();
  });

  it("gives each line of one order its own cost currency", async () => {
    await signInWithRole("ADMIN");
    const supplier = await createSupplier();
    const customer = await seedCustomer({ name: "Two Sources Ltd" });
    const dollarPart = await seedProduct({
      sku: "OC-USD",
      sellingPrice: "100.00",
      stockQuantity: 0,
    });
    const rupeePart = await seedProduct({
      sku: "OC-INR",
      sellingPrice: "100.00",
      stockQuantity: 0,
    });

    await receiveStock({
      productId: dollarPart.id,
      supplierId: supplier.id,
      quantity: 10,
      unitCost: "40.00",
      currency: "USD",
    });
    await receiveStock({
      productId: rupeePart.id,
      supplierId: supplier.id,
      quantity: 10,
      unitCost: "3000.00",
      currency: "INR",
    });

    await setCurrency("USD");
    const order = await createOrder({
      customerId: customer.id,
      items: [
        { productId: dollarPart.id, quantity: 2, unitPrice: "100.00" },
        { productId: rupeePart.id, quantity: 3, unitPrice: "100.00" },
      ],
    });
    await confirmOrder(order.id);

    const detail = await detailLines(order.id);
    const bySku = new Map(detail.lines.map((line) => [line.sku, line]));

    /*
     * One order, two cost currencies. This is where an order first becomes
     * multi-currency: each line is internally consistent, and no single figure
     * describes the pair.
     */
    expect(bySku.get("OC-USD")!.costCurrency).toBe("USD");
    expect(bySku.get("OC-USD")!.costTotal).toBe("80");
    expect(bySku.get("OC-INR")!.costCurrency).toBe("INR");
    expect(bySku.get("OC-INR")!.costTotal).toBe("9000");

    // Both lines shipped in full, whatever their money says.
    expect(bySku.get("OC-USD")!.fulfilledQuantity).toBe(2);
    expect(bySku.get("OC-USD")!.costedQuantity).toBe(2);
    expect(bySku.get("OC-INR")!.fulfilledQuantity).toBe(3);
    expect(bySku.get("OC-INR")!.costedQuantity).toBe(3);

    await expectCostPairingHolds();
  });

  it("reports no currency on a line whose batches disagreed", async () => {
    await signInWithRole("ADMIN");
    const supplier = await createSupplier();
    const customer = await seedCustomer({ name: "Mixed Batches Ltd" });
    const part = await seedProduct({
      sku: "OC-MIX",
      sellingPrice: "100.00",
      stockQuantity: 0,
    });

    await receiveStock({
      productId: part.id,
      supplierId: supplier.id,
      quantity: 5,
      unitCost: "40.00",
      currency: "USD",
    });
    await receiveStock({
      productId: part.id,
      supplierId: supplier.id,
      quantity: 5,
      unitCost: "3000.00",
      currency: "INR",
    });

    await setCurrency("USD");
    const order = await createOrder({
      customerId: customer.id,
      items: [{ productId: part.id, quantity: 8, unitPrice: "100.00" }],
    });
    await confirmOrder(order.id);

    const detail = await detailLines(order.id);
    const line = detail.lines[0]!;

    /*
     * The established behaviour, unchanged: rather than blend, the line gives
     * up its total entirely. The label now goes null with it.
     */
    expect(line.costTotal).toBeNull();
    expect(line.costCurrency).toBeNull();
    expect(line.costedQuantity).toBe(0);

    // The goods still shipped. Refusing a cost is not refusing a delivery.
    expect(line.fulfilledQuantity).toBe(8);
    expect(line.quantity).toBe(8);

    await expectCostPairingHolds();
  });

  it("reports no currency on a line drawn from stock nobody priced", async () => {
    await signInWithRole("ADMIN");
    const customer = await seedCustomer({ name: "Legacy Stock Ltd" });
    // `lotUnitCost: null` seeds stock that predates cost tracking.
    const part = await seedProduct({
      sku: "OC-NONE",
      sellingPrice: "100.00",
      stockQuantity: 10,
      lotUnitCost: null,
    });

    await setCurrency("USD");
    const order = await createOrder({
      customerId: customer.id,
      items: [{ productId: part.id, quantity: 6, unitPrice: "100.00" }],
    });
    await confirmOrder(order.id);

    const line = (await detailLines(order.id)).lines[0]!;

    expect(line.costTotal).toBeNull();
    expect(line.costCurrency).toBeNull();
    expect(line.costedQuantity).toBe(0);
    expect(line.fulfilledQuantity).toBe(6);

    await expectCostPairingHolds();
  });

  it("keeps a free delivery costed at a real zero, with its currency", async () => {
    await signInWithRole("ADMIN");
    const supplier = await createSupplier();
    const customer = await seedCustomer({ name: "Free Sample Ltd" });
    const part = await seedProduct({
      sku: "OC-ZERO",
      sellingPrice: "100.00",
      stockQuantity: 0,
    });

    await receiveStock({
      productId: part.id,
      supplierId: supplier.id,
      quantity: 10,
      unitCost: "0.00",
      currency: "EUR",
    });

    await setCurrency("EUR");
    const order = await createOrder({
      customerId: customer.id,
      items: [{ productId: part.id, quantity: 4, unitPrice: "100.00" }],
    });
    await confirmOrder(order.id);

    const line = (await detailLines(order.id)).lines[0]!;

    /*
     * Nothing was paid, which is a fact — and a different one from nobody
     * having recorded what was paid. A zero total keeps its currency and its
     * costed quantity, so the margin over it is real rather than refused.
     */
    expect(Number(line.costTotal)).toBe(0);
    expect(line.costTotal).not.toBeNull();
    expect(line.costCurrency).toBe("EUR");
    expect(line.costedQuantity).toBe(4);
    expect(line.fulfilledQuantity).toBe(4);

    await expectCostPairingHolds();
  });

  it("leaves coverage intact when the currency is the only thing missing", async () => {
    await signInWithRole("ADMIN");
    const supplier = await createSupplier();
    const customer = await seedCustomer({ name: "Partial Ltd" });
    const part = await seedProduct({
      sku: "OC-COVER",
      sellingPrice: "100.00",
      stockQuantity: 0,
    });

    // Five costed units in dollars, then five more in rupees: the line goes
    // indeterminate, but every physical number must survive it.
    await receiveStock({
      productId: part.id,
      supplierId: supplier.id,
      quantity: 5,
      unitCost: "40.00",
      currency: "USD",
    });
    await receiveStock({
      productId: part.id,
      supplierId: supplier.id,
      quantity: 5,
      unitCost: "3000.00",
      currency: "INR",
    });

    await setCurrency("USD");
    const order = await createOrder({
      customerId: customer.id,
      items: [{ productId: part.id, quantity: 10, unitPrice: "100.00" }],
    });
    await confirmOrder(order.id);

    const line = (await detailLines(order.id)).lines[0]!;

    expect(line.costCurrency).toBeNull();

    // Quantity, fulfilment, returns and the returnable window all stand.
    expect(line.quantity).toBe(10);
    expect(line.fulfilledQuantity).toBe(10);
    expect(line.returnedQuantity).toBe(0);
    expect(line.returnableQuantity).toBe(10);

    await expectCostPairingHolds();
  });
});
