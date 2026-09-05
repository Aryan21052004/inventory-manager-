import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@clerk/nextjs/server", async () => {
  const { clerkServerMock } = await import("./clerk-mock");
  return clerkServerMock;
});

import { prisma } from "@/lib/prisma";
import { adjustStock } from "@/server/products";

import { signOut } from "./clerk-mock";
import {
  expectConsumptionsReconcile,
  expectLotsReconcile,
  resetDatabase,
  seedProduct,
  signInWithRole,
} from "./database";

/**
 * What an adjustment says about acquisition cost.
 *
 * An adjustment that adds stock creates a batch, and a batch has an
 * acquisition cost or honestly does not. This used to be neither asked nor
 * recorded: every increase produced an UNKNOWN lot, so a cost the operator
 * knew perfectly well was discarded by the shape of the form,
 * `LotCostSource.ADJUSTMENT` was a value nothing could produce, and uncosted
 * units accumulated in the FIFO queue — draining first, so they suppressed
 * cost coverage on the *next* sales rather than the last.
 *
 * The fix is a required answer, not a required number. Demanding a cost for
 * units found in a corner with no paperwork would guarantee an invented one,
 * which is the single thing this costing model exists to prevent. What changed
 * is that unknown became something the operator states rather than something
 * the form assumes — which is why every refusal below names the field that was
 * not answered, and why none of them can be satisfied by a placeholder.
 *
 * Mechanics, authorisation and concurrency live in stock-adjustment.test.ts;
 * this file is only about the money.
 */

beforeEach(async () => {
  signOut();
  await resetDatabase();
});

/** The form fields, as strings — which is how they arrive from FormData. */
function adjustmentForm(
  productId: string,
  overrides: Record<string, string> = {},
) {
  return {
    productId,
    quantity: "20",
    direction: "DECREASE",
    reason: "Stock count correction",
    ...overrides,
  };
}

async function lotsOf(productId: string) {
  return prisma.stockLot.findMany({
    where: { productId },
    orderBy: [{ receivedAt: "asc" }, { id: "asc" }],
  });
}

describe("an increase that knows what it cost", () => {
  it("records the stated cost against the batch it creates", async () => {
    await signInWithRole("ADMIN");
    const product = await seedProduct({ sku: "ADJ-100", stockQuantity: 0 });

    await adjustStock(
      adjustmentForm(product.id, {
        quantity: "12",
        direction: "INCREASE",
        costBasis: "KNOWN",
        unitCost: "9500.00",
        reason: "Delivery booked in by hand — supplier portal was down",
      }),
    );

    const lots = await lotsOf(product.id);
    expect(lots).toHaveLength(1);
    expect(lots[0]!.unitCost?.toString()).toBe("9500");
    expect(lots[0]!.quantityReceived).toBe(12);
    expect(lots[0]!.quantityRemaining).toBe(12);

    // The enum value that nothing could previously produce.
    expect(lots[0]!.costSource).toBe("ADJUSTMENT");

    await expectLotsReconcile();
    await expectConsumptionsReconcile();
  });

  it("costs a later draw from the batch it created", async () => {
    await signInWithRole("ADMIN");
    const product = await seedProduct({ sku: "ADJ-108", stockQuantity: 0 });

    await adjustStock(
      adjustmentForm(product.id, {
        quantity: "6",
        direction: "INCREASE",
        costBasis: "KNOWN",
        unitCost: "11000.00",
        reason: "Booked in by hand",
      }),
    );

    // The whole point of recording the cost: it reaches the next draw.
    await adjustStock(
      adjustmentForm(product.id, { quantity: "2", direction: "DECREASE" }),
    );

    const lots = await lotsOf(product.id);
    const consumption = await prisma.stockLotConsumption.findFirstOrThrow({
      where: { lotId: lots[0]!.id, quantity: { gt: 0 } },
    });

    expect(consumption.unitCost?.toString()).toBe("11000");
    expect(consumption.totalCost?.toString()).toBe("22000");

    await expectLotsReconcile();
    await expectConsumptionsReconcile();
  });
});

