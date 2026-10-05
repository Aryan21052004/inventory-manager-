import { beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import {
  DEFAULT_MOVEMENT_PARAMS,
  parseMovementListParams,
  type MovementListParams,
} from "@/lib/stock-movement-query";
import {
  listMovements,
  loadMovementProducts,
  loadMovementStats,
} from "@/server/stock-movements";
import { createPurchase, receivePurchase } from "@/server/purchases";
import { setCurrency } from "@/server/settings";
import { recordStockMovement } from "@/server/stock";

import { signOutSupabase } from "./supabase-auth-mock";
import {
  createSupplier,
  resetDatabase,
  seedProduct,
  signInWithRole,
} from "./database";

/**
 * The stock movements read model.
 *
 * This module writes nothing — it reads the ledger that the stock engine,
 * orders and purchases fill in. So the tests here are about *reporting*: that a
 * filter returns what it claims, that the signed change is derived correctly for
 * each movement type, that pagination cannot lose or repeat a row, and that
 * reading the ledger never changes it.
 *
 * Most fixtures are written straight to the table rather than through the
 * engine, because these tests need control over `createdAt` (for date filtering)
 * and over the exact mix of types and references. The rows are still valid
 * ledger rows — the check constraints on `stock_transactions` reject anything
 * whose arithmetic does not add up, so a careless fixture fails loudly. One test
 * goes through the real engine to prove the read model agrees with what the
 * engine actually writes.
 */

beforeEach(async () => {
  signOutSupabase();
  await resetDatabase();
});

function params(overrides: Partial<MovementListParams> = {}): MovementListParams {
  return { ...DEFAULT_MOVEMENT_PARAMS, ...overrides };
}

/**
 * A ledger row with an explicit date.
 *
 * `previousStock`/`newStock` are supplied so the arithmetic satisfies
 * `stock_transactions_arithmetic_balances`: STOCK_IN adds, STOCK_OUT subtracts,
 * and ADJUSTMENT/REVERSAL move by the absolute quantity in either direction.
 */
async function movement(input: {
  productId: string;
  type: "STOCK_IN" | "STOCK_OUT" | "ADJUSTMENT" | "REVERSAL";
  quantity: number;
  previousStock: number;
  newStock: number;
  createdAt?: Date;
  referenceType?: "ORDER" | "PURCHASE" | "STOCK_TRANSACTION" | "MANUAL";
  referenceId?: string | null;
  note?: string | null;
  createdBy?: string | null;
}) {
  const referenceType = input.referenceType ?? "MANUAL";

  return prisma.stockTransaction.create({
    data: {
      productId: input.productId,
      type: input.type,
      quantity: input.quantity,
      previousStock: input.previousStock,
      newStock: input.newStock,
      referenceType,
      // The pairing constraint: an id for every type except MANUAL, and none
      // for MANUAL.
      referenceId:
        referenceType === "MANUAL" ? null : (input.referenceId ?? "ref-1"),
      note: input.note ?? null,
      createdBy: input.createdBy ?? null,
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    },
  });
}

const day = (iso: string) => new Date(`${iso}T12:00:00.000Z`);

// ---------------------------------------------------------------------------
// 1 — the ledger comes back
// ---------------------------------------------------------------------------

describe("listMovements", () => {
  it("returns the stock transactions with their product and balances", async () => {
    const part = await seedProduct({
      sku: "MOV-1",
      name: "Hydraulic Actuator",
      stockQuantity: 150,
    });

    await movement({
      productId: part.id,
      type: "STOCK_IN",
      quantity: 100,
      previousStock: 50,
      newStock: 150,
      note: "Delivery booked in",
    });

    const result = await listMovements(params());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.total).toBe(1);
    expect(result.data.items).toHaveLength(1);

    // The raw quantity is not exposed: a row carries the *signed* change, so a
    // table cannot accidentally render an outflow as a positive number.
    expect(result.data.items[0]).not.toHaveProperty("quantity");

    expect(result.data.items[0]).toMatchObject({
      type: "STOCK_IN",
      change: 100,
      previousStock: 50,
      newStock: 150,
      productId: part.id,
      productName: "Hydraulic Actuator",
      productSku: "MOV-1",
      referenceType: "MANUAL",
      referenceId: null,
      referenceHref: null,
      referenceLabel: "Manual",
      note: "Delivery booked in",
      createdByName: null,
    });
  });

  it("derives the signed change from the movement type", async () => {
    const part = await seedProduct({ sku: "MOV-2", stockQuantity: 100 });

    await movement({
      productId: part.id,
      type: "STOCK_IN",
      quantity: 40,
      previousStock: 100,
      newStock: 140,
    });
    await movement({
      productId: part.id,
      type: "STOCK_OUT",
      quantity: 15,
      previousStock: 140,
      newStock: 125,
    });
    // An adjustment downwards: the direction lives in the balances, not the
    // type, so the read model reads it from there.
    await movement({
      productId: part.id,
      type: "ADJUSTMENT",
      quantity: 5,
      previousStock: 125,
      newStock: 120,
    });
    // A reversal upwards — an order cancellation putting units back.
    await movement({
      productId: part.id,
      type: "REVERSAL",
      quantity: 30,
      previousStock: 120,
      newStock: 150,
    });

    const result = await listMovements(params({ sort: "createdAt", direction: "asc" }));
    if (!result.ok) throw new Error("expected the list to load");

    expect(
      result.data.items.map((item) => [item.type, item.change]),
    ).toEqual([
      ["STOCK_IN", 40],
      ["STOCK_OUT", -15],
      ["ADJUSTMENT", -5],
      ["REVERSAL", 30],
    ]);
  });

  it("agrees with what the stock engine actually writes", async () => {
    // One pass through the real engine, so the read model is checked against
    // genuine ledger rows rather than only against hand-built fixtures.
    const user = await signInWithRole("STAFF");
    const part = await seedProduct({ sku: "MOV-3", stockQuantity: 200 });

    await recordStockMovement({
      productId: part.id,
      type: "STOCK_OUT",
      quantity: 20,
      reference: { type: "MANUAL" },
    });

    const result = await listMovements(params());
    if (!result.ok) throw new Error("expected the list to load");

    expect(result.data.items[0]).toMatchObject({
      type: "STOCK_OUT",
      change: -20,
      previousStock: 200,
      newStock: 180,
      createdByName: user.name,
    });
  });

  it("builds a clickable reference for orders and purchases, and none otherwise", async () => {
    const part = await seedProduct({ sku: "MOV-4", stockQuantity: 100 });

    await movement({
      productId: part.id,
      type: "STOCK_OUT",
      quantity: 10,
      previousStock: 100,
      newStock: 90,
      referenceType: "ORDER",
      referenceId: "order-abc",
      createdAt: day("2026-08-01"),
    });
    await movement({
      productId: part.id,
      type: "STOCK_IN",
      quantity: 10,
      previousStock: 90,
      newStock: 100,
      referenceType: "PURCHASE",
      referenceId: "purchase-xyz",
      createdAt: day("2026-08-02"),
    });
    await movement({
      productId: part.id,
      type: "ADJUSTMENT",
      quantity: 5,
      previousStock: 100,
      newStock: 105,
      referenceType: "MANUAL",
      createdAt: day("2026-08-03"),
    });

    const result = await listMovements(
      params({ sort: "createdAt", direction: "asc" }),
    );
    if (!result.ok) throw new Error("expected the list to load");

    expect(
      result.data.items.map((item) => [
        item.referenceType,
        item.referenceHref,
        item.referenceLabel,
      ]),
    ).toEqual([
      ["ORDER", "/orders/order-abc", "Order"],
      ["PURCHASE", "/purchases/purchase-xyz", "Purchase"],
      ["MANUAL", null, "Manual"],
    ]);
  });

  it("names who recorded the movement, or reports none", async () => {
    const user = await signInWithRole("ADMIN");
    const part = await seedProduct({ sku: "MOV-5", stockQuantity: 100 });

    await movement({
      productId: part.id,
      type: "STOCK_IN",
      quantity: 1,
      previousStock: 100,
      newStock: 101,
      createdBy: user.id,
      createdAt: day("2026-08-02"),
    });
    // A system row — the seed's, for instance — has no user behind it.
    await movement({
      productId: part.id,
      type: "STOCK_IN",
      quantity: 1,
      previousStock: 101,
      newStock: 102,
      createdBy: null,
      createdAt: day("2026-08-01"),
    });

    const result = await listMovements(params());
    if (!result.ok) throw new Error("expected the list to load");

    expect(result.data.items.map((item) => item.createdByName)).toEqual([
      user.name,
      null,
    ]);
  });
});

