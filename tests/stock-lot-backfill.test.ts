import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@clerk/nextjs/server", async () => {
  const { clerkServerMock } = await import("./clerk-mock");
  return clerkServerMock;
});

import { prisma } from "@/lib/prisma";

import { signOut } from "./clerk-mock";
import { createSupplier, resetDatabase, signInWithRole } from "./database";

/**
 * The backfill, run against data shaped like a pre-costing database.
 *
 * The migration itself has already executed by the time any test runs — it is
 * part of the schema the suite is built from — so what is exercised here is its
 * logic, re-issued as the same SQL against rows arranged to look like history.
 * That is the part worth testing: the attribution rule, and the refusal to
 * invent what it cannot prove.
 *
 * Two properties matter.
 *
 *   Stock whose cost the existing data establishes gets that cost, attributed
 *   newest-first — because FIFO consumes the oldest units, so what is still on
 *   the shelf is what arrived most recently.
 *
 *   Everything else becomes an UNKNOWN lot with a null cost. Not the standard
 *   cost, not an average, not zero. The distinction between a cost that is
 *   known and one that is not has to survive the migration, or the whole
 *   redesign was pointless.
 */

beforeEach(async () => {
  signOut();
  await resetDatabase();
});

/**
 * The backfill's two INSERTs and its guard, exactly as the migration issues
 * them. Kept verbatim rather than reimplemented in TypeScript: a paraphrase
 * would test the paraphrase.
 */
async function runBackfill(): Promise<void> {
  await prisma.$executeRawUnsafe(`
    INSERT INTO "stock_lots" (
      "id", "product_id", "unit_cost", "cost_source",
      "quantity_received", "quantity_remaining",
      "source_type", "source_id", "received_at",
      "stock_transaction_id", "created_by", "created_at"
    )
    SELECT
      gen_random_uuid()::text,
      c."product_id",
      c."unit_cost",
      'PURCHASE'::"LotCostSource",
      c."take",
      c."take",
      'PURCHASE'::"StockReferenceType",
      c."purchase_id",
      c."received_at",
      c."stock_transaction_id",
      NULL,
      CURRENT_TIMESTAMP
    FROM (
      SELECT
        b."product_id", b."unit_cost", b."purchase_id", b."received_at",
        b."stock_transaction_id",
        LEAST(
          b."quantity",
          b."stock_quantity" - (b."running_total" - b."quantity")
        ) AS "take"
      FROM (
        SELECT
          pi."product_id", pi."quantity", pi."unit_cost",
          p."id" AS "purchase_id", p."received_at", pr."stock_quantity",
          (
            SELECT st."id" FROM "stock_transactions" st
            WHERE st."reference_type" = 'PURCHASE'
              AND st."reference_id" = p."id"
              AND st."product_id" = pi."product_id"
              AND st."type" = 'STOCK_IN'
            ORDER BY st."created_at" ASC, st."id" ASC
            LIMIT 1
          ) AS "stock_transaction_id",
          SUM(pi."quantity") OVER (
            PARTITION BY pi."product_id"
            ORDER BY p."received_at" DESC, p."id" DESC
            ROWS UNBOUNDED PRECEDING
          ) AS "running_total"
        FROM "purchase_items" pi
        JOIN "purchases" p
          ON p."id" = pi."purchase_id"
         AND p."status" = 'RECEIVED'
         AND p."received_at" IS NOT NULL
        JOIN "products" pr ON pr."id" = pi."product_id"
        WHERE pr."stock_quantity" > 0
      ) b
      WHERE b."running_total" - b."quantity" < b."stock_quantity"
    ) c
    WHERE c."take" > 0
  `);

  await prisma.$executeRawUnsafe(`
    INSERT INTO "stock_lots" (
      "id", "product_id", "unit_cost", "cost_source",
      "quantity_received", "quantity_remaining",
      "source_type", "source_id", "received_at",
      "stock_transaction_id", "created_by", "created_at"
    )
    SELECT
      gen_random_uuid()::text, pr."id", NULL, 'UNKNOWN'::"LotCostSource",
      pr."stock_quantity" - COALESCE(l."covered", 0),
      pr."stock_quantity" - COALESCE(l."covered", 0),
      'MANUAL'::"StockReferenceType", NULL, pr."created_at",
      NULL, NULL, CURRENT_TIMESTAMP
    FROM "products" pr
    LEFT JOIN (
      SELECT "product_id", SUM("quantity_remaining")::int AS "covered"
      FROM "stock_lots" GROUP BY "product_id"
    ) l ON l."product_id" = pr."id"
    WHERE pr."stock_quantity" - COALESCE(l."covered", 0) > 0
  `);

  const mismatched = await prisma.$queryRawUnsafe<{ n: number }[]>(`
    SELECT COUNT(*)::int AS n
    FROM "products" pr
    LEFT JOIN (
      SELECT "product_id", SUM("quantity_remaining")::int AS "remaining"
      FROM "stock_lots" GROUP BY "product_id"
    ) l ON l."product_id" = pr."id"
    WHERE pr."stock_quantity" <> COALESCE(l."remaining", 0)
  `);

  if ((mismatched[0]?.n ?? 0) > 0) {
    throw new Error(
      `Backfill guard: ${mismatched[0]!.n} product(s) do not reconcile`,
    );
  }
}