describe("an increase whose cost is genuinely unknown", () => {
  it("stays unknown, and records why", async () => {
    await signInWithRole("ADMIN");
    const product = await seedProduct({ sku: "ADJ-101", stockQuantity: 0 });

    await adjustStock(
      adjustmentForm(product.id, {
        quantity: "4",
        direction: "INCREASE",
        costBasis: "UNKNOWN",
        unknownCostReason: "No paperwork — original delivery cannot be traced",
        reason: "Found behind the rack during the annual count",
      }),
    );

    const lots = await lotsOf(product.id);
    expect(lots).toHaveLength(1);
    expect(lots[0]!.unitCost).toBeNull();
    expect(lots[0]!.costSource).toBe("UNKNOWN");

    /*
     * Both explanations reach the ledger. Why the stock changed and why nobody
     * can price it are different facts with different consequences — the
     * second explains every uncosted sale this batch will produce — and the
     * note is the only durable place the second can live.
     */
    const movement = await prisma.stockTransaction.findFirstOrThrow({
      where: { productId: product.id },
    });
    expect(movement.note).toContain("Found behind the rack");
    expect(movement.note).toContain("Acquisition cost unknown");
    expect(movement.note).toContain("original delivery cannot be traced");

    await expectLotsReconcile();
  });

  it("never reaches for the catalogue figure", async () => {
    await signInWithRole("ADMIN");
    const product = await seedProduct({
      sku: "ADJ-106",
      stockQuantity: 0,
      // A planning number sitting right there, and deliberately not used.
    });

    await adjustStock(
      adjustmentForm(product.id, {
        quantity: "3",
        direction: "INCREASE",
        costBasis: "UNKNOWN",
        unknownCostReason: "Nobody can say what these cost",
        reason: "Stock count correction",
      }),
    );

    const lots = await lotsOf(product.id);
    expect(lots[0]!.unitCost).toBeNull();
  });
});

describe("an increase that has not answered", () => {
  it("is refused, and writes nothing at all", async () => {
    await signInWithRole("ADMIN");
    const product = await seedProduct({ sku: "ADJ-102", stockQuantity: 0 });

    await expect(
      adjustStock(
        adjustmentForm(product.id, { quantity: "5", direction: "INCREASE" }),
      ),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      details: { field: "costBasis" },
    });

    // Not the movement, not the lot, not the balance.
    expect(await prisma.stockTransaction.count()).toBe(0);
    expect(await prisma.stockLot.count()).toBe(0);
    const after = await prisma.product.findUniqueOrThrow({
      where: { id: product.id },
    });
    expect(after.stockQuantity).toBe(0);
  });

  it("refuses a known cost with no number behind it", async () => {
    await signInWithRole("ADMIN");
    const product = await seedProduct({ sku: "ADJ-103", stockQuantity: 0 });

    await expect(
      adjustStock(
        adjustmentForm(product.id, {
          quantity: "5",
          direction: "INCREASE",
          costBasis: "KNOWN",
        }),
      ),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      details: { field: "unitCost" },
    });
  });

  it("refuses a declared unknown with no explanation", async () => {
    await signInWithRole("ADMIN");
    const product = await seedProduct({ sku: "ADJ-104", stockQuantity: 0 });

    await expect(
      adjustStock(
        adjustmentForm(product.id, {
          quantity: "5",
          direction: "INCREASE",
          costBasis: "UNKNOWN",
        }),
      ),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      details: { field: "unknownCostReason" },
    });
  });

  it("reads a blank cost as absent rather than as free", async () => {
    await signInWithRole("ADMIN");
    const product = await seedProduct({ sku: "ADJ-105", stockQuantity: 0 });

    /*
     * `Number("")` is 0, so a cleared field coerced up front would record
     * these units as having cost nothing — a cost, and a wrong one. It has to
     * come back as a missing value instead.
     */
    await expect(
      adjustStock(
        adjustmentForm(product.id, {
          quantity: "5",
          direction: "INCREASE",
          costBasis: "KNOWN",
          unitCost: "",
        }),
      ),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      details: { field: "unitCost" },
    });
  });
});

describe("a decrease", () => {
  it("asks nothing, and is costed from the lots it draws", async () => {
    await signInWithRole("ADMIN");
    const product = await seedProduct({
      sku: "ADJ-107",
      stockQuantity: 10,
      lotUnitCost: "8000.00",
    });

    await adjustStock(
      adjustmentForm(product.id, { quantity: "4", direction: "DECREASE" }),
    );

    const lots = await lotsOf(product.id);
    expect(lots[0]!.quantityRemaining).toBe(6);

    // Drawn at the batch's own price, with nothing supplied by the caller.
    const consumption = await prisma.stockLotConsumption.findFirstOrThrow({
      where: { lotId: lots[0]!.id },
    });
    expect(consumption.quantity).toBe(4);
    expect(consumption.unitCost?.toString()).toBe("8000");

    await expectLotsReconcile();
    await expectConsumptionsReconcile();
  });

  it("ignores costing fields if a caller sends them anyway", async () => {
    await signInWithRole("ADMIN");
    const product = await seedProduct({
      sku: "ADJ-109",
      stockQuantity: 10,
      lotUnitCost: "8000.00",
    });

    /*
     * The action is a public endpoint, so anything can be posted to it. A cost
     * on an outbound movement has nothing to attach to — no batch is created —
     * and it must not become one.
     */
    await adjustStock(
      adjustmentForm(product.id, {
        quantity: "3",
        direction: "DECREASE",
        costBasis: "KNOWN",
        unitCost: "1.00",
      }),
    );

    const lots = await lotsOf(product.id);
    expect(lots).toHaveLength(1);
    expect(lots[0]!.unitCost?.toString()).toBe("8000");
    expect(lots[0]!.quantityRemaining).toBe(7);

    await expectLotsReconcile();
    await expectConsumptionsReconcile();
  });
});