// ---------------------------------------------------------------------------
// 2 — product filter
// ---------------------------------------------------------------------------

describe("the product filter", () => {
  it("returns only that product's movements", async () => {
    const a = await seedProduct({ sku: "PF-A", name: "Alpha", stockQuantity: 100 });
    const b = await seedProduct({ sku: "PF-B", name: "Bravo", stockQuantity: 100 });

    await movement({
      productId: a.id,
      type: "STOCK_IN",
      quantity: 5,
      previousStock: 100,
      newStock: 105,
    });
    await movement({
      productId: a.id,
      type: "STOCK_OUT",
      quantity: 5,
      previousStock: 105,
      newStock: 100,
    });
    await movement({
      productId: b.id,
      type: "STOCK_IN",
      quantity: 7,
      previousStock: 100,
      newStock: 107,
    });

    const result = await listMovements(params({ productId: a.id }));
    if (!result.ok) throw new Error("expected the list to load");

    expect(result.data.total).toBe(2);
    expect(
      result.data.items.every((item) => item.productId === a.id),
    ).toBe(true);
  });

  it("returns nothing for a product with no movements", async () => {
    const quiet = await seedProduct({ sku: "PF-C", stockQuantity: 10 });
    const busy = await seedProduct({ sku: "PF-D", stockQuantity: 10 });

    await movement({
      productId: busy.id,
      type: "STOCK_IN",
      quantity: 1,
      previousStock: 10,
      newStock: 11,
    });

    const result = await listMovements(params({ productId: quiet.id }));
    if (!result.ok) throw new Error("expected the list to load");

    expect(result.data.items).toEqual([]);
    expect(result.data.total).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3 — transaction type filter
// ---------------------------------------------------------------------------

describe("the movement type filter", () => {
  async function ledgerOfEveryType() {
    const part = await seedProduct({ sku: "TF-1", stockQuantity: 100 });

    await movement({
      productId: part.id,
      type: "STOCK_IN",
      quantity: 10,
      previousStock: 100,
      newStock: 110,
    });
    await movement({
      productId: part.id,
      type: "STOCK_OUT",
      quantity: 4,
      previousStock: 110,
      newStock: 106,
    });
    await movement({
      productId: part.id,
      type: "STOCK_OUT",
      quantity: 6,
      previousStock: 106,
      newStock: 100,
    });
    await movement({
      productId: part.id,
      type: "ADJUSTMENT",
      quantity: 3,
      previousStock: 100,
      newStock: 97,
    });
    await movement({
      productId: part.id,
      type: "REVERSAL",
      quantity: 3,
      previousStock: 97,
      newStock: 100,
    });

    return part;
  }

  it("returns only movements of the chosen type", async () => {
    await ledgerOfEveryType();

    for (const [type, expected] of [
      ["STOCK_IN", 1],
      ["STOCK_OUT", 2],
      ["ADJUSTMENT", 1],
      ["REVERSAL", 1],
    ] as const) {
      const result = await listMovements(params({ type }));
      if (!result.ok) throw new Error("expected the list to load");

      expect(result.data.total).toBe(expected);
      expect(result.data.items.every((item) => item.type === type)).toBe(true);
    }
  });

  it("returns everything when no type is chosen", async () => {
    await ledgerOfEveryType();

    const result = await listMovements(params({ type: null }));
    if (!result.ok) throw new Error("expected the list to load");

    expect(result.data.total).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// 4 — reference type
//
// There is no reference-type *filter*: `MovementListParams` carries search,
// productId, type and a date range, and nothing else. What the module does
// expose is the reference on each row, so that is what is pinned here — the
// three-way mapping from a stored referenceType to the href and label the table
// renders. If a filter is added later, these are the rows it will have to
// select correctly.
// ---------------------------------------------------------------------------

describe("reference types on each row", () => {
  it("surfaces every reference type the ledger can hold", async () => {
    const part = await seedProduct({ sku: "RF-1", stockQuantity: 100 });

    await movement({
      productId: part.id,
      type: "STOCK_OUT",
      quantity: 1,
      previousStock: 100,
      newStock: 99,
      referenceType: "ORDER",
      referenceId: "o1",
      createdAt: day("2026-08-01"),
    });
    await movement({
      productId: part.id,
      type: "STOCK_IN",
      quantity: 1,
      previousStock: 99,
      newStock: 100,
      referenceType: "PURCHASE",
      referenceId: "p1",
      createdAt: day("2026-08-02"),
    });
    await movement({
      productId: part.id,
      type: "REVERSAL",
      quantity: 1,
      previousStock: 100,
      newStock: 101,
      referenceType: "STOCK_TRANSACTION",
      referenceId: "t1",
      createdAt: day("2026-08-03"),
    });
    await movement({
      productId: part.id,
      type: "ADJUSTMENT",
      quantity: 1,
      previousStock: 101,
      newStock: 100,
      referenceType: "MANUAL",
      createdAt: day("2026-08-04"),
    });

    const result = await listMovements(
      params({ sort: "createdAt", direction: "asc" }),
    );
    if (!result.ok) throw new Error("expected the list to load");

    expect(result.data.items.map((item) => item.referenceType)).toEqual([
      "ORDER",
      "PURCHASE",
      "STOCK_TRANSACTION",
      "MANUAL",
    ]);

    // Only orders and purchases have a page to link to; the other two are
    // labelled but not clickable.
    expect(result.data.items.map((item) => item.referenceHref)).toEqual([
      "/orders/o1",
      "/purchases/p1",
      null,
      null,
    ]);
    expect(result.data.items.map((item) => item.referenceLabel)).toEqual([
      "Order",
      "Purchase",
      "Transaction",
      "Manual",
    ]);
  });
});

// ---------------------------------------------------------------------------
// 5 — date range
// ---------------------------------------------------------------------------

describe("the date range filter", () => {
  async function threeDays() {
    const part = await seedProduct({ sku: "DF-1", stockQuantity: 100 });

    await movement({
      productId: part.id,
      type: "STOCK_IN",
      quantity: 1,
      previousStock: 100,
      newStock: 101,
      createdAt: day("2026-08-10"),
      note: "first",
    });
    await movement({
      productId: part.id,
      type: "STOCK_IN",
      quantity: 1,
      previousStock: 101,
      newStock: 102,
      createdAt: day("2026-08-15"),
      note: "second",
    });
    await movement({
      productId: part.id,
      type: "STOCK_IN",
      quantity: 1,
      previousStock: 102,
      newStock: 103,
      createdAt: day("2026-08-20"),
      note: "third",
    });

    return part;
  }

  it("filters from a date onwards", async () => {
    await threeDays();

    const result = await listMovements(params({ from: "2026-08-15" }));
    if (!result.ok) throw new Error("expected the list to load");

    expect(result.data.items.map((item) => item.note).sort()).toEqual([
      "second",
      "third",
    ]);
  });

  it("filters up to and including a date", async () => {
    await threeDays();

    // Inclusive: "to the 15th" covers the whole of the 15th, so the movement
    // recorded at midday that day is in.
    const result = await listMovements(params({ to: "2026-08-15" }));
    if (!result.ok) throw new Error("expected the list to load");

    expect(result.data.items.map((item) => item.note).sort()).toEqual([
      "first",
      "second",
    ]);
  });

  it("filters between two dates", async () => {
    await threeDays();

    const result = await listMovements(
      params({ from: "2026-08-11", to: "2026-08-19" }),
    );
    if (!result.ok) throw new Error("expected the list to load");

    expect(result.data.items.map((item) => item.note)).toEqual(["second"]);
  });

  it("returns nothing for a range with no movements in it", async () => {
    await threeDays();

    const result = await listMovements(
      params({ from: "2026-09-01", to: "2026-09-30" }),
    );
    if (!result.ok) throw new Error("expected the list to load");

    expect(result.data.items).toEqual([]);
    expect(result.data.total).toBe(0);
  });

  it("swaps a backwards range rather than returning nothing", async () => {
    await threeDays();

    // Parsed from the URL, where someone can put the later date first.
    const parsed = parseMovementListParams({
      from: "2026-08-19",
      to: "2026-08-11",
    });
    expect(parsed.from).toBe("2026-08-11");
    expect(parsed.to).toBe("2026-08-19");

    const result = await listMovements(parsed);
    if (!result.ok) throw new Error("expected the list to load");
    expect(result.data.items.map((item) => item.note)).toEqual(["second"]);
  });
});

// ---------------------------------------------------------------------------
// 6 — search
// ---------------------------------------------------------------------------

describe("search", () => {
  async function twoProducts() {
    const keyboard = await seedProduct({
      sku: "KEY-001",
      name: "Mechanical Keyboard",
      stockQuantity: 100,
    });
    const mouse = await seedProduct({
      sku: "MSE-001",
      name: "Wireless Mouse",
      stockQuantity: 100,
    });

    await movement({
      productId: keyboard.id,
      type: "STOCK_IN",
      quantity: 1,
      previousStock: 100,
      newStock: 101,
    });
    await movement({
      productId: mouse.id,
      type: "STOCK_IN",
      quantity: 1,
      previousStock: 100,
      newStock: 101,
    });

    return { keyboard, mouse };
  }

  it("matches on the product name", async () => {
    const { keyboard } = await twoProducts();

    const result = await listMovements(params({ search: "keyboard" }));
    if (!result.ok) throw new Error("expected the list to load");

    expect(result.data.items).toHaveLength(1);
    expect(result.data.items[0]!.productId).toBe(keyboard.id);
  });

  it("matches on the product SKU", async () => {
    const { mouse } = await twoProducts();

    const result = await listMovements(params({ search: "MSE-001" }));
    if (!result.ok) throw new Error("expected the list to load");

    expect(result.data.items).toHaveLength(1);
    expect(result.data.items[0]!.productId).toBe(mouse.id);
  });

  it("ignores case and matches part of a word", async () => {
    await twoProducts();

    const result = await listMovements(params({ search: "MoUs" }));
    if (!result.ok) throw new Error("expected the list to load");

    expect(result.data.items).toHaveLength(1);
  });

  it("returns nothing rather than everything when there is no match", async () => {
    await twoProducts();

    const result = await listMovements(params({ search: "zzzz" }));
    if (!result.ok) throw new Error("expected the list to load");

    expect(result.data.items).toEqual([]);
    expect(result.data.total).toBe(0);
  });

  it("combines with the other filters rather than replacing them", async () => {
    const { keyboard } = await twoProducts();

    await movement({
      productId: keyboard.id,
      type: "STOCK_OUT",
      quantity: 1,
      previousStock: 101,
      newStock: 100,
    });

    const result = await listMovements(
      params({ search: "keyboard", type: "STOCK_OUT" }),
    );
    if (!result.ok) throw new Error("expected the list to load");

    expect(result.data.total).toBe(1);
    expect(result.data.items[0]!.type).toBe("STOCK_OUT");
  });
});

// ---------------------------------------------------------------------------
// 7 — sorting
// ---------------------------------------------------------------------------

describe("sorting", () => {
  async function mixedLedger() {
    const alpha = await seedProduct({
      sku: "SORT-A",
      name: "Alpha Part",
      stockQuantity: 100,
    });
    const zulu = await seedProduct({
      sku: "SORT-Z",
      name: "Zulu Part",
      stockQuantity: 100,
    });

    await movement({
      productId: zulu.id,
      type: "STOCK_IN",
      quantity: 5,
      previousStock: 100,
      newStock: 105,
      createdAt: day("2026-08-01"),
    });
    await movement({
      productId: alpha.id,
      type: "STOCK_OUT",
      quantity: 50,
      previousStock: 100,
      newStock: 50,
      createdAt: day("2026-08-02"),
    });
    await movement({
      productId: alpha.id,
      type: "ADJUSTMENT",
      quantity: 20,
      previousStock: 50,
      newStock: 70,
      createdAt: day("2026-08-03"),
    });

    return { alpha, zulu };
  }

  it("defaults to newest first", async () => {
    await mixedLedger();

    const result = await listMovements(params());
    if (!result.ok) throw new Error("expected the list to load");

    const dates = result.data.items.map((item) => item.createdAt.getTime());
    expect(dates).toEqual([...dates].sort((a, b) => b - a));
  });

  it("sorts by date in both directions", async () => {
    await mixedLedger();

    const ascending = await listMovements(
      params({ sort: "createdAt", direction: "asc" }),
    );
    const descending = await listMovements(
      params({ sort: "createdAt", direction: "desc" }),
    );

    if (!ascending.ok || !descending.ok) {
      throw new Error("expected the list to load");
    }

    expect(ascending.data.items.map((item) => item.type)).toEqual([
      "STOCK_IN",
      "STOCK_OUT",
      "ADJUSTMENT",
    ]);
    expect(descending.data.items.map((item) => item.type)).toEqual([
      "ADJUSTMENT",
      "STOCK_OUT",
      "STOCK_IN",
    ]);
  });

  it("sorts by product name through the relation", async () => {
    await mixedLedger();

    const result = await listMovements(
      params({ sort: "product", direction: "asc" }),
    );
    if (!result.ok) throw new Error("expected the list to load");

    expect(result.data.items.map((item) => item.productName)).toEqual([
      "Alpha Part",
      "Alpha Part",
      "Zulu Part",
    ]);
  });

  it("sorts by quantity numerically", async () => {
    await mixedLedger();

    const result = await listMovements(
      params({ sort: "quantity", direction: "desc" }),
    );
    if (!result.ok) throw new Error("expected the list to load");

    // 50, 20, 5 — the sizes of the moves, not their signed effect.
    expect(result.data.items.map((item) => Math.abs(item.change))).toEqual([
      50, 20, 5,
    ]);
  });

  it("sorts by the resulting balance", async () => {
    await mixedLedger();

    const result = await listMovements(
      params({ sort: "newStock", direction: "asc" }),
    );
    if (!result.ok) throw new Error("expected the list to load");

    expect(result.data.items.map((item) => item.newStock)).toEqual([
      50, 70, 105,
    ]);
  });
});

// ---------------------------------------------------------------------------
// 8 — pagination
// ---------------------------------------------------------------------------

describe("pagination", () => {
  async function twelveMovements() {
    const part = await seedProduct({ sku: "PAGE-1", stockQuantity: 0 });

    for (let index = 0; index < 12; index += 1) {
      await movement({
        productId: part.id,
        type: "STOCK_IN",
        quantity: 1,
        previousStock: index,
        newStock: index + 1,
        createdAt: new Date(Date.UTC(2026, 7, index + 1, 12)),
        note: `movement-${String(index).padStart(2, "0")}`,
      });
    }

    return part;
  }

  it("reports the total across pages, not the page size", async () => {
    await twelveMovements();

    const result = await listMovements(params({ pageSize: 10, page: 1 }));
    if (!result.ok) throw new Error("expected the list to load");

    expect(result.data.items).toHaveLength(10);
    expect(result.data.total).toBe(12);
    expect(result.data.pageCount).toBe(2);
    expect(result.data.page).toBe(1);
    expect(result.data.pageSize).toBe(10);
  });

  it("returns the remainder on the last page", async () => {
    await twelveMovements();

    const result = await listMovements(params({ pageSize: 10, page: 2 }));
    if (!result.ok) throw new Error("expected the list to load");

    expect(result.data.items).toHaveLength(2);
    expect(result.data.total).toBe(12);
  });

  it("loses no row and repeats none across pages", async () => {
    await twelveMovements();

    const first = await listMovements(params({ pageSize: 5, page: 1 }));
    const second = await listMovements(params({ pageSize: 5, page: 2 }));
    const third = await listMovements(params({ pageSize: 5, page: 3 }));

    if (!first.ok || !second.ok || !third.ok) {
      throw new Error("expected the list to load");
    }

    const ids = [
      ...first.data.items,
      ...second.data.items,
      ...third.data.items,
    ].map((item) => item.id);

    expect(ids).toHaveLength(12);
    // The tiebreak on id is what makes this hold — without it a row can land on
    // two pages, or on neither.
    expect(new Set(ids).size).toBe(12);
  });

  it("returns an empty page past the end, still reporting the total", async () => {
    await twelveMovements();

    const result = await listMovements(params({ pageSize: 10, page: 5 }));
    if (!result.ok) throw new Error("expected the list to load");

    expect(result.data.items).toEqual([]);
    expect(result.data.total).toBe(12);
    expect(result.data.pageCount).toBe(2);
  });

  it("counts only rows matching the filters", async () => {
    const part = await twelveMovements();

    await movement({
      productId: part.id,
      type: "STOCK_OUT",
      quantity: 1,
      previousStock: 12,
      newStock: 11,
    });

    const result = await listMovements(params({ type: "STOCK_OUT" }));
    if (!result.ok) throw new Error("expected the list to load");

    expect(result.data.total).toBe(1);
    expect(result.data.pageCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 9 — stats
// ---------------------------------------------------------------------------

describe("loadMovementStats", () => {
  it("counts each type and nets the change", async () => {
    const part = await seedProduct({ sku: "ST-1", stockQuantity: 100 });

    await movement({
      productId: part.id,
      type: "STOCK_IN",
      quantity: 100,
      previousStock: 0,
      newStock: 100,
    });
    await movement({
      productId: part.id,
      type: "STOCK_IN",
      quantity: 50,
      previousStock: 100,
      newStock: 150,
    });
    await movement({
      productId: part.id,
      type: "STOCK_OUT",
      quantity: 30,
      previousStock: 150,
      newStock: 120,
    });
    await movement({
      productId: part.id,
      type: "ADJUSTMENT",
      quantity: 5,
      previousStock: 120,
      newStock: 115,
    });
    await movement({
      productId: part.id,
      type: "REVERSAL",
      quantity: 15,
      previousStock: 115,
      newStock: 130,
    });

    const result = await loadMovementStats();
    if (!result.ok) throw new Error("expected the stats to load");

    expect(result.data.total).toBe(5);
    expect(result.data.stockIn).toBe(2);
    expect(result.data.stockOut).toBe(1);
    // Adjustments and reversals are counted together — both are corrections.
    expect(result.data.adjustments).toBe(2);
    // +100 +50 −30 −5 +15
    expect(result.data.netChange).toBe(130);
  });

  it("nets to the closing balance of a single product's ledger", async () => {
    const part = await seedProduct({ sku: "ST-2", stockQuantity: 0 });

    await movement({
      productId: part.id,
      type: "STOCK_IN",
      quantity: 80,
      previousStock: 0,
      newStock: 80,
    });
    await movement({
      productId: part.id,
      type: "STOCK_OUT",
      quantity: 30,
      previousStock: 80,
      newStock: 50,
    });

    const result = await loadMovementStats();
    if (!result.ok) throw new Error("expected the stats to load");

    // The ledger replays from zero to the balance it describes.
    expect(result.data.netChange).toBe(50);
  });

  it("returns zeroes for an empty ledger", async () => {
    const result = await loadMovementStats();
    if (!result.ok) throw new Error("expected the stats to load");

    expect(result.data).toEqual({
      total: 0,
      stockIn: 0,
      stockOut: 0,
      adjustments: 0,
      netChange: 0,
    });
  });

  it("is unaffected by the list filters", async () => {
    // The tiles describe the whole ledger, not the current page — a filtered
    // list must not change what they report.
    const part = await seedProduct({ sku: "ST-3", stockQuantity: 0 });

    await movement({
      productId: part.id,
      type: "STOCK_IN",
      quantity: 10,
      previousStock: 0,
      newStock: 10,
    });
    await movement({
      productId: part.id,
      type: "STOCK_OUT",
      quantity: 4,
      previousStock: 10,
      newStock: 6,
    });

    await listMovements(params({ type: "STOCK_IN" }));

    const result = await loadMovementStats();
    if (!result.ok) throw new Error("expected the stats to load");
    expect(result.data.total).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 10 — filter options
// ---------------------------------------------------------------------------

describe("loadMovementProducts", () => {
  it("returns only products that have actually moved", async () => {
    const moved = await seedProduct({
      sku: "OPT-1",
      name: "Moved Part",
      stockQuantity: 100,
    });
    await seedProduct({
      sku: "OPT-2",
      name: "Never Moved Part",
      stockQuantity: 100,
    });

    await movement({
      productId: moved.id,
      type: "STOCK_IN",
      quantity: 1,
      previousStock: 100,
      newStock: 101,
    });

    const options = await loadMovementProducts();

    // A product with no movements would only ever produce an empty result, so
    // it is left out of the dropdown.
    expect(options).toEqual([
      { id: moved.id, name: "Moved Part", sku: "OPT-1" },
    ]);
  });

  it("lists each product once however many times it has moved", async () => {
    const part = await seedProduct({
      sku: "OPT-3",
      name: "Busy Part",
      stockQuantity: 100,
    });

    for (let index = 0; index < 4; index += 1) {
      await movement({
        productId: part.id,
        type: "STOCK_IN",
        quantity: 1,
        previousStock: 100 + index,
        newStock: 101 + index,
      });
    }

    const options = await loadMovementProducts();
    expect(options).toHaveLength(1);
    expect(options[0]!.sku).toBe("OPT-3");
  });

  it("orders them by name", async () => {
    const zulu = await seedProduct({ sku: "OPT-Z", name: "Zulu", stockQuantity: 10 });
    const alpha = await seedProduct({ sku: "OPT-A", name: "Alpha", stockQuantity: 10 });
    const mike = await seedProduct({ sku: "OPT-M", name: "Mike", stockQuantity: 10 });

    for (const part of [zulu, alpha, mike]) {
      await movement({
        productId: part.id,
        type: "STOCK_IN",
        quantity: 1,
        previousStock: 10,
        newStock: 11,
      });
    }

    const options = await loadMovementProducts();
    expect(options.map((option) => option.name)).toEqual([
      "Alpha",
      "Mike",
      "Zulu",
    ]);
  });

  it("returns an empty list when nothing has moved", async () => {
    await seedProduct({ sku: "OPT-4", stockQuantity: 100 });

    expect(await loadMovementProducts()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 11 — empty results
// ---------------------------------------------------------------------------

describe("an empty ledger", () => {
  it("returns an empty page rather than failing", async () => {
    const result = await listMovements(params());
    if (!result.ok) throw new Error("expected the list to load");

    expect(result.data).toEqual({
      items: [],
      total: 0,
      page: 1,
      pageSize: DEFAULT_MOVEMENT_PARAMS.pageSize,
      // One page, not zero — a list is always on a page, even an empty one.
      pageCount: 1,
    });
  });

  it("reports a page count of at least one for every filter", async () => {
    const part = await seedProduct({ sku: "EM-1", stockQuantity: 100 });
    await movement({
      productId: part.id,
      type: "STOCK_IN",
      quantity: 1,
      previousStock: 100,
      newStock: 101,
    });

    const result = await listMovements(params({ type: "REVERSAL" }));
    if (!result.ok) throw new Error("expected the list to load");

    expect(result.data.items).toEqual([]);
    expect(result.data.pageCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 12 — read access and read-only behaviour
// ---------------------------------------------------------------------------

describe("read access", () => {
  /*
   * These functions carry no role check of their own, and that is the existing
   * design rather than an oversight: access is enforced at the route boundary
   * by `getCurrentUser()` in the `(app)` layout, exactly as it is for
   * `listProducts`, `listOrders` and `listPurchases`. The tests below pin that
   * arrangement — that reading the ledger needs no role, and that no role can
   * change it — so a future change to either half is deliberate rather than
   * accidental.
   */

  it("is readable by STAFF as well as ADMIN", async () => {
    await signInWithRole("ADMIN");
    const part = await seedProduct({ sku: "AC-1", stockQuantity: 100 });
    await movement({
      productId: part.id,
      type: "STOCK_IN",
      quantity: 1,
      previousStock: 100,
      newStock: 101,
    });

    for (const role of ["ADMIN", "STAFF"] as const) {
      signOutSupabase();
      await signInWithRole(role);

      const result = await listMovements(params());
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.data.total).toBe(1);
    }
  });

  it("never writes to the ledger or to stock", async () => {
    await signInWithRole("STAFF");
    const part = await seedProduct({ sku: "AC-2", stockQuantity: 100 });

    await movement({
      productId: part.id,
      type: "STOCK_IN",
      quantity: 25,
      previousStock: 100,
      newStock: 125,
    });

    const ledgerBefore = await prisma.stockTransaction.count();
    const stockBefore = (
      await prisma.product.findUniqueOrThrow({ where: { id: part.id } })
    ).stockQuantity;

    // Every read path in the module, several times over.
    await listMovements(params());
    await listMovements(params({ type: "STOCK_IN", search: "AC" }));
    await loadMovementStats();
    await loadMovementProducts();

    expect(await prisma.stockTransaction.count()).toBe(ledgerBefore);
    expect(
      (await prisma.product.findUniqueOrThrow({ where: { id: part.id } }))
        .stockQuantity,
    ).toBe(stockBefore);
  });

  it("does not fail when there is no session", async () => {
    // Documenting the boundary: the guard is the route, not the function. If a
    // role check is ever added here, this test is the one that will notice.
    const part = await seedProduct({ sku: "AC-3", stockQuantity: 100 });
    await movement({
      productId: part.id,
      type: "STOCK_IN",
      quantity: 1,
      previousStock: 100,
      newStock: 101,
    });

    signOutSupabase();

    const result = await listMovements(params());
    expect(result.ok).toBe(true);
    expect((await loadMovementStats()).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Parameter parsing — the URL is user input
// ---------------------------------------------------------------------------

describe("parameter parsing", () => {
  it("falls back to defaults for anything unrecognised", async () => {
    const parsed = parseMovementListParams({
      type: "NOT_A_TYPE",
      sort: "nonsense",
      page: "-4",
      size: "999",
      dir: "sideways",
      from: "not-a-date",
    });

    expect(parsed.type).toBeNull();
    expect(parsed.sort).toBe(DEFAULT_MOVEMENT_PARAMS.sort);
    expect(parsed.page).toBe(1);
    expect(parsed.pageSize).toBe(DEFAULT_MOVEMENT_PARAMS.pageSize);
    expect(parsed.direction).toBe("desc");
    expect(parsed.from).toBeNull();
  });

  it("survives a mangled query string reaching the database", async () => {
    const part = await seedProduct({ sku: "PP-1", stockQuantity: 100 });
    await movement({
      productId: part.id,
      type: "STOCK_IN",
      quantity: 1,
      previousStock: 100,
      newStock: 101,
    });

    // Nothing unrecognised should reach the query builder, so this is a normal
    // unfiltered read rather than an error page.
    const result = await listMovements(
      parseMovementListParams({ sort: "; DROP TABLE", type: "OOPS" }),
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.total).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Movement cost, per currency
// ---------------------------------------------------------------------------

/**
 * What a movement cost, when its batches disagree about the currency.
 *
 * FIFO draws oldest-first and never reorders to chase a tidier answer, so one
 * outflow can legitimately consume a batch bought in dollars and a batch
 * bought in rupees. This read model used to add those together into a single
 * scalar — a number in no currency at all, which the table then labelled with
 * the installation default. These tests pin the replacement: one figure per
 * currency, and never one figure across them.
 *
 * Written through the real engine rather than hand-built rows, because the
 * per-layer currency is frozen onto `StockLotConsumption` at the moment of the
 * draw. A fixture that wrote those rows itself would be testing the fixture.
 *
 * Physical movement semantics are the control group throughout: `change`,
 * `previousStock`, `newStock` and `costedQuantity` must be untouched by the
 * currency split.
 */
describe("movement cost, per currency", () => {
  /** Receives `quantity` at `unitCost`, in whatever the default is set to. */
  async function receive(input: {
    supplierId: string;
    productId: string;
    quantity: number;
    unitCost: string;
    currency: "USD" | "INR" | "EUR";
  }) {
    await setCurrency(input.currency);

    const purchase = await createPurchase({
      supplierId: input.supplierId,
      items: [
        {
          productId: input.productId,
          quantity: input.quantity,
          unitCost: input.unitCost,
        },
      ],
    });

    await receivePurchase(purchase.id);
    return purchase;
  }

  /** The most recent movement, which is the one each test just made. */
  async function latest() {
    const result = await listMovements(params());
    if (!result.ok) throw new Error("expected the list to load");
    return result.data.items[0]!;
  }

  /** Blanks the currency on every lot, leaving the cost — the legacy shape. */
  async function forgetCurrencies(productId: string) {
    await prisma.stockLot.updateMany({
      where: { productId },
      data: { costCurrency: null },
    });
  }

  // -------------------------------------------------------------------------
  // A — one known currency
  // -------------------------------------------------------------------------

  it("reports one figure when every batch drawn shares a currency", async () => {
    await signInWithRole("ADMIN");
    const supplier = await createSupplier();
    const part = await seedProduct({ sku: "COST-A", stockQuantity: 0 });

    await receive({
      supplierId: supplier.id,
      productId: part.id,
      quantity: 10,
      unitCost: "40.00",
      currency: "USD",
    });
    await receive({
      supplierId: supplier.id,
      productId: part.id,
      quantity: 10,
      unitCost: "60.00",
      currency: "USD",
    });

    // FIFO: all ten of the first batch, then five of the second.
    await recordStockMovement({
      productId: part.id,
      type: "STOCK_OUT",
      quantity: 15,
      reference: { type: "MANUAL" },
    });

    const movement = await latest();

    // 10 x 40.00 + 5 x 60.00, both in dollars.
    expect(movement.costTotalByCurrency).toEqual([
      { currency: "USD", amount: "700.00" },
    ]);

    // The control: the physical movement is untouched by the split.
    expect(movement.change).toBe(-15);
    expect(movement.previousStock).toBe(20);
    expect(movement.newStock).toBe(5);
    expect(movement.costedQuantity).toBe(15);
  });

  // -------------------------------------------------------------------------
  // B — several known currencies
  // -------------------------------------------------------------------------

  it("refuses a single figure when the batches drawn disagree", async () => {
    await signInWithRole("ADMIN");
    const supplier = await createSupplier();
    const part = await seedProduct({ sku: "COST-B", stockQuantity: 0 });

    await receive({
      supplierId: supplier.id,
      productId: part.id,
      quantity: 10,
      unitCost: "40.00",
      currency: "USD",
    });
    await receive({
      supplierId: supplier.id,
      productId: part.id,
      quantity: 10,
      unitCost: "3000.00",
      currency: "INR",
    });

    await recordStockMovement({
      productId: part.id,
      type: "STOCK_OUT",
      quantity: 15,
      reference: { type: "MANUAL" },
    });

    const movement = await latest();

    // Two figures, each in its own currency: 10 x 40.00 and 5 x 3000.00.
    expect(movement.costTotalByCurrency).toEqual([
      { currency: "USD", amount: "400.00" },
      { currency: "INR", amount: "15000.00" },
    ]);

    /*
     * The defect this replaced: 400 + 15000 added straight together. No
     * exchange rate was consulted to produce 15400, so it must appear nowhere.
     */
    expect(
      movement.costTotalByCurrency.map((entry) => entry.amount),
    ).not.toContain("15400.00");

    // And the units are one number however the money splits.
    expect(movement.change).toBe(-15);
    expect(movement.previousStock).toBe(20);
    expect(movement.newStock).toBe(5);
    expect(movement.costedQuantity).toBe(15);
  });

  // -------------------------------------------------------------------------
  // C — known and unknown together
  // -------------------------------------------------------------------------

  it("keeps an unrecorded currency in its own bucket beside a known one", async () => {
    await signInWithRole("ADMIN");
    const supplier = await createSupplier();
    const part = await seedProduct({ sku: "COST-C", stockQuantity: 0 });

    // The older batch loses its currency — legacy data, cost intact.
    await receive({
      supplierId: supplier.id,
      productId: part.id,
      quantity: 10,
      unitCost: "50.00",
      currency: "USD",
    });
    await forgetCurrencies(part.id);

    await receive({
      supplierId: supplier.id,
      productId: part.id,
      quantity: 10,
      unitCost: "70.00",
      currency: "USD",
    });

    await recordStockMovement({
      productId: part.id,
      type: "STOCK_OUT",
      quantity: 15,
      reference: { type: "MANUAL" },
    });

    const movement = await latest();

    // The known currency first, the unrecorded one last — never merged.
    expect(movement.costTotalByCurrency).toEqual([
      { currency: "USD", amount: "350.00" },
      { currency: null, amount: "500.00" },
    ]);
    expect(movement.costedQuantity).toBe(15);
    expect(movement.change).toBe(-15);
  });

  // -------------------------------------------------------------------------
  // D — every layer's currency unknown
  // -------------------------------------------------------------------------

  it("reports the amount with a null currency when none was ever recorded", async () => {
    await signInWithRole("ADMIN");
    const supplier = await createSupplier();
    const part = await seedProduct({ sku: "COST-D", stockQuantity: 0 });

    await receive({
      supplierId: supplier.id,
      productId: part.id,
      quantity: 10,
      unitCost: "25.00",
      currency: "EUR",
    });
    await forgetCurrencies(part.id);

    await recordStockMovement({
      productId: part.id,
      type: "STOCK_OUT",
      quantity: 4,
      reference: { type: "MANUAL" },
    });

    const movement = await latest();

    // The money is real and is reported; only its label is missing.
    expect(movement.costTotalByCurrency).toEqual([
      { currency: null, amount: "100.00" },
    ]);

    /*
     * An unknown *currency* is not an unknown *cost*. The established rule is
     * that `costedQuantity` counts every layer carrying a unit cost, so these
     * units are costed — and the table must not read as though they were not.
     */
    expect(movement.costedQuantity).toBe(4);
    expect(movement.change).toBe(-4);
  });

  // -------------------------------------------------------------------------
  // E — nothing cost-bearing at all
  // -------------------------------------------------------------------------

  it("reports nothing at all when no batch drawn carried a cost", async () => {
    await signInWithRole("ADMIN");
    // `lotUnitCost: null` seeds stock that predates cost tracking.
    const part = await seedProduct({
      sku: "COST-E",
      stockQuantity: 12,
      lotUnitCost: null,
    });

    await recordStockMovement({
      productId: part.id,
      type: "STOCK_OUT",
      quantity: 5,
      reference: { type: "MANUAL" },
    });

    const movement = await latest();

    // Empty, which the table renders as "Unknown" — distinct from a zero.
    expect(movement.costTotalByCurrency).toEqual([]);
    expect(movement.costedQuantity).toBe(0);
    expect(movement.change).toBe(-5);
    expect(movement.newStock).toBe(7);
  });

  // -------------------------------------------------------------------------
  // F — a genuine zero
  // -------------------------------------------------------------------------

  it("reports a free delivery as a real zero, not as no cost at all", async () => {
    await signInWithRole("ADMIN");
    const supplier = await createSupplier();
    const part = await seedProduct({ sku: "COST-F", stockQuantity: 0 });

    await receive({
      supplierId: supplier.id,
      productId: part.id,
      quantity: 6,
      unitCost: "0.00",
      currency: "USD",
    });

    const movement = await latest();

    /*
     * Nothing was paid, which is a fact — and a different one from nobody
     * having recorded what was paid. The two must not collapse together.
     */
    expect(movement.costTotalByCurrency).toEqual([
      { currency: "USD", amount: "0.00" },
    ]);
    expect(movement.costTotalByCurrency).not.toEqual([]);
    expect(movement.costedQuantity).toBe(6);
    expect(movement.change).toBe(6);
  });

  // -------------------------------------------------------------------------
  // The inflow path
  // -------------------------------------------------------------------------

  it("costs a receipt in the currency it was bought in, not the default", async () => {
    await signInWithRole("ADMIN");
    const supplier = await createSupplier();
    const part = await seedProduct({ sku: "COST-IN", stockQuantity: 0 });

    await receive({
      supplierId: supplier.id,
      productId: part.id,
      quantity: 8,
      unitCost: "12.50",
      currency: "EUR",
    });

    // The setting moves on. What has already happened must not.
    await setCurrency("INR");

    const movement = await latest();

    expect(movement.costTotalByCurrency).toEqual([
      { currency: "EUR", amount: "100.00" },
    ]);
    expect(movement.change).toBe(8);
    expect(movement.previousStock).toBe(0);
    expect(movement.newStock).toBe(8);
    expect(movement.costedQuantity).toBe(8);
  });
});
