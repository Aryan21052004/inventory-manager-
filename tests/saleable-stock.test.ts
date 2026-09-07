import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@clerk/nextjs/server", async () => {
  const { clerkServerMock } = await import("./clerk-mock");
  return clerkServerMock;
});

import { parseReportParams, type ReportParams } from "@/lib/report-query";
import { prisma } from "@/lib/prisma";
import { adjustStock } from "@/server/products";
import { confirmOrder, createOrder, fulfilOrder } from "@/server/orders";
import { loadValuationReport } from "@/server/reports";

import { signOut } from "./clerk-mock";
import {
  expectConsumptionsReconcile,
  expectLotsReconcile,
  quoted,
  resetDatabase,
  seedProduct,
  signInWithRole,
} from "./database";

/**
 * Saleable stock: which batches an order is allowed to draw from.
 *
 * A lot's status answers one question — may FIFO consume these units — and it
 * answers no others. The units in a quarantined batch are on the shelf, inside
 * `Product.stockQuantity`, inside `SUM(quantityRemaining) = stockQuantity`, and
 * inside the valuation. They are simply not available to sell.
 *
 * Keeping those two ideas apart is the whole point of this file, and the way it
 * goes wrong is specific. `allocateFifo` throws INTERNAL — "Stock lots do not
 * cover this movement" — when it cannot fill a draw, and that assertion exists
 * to detect a *broken invariant*. If a guard checked physical stock while the
 * scan filtered on status, every sale against quarantined stock would trip it,
 * and a routine warehouse situation would start reporting itself as data
 * corruption. Several tests below assert the error is an ordinary refusal, and
 * they are the reason the guards and the FIFO clause had to ship together.
 *
 * Nothing here creates a return: the return workflow does not exist yet. The
 * fixtures write lot statuses directly, which is the only way to reach these
 * states in this phase and is deliberately the *only* thing they fake.
 */

beforeEach(async () => {
  signOut();
  await resetDatabase();
});

/**
 * Re-statuses a product's lots by writing the column directly.
 *
 * A fixture rather than a workflow, because the workflow that produces
 * quarantined stock is a later phase. `receivedAt` is left alone so FIFO
 * ordering stays whatever the test set up.
 */
async function setLotStatus(
  productId: string,
  status: "SALEABLE" | "QUARANTINED" | "REJECTED",
  options: { skip?: number } = {},
) {
  const lots = await prisma.stockLot.findMany({
    where: { productId },
    orderBy: [{ receivedAt: "asc" }, { id: "asc" }],
    select: { id: true },
  });

  const target = lots.slice(options.skip ?? 0);

  await prisma.stockLot.updateMany({
    where: { id: { in: target.map((lot) => lot.id) } },
    data:
      status === "SALEABLE"
        ? { status }
        : {
            status,
            statusChangedAt: new Date(),
            statusNote: "Fixture — set directly for this test",
          },
  });

  return target.length;
}

/** Adds a second, later batch so FIFO has something to order. */
async function addLot(
  productId: string,
  quantity: number,
  unitCost: string | null,
  receivedAt: Date,
  status: "SALEABLE" | "QUARANTINED" | "REJECTED" = "SALEABLE",
) {
  await prisma.stockLot.create({
    data: {
      productId,
      unitCost,
      costSource: unitCost === null ? "UNKNOWN" : "OPENING",
      quantityReceived: quantity,
      quantityRemaining: quantity,
      sourceType: "MANUAL",
      sourceId: null,
      receivedAt,
      status,
      ...(status === "SALEABLE"
        ? {}
        : {
            statusChangedAt: new Date(),
            statusNote: "Fixture — set directly for this test",
          }),
    },
  });

  await prisma.product.update({
    where: { id: productId },
    data: { stockQuantity: { increment: quantity } },
  });
}

async function orderFor(productId: string, quantity: number) {
  const customer = await prisma.customer.create({
    data: { name: "Contoso Aviation" },
  });

  return createOrder({
    customerId: customer.id,
    items: await quoted([{ productId, quantity }]),
  });
}

async function lineOf(orderId: string) {
  return prisma.orderItem.findFirstOrThrow({ where: { orderId } });
}

/**
 * Pins the fixture lot's receipt date.
 *
 * `seedProduct` dates its lot to now, and the batches added below are dated
 * relative to a fixed instant — so without this the seeded lot would sort last
 * and the FIFO expectations would be about the wrong batch.
 */
async function pinSeededLot(productId: string, receivedAt: Date) {
  const lot = await prisma.stockLot.findFirstOrThrow({
    where: { productId },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });

  await prisma.stockLot.update({ where: { id: lot.id }, data: { receivedAt } });
}

