import { beforeEach, describe, expect, it } from "vitest";

import {
  canTransitionLot,
  lotTransitionRefusal,
  QUARANTINED_LOT_STATUS,
  REJECTED_LOT_STATUS,
  SALEABLE_LOT_STATUS,
} from "@/lib/lot-status";
import { prisma } from "@/lib/prisma";
import {
  listQuarantinedLots,
  releaseLot,
  rejectLot,
  writeOffLot,
} from "@/server/lots";
import { confirmOrder, createOrder } from "@/server/orders";
import { recordSalesReturn } from "@/server/returns";

import { signOutSupabase } from "./supabase-auth-mock";
import {
  expectConsumptionsReconcile,
  expectLotsReconcile,
  quoted,
  resetDatabase,
  seedProduct,
  signInWithRole,
} from "./database";

/**
 * Inspection: what happens to a returned batch after somebody looks at it.
 *
 * Three decisions in a strict order — quarantined, then released or condemned,
 * then destroyed — and every one of them irreversible. The tests below are
 * mostly about the refusals, because that is where this feature is load-bearing:
 * a release that should not have happened puts unsaleable stock on the shelf,
 * and a write-off aimed at the wrong batch destroys good units' cost basis while
 * every invariant still reconciles and nothing looks wrong.
 *
 * The write-off is the sharp edge. A rejected batch is invisible to FIFO, so a
 * generic decrease against the product would consume the *saleable* batches
 * beside it. Several tests below assert not just that the right batch shrank but
 * that the others did not.
 */

beforeEach(async () => {
  signOutSupabase();
  await resetDatabase();
});

const BASE = new Date("2026-04-01T00:00:00.000Z");

