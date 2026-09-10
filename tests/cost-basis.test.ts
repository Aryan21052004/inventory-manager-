import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@clerk/nextjs/server", async () => {
  const { clerkServerMock } = await import("./clerk-mock");
  return clerkServerMock;
});

import { prisma } from "@/lib/prisma";
import {
  COST_BASES,
  UNKNOWN_COST_REASON_MAX,
  basisForQuantity,
  costBasisUnitCostCents,
  withUnknownCostReason,
} from "@/lib/validation/cost-basis";
import {
  adjustmentCost,
  stockAdjustmentSchema,
} from "@/lib/validation/adjustment";
import {
  createProductSchema,
  openingStockCost,
  OPENING_STOCK_COST_BASES,
} from "@/lib/validation/product";
import { adjustStock } from "@/server/products";
import { recordOpeningStock, recordStockMovement } from "@/server/stock";

import { signOut } from "./clerk-mock";
import { resetDatabase, seedProduct, signInWithRole } from "./database";

/**
 * One cost-basis rule, proved once and proved shared.
 *
 * Stock enters this system by three routes. A purchase carries a supplier
 * invoice and its cost is proven. The other two — an opening balance typed when
 * a product is created, and an upward stock adjustment — are operator
 * assertions, and both face the same question: *can you say what these cost?*
 *
 * Both once answered it by omission, and were fixed separately, which left two
 * copies of the rule. The copies are gone; this file is what stops them coming
 * back. Most of the assertions below are about the two flows agreeing, because
 * the failure worth catching is not "the rule is wrong" — a single flow's own
 * tests would catch that — but "the rule is now two rules", which nothing else
 * would notice until one of them quietly relaxed.
 *
 * The database constraints get the same treatment from the other side. A
 * validation rule protects the path it sits on; a check constraint protects the
 * table, whichever door the row arrives through.
 */

beforeEach(async () => {
  signOut();
  await resetDatabase();
});

/** The create form's fields, as strings — which is how FormData delivers them. */
function productForm(overrides: Record<string, string> = {}) {
  return {
    name: "Bracket",
    sku: "CB-1",
    category: "Airframe",
    sellingPrice: "12000.00",
    stockQuantity: "10",
    status: "ACTIVE",
    ...overrides,
  };
}