function reportParams(): ReportParams {
  return parseReportParams(
    { range: "all" },
    {
      groupings: [],
      defaultGrouping: "product",
      sortKeys: ["value", "units"],
      defaultSort: "value",
      defaultDirection: "desc",
    },
  );
}

// ---------------------------------------------------------------------------

describe("stock with nothing blocked", () => {
  it("behaves exactly as it did before statuses existed", async () => {
    await signInWithRole("ADMIN");
    const product = await seedProduct({
      sku: "SAL-1",
      stockQuantity: 10,
      lotUnitCost: "100.00",
    });

    const order = await orderFor(product.id, 4);
    await confirmOrder(order.id);

    const after = await prisma.product.findUniqueOrThrow({
      where: { id: product.id },
    });
    expect(after.stockQuantity).toBe(6);

    const line = await lineOf(order.id);
    expect(line.fulfilledQuantity).toBe(4);
    expect(line.costedQuantity).toBe(4);
    expect(Number(line.costTotal)).toBe(400);

    await expectLotsReconcile();
    await expectConsumptionsReconcile();
  });

  it("leaves every seeded lot SALEABLE", async () => {
    await seedProduct({ sku: "SAL-2", stockQuantity: 5 });

    const lots = await prisma.stockLot.findMany({ select: { status: true } });
    expect(lots).not.toHaveLength(0);
    expect(lots.every((lot) => lot.status === "SALEABLE")).toBe(true);
  });
});

describe("stock that is entirely blocked", () => {
  it("confirms an order with everything outstanding rather than failing", async () => {
    await signInWithRole("ADMIN");
    const product = await seedProduct({
      sku: "QUAR-1",
      stockQuantity: 10,
      lotUnitCost: "100.00",
    });
    await setLotStatus(product.id, "QUARANTINED");

    const order = await orderFor(product.id, 1);

    // The whole point: an ordinary outcome, not an INTERNAL assertion.
    await expect(confirmOrder(order.id)).resolves.toMatchObject({
      status: "CONFIRMED",
    });

    const line = await lineOf(order.id);
    expect(line.fulfilledQuantity).toBe(0);
    expect(line.costedQuantity).toBe(0);
    expect(line.costTotal).toBeNull();

    // Physical stock is untouched — the units are still on the shelf.
    const after = await prisma.product.findUniqueOrThrow({
      where: { id: product.id },
    });
    expect(after.stockQuantity).toBe(10);

    // And no movement was written, because nothing moved.
    expect(
      await prisma.stockTransaction.count({ where: { productId: product.id } }),
    ).toBe(0);

    await expectLotsReconcile();
  });

  it("refuses fulfilment as a business error, never as INTERNAL", async () => {
    await signInWithRole("ADMIN");
    const product = await seedProduct({
      sku: "QUAR-2",
      stockQuantity: 4,
      lotUnitCost: "100.00",
    });

    // Ordered 10 against 4 on hand, so 6 units stay outstanding.
    const order = await orderFor(product.id, 10);
    await confirmOrder(order.id);

    // Stock for the rest arrives, but all of it is blocked.
    await addLot(product.id, 6, "100.00", new Date(), "QUARANTINED");

    const line = await lineOf(order.id);

    const failure = await fulfilOrder(order.id, {
      lines: [{ orderItemId: line.id, quantity: 1 }],
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as { code?: string }).code).toBe("INSUFFICIENT_STOCK");
    expect((failure as { code?: string }).code).not.toBe("INTERNAL");
    // The message has to name the blockage, or it sends somebody to count a
    // shelf that is full.
    expect((failure as Error).message).toMatch(/not available to sell/i);

    await expectLotsReconcile();
  });

  it("treats rejected stock as zero saleable, the same as quarantined", async () => {
    await signInWithRole("ADMIN");
    const product = await seedProduct({
      sku: "REJ-1",
      stockQuantity: 10,
      lotUnitCost: "100.00",
    });
    await setLotStatus(product.id, "REJECTED");

    const order = await orderFor(product.id, 3);
    await confirmOrder(order.id);

    const line = await lineOf(order.id);
    expect(line.fulfilledQuantity).toBe(0);

    const after = await prisma.product.findUniqueOrThrow({
      where: { id: product.id },
    });
    expect(after.stockQuantity).toBe(10);

    await expectLotsReconcile();
  });

  it("refuses an outbound adjustment instead of failing inside FIFO", async () => {
    await signInWithRole("ADMIN");
    const product = await seedProduct({
      sku: "ADJ-BLOCK",
      stockQuantity: 10,
      lotUnitCost: "100.00",
    });
    await setLotStatus(product.id, "QUARANTINED");

    /*
     * Every outflow reaches `allocateFifo`, not just order movements. Without a
     * saleable guard here the physical non-negative check would pass — ten
     * units really are on hand — and the scan would then fail with the
     * broken-invariant assertion.
     */
    const failure = await adjustStock({
      productId: product.id,
      quantity: "4",
      direction: "DECREASE",
      reason: "Attempting to draw against quarantined stock",
    }).catch((error: unknown) => error);

    expect((failure as { code?: string }).code).toBe("INSUFFICIENT_STOCK");
    expect((failure as { code?: string }).code).not.toBe("INTERNAL");

    const after = await prisma.product.findUniqueOrThrow({
      where: { id: product.id },
    });
    expect(after.stockQuantity).toBe(10);

    await expectLotsReconcile();
  });
});

