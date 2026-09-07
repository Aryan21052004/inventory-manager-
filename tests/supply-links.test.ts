import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@clerk/nextjs/server", async () => {
  const { clerkServerMock } = await import("./clerk-mock");
  return clerkServerMock;
});

import { prisma } from "@/lib/prisma";
import {
  cancelOrder,
  confirmOrder,
  createOrder,
  fulfilOrder,
  setOrderStatus,
} from "@/server/orders";
import {
  cancelPurchase,
  createPurchase,
  receivePurchase,
  setPurchaseStatus,
} from "@/server/purchases";
import {
  createSupplyLink,
  listLinkablePurchaseLines,
  listSupplyLinksForOrder,
  listSupplyLinksForPurchase,
  removeSupplyLink,
  updateSupplyLinkQuantity,
} from "@/server/supply-links";

import {
  createSupplier,
  expectFulfilmentReconciles,
  expectLotsReconcile,
  quoted,
  resetDatabase,
  seedCustomer,
  seedProduct,
  signInWithRole,
} from "./database";

/**
 * Supply links: which delivery is expected to clear which outstanding line.
 *
 * The whole feature is an expectation, and most of these tests exist to prove
 * that it stays one. A link must not create stock, consume any, cost anything,
 * touch a lot, write a ledger row or move a quantity on either document — so
 * the assertions below check what did *not* happen at least as often as what
 * did, and the receipt test is the sharpest of them: a linked delivery arriving
 * must leave the order exactly as outstanding as it was.
 *
 * The two allocation guards are aggregates, which is why they are enforced in
 * the server under row locks rather than by a constraint. That makes the
 * concurrency case load-bearing rather than decorative: two operators promising
 * the same units to different orders is the exact race the locks exist for.
 */

beforeEach(async () => {
  await resetDatabase();
});

/**
 * An order confirmed against an empty shelf, so its line is fully outstanding.
 *
 * Built through the real workflow rather than by writing rows, so the line
 * under test carries exactly what `confirmOrder` produces: `fulfilledQuantity`
 * of zero, no movement, no lot and no cost.
 */
async function outstandingOrder(sku: string, quantity: number) {
  const product = await seedProduct({ sku, stockQuantity: 0, sellingPrice: "500.00" });
  const customer = await seedCustomer({ name: `Buyer ${sku}` });

  const order = await createOrder({
    customerId: customer.id,
    items: await quoted([{ productId: product.id, quantity }]),
  });

  await confirmOrder(order.id);

  const line = await prisma.orderItem.findFirstOrThrow({
    where: { orderId: order.id },
  });

  expect(line.fulfilledQuantity).toBe(0);

  return { product, order, line };
}

/**
 * An order that has *not* committed, left in DRAFT or moved to PENDING.
 *
 * The line still has a non-zero `quantity - fulfilledQuantity`, which is the
 * point: the arithmetic looks like an outstanding quantity while the order has
 * promised nobody anything, and that is exactly the case the status guard has
 * to refuse.
 */
async function uncommittedOrder(sku: string, quantity: number, pending = false) {
  const product = await seedProduct({ sku, stockQuantity: 0, sellingPrice: "500.00" });
  const customer = await seedCustomer({ name: `Buyer ${sku}` });

  const order = await createOrder({
    customerId: customer.id,
    items: await quoted([{ productId: product.id, quantity }]),
  });

  if (pending) await setOrderStatus(order.id, "PENDING");

  const line = await prisma.orderItem.findFirstOrThrow({
    where: { orderId: order.id },
  });

  expect(line.fulfilledQuantity).toBe(0);

  return { product, order, line };
}

/**
 * A purchase for `productId`, left in whichever status the test needs.
 *
 * Defaults to RECEIVED because that is now the only linkable state: a pending
 * purchase's lines can still be edited, and `updatePurchase` replaces them
 * wholesale, so a link against one would be cascaded away without a word.
 *
 * Receiving adds stock, so tests that need an order to stay outstanding must
 * confirm the order *before* calling this — which is also the real sequence:
 * you sell what you do not hold, then the delivery turns up.
 */
