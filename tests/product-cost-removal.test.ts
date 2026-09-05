import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@clerk/nextjs/server", async () => {
  const { clerkServerMock } = await import("./clerk-mock");
  return clerkServerMock;
});

import { prisma } from "@/lib/prisma";
import { DEFAULT_LIST_PARAMS, parseProductListParams } from "@/lib/product-query";
import { createProductSchema } from "@/lib/validation/product";
import {
  createProduct as createCatalogueProduct,
  getProductDetail,
  listProducts,
  updateProduct,
} from "@/server/products";
import {
  createPurchase,
  loadPurchaseProducts,
  receivePurchase,
  searchPurchaseProducts,
} from "@/server/purchases";
import { adjustStock } from "@/server/products";

import { signOut } from "./clerk-mock";
import {
  createSupplier,
  expectLotsReconcile,
  resetDatabase,
  seedProduct,
  signInWithRole,
} from "./database";

/**
 * The catalogue has no cost, and nothing may put one back.
 *
 * `Product.costPrice` became `Product.standardCost` became nothing at all. The
 * column is gone because a single figure on the catalogue row cannot describe a
 * shelf of mixed deliveries: the same part arrives at ₹8,000, then ₹9,500, then
 * ₹11,000, and whichever of those the column held would be wrong about the
 * other two while reading, to everything downstream, exactly like a real cost.
 *
 * The tests here are mostly about absence, which is the awkward thing to test
 * and the thing most worth testing. A removed column comes back by accident —
 * as a convenience field, as a cache, as `lastPurchaseCost` or `averageCost`,
 * each a smaller version of the same mistake. So these assert not just that
 * costing is right today but that the shapes which used to carry the mistake
 * are still empty: no cost on the row, no cost in the API, no cost to sort by.
 *
 * What replaces the prefill is a *read*: the price actually paid on the most
 * recent receipt, labelled with its date, computed at query time and stored
 * nowhere. That cannot go stale, because there is nothing to go stale.
 */

beforeEach(async () => {
  signOut();
  await resetDatabase();
});