/**
 * A product carrying stock but no lots — the state every product is in the
 * instant before the backfill runs.
 *
 * Created well in the past, because that is the only order reality allows: a
 * purchase line carries a foreign key to a product, so the product necessarily
 * exists before any delivery can reference it. The backfill relies on that when
 * it dates the uncosted residual to `products.created_at` — doing so puts the
 * unexplained stock at the head of the FIFO queue, which is correct precisely
 * because it is the oldest stock there is.
 */
async function preCostingProduct(sku: string, stockQuantity: number) {
  return prisma.product.create({
    data: {
      sku,
      name: `Part ${sku}`,
      category: "Airframe",
      standardCost: "9999.00",
      sellingPrice: "12000.00",
      stockQuantity,
      createdAt: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000),
    },
  });
}

/** A received purchase written directly, with its STOCK_IN, as history would. */
async function historicPurchase(params: {
  supplierId: string;
  productId: string;
  number: string;
  quantity: number;
  unitCost: string;
  daysAgo: number;
}) {
  const receivedAt = new Date(
    Date.now() - params.daysAgo * 24 * 60 * 60 * 1000,
  );

  const purchase = await prisma.purchase.create({
    data: {
      purchaseNumber: params.number,
      status: "RECEIVED",
      total: (Number(params.unitCost) * params.quantity).toFixed(2),
      purchaseDate: receivedAt,
      receivedAt,
      supplierId: params.supplierId,
      items: {
        create: [
          {
            productId: params.productId,
            quantity: params.quantity,
            unitCost: params.unitCost,
            total: (Number(params.unitCost) * params.quantity).toFixed(2),
          },
        ],
      },
    },
  });

  await prisma.stockTransaction.create({
    data: {
      productId: params.productId,
      type: "STOCK_IN",
      quantity: params.quantity,
      previousStock: 0,
      newStock: params.quantity,
      referenceType: "PURCHASE",
      referenceId: purchase.id,
      createdAt: receivedAt,
    },
  });

  return purchase;
}

async function lotsOf(productId: string) {
  return prisma.stockLot.findMany({
    where: { productId },
    orderBy: [{ receivedAt: "asc" }, { id: "asc" }],
  });
}