async function purchaseFor(
  productId: string,
  quantity: number,
  status: "DRAFT" | "PENDING" | "RECEIVED" = "RECEIVED",
) {
  const supplier = await createSupplier(`Supplier ${Math.random().toString(36).slice(2, 8)}`);

  const purchase = await createPurchase({
    supplierId: supplier.id,
    items: [{ productId, quantity, unitCost: "40.00" }],
  });

  if (status === "PENDING") await setPurchaseStatus(purchase.id, "PENDING");
  if (status === "RECEIVED") await receivePurchase(purchase.id);

  const line = await prisma.purchaseItem.findFirstOrThrow({
    where: { purchaseId: purchase.id },
  });

  return { purchase, line };
}

async function linkCount() {
  return prisma.supplyLink.count();
}

// ---------------------------------------------------------------------------
// The happy paths
// ---------------------------------------------------------------------------

describe("creating a link", () => {
  it("records the expectation and moves nothing", async () => {
    await signInWithRole("STAFF");
    const { product, order, line } = await outstandingOrder("SL-1", 5);
    const { purchase, line: purchaseLine } = await purchaseFor(product.id, 5);

    const stockBefore = await prisma.product.findUniqueOrThrow({
      where: { id: product.id },
    });
    const ledgerBefore = await prisma.stockTransaction.count();
    const lotsBefore = await prisma.stockLot.count();
    const consumptionsBefore = await prisma.stockLotConsumption.count();

    const outcome = await createSupplyLink({
      orderItemId: line.id,
      purchaseItemId: purchaseLine.id,
      quantity: "5",
    });

    expect(outcome.quantity).toBe(5);
    expect(outcome.orderId).toBe(order.id);
    expect(outcome.purchaseId).toBe(purchase.id);

    const stored = await prisma.supplyLink.findUniqueOrThrow({
      where: { id: outcome.id },
    });
    expect(stored.quantity).toBe(5);
    expect(stored.orderItemId).toBe(line.id);
    expect(stored.purchaseItemId).toBe(purchaseLine.id);

    // Nothing about either document changed.
    const lineAfter = await prisma.orderItem.findUniqueOrThrow({
      where: { id: line.id },
    });
    expect(lineAfter.fulfilledQuantity).toBe(0);
    expect(lineAfter.quantity).toBe(5);
    expect(lineAfter.costTotal).toBeNull();
    expect(lineAfter.costedQuantity).toBe(0);

    const stockAfter = await prisma.product.findUniqueOrThrow({
      where: { id: product.id },
    });
    expect(stockAfter.stockQuantity).toBe(stockBefore.stockQuantity);

    // And nothing about stock changed either.
    expect(await prisma.stockTransaction.count()).toBe(ledgerBefore);
    expect(await prisma.stockLot.count()).toBe(lotsBefore);
    expect(await prisma.stockLotConsumption.count()).toBe(consumptionsBefore);

    await expectLotsReconcile();
    await expectFulfilmentReconciles();
  });

  it("surfaces on both documents", async () => {
    await signInWithRole("STAFF");
    const { product, order, line } = await outstandingOrder("SL-2", 4);
    const { purchase, line: purchaseLine } = await purchaseFor(product.id, 4);

    await createSupplyLink({
      orderItemId: line.id,
      purchaseItemId: purchaseLine.id,
      quantity: "3",
    });

    const fromOrder = await listSupplyLinksForOrder(order.id);
    const orderRows = fromOrder.get(line.id) ?? [];
    expect(orderRows).toHaveLength(1);
    expect(orderRows[0]!.purchaseId).toBe(purchase.id);
    expect(orderRows[0]!.quantity).toBe(3);
    expect(orderRows[0]!.purchaseStatus).toBe("RECEIVED");

    const fromPurchase = await listSupplyLinksForPurchase(purchase.id);
    const purchaseRows = fromPurchase.get(purchaseLine.id) ?? [];
    expect(purchaseRows).toHaveLength(1);
    expect(purchaseRows[0]!.orderId).toBe(order.id);
    expect(purchaseRows[0]!.quantity).toBe(3);
    // Outstanding is derived at read time, never stored.
    expect(purchaseRows[0]!.outstandingQuantity).toBe(4);
  });

  it("accepts a received purchase", async () => {
    await signInWithRole("STAFF");
    const { product, line } = await outstandingOrder("SL-3", 2);
    const { line: purchaseLine } = await purchaseFor(product.id, 2, "RECEIVED");

    const outcome = await createSupplyLink({
      orderItemId: line.id,
      purchaseItemId: purchaseLine.id,
      quantity: "2",
    });

    expect(outcome.quantity).toBe(2);
  });

  it("refuses a draft purchase", async () => {
    await signInWithRole("STAFF");
    const { product, line } = await outstandingOrder("SL-4", 2);
    const { line: purchaseLine } = await purchaseFor(product.id, 2, "DRAFT");

    await expect(
      createSupplyLink({
        orderItemId: line.id,
        purchaseItemId: purchaseLine.id,
        quantity: "2",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect(await linkCount()).toBe(0);
  });

  it("refuses a pending purchase", async () => {
    await signInWithRole("STAFF");
    const { product, line } = await outstandingOrder("SL-4B", 2);
    const { purchase, line: purchaseLine } = await purchaseFor(
      product.id,
      2,
      "PENDING",
    );

    const stored = await prisma.purchase.findUniqueOrThrow({
      where: { id: purchase.id },
    });
    expect(stored.status).toBe("PENDING");

    /*
     * The delivery is placed and in transit, which reads like exactly the case
     * a supply link is for — and is refused anyway. A pending purchase is still
     * editable, `updatePurchase` replaces its lines wholesale, and the cascade
     * would take the link with them without saying so.
     */
    await expect(
      createSupplyLink({
        orderItemId: line.id,
        purchaseItemId: purchaseLine.id,
        quantity: "2",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect(await linkCount()).toBe(0);
  });

  it("accepts the same delivery once it has been received", async () => {
    await signInWithRole("STAFF");
    const { product, line } = await outstandingOrder("SL-4C", 2);
    const { purchase, line: purchaseLine } = await purchaseFor(
      product.id,
      2,
      "PENDING",
    );

    await expect(
      createSupplyLink({
        orderItemId: line.id,
        purchaseItemId: purchaseLine.id,
        quantity: "2",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    await receivePurchase(purchase.id);

    // Receipt replaces no purchase lines, so the id is still good.
    const outcome = await createSupplyLink({
      orderItemId: line.id,
      purchaseItemId: purchaseLine.id,
      quantity: "2",
    });

    expect(outcome.quantity).toBe(2);
    expect(await linkCount()).toBe(1);
  });

  it("refuses a second link between the same two lines", async () => {
    await signInWithRole("STAFF");
    const { product, line } = await outstandingOrder("SL-5", 6);
    const { line: purchaseLine } = await purchaseFor(product.id, 6);

    await createSupplyLink({
      orderItemId: line.id,
      purchaseItemId: purchaseLine.id,
      quantity: "2",
    });

    await expect(
      createSupplyLink({
        orderItemId: line.id,
        purchaseItemId: purchaseLine.id,
        quantity: "1",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect(await linkCount()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------

describe("what a link refuses", () => {
  it("refuses two lines for different products", async () => {
    await signInWithRole("STAFF");
    const { line } = await outstandingOrder("SL-P1", 3);

    const other = await seedProduct({ sku: "SL-P2", stockQuantity: 0 });
    const { line: purchaseLine } = await purchaseFor(other.id, 3);

    await expect(
      createSupplyLink({
        orderItemId: line.id,
        purchaseItemId: purchaseLine.id,
        quantity: "1",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(await linkCount()).toBe(0);
  });

  it("refuses zero, negative and fractional quantities", async () => {
    await signInWithRole("STAFF");
    const { product, line } = await outstandingOrder("SL-Q", 5);
    const { line: purchaseLine } = await purchaseFor(product.id, 5);

    for (const quantity of ["0", "-2", "1.5", "", "two"]) {
      await expect(
        createSupplyLink({
          orderItemId: line.id,
          purchaseItemId: purchaseLine.id,
          quantity,
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }

    expect(await linkCount()).toBe(0);
  });

  it("refuses more than the order line still has outstanding", async () => {
    await signInWithRole("STAFF");
    const { product, line } = await outstandingOrder("SL-OUT", 3);
    const { line: purchaseLine } = await purchaseFor(product.id, 10);

    await expect(
      createSupplyLink({
        orderItemId: line.id,
        purchaseItemId: purchaseLine.id,
        quantity: "4",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(await linkCount()).toBe(0);
  });

  it("counts links already against the line when measuring outstanding", async () => {
    await signInWithRole("STAFF");
    const { product, line } = await outstandingOrder("SL-OUT2", 5);
    const first = await purchaseFor(product.id, 5);
    const second = await purchaseFor(product.id, 5);

    await createSupplyLink({
      orderItemId: line.id,
      purchaseItemId: first.line.id,
      quantity: "3",
    });

    // 5 outstanding, 3 already expected — 2 left, so 3 is one too many.
    await expect(
      createSupplyLink({
        orderItemId: line.id,
        purchaseItemId: second.line.id,
        quantity: "3",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    // Exactly the remainder is accepted.
    const outcome = await createSupplyLink({
      orderItemId: line.id,
      purchaseItemId: second.line.id,
      quantity: "2",
    });
    expect(outcome.quantity).toBe(2);
  });

  it("refuses more than the purchase line has unallocated", async () => {
    await signInWithRole("STAFF");
    const product = await seedProduct({ sku: "SL-ALLOC", stockQuantity: 0, sellingPrice: "500.00" });

    // Both orders committed against an empty shelf first, so both stay fully
    // outstanding when the delivery lands.
    const buyers = [];
    for (const suffix of ["a", "b"]) {
      const customer = await seedCustomer({ name: `Buyer ${suffix}` });
      const order = await createOrder({
        customerId: customer.id,
        items: await quoted([{ productId: product.id, quantity: 4 }]),
      });
      await confirmOrder(order.id);
      buyers.push(
        await prisma.orderItem.findFirstOrThrow({ where: { orderId: order.id } }),
      );
    }

    const { line: purchaseLine } = await purchaseFor(product.id, 4);

    await createSupplyLink({
      orderItemId: buyers[0]!.id,
      purchaseItemId: purchaseLine.id,
      quantity: "3",
    });

    // Four ordered, three promised — one left, so two is one too many.
    await expect(
      createSupplyLink({
        orderItemId: buyers[1]!.id,
        purchaseItemId: purchaseLine.id,
        quantity: "2",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    const outcome = await createSupplyLink({
      orderItemId: buyers[1]!.id,
      purchaseItemId: purchaseLine.id,
      quantity: "1",
    });
    expect(outcome.quantity).toBe(1);

    const total = await prisma.supplyLink.aggregate({
      where: { purchaseItemId: purchaseLine.id },
      _sum: { quantity: true },
    });
    expect(total._sum.quantity).toBe(4);
  });

  it("refuses a line with nothing outstanding", async () => {
    await signInWithRole("STAFF");
    const product = await seedProduct({
      sku: "SL-FULL",
      stockQuantity: 5,
      lotUnitCost: "20.00",
      sellingPrice: "500.00",
    });
    const customer = await seedCustomer({ name: "Fully served" });

    const order = await createOrder({
      customerId: customer.id,
      items: await quoted([{ productId: product.id, quantity: 5 }]),
    });
    await confirmOrder(order.id);

    const line = await prisma.orderItem.findFirstOrThrow({
      where: { orderId: order.id },
    });
    expect(line.fulfilledQuantity).toBe(5);

    const { line: purchaseLine } = await purchaseFor(product.id, 5);

    await expect(
      createSupplyLink({
        orderItemId: line.id,
        purchaseItemId: purchaseLine.id,
        quantity: "1",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("refuses a missing order line", async () => {
    await signInWithRole("STAFF");
    const product = await seedProduct({ sku: "SL-MISS1", stockQuantity: 0 });
    const { line: purchaseLine } = await purchaseFor(product.id, 2);

    await expect(
      createSupplyLink({
        orderItemId: "does-not-exist",
        purchaseItemId: purchaseLine.id,
        quantity: "1",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("refuses a missing purchase line", async () => {
    await signInWithRole("STAFF");
    const { line } = await outstandingOrder("SL-MISS2", 2);

    await expect(
      createSupplyLink({
        orderItemId: line.id,
        purchaseItemId: "does-not-exist",
        quantity: "1",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

// ---------------------------------------------------------------------------
// Update and removal
// ---------------------------------------------------------------------------

describe("changing a link", () => {
  it("raises and lowers the quantity", async () => {
    await signInWithRole("STAFF");
    const { product, line } = await outstandingOrder("SL-UP", 8);
    const { line: purchaseLine } = await purchaseFor(product.id, 8);

    const created = await createSupplyLink({
      orderItemId: line.id,
      purchaseItemId: purchaseLine.id,
      quantity: "3",
    });

    // Raising has to measure the other links, not this one — counting itself
    // would refuse an increase for exceeding a total it is inside.
    const raised = await updateSupplyLinkQuantity({
      supplyLinkId: created.id,
      quantity: "8",
    });
    expect(raised.quantity).toBe(8);

    const lowered = await updateSupplyLinkQuantity({
      supplyLinkId: created.id,
      quantity: "1",
    });
    expect(lowered.quantity).toBe(1);

    expect(await linkCount()).toBe(1);
  });

  it("refuses an update that would over-allocate", async () => {
    await signInWithRole("STAFF");
    const { product, line } = await outstandingOrder("SL-UP2", 10);
    const { line: purchaseLine } = await purchaseFor(product.id, 4);

    const created = await createSupplyLink({
      orderItemId: line.id,
      purchaseItemId: purchaseLine.id,
      quantity: "2",
    });

    await expect(
      updateSupplyLinkQuantity({ supplyLinkId: created.id, quantity: "5" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    const unchanged = await prisma.supplyLink.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(unchanged.quantity).toBe(2);
  });

  it("refuses an update to a missing link", async () => {
    await signInWithRole("STAFF");

    await expect(
      updateSupplyLinkQuantity({ supplyLinkId: "nope", quantity: "1" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("removes a link and frees the units it held", async () => {
    await signInWithRole("STAFF");
    const { product, line } = await outstandingOrder("SL-RM", 5);
    const { line: purchaseLine } = await purchaseFor(product.id, 5);

    const created = await createSupplyLink({
      orderItemId: line.id,
      purchaseItemId: purchaseLine.id,
      quantity: "5",
    });

    await removeSupplyLink(created.id);
    expect(await linkCount()).toBe(0);

    // The units are promised to nobody again.
    const again = await createSupplyLink({
      orderItemId: line.id,
      purchaseItemId: purchaseLine.id,
      quantity: "5",
    });
    expect(again.quantity).toBe(5);
  });

  it("refuses to remove a missing link", async () => {
    await signInWithRole("STAFF");
    await expect(removeSupplyLink("nope")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

describe("concurrency", () => {
  it("serialises two links promising the same units", async () => {
    await signInWithRole("STAFF");
    const product = await seedProduct({ sku: "SL-RACE", stockQuantity: 0, sellingPrice: "500.00" });

    const lines = [];
    for (const suffix of ["a", "b"]) {
      const customer = await seedCustomer({ name: `Racer ${suffix}` });
      const order = await createOrder({
        customerId: customer.id,
        items: await quoted([{ productId: product.id, quantity: 4 }]),
      });
      await confirmOrder(order.id);
      lines.push(
        await prisma.orderItem.findFirstOrThrow({ where: { orderId: order.id } }),
      );
    }

    const { line: purchaseLine } = await purchaseFor(product.id, 4);

    /*
     * Both promise three of the four units. The purchase row lock has to
     * serialise them: whichever commits second re-reads one unit free and is
     * refused. Six units must never be promised out of a delivery of four.
     */
    const results = await Promise.allSettled([
      createSupplyLink({
        orderItemId: lines[0]!.id,
        purchaseItemId: purchaseLine.id,
        quantity: "3",
      }),
      createSupplyLink({
        orderItemId: lines[1]!.id,
        purchaseItemId: purchaseLine.id,
        quantity: "3",
      }),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);

    const total = await prisma.supplyLink.aggregate({
      where: { purchaseItemId: purchaseLine.id },
      _sum: { quantity: true },
    });
    expect(total._sum.quantity).toBe(3);
  });

  it("serialises two links against the same outstanding line", async () => {
    await signInWithRole("STAFF");
    const { product, line } = await outstandingOrder("SL-RACE2", 4);
    const first = await purchaseFor(product.id, 4);
    const second = await purchaseFor(product.id, 4);

    const results = await Promise.allSettled([
      createSupplyLink({
        orderItemId: line.id,
        purchaseItemId: first.line.id,
        quantity: "3",
      }),
      createSupplyLink({
        orderItemId: line.id,
        purchaseItemId: second.line.id,
        quantity: "3",
      }),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);

    const total = await prisma.supplyLink.aggregate({
      where: { orderItemId: line.id },
      _sum: { quantity: true },
    });
    // Never more than the four outstanding.
    expect(total._sum.quantity).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

describe("cancellation clears expectations", () => {
  it("drops an order's links when the order is cancelled", async () => {
    await signInWithRole("STAFF");
    const { product, order, line } = await outstandingOrder("SL-CO", 3);
    const { line: purchaseLine } = await purchaseFor(product.id, 3);

    await createSupplyLink({
      orderItemId: line.id,
      purchaseItemId: purchaseLine.id,
      quantity: "3",
    });
    expect(await linkCount()).toBe(1);

    await cancelOrder(order.id, "Customer changed their mind");

    expect(await linkCount()).toBe(0);
    // The purchase itself is untouched — it is still arriving.
    const purchaseLineAfter = await prisma.purchaseItem.findUniqueOrThrow({
      where: { id: purchaseLine.id },
    });
    expect(purchaseLineAfter.quantity).toBe(3);

    await expectLotsReconcile();
    await expectFulfilmentReconciles();
  });

  it("drops a purchase's links when the purchase is cancelled", async () => {
    await signInWithRole("STAFF");
    const { product, order, line } = await outstandingOrder("SL-CP", 3);
    const { purchase, line: purchaseLine } = await purchaseFor(product.id, 3);

    await createSupplyLink({
      orderItemId: line.id,
      purchaseItemId: purchaseLine.id,
      quantity: "3",
    });

    await cancelPurchase(purchase.id, "Supplier cannot deliver");

    expect(await linkCount()).toBe(0);
    // The order still owes what it owed; only the expectation is gone.
    const lineAfter = await prisma.orderItem.findUniqueOrThrow({
      where: { id: line.id },
    });
    expect(lineAfter.quantity).toBe(3);
    expect(lineAfter.fulfilledQuantity).toBe(0);

    const orderAfter = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
    });
    expect(orderAfter.status).toBe("CONFIRMED");

    await expectLotsReconcile();
  });

  it("refuses a link against a cancelled order", async () => {
    await signInWithRole("STAFF");
    const { product, order, line } = await outstandingOrder("SL-CO2", 3);
    const { line: purchaseLine } = await purchaseFor(product.id, 3);

    await cancelOrder(order.id);

    await expect(
      createSupplyLink({
        orderItemId: line.id,
        purchaseItemId: purchaseLine.id,
        quantity: "1",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("refuses a link against a draft order", async () => {
    await signInWithRole("STAFF");
    const { product, line } = await uncommittedOrder("SL-DRAFT", 4);
    const { line: purchaseLine } = await purchaseFor(product.id, 4);

    /*
     * The subtraction says four units are unshipped, but a draft has committed
     * to nothing — and its lines are replaced wholesale by any edit, which
     * would cascade a link away without a word.
     */
    await expect(
      createSupplyLink({
        orderItemId: line.id,
        purchaseItemId: purchaseLine.id,
        quantity: "2",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect(await linkCount()).toBe(0);
  });

  it("refuses a link against a pending order", async () => {
    await signInWithRole("STAFF");
    const { product, order, line } = await uncommittedOrder("SL-PENDING", 4, true);
    const { line: purchaseLine } = await purchaseFor(product.id, 4);

    const stored = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(stored.status).toBe("PENDING");

    await expect(
      createSupplyLink({
        orderItemId: line.id,
        purchaseItemId: purchaseLine.id,
        quantity: "2",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect(await linkCount()).toBe(0);
  });

  it("accepts the same line once the order is confirmed", async () => {
    await signInWithRole("STAFF");
    const { product, order, line } = await uncommittedOrder("SL-THEN", 4);

    /*
     * Two units on the shelf against an order for four, so confirmation ships
     * what exists and leaves two outstanding — which is what the link is then
     * allowed to cover.
     */
    const { line: purchaseLine } = await purchaseFor(product.id, 2);

    await expect(
      createSupplyLink({
        orderItemId: line.id,
        purchaseItemId: purchaseLine.id,
        quantity: "2",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    await confirmOrder(order.id);

    const confirmedLine = await prisma.orderItem.findFirstOrThrow({
      where: { orderId: order.id },
    });
    expect(confirmedLine.fulfilledQuantity).toBe(2);

    // The same request, refused a moment ago, is now the ordinary case.
    const outcome = await createSupplyLink({
      orderItemId: confirmedLine.id,
      purchaseItemId: purchaseLine.id,
      quantity: "2",
    });

    expect(outcome.quantity).toBe(2);
    expect(await linkCount()).toBe(1);
  });

  it("refuses a link against a cancelled purchase", async () => {
    await signInWithRole("STAFF");
    const { product, line } = await outstandingOrder("SL-CP2", 3);
    const { purchase, line: purchaseLine } = await purchaseFor(product.id, 3);

    await cancelPurchase(purchase.id);

    await expect(
      createSupplyLink({
        orderItemId: line.id,
        purchaseItemId: purchaseLine.id,
        quantity: "1",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

// ---------------------------------------------------------------------------
// The line this feature must not cross
// ---------------------------------------------------------------------------

describe("a link stays advisory", () => {
  it("earmarking an arrived delivery fulfils nothing", async () => {
    await signInWithRole("STAFF");
    const { product, line } = await outstandingOrder("SL-ADV", 5);
    // Received first — the only state a link may point at now, so the stock is
    // already on the shelf before the expectation is recorded.
    const { line: purchaseLine } = await purchaseFor(product.id, 5);

    await createSupplyLink({
      orderItemId: line.id,
      purchaseItemId: purchaseLine.id,
      quantity: "5",
    });

    /*
     * The units are on the shelf and the link says who is waiting for them.
     * Neither fact ships anything: `fulfilOrder` is an operator action, because
     * choosing which of several waiting orders gets a short delivery is a
     * commercial decision this system has no grounds to make.
     */
    const lineAfter = await prisma.orderItem.findUniqueOrThrow({
      where: { id: line.id },
    });
    expect(lineAfter.fulfilledQuantity).toBe(0);
    expect(lineAfter.costTotal).toBeNull();
    expect(lineAfter.costedQuantity).toBe(0);

    // The stock arrived exactly as it would have without any link.
    const stock = await prisma.product.findUniqueOrThrow({
      where: { id: product.id },
    });
    expect(stock.stockQuantity).toBe(5);

    // One receipt movement, one lot, and nothing consumed from it.
    const movements = await prisma.stockTransaction.findMany({
      where: { productId: product.id },
    });
    expect(movements).toHaveLength(1);
    expect(movements[0]!.type).toBe("STOCK_IN");
    expect(movements[0]!.referenceType).toBe("PURCHASE");

    const lots = await prisma.stockLot.findMany({ where: { productId: product.id } });
    expect(lots).toHaveLength(1);
    expect(lots[0]!.quantityRemaining).toBe(5);
    expect(lots[0]!.costSource).toBe("PURCHASE");

    expect(
      await prisma.stockLotConsumption.count({ where: { lotId: lots[0]!.id } }),
    ).toBe(0);

    // The link is still there, still saying what it said.
    expect(await linkCount()).toBe(1);

    await expectLotsReconcile();
    await expectFulfilmentReconciles();
  });

  it("does not disturb FIFO or the cost of a later fulfilment", async () => {
    await signInWithRole("STAFF");
    const { product, order, line } = await outstandingOrder("SL-FIFO", 4);

    // Two deliveries at two prices. The link names the *second*, which FIFO
    // must still ignore in favour of the older batch.
    const supplier = await createSupplier("Two-price supplier");

    const older = await createPurchase({
      supplierId: supplier.id,
      items: [{ productId: product.id, quantity: 4, unitCost: "10.00" }],
    });
    await receivePurchase(older.id);

    const newer = await createPurchase({
      supplierId: supplier.id,
      items: [{ productId: product.id, quantity: 4, unitCost: "99.00" }],
    });
    await receivePurchase(newer.id);

    const newerLine = await prisma.purchaseItem.findFirstOrThrow({
      where: { purchaseId: newer.id },
    });

    await createSupplyLink({
      orderItemId: line.id,
      purchaseItemId: newerLine.id,
      quantity: "4",
    });

    await fulfilOrder(order.id, {
      lines: [{ orderItemId: line.id, quantity: 4 }],
    });

    const lineAfter = await prisma.orderItem.findUniqueOrThrow({
      where: { id: line.id },
    });

    // Costed from the older batch at 10.00, not from the linked one at 99.00.
    expect(lineAfter.fulfilledQuantity).toBe(4);
    expect(Number(lineAfter.costTotal)).toBe(40);
    expect(lineAfter.costedQuantity).toBe(4);

    await expectLotsReconcile();
    await expectFulfilmentReconciles();
  });
});

// ---------------------------------------------------------------------------
// The picker
// ---------------------------------------------------------------------------

describe("linkable purchase lines", () => {
  it("offers only eligible lines, with what is left of each", async () => {
    await signInWithRole("STAFF");
    const { product, line } = await outstandingOrder("SL-PICK", 6);

    const draft = await purchaseFor(product.id, 5, "DRAFT");
    const pending = await purchaseFor(product.id, 5, "PENDING");
    const received = await purchaseFor(product.id, 5, "RECEIVED");
    const second = await purchaseFor(product.id, 5, "RECEIVED");

    const other = await seedProduct({ sku: "SL-PICK-OTHER", stockQuantity: 0 });
    await purchaseFor(other.id, 5, "RECEIVED");

    await createSupplyLink({
      orderItemId: line.id,
      purchaseItemId: received.line.id,
      quantity: "2",
    });

    const options = await listLinkablePurchaseLines(line.id);
    const ids = options.map((option) => option.purchaseItemId);

    expect(ids).toContain(received.line.id);
    expect(ids).toContain(second.line.id);
    // A draft has not been placed with anybody, a pending delivery has not
    // arrived, and another part is not ours.
    expect(ids).not.toContain(draft.line.id);
    expect(ids).not.toContain(pending.line.id);
    expect(ids).toHaveLength(2);

    const offered = options.find((o) => o.purchaseItemId === received.line.id)!;
    expect(offered.quantity).toBe(5);
    expect(offered.unallocatedQuantity).toBe(3);
  });

  it("drops a line once every unit is promised", async () => {
    await signInWithRole("STAFF");
    const { product, line } = await outstandingOrder("SL-PICK2", 5);
    const { line: purchaseLine } = await purchaseFor(product.id, 5);

    await createSupplyLink({
      orderItemId: line.id,
      purchaseItemId: purchaseLine.id,
      quantity: "5",
    });

    expect(await listLinkablePurchaseLines(line.id)).toEqual([]);
  });
});