/** The create form's fields, as strings — which is how FormData delivers them. */
function productForm(overrides: Record<string, string> = {}) {
  return {
    name: "Bracket",
    sku: "BRK-1",
    category: "Airframe",
    sellingPrice: "12000.00",
    stockQuantity: "0",
    status: "ACTIVE",
    ...overrides,
  };
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

// ---------------------------------------------------------------------------
// The column is gone
// ---------------------------------------------------------------------------

describe("the catalogue carries no cost", () => {
  it("has no standard_cost column and no check constraint for one", async () => {
    // Straight at the database, because the schema is the claim. A Prisma model
    // that merely stopped selecting the column would leave the data — and the
    // temptation — in place.
    const columns = await prisma.$queryRaw<{ column_name: string }[]>`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'products'
    `;

    const names = columns.map((row) => row.column_name);
    expect(names).not.toContain("standard_cost");
    expect(names).not.toContain("cost_price");
    // Nor any of the names the same idea would return under.
    expect(names).not.toContain("last_purchase_cost");
    expect(names).not.toContain("average_cost");
    // The reference price stays: it is a price, not a cost.
    expect(names).toContain("selling_price");

    const constraints = await prisma.$queryRaw<{ conname: string }[]>`
      SELECT conname
      FROM pg_constraint
      WHERE conrelid = 'products'::regclass
    `;

    expect(constraints.map((row) => row.conname)).not.toContain(
      "products_standard_cost_non_negative",
    );
  });

  it("keeps no cost field on the product row itself", async () => {
    const product = await seedProduct({ sku: "SHAPE-1" });
    const row = await prisma.product.findUniqueOrThrow({
      where: { id: product.id },
    });

    for (const forbidden of [
      "standardCost",
      "costPrice",
      "lastPurchaseCost",
      "averageCost",
    ]) {
      expect(Object.keys(row)).not.toContain(forbidden);
    }
  });

  it("ignores a standard cost submitted to the create action", async () => {
    /*
     * A stale form, or a client that was never updated, can still post the old
     * field. It must be dropped rather than stored anywhere — silently
     * accepting it into some other column is how a removed concept survives.
     */
    await signInWithRole("ADMIN");

    const parsed = createProductSchema.parse(
      productForm({ standardCost: "8000.00" }),
    );

    expect(parsed).not.toHaveProperty("standardCost");

    const created = await createCatalogueProduct(
      productForm({ sku: "IGNORE-1", standardCost: "8000.00" }),
    );

    const row = await prisma.product.findUniqueOrThrow({
      where: { id: created.id },
    });

    // The only money on the row is the reference price it was given.
    expect(row.sellingPrice?.toString()).toBe("12000");
  });

  it("never exposes a cost on the product list or detail API", async () => {
    await signInWithRole("ADMIN");
    const product = await seedProduct({ sku: "API-1", lotUnitCost: "8000.00" });

    const list = await listProducts(DEFAULT_LIST_PARAMS);
    if (!list.ok) throw new Error("expected the list to load");
    expect(Object.keys(list.data.items[0]!)).not.toContain("standardCost");

    const detail = await getProductDetail(product.id);
    if (!detail.ok || !detail.data) throw new Error("expected a product");
    expect(Object.keys(detail.data)).not.toContain("standardCost");

    // Actual cost is still reachable — on the batch, where it belongs.
    expect(detail.data.lots[0]!.unitCost).toBe("8000");
  });

  it("refuses to sort the catalogue by a cost that no longer exists", async () => {
    /*
     * Browsing by cost is not replaced by last-paid or average cost, and this
     * is where that decision is enforced. A product does not have one cost, so
     * ranking a catalogue by it would order the list on an arbitrary batch.
     * Inventory value is the valuation report's question, answered per lot with
     * its own coverage disclosed.
     */
    const params = parseProductListParams({ sort: "standardCost" });
    expect(params.sort).toBe("name");

    for (const attempt of ["lastPurchaseCost", "averageCost", "costPrice"]) {
      expect(parseProductListParams({ sort: attempt }).sort).toBe("name");
    }
  });
});

// ---------------------------------------------------------------------------
// The reference price is a price, and optional
// ---------------------------------------------------------------------------

describe("the reference price", () => {
  it("may be absent, because some parts are only ever quoted", async () => {
    await signInWithRole("ADMIN");

    const created = await createCatalogueProduct(
      productForm({ sku: "NOPRICE-1", sellingPrice: "" }),
    );

    const row = await prisma.product.findUniqueOrThrow({
      where: { id: created.id },
    });

    // Null, not zero. Zero would mean the part is given away.
    expect(row.sellingPrice).toBeNull();

    // And it stays nullable through an edit.
    await updateProduct(created.id, {
      name: "Bracket",
      sku: "NOPRICE-1",
      category: "Airframe",
      sellingPrice: "",
      status: "ACTIVE",
    });

    const after = await prisma.product.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(after.sellingPrice).toBeNull();
  });

  it("cannot influence what stock is valued at", async () => {
    /*
     * The decoy, inverted. `sellingPrice` is the only money left on the
     * catalogue row, which makes it the field most likely to be reached for the
     * next time something needs "a cost". It must not be.
     */
    await signInWithRole("STAFF");
    const supplier = await createSupplier();
    const a = await seedProduct({
      sku: "DECOY-1",
      stockQuantity: 0,
      sellingPrice: "99999.00",
    });

    await receive(supplier.id, a.id, 10, "8000.00");

    const lots = await prisma.stockLot.findMany({ where: { productId: a.id } });
    expect(lots[0]!.unitCost?.toString()).toBe("8000");

    await prisma.product.update({
      where: { id: a.id },
      data: { sellingPrice: "1.00" },
    });

    const after = await prisma.stockLot.findMany({ where: { productId: a.id } });
    expect(after[0]!.unitCost?.toString()).toBe("8000");
  });
});

// ---------------------------------------------------------------------------
// One product, several acquisition prices
// ---------------------------------------------------------------------------

describe("a product with several acquisition prices", () => {
  it("keeps one lot per receipt, each remembering its own cost", async () => {
    /*
     * The case the removed column could not represent, asserted end to end.
     * Three deliveries of one part at three prices are three lots, and the
     * average nobody paid (₹9,500) appears nowhere.
     */
    await signInWithRole("STAFF");
    const supplier = await createSupplier();
    const a = await seedProduct({ sku: "MULTI-1", stockQuantity: 0 });

    await receive(supplier.id, a.id, 10, "8000.00");
    await receive(supplier.id, a.id, 10, "9500.00");
    await receive(supplier.id, a.id, 10, "11000.00");

    const lots = await prisma.stockLot.findMany({
      where: { productId: a.id },
      orderBy: [{ receivedAt: "asc" }, { id: "asc" }],
    });

    expect(lots.map((lot) => lot.unitCost?.toString())).toEqual([
      "8000",
      "9500",
      "11000",
    ]);
    expect(lots.every((lot) => lot.costSource === "PURCHASE")).toBe(true);

    // Valuation is the sum of what was actually paid, not 30 × any one price.
    const value = lots.reduce(
      (sum, lot) => sum + Number(lot.unitCost) * lot.quantityRemaining,
      0,
    );
    expect(value).toBe(285_000);

    await expectLotsReconcile();
  });
});

// ---------------------------------------------------------------------------
// The prefill: what was last actually paid
// ---------------------------------------------------------------------------

describe("the purchase line's cost prefill", () => {
  it("offers the most recent price actually paid, with its date", async () => {
    await signInWithRole("STAFF");
    const supplier = await createSupplier();
    const a = await seedProduct({ sku: "PREFILL-1", stockQuantity: 0 });

    await receive(supplier.id, a.id, 10, "8000.00");
    await receive(supplier.id, a.id, 10, "11000.00");

    const [option] = await searchPurchaseProducts("PREFILL-1");

    // The latest receipt, not the first and not an average of the two.
    expect(option!.lastPaidUnitCost).toBe("11000.00");
    expect(option!.lastPaidAt).toBeInstanceOf(Date);
  });

  it("leaves the prefill blank for a part never purchased", async () => {
    /*
     * No history, no figure — and emphatically not a zero. A prefill nobody can
     * source is worse than an empty box, because the operator has no way to
     * tell it from a real one, and a zero accepted unthinkingly records the
     * batch as free stock.
     */
    await signInWithRole("STAFF");
    await seedProduct({ sku: "NEVER-1", stockQuantity: 0 });

    const [option] = await searchPurchaseProducts("NEVER-1");

    expect(option!.lastPaidUnitCost).toBeNull();
    expect(option!.lastPaidAt).toBeNull();
  });

  it("ignores costs that no supplier invoice evidences", async () => {
    /*
     * "Last paid" is a claim about what a supplier charged. Opening stock and
     * manual adjustments are operator assertions about units that arrived
     * without an invoice behind them; they are real costs for valuation and
     * wrong answers to this question.
     */
    await signInWithRole("ADMIN");

    const created = await createCatalogueProduct(
      productForm({
        sku: "OPENING-1",
        stockQuantity: "5",
        openingStockCostBasis: "KNOWN",
        openingStockUnitCost: "7500.00",
      }),
    );

    await adjustStock({
      productId: created.id,
      quantity: "3",
      direction: "INCREASE",
      reason: "Found in the bonded store",
      costBasis: "KNOWN",
      unitCost: "6100.00",
    });

    const [before] = await searchPurchaseProducts("OPENING-1");
    expect(before!.lastPaidUnitCost).toBeNull();

    // A real receipt, and now there is something to report.
    const supplier = await createSupplier();
    await receive(supplier.id, created.id, 4, "8250.00");

    const [after] = await searchPurchaseProducts("OPENING-1");
    expect(after!.lastPaidUnitCost).toBe("8250.00");
  });

  it("reports nothing until the goods actually arrive", async () => {
    // A purchase that has been raised but not received has cost nobody
    // anything yet. Committing to its price would be pricing a delivery that
    // may still change or never land.
    await signInWithRole("STAFF");
    const supplier = await createSupplier();
    const a = await seedProduct({ sku: "PENDING-1", stockQuantity: 0 });

    const purchase = await createPurchase({
      supplierId: supplier.id,
      items: [{ productId: a.id, quantity: 5, unitCost: "9900.00" }],
    });

    expect((await searchPurchaseProducts("PENDING-1"))[0]!.lastPaidUnitCost)
      .toBeNull();

    await receivePurchase(purchase.id);

    expect((await searchPurchaseProducts("PENDING-1"))[0]!.lastPaidUnitCost)
      .toBe("9900.00");
  });

  it("reports it for a retired product being edited on an old purchase", async () => {
    // `loadPurchaseProducts` serves the edit screen, which must render lines
    // whatever the product's status. It answers the same question the same way.
    await signInWithRole("STAFF");
    const supplier = await createSupplier();
    const a = await seedProduct({ sku: "RETIRED-1", stockQuantity: 0 });

    // Bought while it was still active, then taken out of circulation — which
    // is exactly the state an old purchase's edit screen has to render.
    await receive(supplier.id, a.id, 6, "4300.00");
    await prisma.product.update({
      where: { id: a.id },
      data: { status: "DISCONTINUED" },
    });

    const [option] = await loadPurchaseProducts([a.id]);

    expect(option!.isActive).toBe(false);
    expect(option!.lastPaidUnitCost).toBe("4300.00");
  });

  it("stores nothing back on the product when it is read", async () => {
    // The whole reason this is a read. If asking the question wrote an answer,
    // the answer would start drifting the moment the next delivery landed.
    await signInWithRole("STAFF");
    const supplier = await createSupplier();
    const a = await seedProduct({ sku: "READONLY-1", stockQuantity: 0 });

    await receive(supplier.id, a.id, 10, "8000.00");

    const before = await prisma.product.findUniqueOrThrow({
      where: { id: a.id },
    });
    await searchPurchaseProducts("READONLY-1");
    const after = await prisma.product.findUniqueOrThrow({
      where: { id: a.id },
    });

    expect(after).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// Opening stock has to say what it cost, or why it cannot
// ---------------------------------------------------------------------------

describe("opening stock cost basis", () => {
  it("refuses an opening balance that does not declare one", async () => {
    /*
     * The hole this workstream closed. Leaving the cost box empty used to
     * create an UNKNOWN lot silently, so every uncosted opening unit in this
     * system came from a form that never asked rather than from anyone deciding
     * the cost was unrecoverable.
     */
    await signInWithRole("ADMIN");

    await expect(
      createCatalogueProduct(productForm({ sku: "NOBASIS-1", stockQuantity: "50" })),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      details: { field: "openingStockCostBasis" },
    });

    expect(await prisma.product.count()).toBe(0);
  });

  it("requires an actual cost when the basis is known", async () => {
    await signInWithRole("ADMIN");

    await expect(
      createCatalogueProduct(
        productForm({
          sku: "KNOWN-BLANK",
          stockQuantity: "50",
          openingStockCostBasis: "KNOWN",
          openingStockUnitCost: "",
        }),
      ),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      details: { field: "openingStockUnitCost" },
    });

    expect(await prisma.product.count()).toBe(0);
  });

  it("stores the actual unit cost when the basis is known", async () => {
    await signInWithRole("ADMIN");

    const created = await createCatalogueProduct(
      productForm({
        sku: "KNOWN-1",
        stockQuantity: "50",
        openingStockCostBasis: "KNOWN",
        openingStockUnitCost: "7500.00",
      }),
    );

    const lot = await prisma.stockLot.findFirstOrThrow({
      where: { productId: created.id },
    });

    expect(lot.unitCost?.toString()).toBe("7500");
    expect(lot.costSource).toBe("OPENING");
    expect(lot.quantityReceived).toBe(50);
    await expectLotsReconcile();
  });

  it("requires a reason when the basis is unknown", async () => {
    /*
     * The asymmetry the option rests on. A known cost is evidenced by the
     * number itself; an unknown one leaves a permanent hole in the valuation of
     * every sale that later draws on this batch, and the reason is the only
     * thing that will ever explain it.
     */
    await signInWithRole("ADMIN");

    await expect(
      createCatalogueProduct(
        productForm({
          sku: "UNKNOWN-BLANK",
          stockQuantity: "50",
          openingStockCostBasis: "UNKNOWN",
        }),
      ),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      details: { field: "openingStockUnknownReason" },
    });

    expect(await prisma.product.count()).toBe(0);
  });

  it("records an unknown cost as unknown, never as an invented number", async () => {
    await signInWithRole("ADMIN");

    const created = await createCatalogueProduct(
      productForm({
        sku: "UNKNOWN-1",
        sellingPrice: "12000.00",
        stockQuantity: "50",
        openingStockCostBasis: "UNKNOWN",
        openingStockUnknownReason: "Predates this system; paperwork lost.",
      }),
    );

    const lot = await prisma.stockLot.findFirstOrThrow({
      where: { productId: created.id },
    });

    // Null, not zero, and emphatically not the ₹12,000 it is priced at.
    expect(lot.unitCost).toBeNull();
    expect(lot.costSource).toBe("UNKNOWN");

    const movement = await prisma.stockTransaction.findFirstOrThrow({
      where: { productId: created.id, type: "STOCK_IN" },
    });
    expect(movement.note).toContain("Opening stock");
    expect(movement.note).toContain("paperwork lost");

    await expectLotsReconcile();
  });

  it("asks nothing of a product that opens with no stock", async () => {
    // No units, no batch, nothing to cost. Asking anyway is how a form teaches
    // people to dismiss the question.
    await signInWithRole("ADMIN");

    const created = await createCatalogueProduct(
      productForm({ sku: "ZERO-1", stockQuantity: "0" }),
    );

    expect(
      await prisma.stockLot.count({ where: { productId: created.id } }),
    ).toBe(0);
    expect(
      await prisma.stockTransaction.count({ where: { productId: created.id } }),
    ).toBe(0);
  });

  it("does not let a declared cost leak onto the catalogue row", async () => {
    await signInWithRole("ADMIN");

    const created = await createCatalogueProduct(
      productForm({
        sku: "LEAK-1",
        sellingPrice: "12000.00",
        stockQuantity: "10",
        openingStockCostBasis: "KNOWN",
        openingStockUnitCost: "7500.00",
      }),
    );

    const row = await prisma.product.findUniqueOrThrow({
      where: { id: created.id },
    });

    expect(Object.keys(row)).not.toContain("standardCost");
    expect(row.sellingPrice?.toString()).toBe("12000");
  });
});
