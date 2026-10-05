import { beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { cancelOrder, confirmOrder, createOrder } from "@/server/orders";
import { createPurchase, receivePurchase } from "@/server/purchases";

import { signOutSupabase } from "./supabase-auth-mock";
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
 * Reversal netting: a document's reversals count against its own draws.
 *
 * `returnToLots` decides how many units a reversal puts back into each batch,
 * and it does that by netting the consumption rows written against the
 * document's movements. It used to be given only the outbound half of those
 * movements, which made a prior REVERSAL's negative rows — written against the
 * *reversal's* transaction id — invisible to it. The draw then looked larger
 * than it was and the lots were over-restored.
 *
 * That produced two failures, and only one of them announced itself:
 *
 *   Where the document was a lot's sole consumer, the over-restore pushed
 *   `quantityRemaining` past `quantityReceived` and the check constraint
 *   refused the write. Loud, and harmless.
 *
 *   Where another document had since drawn from the same lot, the lot had
 *   room to absorb the excess. Nothing was refused, and
 *   `SUM(quantityRemaining)` quietly stopped equalling `Product.stockQuantity`.
 *
 * Both shapes need a second REVERSAL against one order, and **no application
 * code writes one**. `cancelOrder` is the only writer of an ORDER-referenced
 * reversal, it runs once, and the status it moves to is terminal — so neither
 * shape has a reachable trigger, and with returns out of scope (HANDOVER §8)
 * none is coming.
 *
 * These tests are kept anyway, and it is worth being clear about what they are
 * for. They are not guarding against a live bug. They pin the netting as
 * correct *by construction* rather than correct by accident, and they prove the
 * shortfall guard turns a class of silent I-1 corruption into a loud failure.
 * `simulateSecondReversal` builds the state by hand for that reason and for no
 * other — it is a test fixture, not a sketch of a feature.
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

async function stockOf(productId: string) {
  const row = await prisma.product.findUniqueOrThrow({
    where: { id: productId },
  });
  return row.stockQuantity;
}

async function sellAndConfirm(
  customerId: string,
  productId: string,
  quantity: number,
) {
  const order = await createOrder({
    customerId,
    items: await quoted([{ productId, quantity }]),
  });
  await confirmOrder(order.id);
  return order;
}

/**
 * A second REVERSAL against an order, built by hand: the ledger row, negative
 * consumption rows against the batches that were drawn, and the balances moved
 * to match.
 *
 * **Nothing in the application does this**, and nothing is going to — see the
 * note at the top of this file. It exists to put the netting in a state it
 * would otherwise never be asked to handle, so that the arithmetic can be
 * asserted rather than assumed.
 *
 * The order *line* is brought along only so far as the check constraints
 * require. These tests assert lot and stock behaviour; how a line ought to
 * record units coming back is not a question this codebase answers.
 */
async function simulateSecondReversal(params: {
  orderId: string;
  productId: string;
  quantity: number;
  /**
   * Move the ledger but not the lots, leaving the two disagreeing.
   *
   * Not a coherent state at all — it is how the over-restore guard is
   * provoked without having to corrupt a lot row directly.
   */
  ledgerOnly?: boolean;
}) {
  const product = await prisma.product.findUniqueOrThrow({
    where: { id: params.productId },
  });

  const reversal = await prisma.stockTransaction.create({
    data: {
      productId: params.productId,
      type: "REVERSAL",
      quantity: params.quantity,
      previousStock: product.stockQuantity,
      newStock: product.stockQuantity + params.quantity,
      referenceType: "ORDER",
      referenceId: params.orderId,
      note: "Synthetic second reversal — test fixture",
    },
  });

  await prisma.product.update({
    where: { id: params.productId },
    data: { stockQuantity: product.stockQuantity + params.quantity },
  });

  if (params.ledgerOnly) return reversal;

  // Back into the batches this order drew from, newest draw first.
  const draws = await prisma.stockLotConsumption.findMany({
    where: {
      quantity: { gt: 0 },
      lot: { productId: params.productId },
      stockTransaction: {
        referenceType: "ORDER",
        referenceId: params.orderId,
        type: "STOCK_OUT",
      },
    },
    include: { lot: true },
    orderBy: { id: "desc" },
  });

  let outstanding = params.quantity;
  let returnedCosted = 0;
  let returnedCostCents = 0;

  for (const draw of draws) {
    if (outstanding <= 0) break;
    const take = Math.min(outstanding, draw.quantity);

    await prisma.stockLot.update({
      where: { id: draw.lotId },
      data: { quantityRemaining: { increment: take } },
    });

    await prisma.stockLotConsumption.create({
      data: {
        lotId: draw.lotId,
        stockTransactionId: reversal.id,
        quantity: -take,
        unitCost: draw.lot.unitCost,
        totalCost:
          draw.lot.unitCost === null
            ? null
            : draw.lot.unitCost.mul(-take).toFixed(2),
      },
    });

    if (draw.lot.unitCost !== null) {
      returnedCosted += take;
      returnedCostCents += Math.round(Number(draw.lot.unitCost) * 100) * take;
    }

    outstanding -= take;
  }

  /*
   * Bring the line back in step with the ledger.
   *
   * Both quantities have to move together, not just the fulfilled one:
   * `order_items_costed_within_fulfilled` will not let a line claim to have
   * costed more units than it shipped, and it catches this fixture
   * immediately if only `fulfilledQuantity` is decremented. Cost comes off at
   * what the returned units actually cost, read from the batches they went
   * back to — the same rule the rest of the system follows, never a rate.
   *
   * This is simply the arrangement that keeps every existing constraint
   * satisfied, which is all these tests need it to be.
   */
  const line = await prisma.orderItem.findFirstOrThrow({
    where: { orderId: params.orderId, productId: params.productId },
  });

  const costedQuantity = Math.max(0, line.costedQuantity - returnedCosted);
  const costTotalCents =
    Math.round(Number(line.costTotal ?? 0) * 100) - returnedCostCents;

  await prisma.orderItem.update({
    where: { id: line.id },
    data: {
      fulfilledQuantity: line.fulfilledQuantity - params.quantity,
      costedQuantity,
      // The pairing constraint: no costed units means no total, never a zero.
      costTotal: costedQuantity === 0 ? null : (costTotalCents / 100).toFixed(2),
    },
  });

  return reversal;
}

describe("cancelling an order that was already partly reversed", () => {
  it("restores only the remainder when this order was the lot's sole consumer", async () => {
    await signInWithRole("ADMIN");
    const supplier = await createSupplier();
    const buyer = await customer();
    const a = await part("A-1");

    await receive(supplier.id, a.id, 10, "8000.00");
    const order = await sellAndConfirm(buyer.id, a.id, 10);

    // Three units go back to the shelf before the order is cancelled.
    await simulateSecondReversal({
      orderId: order.id,
      productId: a.id,
      quantity: 3,
    });

    expect(await stockOf(a.id)).toBe(3);
    expect((await lotsOf(a.id))[0]!.quantityRemaining).toBe(3);

    await cancelOrder(order.id);

    /*
     * Seven, not ten. Netting only the STOCK_OUT rows would have tried to put
     * all ten back into a batch that received ten and already held three —
     * which the check constraint would have refused outright, taking the whole
     * cancellation down with it.
     */
    expect(await stockOf(a.id)).toBe(10);
    expect((await lotsOf(a.id))[0]!.quantityRemaining).toBe(10);

    await expectLotsReconcile();
    await expectConsumptionsReconcile();
  });

  it("restores only the remainder when another order has since drawn from the same lot", async () => {
    await signInWithRole("ADMIN");
    const supplier = await createSupplier();
    const buyer = await customer();
    const a = await part("A-1");

    await receive(supplier.id, a.id, 10, "8000.00");

    const first = await sellAndConfirm(buyer.id, a.id, 5);
    await simulateSecondReversal({
      orderId: first.id,
      productId: a.id,
      quantity: 2,
    });

    // A second order draws from the same batch, giving it headroom.
    await sellAndConfirm(buyer.id, a.id, 4);

    expect(await stockOf(a.id)).toBe(3);
    expect((await lotsOf(a.id))[0]!.quantityRemaining).toBe(3);

    await cancelOrder(first.id);

    /*
     * The silent half of the bug. Five went out and two came back, so three
     * are owed — and the lot had room to absorb an extra two without
     * breaching its received quantity, so nothing would have complained.
     * `SUM(quantityRemaining)` would simply have stopped equalling
     * `stockQuantity`, with no error raised anywhere.
     */
    expect(await stockOf(a.id)).toBe(6);
    expect((await lotsOf(a.id))[0]!.quantityRemaining).toBe(6);

    await expectLotsReconcile();
    await expectConsumptionsReconcile();
  });

  it("nets per lot when the order drew across two batches at two prices", async () => {
    await signInWithRole("ADMIN");
    const supplier = await createSupplier();
    const buyer = await customer();
    const a = await part("A-1");

    await receive(supplier.id, a.id, 6, "8000.00");
    await receive(supplier.id, a.id, 6, "12000.00");

    // FIFO: all six of the older batch, then three of the newer.
    const order = await sellAndConfirm(buyer.id, a.id, 9);

    const drawn = await lotsOf(a.id);
    expect(drawn[0]!.quantityRemaining).toBe(0);
    expect(drawn[1]!.quantityRemaining).toBe(3);

    // Three units go back, allocated to the newest draw first.
    await simulateSecondReversal({
      orderId: order.id,
      productId: a.id,
      quantity: 3,
    });

    expect((await lotsOf(a.id))[1]!.quantityRemaining).toBe(6);

    await cancelOrder(order.id);

    // The six still outstanding belong to the older batch and go back there.
    const after = await lotsOf(a.id);
    expect(after[0]!.quantityRemaining).toBe(6);
    expect(after[1]!.quantityRemaining).toBe(6);
    expect(await stockOf(a.id)).toBe(12);

    await expectLotsReconcile();
    await expectConsumptionsReconcile();
  });

  it("puts units back into their own batch at their own cost, not at the newest price", async () => {
    await signInWithRole("ADMIN");
    const supplier = await createSupplier();
    const buyer = await customer();
    const a = await part("A-1");

    await receive(supplier.id, a.id, 5, "8000.00");
    const order = await sellAndConfirm(buyer.id, a.id, 5);

    // A more expensive delivery lands between the sale and the cancellation.
    await receive(supplier.id, a.id, 5, "11000.00");

    await simulateSecondReversal({
      orderId: order.id,
      productId: a.id,
      quantity: 2,
    });
    await cancelOrder(order.id);

    const lots = await lotsOf(a.id);

    // No batch was invented at today's price to hold the returned units.
    expect(lots).toHaveLength(2);
    expect(lots[0]!.unitCost?.toString()).toBe("8000");
    expect(lots[0]!.quantityRemaining).toBe(5);
    expect(lots[1]!.unitCost?.toString()).toBe("11000");
    expect(lots[1]!.quantityRemaining).toBe(5);

    await expectLotsReconcile();
    await expectConsumptionsReconcile();
  });
});

describe("cancelling twice", () => {
  it("restores nothing the second time and says so", async () => {
    await signInWithRole("ADMIN");
    const supplier = await createSupplier();
    const buyer = await customer();
    const a = await part("A-1");

    await receive(supplier.id, a.id, 10, "8000.00");
    const order = await sellAndConfirm(buyer.id, a.id, 10);

    const first = await cancelOrder(order.id);
    expect(first.alreadyInState).toBe(false);

    const movementsAfterFirst = await prisma.stockTransaction.count({
      where: { productId: a.id },
    });
    const consumptionsAfterFirst = await prisma.stockLotConsumption.count();

    const second = await cancelOrder(order.id);

    expect(second.alreadyInState).toBe(true);
    expect(second.movements).toEqual([]);

    // Nothing was written, and nothing moved a second time.
    expect(
      await prisma.stockTransaction.count({ where: { productId: a.id } }),
    ).toBe(movementsAfterFirst);
    expect(await prisma.stockLotConsumption.count()).toBe(
      consumptionsAfterFirst,
    );
    expect(await stockOf(a.id)).toBe(10);
    expect((await lotsOf(a.id))[0]!.quantityRemaining).toBe(10);

    await expectLotsReconcile();
    await expectConsumptionsReconcile();
  });

  it("is idempotent even when the order was partly reversed first", async () => {
    await signInWithRole("ADMIN");
    const supplier = await createSupplier();
    const buyer = await customer();
    const a = await part("A-1");

    await receive(supplier.id, a.id, 8, "9500.00");
    const order = await sellAndConfirm(buyer.id, a.id, 8);

    await simulateSecondReversal({
      orderId: order.id,
      productId: a.id,
      quantity: 3,
    });

    await cancelOrder(order.id);
    await cancelOrder(order.id);

    expect(await stockOf(a.id)).toBe(8);
    expect((await lotsOf(a.id))[0]!.quantityRemaining).toBe(8);

    await expectLotsReconcile();
    await expectConsumptionsReconcile();
  });
});

describe("a reversal that would over-restore its lots", () => {
  it("refuses rather than clamping the discrepancy away", async () => {
    await signInWithRole("ADMIN");
    const supplier = await createSupplier();
    const buyer = await customer();
    const a = await part("A-1");

    await receive(supplier.id, a.id, 10, "8000.00");
    const order = await sellAndConfirm(buyer.id, a.id, 10);

    /*
     * A reversal recorded in the ledger with no matching lot return, so the
     * consumption rows claim more is outstanding than the ledger says.
     * Cancelling now would put ten units back into the lots while restoring
     * only seven to the balance.
     *
     * This used to be swallowed by `Math.max(0, shortfall)`. The lots had
     * already been incremented by the time the negative was clamped, so the
     * discrepancy became permanent and silent. It now fails the transaction.
     */
    await simulateSecondReversal({
      orderId: order.id,
      productId: a.id,
      quantity: 3,
      ledgerOnly: true,
    });

    await expect(cancelOrder(order.id)).rejects.toMatchObject({
      code: "INTERNAL",
    });

    // Rolled back entirely: the order is still confirmed and no lot moved.
    const after = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
    });
    expect(after.status).toBe("CONFIRMED");
    expect((await lotsOf(a.id))[0]!.quantityRemaining).toBe(0);
  });
});