/** The adjustment form's fields, defaulting to an increase. */
function adjustmentForm(overrides: Record<string, string> = {}) {
  return {
    productId: "some-product-id",
    quantity: "10",
    direction: "INCREASE",
    reason: "Found during the stock take",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The two flows ask the same question
// ---------------------------------------------------------------------------

describe("the shared cost-basis rule", () => {
  it("offers the same two answers to both flows", () => {
    // Identity, not just equality: both names point at the one tuple.
    expect(OPENING_STOCK_COST_BASES).toBe(COST_BASES);
    expect([...COST_BASES]).toEqual(["KNOWN", "UNKNOWN"]);
  });

  it("refuses an undeclared basis on both flows", () => {
    const opening = createProductSchema.safeParse(productForm());
    const adjustment = stockAdjustmentSchema.safeParse(adjustmentForm());

    expect(opening.success).toBe(false);
    expect(adjustment.success).toBe(false);

    /*
     * The messages differ only in the subject — "the opening stock" against
     * "these units" — because that is the only part that honestly differs.
     * Everything after it is the same sentence, and it is the same sentence
     * because it is the same rule.
     */
    const tail =
      "is known. Leaving it unanswered is what used to record a cost as unknown by accident.";

    expect(issueFor(opening, "openingStockCostBasis")).toContain(tail);
    expect(issueFor(adjustment, "costBasis")).toContain(tail);
  });

  it("refuses a known basis with no number, identically", () => {
    const opening = createProductSchema.safeParse(
      productForm({ openingStockCostBasis: "KNOWN", openingStockUnitCost: "" }),
    );
    const adjustment = stockAdjustmentSchema.safeParse(
      adjustmentForm({ costBasis: "KNOWN", unitCost: "" }),
    );

    expect(issueFor(opening, "openingStockUnitCost")).toBe(
      issueFor(adjustment, "unitCost"),
    );
    expect(issueFor(adjustment, "unitCost")).toContain("never a placeholder");
  });

  it("refuses a declared unknown with no explanation, identically", () => {
    const opening = createProductSchema.safeParse(
      productForm({ openingStockCostBasis: "UNKNOWN" }),
    );
    const adjustment = stockAdjustmentSchema.safeParse(
      adjustmentForm({ costBasis: "UNKNOWN" }),
    );

    expect(issueFor(opening, "openingStockUnknownReason")).toBe(
      issueFor(adjustment, "unknownCostReason"),
    );
  });

  it("caps the explanation at the same length on both flows", () => {
    const tooLong = "x".repeat(UNKNOWN_COST_REASON_MAX + 1);
    const justFits = "x".repeat(UNKNOWN_COST_REASON_MAX);

    const openingLong = createProductSchema.safeParse(
      productForm({
        openingStockCostBasis: "UNKNOWN",
        openingStockUnknownReason: tooLong,
      }),
    );
    const adjustmentLong = stockAdjustmentSchema.safeParse(
      adjustmentForm({ costBasis: "UNKNOWN", unknownCostReason: tooLong }),
    );

    expect(issueFor(openingLong, "openingStockUnknownReason")).toBe(
      issueFor(adjustmentLong, "unknownCostReason"),
    );

    // And the boundary itself is accepted by both.
    expect(
      createProductSchema.safeParse(
        productForm({
          openingStockCostBasis: "UNKNOWN",
          openingStockUnknownReason: justFits,
        }),
      ).success,
    ).toBe(true);
    expect(
      stockAdjustmentSchema.safeParse(
        adjustmentForm({ costBasis: "UNKNOWN", unknownCostReason: justFits }),
      ).success,
    ).toBe(true);
  });

  it("reads a blank cost as absent rather than as free, on both flows", () => {
    // `Number("")` is 0, so a parser that coerced before checking would record
    // a cleared field as "these units were free" — a cost, and a wrong one.
    const opening = createProductSchema.safeParse(
      productForm({ openingStockCostBasis: "KNOWN", openingStockUnitCost: "" }),
    );
    const adjustment = stockAdjustmentSchema.safeParse(
      adjustmentForm({ costBasis: "KNOWN", unitCost: "" }),
    );

    expect(opening.success).toBe(false);
    expect(adjustment.success).toBe(false);
  });

  it("accepts an explicit zero as a real cost, on both flows", () => {
    // Zero is a cost — a warranty replacement genuinely arrived free. Only a
    // *blank* is an absence.
    const opening = createProductSchema.safeParse(
      productForm({
        openingStockCostBasis: "KNOWN",
        openingStockUnitCost: "0",
      }),
    );
    const adjustment = stockAdjustmentSchema.safeParse(
      adjustmentForm({ costBasis: "KNOWN", unitCost: "0" }),
    );

    expect(opening.success).toBe(true);
    expect(adjustment.success).toBe(true);
    expect(costBasisUnitCostCents({ basis: "KNOWN", unitCost: 0 })).toBe(0);
  });

  it("writes an unknown reason into the ledger the same way for both", () => {
    expect(withUnknownCostReason("Base", "paperwork lost")).toBe(
      "Base (Acquisition cost unknown: paperwork lost)",
    );
  });
});

// ---------------------------------------------------------------------------
// The question is withdrawn with the quantity
// ---------------------------------------------------------------------------

describe("clearing a stale basis", () => {
  it("drops the selection once there is no batch to cost", () => {
    expect(basisForQuantity(0, "UNKNOWN")).toBeNull();
    expect(basisForQuantity(0, "KNOWN")).toBeNull();
    // A blank or malformed quantity box is not a positive quantity either.
    expect(basisForQuantity(Number(""), "UNKNOWN")).toBeNull();
    expect(basisForQuantity(Number("abc"), "UNKNOWN")).toBeNull();
    expect(basisForQuantity(-5, "KNOWN")).toBeNull();
  });

  it("keeps it while there is", () => {
    expect(basisForQuantity(1, "KNOWN")).toBe("KNOWN");
    expect(basisForQuantity(50, "UNKNOWN")).toBe("UNKNOWN");
    expect(basisForQuantity(50, null)).toBeNull();
  });

  it("asks nothing of an opening balance of zero", () => {
    // The rule the clearing exists to serve: no units, no batch, no question.
    expect(
      createProductSchema.safeParse(productForm({ stockQuantity: "0" })).success,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The engine's own guard
// ---------------------------------------------------------------------------

describe("recordOpeningStock rejects an illegal declaration", () => {
  /*
   * The union makes these unwriteable in TypeScript, which is the real defence.
   * These casts are what a `JSON.parse`, an older compiled caller, or a future
   * refactor would produce — and the point of the runtime guard is that the
   * invariant survives them too.
   */
  it("refuses a known cost with nothing to record", async () => {
    await signInWithRole("ADMIN");
    const product = await seedProduct({ sku: "GUARD-1", stockQuantity: 0 });

    await expect(
      prisma.$transaction((tx) =>
        recordOpeningStock(tx, {
          productId: product.id,
          quantity: 5,
          userId: "irrelevant",
          cost: { basis: "KNOWN" } as never,
        }),
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("refuses a declared unknown with no reason", async () => {
    await signInWithRole("ADMIN");
    const product = await seedProduct({ sku: "GUARD-2", stockQuantity: 0 });

    await expect(
      prisma.$transaction((tx) =>
        recordOpeningStock(tx, {
          productId: product.id,
          quantity: 5,
          userId: "irrelevant",
          cost: { basis: "UNKNOWN", reason: "  " } as never,
        }),
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("refuses a basis it does not recognise", async () => {
    await signInWithRole("ADMIN");
    const product = await seedProduct({ sku: "GUARD-3", stockQuantity: 0 });

    await expect(
      prisma.$transaction((tx) =>
        recordOpeningStock(tx, {
          productId: product.id,
          quantity: 5,
          userId: "irrelevant",
          cost: { basis: "PROBABLY" } as never,
        }),
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("writes nothing when it refuses", async () => {
    await signInWithRole("ADMIN");
    const product = await seedProduct({ sku: "GUARD-4", stockQuantity: 0 });

    await expect(
      prisma.$transaction((tx) =>
        recordOpeningStock(tx, {
          productId: product.id,
          quantity: 5,
          userId: "irrelevant",
          cost: { basis: "UNKNOWN", reason: "" } as never,
        }),
      ),
    ).rejects.toThrow();

    // The guard runs before the ledger row, so there is nothing to roll back —
    // but the transaction would roll it back anyway. Both are asserted.
    expect(
      await prisma.stockTransaction.count({ where: { productId: product.id } }),
    ).toBe(0);
    expect(
      await prisma.stockLot.count({ where: { productId: product.id } }),
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The form-shape to ledger-shape mapping
// ---------------------------------------------------------------------------

describe("openingStockCost", () => {
  it("maps a known declaration to cents", () => {
    expect(
      openingStockCost({
        openingStockCostBasis: "KNOWN",
        openingStockUnitCost: 7500.5,
      }, "USD"),
    ).toEqual({ basis: "KNOWN", unitCostCents: 750_050, currency: "USD" });
  });

  it("maps an unknown declaration to its reason", () => {
    expect(
      openingStockCost({
        openingStockCostBasis: "UNKNOWN",
        openingStockUnknownReason: "Paperwork lost",
      }, "USD"),
    ).toEqual({ basis: "UNKNOWN", reason: "Paperwork lost" });
  });

  it("throws rather than inventing the missing half", () => {
    // Every one of these is already impossible after the schema. Reaching one
    // means the schema was bypassed, and the right answer to that is to stop.
    expect(() => openingStockCost({}, "USD")).toThrow();
    expect(() =>
      openingStockCost({ openingStockCostBasis: "KNOWN" }, "USD"),
    ).toThrow();
    expect(() =>
      openingStockCost({ openingStockCostBasis: "UNKNOWN" }, "USD"),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// The database enforces the same pairing
// ---------------------------------------------------------------------------

describe("lot cost-source constraints", () => {
  /**
   * Inserts a lot straight past Prisma's model, which is the point: these
   * constraints exist so that a row written by a script, a fixture or a future
   * migration is subject to the same rule as one written by an operator.
   */
  async function insertLot(costSource: string, unitCost: string | null) {
    const product = await seedProduct({
      sku: `RAW-${Math.random().toString(36).slice(2, 8)}`,
      stockQuantity: 0,
    });

    return prisma.$executeRawUnsafe(
      `INSERT INTO stock_lots
         (id, product_id, unit_cost, cost_source, quantity_received,
          quantity_remaining, source_type, source_id, received_at, created_at)
       VALUES ($1, $2, ${unitCost === null ? "NULL" : "$3::decimal"},
               '${costSource}'::"LotCostSource", 5, 5, 'MANUAL', NULL, NOW(), NOW())`,
      ...(unitCost === null
        ? [`raw-${Math.random().toString(36).slice(2, 10)}`, product.id]
        : [`raw-${Math.random().toString(36).slice(2, 10)}`, product.id, unitCost]),
    );
  }

  it("refuses an OPENING lot with no cost", async () => {
    await expect(insertLot("OPENING", null)).rejects.toThrow(
      /stock_lots_opening_cost_known/,
    );
  });

  it("refuses an ADJUSTMENT lot with no cost", async () => {
    await expect(insertLot("ADJUSTMENT", null)).rejects.toThrow(
      /stock_lots_adjustment_cost_known/,
    );
  });

  it("refuses a PURCHASE lot with no cost", async () => {
    // The constraint this pair was modelled on, asserted alongside them.
    await expect(insertLot("PURCHASE", null)).rejects.toThrow(
      /stock_lots_purchase_cost_known/,
    );
  });

  it("refuses an UNKNOWN lot that carries a cost", async () => {
    // The other direction, and the one that keeps "we do not know" from ever
    // being stored as a number.
    await expect(insertLot("UNKNOWN", "8000.00")).rejects.toThrow(
      /stock_lots_unknown_cost_is_null/,
    );
  });

  it("allows every legal pairing", async () => {
    await expect(insertLot("OPENING", "7500.00")).resolves.toBe(1);
    await expect(insertLot("ADJUSTMENT", "6100.00")).resolves.toBe(1);
    await expect(insertLot("PURCHASE", "8000.00")).resolves.toBe(1);
    // Uncosted stock stays fully expressible — that is the whole point.
    await expect(insertLot("UNKNOWN", null)).resolves.toBe(1);
  });
});

/** The message a parse produced for one field, or undefined. */
function issueFor(
  result: { success: boolean; error?: { issues: readonly { path: PropertyKey[]; message: string }[] } },
  field: string,
): string | undefined {
  return result.error?.issues.find((issue) => issue.path[0] === field)?.message;
}

/**
 * The adjustment movement API, held to the same standard as the opening one.
 *
 * `recordStockMovement` used to take a nullable number and read omission as
 * UNKNOWN. Nothing reachable from the UI could exercise that — the schema has
 * required a declaration for some time, and the check constraints refuse a
 * costed source carrying no cost — but the *API* still spelled the defect the
 * rest of this workstream removed, and an API is a thing future callers read.
 * These tests are about the shape of that contract rather than about a bug
 * anybody could trigger today.
 *
 * What must not change is the behaviour, and most of what follows asserts
 * exactly that: the same lots, the same costs, the same notes as before.
 */
describe("the adjustment movement API", () => {
  /** A valid adjustment form, as strings, the way FormData delivers it. */
  function adjustmentForm(overrides: Record<string, string> = {}) {
    return {
      productId: "replaced-by-caller",
      quantity: "5",
      direction: "INCREASE",
      reason: "Found extra units during a shelf count",
      ...overrides,
    };
  }

  async function lotsFor(productId: string) {
    return prisma.stockLot.findMany({
      where: { productId },
      orderBy: { createdAt: "asc" },
      include: { stockTransaction: true },
    });
  }

  it("records the stated cost on a known-cost increase", async () => {
    await signInWithRole("ADMIN");
    const product = await seedProduct({
      sku: "ADJ-KNOWN",
      stockQuantity: 0,
      // Deliberately unlike the declared cost below, so a substituted figure
      // would be visible rather than coincidentally right.
      sellingPrice: "999.00",
    });

    await adjustStock(
      adjustmentForm({
        productId: product.id,
        costBasis: "KNOWN",
        unitCost: "77.77",
      }),
    );

    const lots = await lotsFor(product.id);
    expect(lots).toHaveLength(1);
    expect(lots[0]!.costSource).toBe("ADJUSTMENT");
    expect(Number(lots[0]!.unitCost)).toBe(77.77);
    expect(lots[0]!.quantityReceived).toBe(5);
  });

  it("records no cost, and the reason, on a declared-unknown increase", async () => {
    await signInWithRole("ADMIN");
    const product = await seedProduct({ sku: "ADJ-UNKNOWN", stockQuantity: 0 });

    await adjustStock(
      adjustmentForm({
        productId: product.id,
        costBasis: "UNKNOWN",
        unknownCostReason: "Found loose on the shelf, no paperwork survives",
      }),
    );

    const lots = await lotsFor(product.id);
    expect(lots).toHaveLength(1);
    expect(lots[0]!.costSource).toBe("UNKNOWN");
    expect(lots[0]!.unitCost).toBeNull();

    /*
     * The explanation has to outlive the form, and the ledger note is the only
     * place it can. Both halves travel together: why the stock changed, and
     * why nobody can price it.
     */
    expect(lots[0]!.stockTransaction!.note).toBe(
      withUnknownCostReason(
        "Found extra units during a shelf count",
        "Found loose on the shelf, no paperwork survives",
      ),
    );
  });

  it("substitutes no catalogue, reference or existing-lot cost", async () => {
    await signInWithRole("ADMIN");
    /*
     * A product carrying both a reference price and an already-costed lot —
     * the two figures a substitution bug would most plausibly reach for.
     */
    const product = await seedProduct({
      sku: "ADJ-NOSUB",
      stockQuantity: 10,
      sellingPrice: "500.00",
      lotUnitCost: "12.34",
    });

    await adjustStock(
      adjustmentForm({
        productId: product.id,
        quantity: "3",
        costBasis: "UNKNOWN",
        unknownCostReason: "No paperwork for these three",
      }),
    );

    const unknown = (await lotsFor(product.id)).find(
      (lot) => lot.costSource === "UNKNOWN",
    );

    expect(unknown).toBeDefined();
    expect(unknown!.unitCost).toBeNull();
    // The costed lot beside it is untouched, so "null" is a decision about
    // these units rather than a wipe of everything on the product.
    const costed = (await lotsFor(product.id)).find(
      (lot) => lot.costSource !== "UNKNOWN",
    );
    expect(Number(costed!.unitCost)).toBe(12.34);
  });

  it("refuses an inbound movement that declares nothing", async () => {
    await signInWithRole("ADMIN");
    const product = await seedProduct({ sku: "ADJ-OMIT", stockQuantity: 0 });

    await expect(
      recordStockMovement({
        productId: product.id,
        type: "ADJUSTMENT",
        quantity: 4,
        reference: { type: "MANUAL" },
        note: "No declaration at all",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    // Refused before anything was written, so no half-movement is left behind.
    expect(
      await prisma.stockTransaction.count({ where: { productId: product.id } }),
    ).toBe(0);
    expect(
      await prisma.stockLot.count({ where: { productId: product.id } }),
    ).toBe(0);
    expect(
      (await prisma.product.findUniqueOrThrow({ where: { id: product.id } }))
        .stockQuantity,
    ).toBe(0);
  });

  it("refuses declarations that are malformed rather than merely absent", async () => {
    await signInWithRole("ADMIN");
    const product = await seedProduct({ sku: "ADJ-BAD", stockQuantity: 0 });

    const movement = {
      productId: product.id,
      type: "ADJUSTMENT" as const,
      quantity: 4,
      reference: { type: "MANUAL" as const },
      note: "Malformed declaration",
    };

    /*
     * The union forbids every one of these at compile time. The casts are what
     * a JSON payload, an `as any`, or a caller compiled against the older
     * signature would produce, and the runtime guard is what keeps the
     * invariant true for them too.
     */
    for (const bad of [
      { basis: "KNOWN" },
      { basis: "KNOWN", unitCostCents: -1 },
      { basis: "KNOWN", unitCostCents: 12.5 },
      { basis: "UNKNOWN" },
      { basis: "UNKNOWN", reason: "  " },
      { basis: "PROBABLY" },
    ]) {
      await expect(
        recordStockMovement(movement, bad as never),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }

    expect(
      await prisma.stockLot.count({ where: { productId: product.id } }),
    ).toBe(0);
  });

  it("refuses a cost on a movement that removes stock", async () => {
    await signInWithRole("ADMIN");
    const product = await seedProduct({
      sku: "ADJ-OUT",
      stockQuantity: 10,
      lotUnitCost: "5.00",
    });

    await expect(
      recordStockMovement(
        {
          productId: product.id,
          type: "ADJUSTMENT",
          quantity: -2,
          reference: { type: "MANUAL" },
          note: "Cost supplied for an outbound movement",
        },
        { basis: "KNOWN", unitCostCents: 100, currency: "USD" },
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(
      (await prisma.product.findUniqueOrThrow({ where: { id: product.id } }))
        .stockQuantity,
    ).toBe(10);
  });

  it("leaves a decrease working exactly as before", async () => {
    await signInWithRole("ADMIN");
    const product = await seedProduct({
      sku: "ADJ-DEC",
      stockQuantity: 10,
      lotUnitCost: "5.00",
    });

    await adjustStock(
      adjustmentForm({
        productId: product.id,
        quantity: "4",
        direction: "DECREASE",
        reason: "Four units damaged in handling",
      }),
    );

    const after = await prisma.product.findUniqueOrThrow({
      where: { id: product.id },
    });
    expect(after.stockQuantity).toBe(6);

    // Drawn from the lot already on the shelf rather than creating one.
    const lots = await lotsFor(product.id);
    expect(lots).toHaveLength(1);
    expect(lots[0]!.quantityRemaining).toBe(6);
  });

  it("keeps I-1 and I-3 true across a mixed run of adjustments", async () => {
    await signInWithRole("ADMIN");
    const product = await seedProduct({
      sku: "ADJ-INV",
      stockQuantity: 10,
      lotUnitCost: "5.00",
    });

    await adjustStock(
      adjustmentForm({
        productId: product.id,
        quantity: "6",
        costBasis: "KNOWN",
        unitCost: "9.00",
      }),
    );
    await adjustStock(
      adjustmentForm({
        productId: product.id,
        quantity: "4",
        costBasis: "UNKNOWN",
        unknownCostReason: "Origin of these four is unrecorded",
      }),
    );
    await adjustStock(
      adjustmentForm({
        productId: product.id,
        quantity: "12",
        direction: "DECREASE",
        reason: "Shipped against a manual pick",
      }),
    );

    const after = await prisma.product.findUniqueOrThrow({
      where: { id: product.id },
    });
    const lots = await lotsFor(product.id);

    // I-1: the lots sum to the balance.
    expect(lots.reduce((sum, lot) => sum + lot.quantityRemaining, 0)).toBe(
      after.stockQuantity,
    );
    expect(after.stockQuantity).toBe(8);
    expect(after.stockQuantity).toBeGreaterThanOrEqual(0);

    // I-3: every lot's remainder is what it received less what was drawn.
    for (const lot of lots) {
      const consumed = await prisma.stockLotConsumption.aggregate({
        where: { lotId: lot.id },
        _sum: { quantity: true },
      });
      expect(lot.quantityRemaining).toBe(
        lot.quantityReceived - (consumed._sum.quantity ?? 0),
      );
    }

    // And the pairing the database enforces holds for every lot written here.
    for (const lot of lots) {
      if (lot.costSource === "UNKNOWN") expect(lot.unitCost).toBeNull();
      else expect(lot.unitCost).not.toBeNull();
    }
  });

  it("builds a declaration only when there is a batch to cost", () => {
    /*
     * A decrease has nothing to say and says nothing. That distinction used to
     * be lost: "no batch to cost" and "no knowable cost" both travelled as
     * null, which is what let the engine read silence as UNKNOWN.
     */
    expect(
      adjustmentCost({
        direction: "DECREASE",
        costBasis: "KNOWN",
        unitCost: 5,
      }, "USD"),
    ).toBeUndefined();

    expect(
      adjustmentCost({
        direction: "INCREASE",
        costBasis: "KNOWN",
        unitCost: 12.34,
      }, "USD"),
    ).toEqual({ basis: "KNOWN", unitCostCents: 1234, currency: "USD" });

    expect(
      adjustmentCost({
        direction: "INCREASE",
        costBasis: "UNKNOWN",
        unknownCostReason: "Nobody can price these",
      }, "USD"),
    ).toEqual({ basis: "UNKNOWN", reason: "Nobody can price these" });

    // An undeclared basis produces nothing, so the engine reports the missing
    // declaration rather than a half-built one invented here.
    expect(adjustmentCost({ direction: "INCREASE" }, "USD")).toBeUndefined();
  });
});