describe("stock that is partly blocked", () => {
  it("draws only what is saleable and owes the rest", async () => {
    await signInWithRole("ADMIN");
    const product = await seedProduct({
      sku: "MIX-1",
      stockQuantity: 4,
      lotUnitCost: "100.00",
    });
    // A later, blocked batch of 6. Physical 10, saleable 4.
    await addLot(
      product.id,
      6,
      "250.00",
      new Date(Date.now() + 60_000),
      "QUARANTINED",
    );

    const order = await orderFor(product.id, 9);
    await confirmOrder(order.id);

    const line = await lineOf(order.id);
    expect(line.fulfilledQuantity).toBe(4);
    expect(line.costedQuantity).toBe(4);
    // Costed from the saleable batch only — never the quarantined one.
    expect(Number(line.costTotal)).toBe(400);

    const after = await prisma.product.findUniqueOrThrow({
      where: { id: product.id },
    });
    expect(after.stockQuantity).toBe(6);

    const blocked = await prisma.stockLot.findFirstOrThrow({
      where: { productId: product.id, status: "QUARANTINED" },
    });
    expect(blocked.quantityRemaining).toBe(6);

    await expectLotsReconcile();
    await expectConsumptionsReconcile();
  });

  it("consumes only saleable lots when the three statuses are mixed", async () => {
    await signInWithRole("ADMIN");
    const base = new Date("2026-01-01T00:00:00.000Z");

    // Oldest is quarantined, so a scan that ignored status would take it first.
    const product = await seedProduct({
      sku: "MIX-2",
      stockQuantity: 5,
      lotUnitCost: "10.00",
    });
    await pinSeededLot(product.id, base);
    await setLotStatus(product.id, "QUARANTINED");

    await addLot(product.id, 5, "20.00", new Date(base.getTime() + 1000), "REJECTED");
    await addLot(product.id, 5, "30.00", new Date(base.getTime() + 2000), "SALEABLE");
    await addLot(product.id, 5, "40.00", new Date(base.getTime() + 3000), "SALEABLE");

    const order = await orderFor(product.id, 7);
    await confirmOrder(order.id);

    const line = await lineOf(order.id);
    expect(line.fulfilledQuantity).toBe(7);
    // 5 @ 30 + 2 @ 40 — the two saleable batches, oldest first. Never 10 or 20.
    expect(Number(line.costTotal)).toBe(230);

    const lots = await prisma.stockLot.findMany({
      where: { productId: product.id },
      orderBy: [{ receivedAt: "asc" }, { id: "asc" }],
      select: { status: true, quantityRemaining: true, unitCost: true },
    });

    expect(
      lots.map((lot) => [lot.status, lot.quantityRemaining]),
    ).toEqual([
      ["QUARANTINED", 5],
      ["REJECTED", 5],
      ["SALEABLE", 0],
      ["SALEABLE", 3],
    ]);

    await expectLotsReconcile();
    await expectConsumptionsReconcile();
  });

  it("keeps FIFO order among saleable lots unchanged", async () => {
    await signInWithRole("ADMIN");
    const base = new Date("2026-02-01T00:00:00.000Z");

    const product = await seedProduct({
      sku: "MIX-3",
      stockQuantity: 3,
      lotUnitCost: "5.00",
    });
    await pinSeededLot(product.id, base);
    await addLot(product.id, 3, "7.00", new Date(base.getTime() + 1000));
    await addLot(product.id, 3, "9.00", new Date(base.getTime() + 2000));

    const order = await orderFor(product.id, 7);
    await confirmOrder(order.id);

    const line = await lineOf(order.id);
    // 3 @ 5 + 3 @ 7 + 1 @ 9 = 45. Oldest first, exactly as before.
    expect(Number(line.costTotal)).toBe(45);
    expect(line.fulfilledQuantity).toBe(7);
  });

  it("stops explicit fulfilment from reaching blocked lots", async () => {
    await signInWithRole("ADMIN");
    const product = await seedProduct({ sku: "MIX-4", stockQuantity: 0 });

    const order = await orderFor(product.id, 5);
    await confirmOrder(order.id);

    // Stock arrives, but all of it is blocked.
    await addLot(product.id, 5, "100.00", new Date(), "QUARANTINED");

    const line = await lineOf(order.id);

    const failure = await fulfilOrder(order.id, {
      lines: [{ orderItemId: line.id, quantity: 5 }],
    }).catch((error: unknown) => error);

    expect((failure as { code?: string }).code).toBe("INSUFFICIENT_STOCK");

    const blocked = await prisma.stockLot.findFirstOrThrow({
      where: { productId: product.id },
    });
    expect(blocked.quantityRemaining).toBe(5);
    expect(blocked.status).toBe("QUARANTINED");

    await expectLotsReconcile();
  });
});