async function addLot(
  productId: string,
  quantity: number,
  unitCost: string | null,
  receivedAt = BASE,
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

/**
 * A product whose stock has been sold and then returned, leaving one
 * quarantined return batch of `quantity` units at `unitCost`.
 *
 * Built through the real workflow rather than by writing lots directly, so the
 * batch under test is exactly what a customer return produces.
 */
async function returnedBatch(
  sku: string,
  quantity: number,
  unitCost: string | null,
) {
  const product = await seedProduct({
    sku,
    stockQuantity: 0,
    sellingPrice: "500.00",
  });

  await addLot(product.id, quantity, unitCost);

  const buyer = await prisma.customer.create({ data: { name: "Contoso" } });
  const order = await createOrder({
    customerId: buyer.id,
    items: await quoted([{ productId: product.id, quantity }]),
  });
  await confirmOrder(order.id);

  const line = await prisma.orderItem.findFirstOrThrow({
    where: { orderId: order.id },
  });

  await recordSalesReturn({
    orderId: order.id,
    reason: "Returned for inspection",
    lines: [{ orderItemId: line.id, quantity: String(quantity) }],
  });

  const lot = await prisma.stockLot.findFirstOrThrow({
    where: { productId: product.id, costSource: { in: ["RETURN", "UNKNOWN"] }, orderItemId: { not: null } },
  });

  return { product, lot, orderId: order.id };
}

async function lotById(id: string) {
  return prisma.stockLot.findUniqueOrThrow({ where: { id } });
}

async function expectInvariants() {
  await expectLotsReconcile();
  await expectConsumptionsReconcile();

  const negative = await prisma.product.count({
    where: { stockQuantity: { lt: 0 } },
  });
  expect(negative).toBe(0);

  const badLots = await prisma.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM stock_lots
    WHERE quantity_remaining < 0 OR quantity_remaining > quantity_received
  `;
  expect(badLots[0]!.n).toBe(0);
}

// ---------------------------------------------------------------------------

describe("the transition table", () => {
  it("permits exactly the two inspection outcomes", () => {
    expect(canTransitionLot(QUARANTINED_LOT_STATUS, SALEABLE_LOT_STATUS)).toBe(true);
    expect(canTransitionLot(QUARANTINED_LOT_STATUS, REJECTED_LOT_STATUS)).toBe(true);
  });

  it("refuses every other move", () => {
    const forbidden = [
      [SALEABLE_LOT_STATUS, QUARANTINED_LOT_STATUS],
      [SALEABLE_LOT_STATUS, REJECTED_LOT_STATUS],
      [REJECTED_LOT_STATUS, SALEABLE_LOT_STATUS],
      [REJECTED_LOT_STATUS, QUARANTINED_LOT_STATUS],
    ] as const;

    for (const [from, to] of forbidden) {
      expect(canTransitionLot(from, to)).toBe(false);
      expect(lotTransitionRefusal(from, to)).toBeTruthy();
    }
  });

  it("says something useful about why", () => {
    expect(lotTransitionRefusal(SALEABLE_LOT_STATUS, REJECTED_LOT_STATUS)).toMatch(
      /stock adjustment/i,
    );
    expect(lotTransitionRefusal(REJECTED_LOT_STATUS, SALEABLE_LOT_STATUS)).toMatch(
      /final/i,
    );
    expect(lotTransitionRefusal(QUARANTINED_LOT_STATUS, SALEABLE_LOT_STATUS)).toBeNull();
  });
});

describe("release", () => {
  it("moves a quarantined return batch to saleable", async () => {
    await signInWithRole("ADMIN");
    const { product, lot } = await returnedBatch("REL-1", 5, "80.00");

    const before = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });

    const outcome = await releaseLot({
      lotId: lot.id,
      reason: "Inspected and found serviceable",
    });

    expect(outcome.status).toBe(SALEABLE_LOT_STATUS);
    expect(outcome.alreadyInState).toBe(false);

    const after = await lotById(lot.id);
    expect(after.status).toBe(SALEABLE_LOT_STATUS);
    expect(after.statusChangedBy).not.toBeNull();
    expect(after.statusChangedAt).not.toBeNull();
    expect(after.statusNote).toBe("Inspected and found serviceable");

    // Nothing moved: same quantities, same balance, no ledger row.
    expect(after.quantityReceived).toBe(5);
    expect(after.quantityRemaining).toBe(5);
    const product2 = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(product2.stockQuantity).toBe(before.stockQuantity);

    await expectInvariants();
  });

  it("makes the units visible to FIFO again", async () => {
    await signInWithRole("ADMIN");
    const { product, lot } = await returnedBatch("REL-2", 4, "80.00");

    await releaseLot({ lotId: lot.id, reason: "Passed inspection" });

    const buyer = await prisma.customer.create({ data: { name: "Second buyer" } });
    const order = await createOrder({
      customerId: buyer.id,
      items: await quoted([{ productId: product.id, quantity: 4 }]),
    });
    await confirmOrder(order.id);

    const line = await prisma.orderItem.findFirstOrThrow({ where: { orderId: order.id } });
    expect(line.fulfilledQuantity).toBe(4);
    // Costed from the released batch, at the price it came back at.
    expect(Number(line.costTotal)).toBe(320);

    await expectInvariants();
  });

  it("attaches no certificate and leaves the batch reading MISSING", async () => {
    await signInWithRole("ADMIN");
    const { lot } = await returnedBatch("REL-3", 3, "80.00");

    const before = await prisma.certificate.count();
    await releaseLot({ lotId: lot.id, reason: "Serviceable" });

    expect(await prisma.certificate.count()).toBe(before);
    expect(await prisma.certificate.count({ where: { stockLotId: lot.id } })).toBe(0);
  });

  it("reports an already-released batch without rewriting its audit", async () => {
    await signInWithRole("ADMIN");
    const { lot } = await returnedBatch("REL-4", 2, "80.00");

    await releaseLot({ lotId: lot.id, reason: "First inspector" });
    const first = await lotById(lot.id);

    const again = await releaseLot({ lotId: lot.id, reason: "Second inspector" });
    expect(again.alreadyInState).toBe(true);

    const after = await lotById(lot.id);
    expect(after.statusNote).toBe("First inspector");
    expect(after.statusChangedAt).toEqual(first.statusChangedAt);
  });

  it("refuses a non-ADMIN", async () => {
    await signInWithRole("ADMIN");
    const { lot } = await returnedBatch("REL-5", 2, "80.00");

    await signInWithRole("STAFF");
    await expect(
      releaseLot({ lotId: lot.id, reason: "Trying as staff" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect((await lotById(lot.id)).status).toBe(QUARANTINED_LOT_STATUS);
  });

  it("requires a reason", async () => {
    await signInWithRole("ADMIN");
    const { lot } = await returnedBatch("REL-6", 2, "80.00");

    await expect(releaseLot({ lotId: lot.id, reason: "" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect((await lotById(lot.id)).status).toBe(QUARANTINED_LOT_STATUS);
  });
});

describe("rejection", () => {
  it("condemns a quarantined batch without moving stock", async () => {
    await signInWithRole("ADMIN");
    const { product, lot } = await returnedBatch("REJ-1", 6, "90.00");

    const before = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    const movements = await prisma.stockTransaction.count({ where: { productId: product.id } });

    await rejectLot({ lotId: lot.id, reason: "Corrosion on two units" });

    const after = await lotById(lot.id);
    expect(after.status).toBe(REJECTED_LOT_STATUS);
    expect(after.statusNote).toBe("Corrosion on two units");
    expect(after.quantityRemaining).toBe(6);

    // Still counted, still costed — rejecting is a judgement, not a disposal.
    const product2 = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(product2.stockQuantity).toBe(before.stockQuantity);
    expect(await prisma.stockTransaction.count({ where: { productId: product.id } })).toBe(movements);
    expect(Number(after.unitCost)).toBe(90);

    await expectInvariants();
  });

  it("refuses a non-ADMIN", async () => {
    await signInWithRole("ADMIN");
    const { lot } = await returnedBatch("REJ-2", 2, "90.00");

    await signInWithRole("STAFF");
    await expect(
      rejectLot({ lotId: lot.id, reason: "Trying as staff" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("refuses to reject an already-released batch", async () => {
    await signInWithRole("ADMIN");
    const { lot } = await returnedBatch("REJ-3", 2, "90.00");

    await releaseLot({ lotId: lot.id, reason: "Serviceable" });

    await expect(
      rejectLot({ lotId: lot.id, reason: "Changed my mind" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect((await lotById(lot.id)).status).toBe(SALEABLE_LOT_STATUS);
  });

  it("refuses to release an already-rejected batch", async () => {
    await signInWithRole("ADMIN");
    const { lot } = await returnedBatch("REJ-4", 2, "90.00");

    await rejectLot({ lotId: lot.id, reason: "Damaged" });

    await expect(
      releaseLot({ lotId: lot.id, reason: "Second look" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect((await lotById(lot.id)).status).toBe(REJECTED_LOT_STATUS);
  });
});

describe("eligibility", () => {
  it("refuses a purchase batch", async () => {
    await signInWithRole("ADMIN");
    const product = await seedProduct({ sku: "ELG-1", stockQuantity: 0 });
    const lotId = await addLot(product.id, 5, "10.00");

    for (const action of [releaseLot, rejectLot]) {
      await expect(
        action({ lotId, reason: "Not a return" }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
    }

    await expect(
      writeOffLot({ lotId, quantity: "1", reason: "Not a return" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect((await lotById(lotId)).status).toBe(SALEABLE_LOT_STATUS);
  });

  it("refuses an opening-stock batch", async () => {
    await signInWithRole("ADMIN");
    const product = await seedProduct({
      sku: "ELG-2",
      stockQuantity: 5,
      lotUnitCost: "10.00",
    });
    const lot = await prisma.stockLot.findFirstOrThrow({
      where: { productId: product.id },
    });

    await expect(
      rejectLot({ lotId: lot.id, reason: "Not a return" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("write-off", () => {
  async function rejectedBatch(sku: string, quantity: number, unitCost: string | null) {
    const built = await returnedBatch(sku, quantity, unitCost);
    await rejectLot({ lotId: built.lot.id, reason: "Failed inspection" });
    return built;
  }

  it("destroys a whole batch", async () => {
    await signInWithRole("ADMIN");
    const { product, lot } = await rejectedBatch("WO-FULL", 5, "100.00");

    const before = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });

    const outcome = await writeOffLot({
      lotId: lot.id,
      quantity: "5",
      reason: "Scrapped — beyond economical repair",
    });

    expect(outcome.quantity).toBe(5);
    expect(outcome.quantityRemaining).toBe(0);
    expect(outcome.writtenOffValue).toBe("500.00");

    const after = await lotById(lot.id);
    expect(after.quantityRemaining).toBe(0);
    expect(after.quantityReceived).toBe(5);
    expect(after.status).toBe(REJECTED_LOT_STATUS);

    const product2 = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(product2.stockQuantity).toBe(before.stockQuantity - 5);

    await expectInvariants();
  });

  it("destroys part of a batch and leaves the rest condemned", async () => {
    await signInWithRole("ADMIN");
    const { product, lot } = await rejectedBatch("WO-PART", 10, "100.00");

    const outcome = await writeOffLot({
      lotId: lot.id,
      quantity: "4",
      reason: "Four units unusable",
    });

    expect(outcome.quantity).toBe(4);
    expect(outcome.quantityRemaining).toBe(6);
    expect(outcome.writtenOffValue).toBe("400.00");

    const after = await lotById(lot.id);
    expect(after.quantityRemaining).toBe(6);
    // Ten did arrive, and that stays true.
    expect(after.quantityReceived).toBe(10);
    expect(after.status).toBe(REJECTED_LOT_STATUS);

    const product2 = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(product2.stockQuantity).toBe(6);

    // I-3 on the batch itself.
    const consumed = await prisma.stockLotConsumption.aggregate({
      where: { lotId: lot.id },
      _sum: { quantity: true },
    });
    expect(after.quantityRemaining).toBe(
      after.quantityReceived - (consumed._sum.quantity ?? 0),
    );

    await expectInvariants();
  });

  it("writes the ledger row and the consumption against the named batch", async () => {
    await signInWithRole("ADMIN");
    const { product, lot } = await rejectedBatch("WO-LEDGER", 4, "25.00");

    const outcome = await writeOffLot({
      lotId: lot.id,
      quantity: "3",
      reason: "Three scrapped",
    });

    const movement = await prisma.stockTransaction.findUniqueOrThrow({
      where: { id: outcome.transactionId },
    });
    expect(movement.type).toBe("ADJUSTMENT");
    expect(movement.referenceType).toBe("MANUAL");
    expect(movement.referenceId).toBeNull();
    expect(movement.quantity).toBe(3);
    expect(movement.note).toContain("Three scrapped");
    expect(movement.createdBy).not.toBeNull();
    expect(movement.newStock).toBe(movement.previousStock - 3);
    expect(movement.productId).toBe(product.id);

    const rows = await prisma.stockLotConsumption.findMany({
      where: { stockTransactionId: movement.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.lotId).toBe(lot.id);
    expect(rows[0]!.quantity).toBe(3);
    // The rate is frozen at disposal, so the value survives the batch emptying.
    expect(Number(rows[0]!.unitCost)).toBe(25);
    expect(Number(rows[0]!.totalCost)).toBe(75);
  });

  it("never touches another batch", async () => {
    await signInWithRole("ADMIN");
    const { product, lot } = await rejectedBatch("WO-ISOLATE", 5, "100.00");

    // A saleable batch sitting beside the condemned one, older so FIFO would
    // reach it first if this went anywhere near FIFO.
    const saleableId = await addLot(
      product.id,
      8,
      "20.00",
      new Date(BASE.getTime() - 60_000),
    );

    await writeOffLot({ lotId: lot.id, quantity: "5", reason: "Scrapped" });

    const saleable = await lotById(saleableId);
    expect(saleable.quantityRemaining).toBe(8);
    expect(saleable.status).toBe(SALEABLE_LOT_STATUS);
    expect(
      await prisma.stockLotConsumption.count({ where: { lotId: saleableId } }),
    ).toBe(0);

    const product2 = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(product2.stockQuantity).toBe(8);

    await expectInvariants();
  });

  it("keeps an uncosted batch uncosted", async () => {
    await signInWithRole("ADMIN");
    const { lot } = await rejectedBatch("WO-UNKNOWN", 4, null);

    expect((await lotById(lot.id)).unitCost).toBeNull();

    const outcome = await writeOffLot({
      lotId: lot.id,
      quantity: "4",
      reason: "Scrapped, cost never known",
    });

    // No value is invented for units nobody could price.
    expect(outcome.writtenOffValue).toBeNull();

    const rows = await prisma.stockLotConsumption.findMany({
      where: { stockTransactionId: outcome.transactionId },
    });
    expect(rows[0]!.unitCost).toBeNull();
    expect(rows[0]!.totalCost).toBeNull();

    await expectInvariants();
  });

  it("accepts exactly the remaining quantity", async () => {
    await signInWithRole("ADMIN");
    const { lot } = await rejectedBatch("WO-EXACT", 7, "10.00");

    await writeOffLot({ lotId: lot.id, quantity: "3", reason: "First three" });
    await writeOffLot({ lotId: lot.id, quantity: "4", reason: "The rest" });

    expect((await lotById(lot.id)).quantityRemaining).toBe(0);
    await expectInvariants();
  });

  it("refuses more than remains", async () => {
    await signInWithRole("ADMIN");
    const { lot } = await rejectedBatch("WO-OVER", 5, "10.00");

    await expect(
      writeOffLot({ lotId: lot.id, quantity: "6", reason: "Too many" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect((await lotById(lot.id)).quantityRemaining).toBe(5);
    await expectInvariants();
  });

  it("refuses zero and negative quantities", async () => {
    await signInWithRole("ADMIN");
    const { lot } = await rejectedBatch("WO-ZERO", 5, "10.00");

    for (const quantity of ["0", "-1", "", "1.5", "abc"]) {
      await expect(
        writeOffLot({ lotId: lot.id, quantity, reason: "Bad quantity" }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }

    expect((await lotById(lot.id)).quantityRemaining).toBe(5);
  });

  it("refuses a quarantined batch — it must be rejected first", async () => {
    await signInWithRole("ADMIN");
    const { lot } = await returnedBatch("WO-QUAR", 5, "10.00");

    await expect(
      writeOffLot({ lotId: lot.id, quantity: "1", reason: "Skipping inspection" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect((await lotById(lot.id)).quantityRemaining).toBe(5);
    expect((await lotById(lot.id)).status).toBe(QUARANTINED_LOT_STATUS);
  });

  it("refuses a saleable batch", async () => {
    await signInWithRole("ADMIN");
    const { lot } = await returnedBatch("WO-SALE", 5, "10.00");
    await releaseLot({ lotId: lot.id, reason: "Serviceable" });

    await expect(
      writeOffLot({ lotId: lot.id, quantity: "1", reason: "Should not work" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect((await lotById(lot.id)).quantityRemaining).toBe(5);
  });

  it("refuses a batch already written off in full", async () => {
    await signInWithRole("ADMIN");
    const { lot } = await rejectedBatch("WO-EMPTY", 3, "10.00");
    await writeOffLot({ lotId: lot.id, quantity: "3", reason: "All of it" });

    await expect(
      writeOffLot({ lotId: lot.id, quantity: "1", reason: "Again" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("refuses a non-ADMIN", async () => {
    await signInWithRole("ADMIN");
    const { lot } = await rejectedBatch("WO-STAFF", 5, "10.00");

    await signInWithRole("STAFF");
    await expect(
      writeOffLot({ lotId: lot.id, quantity: "1", reason: "As staff" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect((await lotById(lot.id)).quantityRemaining).toBe(5);
  });

  it("requires a reason", async () => {
    await signInWithRole("ADMIN");
    const { lot } = await rejectedBatch("WO-REASON", 5, "10.00");

    await expect(
      writeOffLot({ lotId: lot.id, quantity: "1", reason: "no" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect((await lotById(lot.id)).quantityRemaining).toBe(5);
  });

  it("serialises concurrent write-offs of the same batch", async () => {
    await signInWithRole("ADMIN");
    const { product, lot } = await rejectedBatch("WO-RACE", 5, "10.00");

    /*
     * Both ask for four of the five condemned units. The product row lock has
     * to serialise them: whichever commits second re-reads a remaining
     * quantity of one and is refused. Eight units must never leave a batch of
     * five, and the balance must fall by exactly four.
     */
    const results = await Promise.allSettled([
      writeOffLot({ lotId: lot.id, quantity: "4", reason: "Concurrent A" }),
      writeOffLot({ lotId: lot.id, quantity: "4", reason: "Concurrent B" }),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);

    const after = await lotById(lot.id);
    expect(after.quantityRemaining).toBe(1);

    const product2 = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(product2.stockQuantity).toBe(1);

    await expectInvariants();
  });
});

/**
 * The quarantine queue.
 *
 * Load-bearing rather than decorative: there is deliberately no quarantine
 * expiry and no automatic release, and that policy is only safe while every
 * waiting batch is visible on a screen. A batch that silently dropped out of
 * this list would sit out of sale for ever with nothing ever mentioning it, and
 * no invariant would notice — so what the query *excludes* is tested as
 * carefully as what it returns.
 */
describe("the quarantine queue", () => {
  /** Backdates a batch, so ageing and ordering can be exercised. */
  async function age(lotId: string, days: number) {
    await prisma.stockLot.update({
      where: { id: lotId },
      data: { receivedAt: new Date(Date.now() - days * 86_400_000) },
    });
  }

  it("lists a quarantined return with its document trail", async () => {
    await signInWithRole("ADMIN");
    const { product, lot, orderId } = await returnedBatch("Q-1", 3, "60.00");

    const salesReturn = await prisma.return.findFirstOrThrow({
      where: { orderId },
    });
    const order = await prisma.order.findUniqueOrThrow({
      where: { id: orderId },
    });

    const rows = await listQuarantinedLots();
    expect(rows).toHaveLength(1);

    const row = rows[0]!;
    expect(row.lotId).toBe(lot.id);
    expect(row.productId).toBe(product.id);
    expect(row.productName).toBe(product.name);
    expect(row.sku).toBe("Q-1");
    expect(row.quantityRemaining).toBe(3);
    expect(Number(row.unitCost)).toBe(60);

    // The provenance the screen renders, read from the row rather than assumed.
    expect(row.status).toBe(QUARANTINED_LOT_STATUS);
    expect(row.isReturn).toBe(true);

    expect(row.returnNumber).toBe(salesReturn.returnNumber);
    expect(row.orderNumber).toBe(order.orderNumber);
    expect(row.customerName).toBe("Contoso");
  });

  it("refuses a non-ADMIN", async () => {
    await signInWithRole("ADMIN");
    await returnedBatch("Q-STAFF", 2, "60.00");

    await signInWithRole("STAFF");
    await expect(listQuarantinedLots()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("excludes released, rejected and emptied batches", async () => {
    await signInWithRole("ADMIN");

    const waiting = await returnedBatch("Q-WAIT", 2, "60.00");
    const released = await returnedBatch("Q-REL", 2, "60.00");
    const rejected = await returnedBatch("Q-REJ", 2, "60.00");
    const emptied = await returnedBatch("Q-GONE", 2, "60.00");

    await releaseLot({ lotId: released.lot.id, reason: "Passed inspection" });
    await rejectLot({ lotId: rejected.lot.id, reason: "Corroded" });

    // Condemned and then destroyed in full: no status left and nothing left.
    await rejectLot({ lotId: emptied.lot.id, reason: "Corroded" });
    await writeOffLot({
      lotId: emptied.lot.id,
      quantity: "2",
      reason: "Scrapped in full",
    });
    expect((await lotById(emptied.lot.id)).quantityRemaining).toBe(0);

    const rows = await listQuarantinedLots();
    expect(rows.map((row) => row.lotId)).toEqual([waiting.lot.id]);
  });

  it("puts the longest wait first and measures it in whole days", async () => {
    await signInWithRole("ADMIN");

    const newest = await returnedBatch("Q-NEW", 1, "60.00");
    const oldest = await returnedBatch("Q-OLD", 1, "60.00");
    const middle = await returnedBatch("Q-MID", 1, "60.00");

    await age(oldest.lot.id, 9);
    await age(middle.lot.id, 4);

    const rows = await listQuarantinedLots();

    expect(rows.map((row) => row.lotId)).toEqual([
      oldest.lot.id,
      middle.lot.id,
      newest.lot.id,
    ]);

    expect(rows[0]!.daysHeld).toBe(9);
    expect(rows[1]!.daysHeld).toBe(4);
    // Booked in moments ago, so not yet a whole day old.
    expect(rows[2]!.daysHeld).toBe(0);
  });

  it("breaks a tie on id, so the order is total", async () => {
    await signInWithRole("ADMIN");

    const first = await returnedBatch("Q-TIE-A", 1, "60.00");
    const second = await returnedBatch("Q-TIE-B", 1, "60.00");

    // Same instant to the millisecond: without the id tiebreak the sequence
    // would be whatever the plan happened to produce.
    const sameMoment = new Date("2026-05-01T09:00:00.000Z");
    for (const id of [first.lot.id, second.lot.id]) {
      await prisma.stockLot.update({
        where: { id },
        data: { receivedAt: sameMoment },
      });
    }

    const rows = await listQuarantinedLots();
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.lotId)).toEqual(
      [first.lot.id, second.lot.id].sort(),
    );
  });

  it("is empty when nothing is waiting", async () => {
    await signInWithRole("ADMIN");
    expect(await listQuarantinedLots()).toEqual([]);
  });
});

describe("returns behaviour is unchanged", () => {
  it("leaves a fresh return quarantined and out of FIFO", async () => {
    await signInWithRole("ADMIN");
    const { product, lot } = await returnedBatch("REG-1", 5, "60.00");

    expect((await lotById(lot.id)).status).toBe(QUARANTINED_LOT_STATUS);

    const buyer = await prisma.customer.create({ data: { name: "Another buyer" } });
    const order = await createOrder({
      customerId: buyer.id,
      items: await quoted([{ productId: product.id, quantity: 5 }]),
    });
    await confirmOrder(order.id);

    const line = await prisma.orderItem.findFirstOrThrow({ where: { orderId: order.id } });
    // Physically present, not saleable — nothing shipped.
    expect(line.fulfilledQuantity).toBe(0);

    const stock = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(stock.stockQuantity).toBe(5);

    await expectInvariants();
  });
});