describe("backfilling lots for stock that already existed", () => {
  it("reconstructs cost from received purchases, newest first", async () => {
    await signInWithRole("ADMIN");
    const supplier = await createSupplier();

    // 30 units bought across three deliveries; 12 have since been sold, so 18
    // remain. Newest-first attribution gives the ₹7,800 and ₹9,500 batches.
    const a = await preCostingProduct("A-1", 18);

    await historicPurchase({
      supplierId: supplier.id,
      productId: a.id,
      number: "PO-OLD-1",
      quantity: 10,
      unitCost: "8000.00",
      daysAgo: 30,
    });
    await historicPurchase({
      supplierId: supplier.id,
      productId: a.id,
      number: "PO-OLD-2",
      quantity: 10,
      unitCost: "9500.00",
      daysAgo: 20,
    });
    await historicPurchase({
      supplierId: supplier.id,
      productId: a.id,
      number: "PO-OLD-3",
      quantity: 10,
      unitCost: "7800.00",
      daysAgo: 10,
    });

    await runBackfill();

    const lots = await lotsOf(a.id);
    // The newest delivery survives whole; the middle one is partly consumed.
    expect(
      lots.map((lot) => [lot.unitCost?.toString(), lot.quantityRemaining]),
    ).toEqual([
      ["9500", 8],
      ["7800", 10],
    ]);

    // 8 × 9,500 + 10 × 7,800 = 154,000
    const value = lots.reduce(
      (sum, lot) => sum + Number(lot.unitCost) * lot.quantityRemaining,
      0,
    );
    expect(value).toBe(154_000);
  });

  it("links each reconstructed lot to the movement that booked it in", async () => {
    await signInWithRole("ADMIN");
    const supplier = await createSupplier();
    const a = await preCostingProduct("A-2", 10);

    await historicPurchase({
      supplierId: supplier.id,
      productId: a.id,
      number: "PO-OLD-4",
      quantity: 10,
      unitCost: "8000.00",
      daysAgo: 5,
    });

    await runBackfill();

    const lot = (await lotsOf(a.id))[0]!;
    expect(lot.stockTransactionId).not.toBeNull();

    const movement = await prisma.stockTransaction.findUniqueOrThrow({
      where: { id: lot.stockTransactionId! },
    });
    expect(movement.type).toBe("STOCK_IN");
    expect(movement.referenceId).toBe(lot.sourceId);
  });

  it("records stock it cannot account for as unknown, never as standard cost", async () => {
    await signInWithRole("ADMIN");

    // Stock with no purchase behind it at all — adjusted in, or seeded. The
    // product carries a plausible ₹9,999 standard cost, and the backfill must
    // decline to use it.
    const a = await preCostingProduct("A-3", 40);

    await runBackfill();

    const lots = await lotsOf(a.id);
    expect(lots).toHaveLength(1);
    expect(lots[0]!.unitCost).toBeNull();
    expect(lots[0]!.costSource).toBe("UNKNOWN");
    expect(lots[0]!.quantityRemaining).toBe(40);
    // Nothing to point at, because no movement explains these units.
    expect(lots[0]!.stockTransactionId).toBeNull();
  });

  it("splits a balance the purchases only partly explain", async () => {
    await signInWithRole("ADMIN");
    const supplier = await createSupplier();

    // 25 on hand, but only 10 of them traceable to a delivery.
    const a = await preCostingProduct("A-4", 25);

    await historicPurchase({
      supplierId: supplier.id,
      productId: a.id,
      number: "PO-OLD-5",
      quantity: 10,
      unitCost: "8000.00",
      daysAgo: 3,
    });

    await runBackfill();

    const lots = await lotsOf(a.id);
    expect(lots).toHaveLength(2);

    const unknown = lots.find((lot) => lot.costSource === "UNKNOWN");
    const costed = lots.find((lot) => lot.costSource === "PURCHASE");

    expect(unknown?.quantityRemaining).toBe(15);
    expect(unknown?.unitCost).toBeNull();
    expect(costed?.quantityRemaining).toBe(10);
    expect(costed?.unitCost?.toString()).toBe("8000");

    // The uncosted batch is dated to the product's creation, so FIFO takes it
    // first and the uncosted share of reporting shrinks over time.
    expect(unknown!.receivedAt.getTime()).toBeLessThan(
      costed!.receivedAt.getTime(),
    );
  });

  it("ignores cancelled purchases, whose stock was already reversed out", async () => {
    await signInWithRole("ADMIN");
    const supplier = await createSupplier();
    const a = await preCostingProduct("A-5", 10);

    await historicPurchase({
      supplierId: supplier.id,
      productId: a.id,
      number: "PO-OLD-6",
      quantity: 10,
      unitCost: "8000.00",
      daysAgo: 6,
    });

    const cancelled = await historicPurchase({
      supplierId: supplier.id,
      productId: a.id,
      number: "PO-OLD-7",
      quantity: 10,
      unitCost: "5.00",
      daysAgo: 2,
    });
    await prisma.purchase.update({
      where: { id: cancelled.id },
      data: { status: "CANCELLED", cancelledAt: new Date() },
    });

    await runBackfill();

    const lots = await lotsOf(a.id);
    // The ₹5.00 cancellation is the newest delivery, and would have claimed the
    // whole balance had it counted.
    expect(lots).toHaveLength(1);
    expect(lots[0]!.unitCost?.toString()).toBe("8000");
  });

  it("leaves a product holding no stock without any lots", async () => {
    await signInWithRole("ADMIN");
    const supplier = await createSupplier();
    const a = await preCostingProduct("A-6", 0);

    await historicPurchase({
      supplierId: supplier.id,
      productId: a.id,
      number: "PO-OLD-8",
      quantity: 10,
      unitCost: "8000.00",
      daysAgo: 9,
    });

    await runBackfill();

    expect(await lotsOf(a.id)).toHaveLength(0);
  });

  it("reconciles every product it touches", async () => {
    await signInWithRole("ADMIN");
    const supplier = await createSupplier();

    const a = await preCostingProduct("R-1", 18);
    const b = await preCostingProduct("R-2", 40);
    const c = await preCostingProduct("R-3", 0);

    await historicPurchase({
      supplierId: supplier.id,
      productId: a.id,
      number: "PO-R-1",
      quantity: 10,
      unitCost: "8000.00",
      daysAgo: 30,
    });
    await historicPurchase({
      supplierId: supplier.id,
      productId: a.id,
      number: "PO-R-2",
      quantity: 10,
      unitCost: "9500.00",
      daysAgo: 20,
    });
    await historicPurchase({
      supplierId: supplier.id,
      productId: b.id,
      number: "PO-R-3",
      quantity: 5,
      unitCost: "300.00",
      daysAgo: 15,
    });

    // The guard inside runBackfill throws if anything fails to reconcile.
    await runBackfill();

    for (const product of [a, b, c]) {
      const lots = await lotsOf(product.id);
      const remaining = lots.reduce(
        (sum, lot) => sum + lot.quantityRemaining,
        0,
      );
      const row = await prisma.product.findUniqueOrThrow({
        where: { id: product.id },
      });
      expect(remaining).toBe(row.stockQuantity);
    }
  });
});