describe("physical accounting is unaffected by status", () => {
  it("keeps I-1 and I-3 true across every status", async () => {
    await signInWithRole("ADMIN");
    const product = await seedProduct({
      sku: "PHYS-1",
      stockQuantity: 4,
      lotUnitCost: "100.00",
    });
    await addLot(product.id, 4, "100.00", new Date(Date.now() + 1000), "QUARANTINED");
    await addLot(product.id, 4, "100.00", new Date(Date.now() + 2000), "REJECTED");

    const order = await orderFor(product.id, 3);
    await confirmOrder(order.id);

    const after = await prisma.product.findUniqueOrThrow({
      where: { id: product.id },
    });

    // Physical stock counts every status: 12 received, 3 sold.
    expect(after.stockQuantity).toBe(9);

    const sum = await prisma.stockLot.aggregate({
      where: { productId: product.id },
      _sum: { quantityRemaining: true },
    });
    expect(sum._sum.quantityRemaining).toBe(after.stockQuantity);

    await expectLotsReconcile();
    await expectConsumptionsReconcile();
  });

  it("never drives stock negative through a blocked product", async () => {
    await signInWithRole("ADMIN");
    const product = await seedProduct({
      sku: "PHYS-2",
      stockQuantity: 6,
      lotUnitCost: "100.00",
    });
    await setLotStatus(product.id, "QUARANTINED");

    const order = await orderFor(product.id, 6);
    await confirmOrder(order.id);

    const products = await prisma.product.findMany({
      select: { stockQuantity: true },
    });
    expect(products.every((row) => row.stockQuantity >= 0)).toBe(true);
  });

  it("values blocked stock exactly like any other physical stock", async () => {
    await signInWithRole("ADMIN");
    const product = await seedProduct({
      sku: "PHYS-3",
      stockQuantity: 5,
      lotUnitCost: "200.00",
    });
    await addLot(product.id, 5, "200.00", new Date(Date.now() + 1000), "QUARANTINED");
    await addLot(product.id, 5, "200.00", new Date(Date.now() + 2000), "REJECTED");

    const result = await loadValuationReport(reportParams());
    if (!result.ok) throw new Error("expected the valuation report to load");
    const row = result.data.rows.find((entry) => entry.sku === "PHYS-3");

    /*
     * Marking a lot quarantined or rejected is a judgement about whether it may
     * be sold, not a disposal. Value leaves inventory when the units do, and
     * not a moment earlier.
     */
    expect(row).toBeDefined();
    expect(row!.units).toBe(15);
    expect(Number(row!.valueAtCost)).toBe(3000);
  });

  it("counts blocked units in the movement summary, which is physical", async () => {
    await signInWithRole("ADMIN");
    const product = await seedProduct({
      sku: "PHYS-4",
      stockQuantity: 0,
    });

    await adjustStock({
      productId: product.id,
      quantity: "8",
      direction: "INCREASE",
      reason: "Counted in",
      costBasis: "KNOWN",
      unitCost: "50.00",
    });

    await setLotStatus(product.id, "QUARANTINED");

    const rows = await prisma.stockTransaction.findMany({
      where: { productId: product.id },
      select: { previousStock: true, newStock: true },
    });

    // The ledger describes the shelf, and re-statusing a lot writes nothing.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.newStock - rows[0]!.previousStock).toBe(8);

    const after = await prisma.product.findUniqueOrThrow({
      where: { id: product.id },
    });
    expect(after.stockQuantity).toBe(8);

    await expectLotsReconcile();
  });
});
