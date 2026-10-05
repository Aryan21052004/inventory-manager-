import { beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import type { StockMovementInput } from "@/lib/validation/stock";
import { recordStockMovement } from "@/server/stock";

import { createProduct, resetDatabase } from "./database";
import {
  fakeSupabaseUser,
  signInAsSupabase,
  signOutSupabase,
} from "./supabase-auth-mock";

beforeEach(async () => {
  signOutSupabase();
  await resetDatabase();
});

/**
 * Signs in backed by a local record with the given role.
 *
 * Its own copy rather than the shared `signInWithRole`, because these tests also
 * cover the case where no local row exists yet and need the two halves separate.
 * The row is created already linked, so resolution is the indexed lookup rather
 * than the one-time adoption.
 */
async function signInWithRole(role: "ADMIN" | "STAFF") {
  const supabaseUserId = `sb_${role.toLowerCase()}`;

  const local = await prisma.user.create({
    data: {
      supabaseUserId,
      name: `${role} Person`,
      email: `${role.toLowerCase()}@example.com`,
      role,
    },
  });

  signInAsSupabase(fakeSupabaseUser(supabaseUserId, local.email));
  return local;
}

/**
 * These tests exercise the ledger — attribution, balances, locking — not the
 * costing model. An inbound movement now has to declare a cost basis before it
 * will be accepted, so they state the one they previously got by omission.
 * Declaring it explicitly leaves the lots they produce exactly as they were:
 * UNKNOWN, with a null cost.
 */
const UNKNOWN_COST = {
  basis: "UNKNOWN",
  reason: "Ledger fixture — what these units cost is not what this test is about.",
} as const;

describe("attribution", () => {
  it("records the local database id of the signed-in user", async () => {
    const user = await signInWithRole("STAFF");
    const product = await createProduct(100);

    const { transaction } = await recordStockMovement(
      {
        productId: product.id,
        type: "STOCK_IN",
        quantity: 25,
        reference: { type: "MANUAL" },
      },
      UNKNOWN_COST,
    );

    // Not the Auth id — the foreign key points at our users table.
    expect(transaction.createdBy).toBe(user.id);
    expect(transaction.createdBy).not.toBe(user.supabaseUserId);

    // And it is a real foreign key, so the join resolves.
    const withUser = await prisma.stockTransaction.findUniqueOrThrow({
      where: { id: transaction.id },
      include: { createdByUser: true },
    });
    expect(withUser.createdByUser?.id).toBe(user.id);
    expect(withUser.createdByUser?.email).toBe("staff@example.com");
  });

  it("creates the local user first when the Auth account is new", async () => {
    // Nobody in the users table at all — the movement still has to be
    // attributable, so resolution has to happen on the way through.
    signInAsSupabase(
      fakeSupabaseUser("sb_firsttimer", "firsttimer@example.com"),
    );
    const product = await createProduct(10);

    const { transaction } = await recordStockMovement(
      {
        productId: product.id,
        type: "STOCK_IN",
        quantity: 5,
        reference: { type: "MANUAL" },
      },
      UNKNOWN_COST,
    );

    const created = await prisma.user.findUniqueOrThrow({
      where: { supabaseUserId: "sb_firsttimer" },
    });
    expect(transaction.createdBy).toBe(created.id);
  });

  it("ignores a createdBy supplied by the caller", async () => {
    const actor = await signInWithRole("STAFF");
    const somebodyElse = await prisma.user.create({
      data: {
        name: "Victim",
        email: "victim@example.com",
        role: "ADMIN",
      },
    });
    const product = await createProduct(50);

    // What a tampered request would look like. The field is not part of the
    // input type, so this is what it takes to even express it in TypeScript —
    // and at runtime it still has no effect.
    const tampered = {
      productId: product.id,
      type: "STOCK_OUT",
      quantity: 5,
      reference: { type: "MANUAL" },
      createdBy: somebodyElse.id,
    } as unknown as StockMovementInput;

    const { transaction } = await recordStockMovement(tampered);

    expect(transaction.createdBy).toBe(actor.id);
    expect(transaction.createdBy).not.toBe(somebodyElse.id);
  });

  it("refuses to record anything for an unauthenticated request", async () => {
    const product = await createProduct(10);

    await expect(
      recordStockMovement({
        productId: product.id,
        type: "STOCK_IN",
        quantity: 1,
        reference: { type: "MANUAL" },
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    expect(await prisma.stockTransaction.count()).toBe(0);
    // And the stock itself is untouched.
    const after = await prisma.product.findUniqueOrThrow({
      where: { id: product.id },
    });
    expect(after.stockQuantity).toBe(10);
  });
});

describe("authorisation", () => {
  it("lets STAFF record ordinary stock movements", async () => {
    await signInWithRole("STAFF");
    const product = await createProduct(100);

    await expect(
      recordStockMovement({
        productId: product.id,
        type: "STOCK_OUT",
        quantity: 10,
        reference: { type: "MANUAL" },
      }),
    ).resolves.toMatchObject({ previousStock: 100, newStock: 90 });
  });

  it("refuses a STAFF user an ADJUSTMENT, whatever the request says", async () => {
    await signInWithRole("STAFF");
    const product = await createProduct(100);

    await expect(
      recordStockMovement({
        productId: product.id,
        type: "ADJUSTMENT",
        quantity: -40,
        reference: { type: "MANUAL" },
        note: "Stock count correction",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });

    // Refused means nothing happened, not that it happened and was logged.
    expect(await prisma.stockTransaction.count()).toBe(0);
    const after = await prisma.product.findUniqueOrThrow({
      where: { id: product.id },
    });
    expect(after.stockQuantity).toBe(100);
  });

  it("refuses a STAFF user a REVERSAL", async () => {
    await signInWithRole("STAFF");
    const product = await createProduct(100);

    await expect(
      recordStockMovement({
        productId: product.id,
        type: "REVERSAL",
        quantity: -5,
        reference: { type: "STOCK_TRANSACTION", id: "whatever" },
        note: "Undoing an earlier mistake",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("allows an ADMIN the same ADJUSTMENT", async () => {
    const admin = await signInWithRole("ADMIN");
    const product = await createProduct(100);

    const { transaction } = await recordStockMovement({
      productId: product.id,
      type: "ADJUSTMENT",
      quantity: -40,
      reference: { type: "MANUAL" },
      note: "Stock count correction",
    });

    expect(transaction.createdBy).toBe(admin.id);
    expect(transaction.quantity).toBe(40);
    expect(transaction.newStock).toBe(60);
  });
});

describe("the ledger itself", () => {
  it("keeps the product balance and the ledger in step", async () => {
    await signInWithRole("STAFF");
    const product = await createProduct(0);

    await recordStockMovement(
      {
        productId: product.id,
        type: "STOCK_IN",
        quantity: 60,
        reference: { type: "MANUAL" },
      },
      UNKNOWN_COST,
    );
    await recordStockMovement({
      productId: product.id,
      type: "STOCK_OUT",
      quantity: 15,
      reference: { type: "MANUAL" },
    });

    const rows = await prisma.stockTransaction.findMany({
      where: { productId: product.id },
      orderBy: { createdAt: "asc" },
    });

    expect(rows.map((row) => [row.previousStock, row.newStock])).toEqual([
      [0, 60],
      [60, 45],
    ]);

    const after = await prisma.product.findUniqueOrThrow({
      where: { id: product.id },
    });
    expect(after.stockQuantity).toBe(45);
  });

  it("refuses a movement that would drive stock negative", async () => {
    await signInWithRole("STAFF");
    const product = await createProduct(3);

    await expect(
      recordStockMovement({
        productId: product.id,
        type: "STOCK_OUT",
        quantity: 4,
        reference: { type: "MANUAL" },
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_STOCK" });

    expect(await prisma.stockTransaction.count()).toBe(0);
  });

  it("rejects a MANUAL movement that carries a reference id", async () => {
    await signInWithRole("STAFF");
    const product = await createProduct(10);

    await expect(
      recordStockMovement({
        productId: product.id,
        type: "STOCK_IN",
        quantity: 1,
        reference: { type: "MANUAL", id: "sneaky" },
      } as unknown as StockMovementInput),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("refuses an ADJUSTMENT with no reason", async () => {
    await signInWithRole("ADMIN");
    const product = await createProduct(10);

    // The two types with no document behind them are the ones the ledger can
    // never explain on its own, so the reason is not optional for them.
    await expect(
      recordStockMovement({
        productId: product.id,
        type: "ADJUSTMENT",
        quantity: -1,
        reference: { type: "MANUAL" },
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(await prisma.stockTransaction.count()).toBe(0);
  });

  it("reports a missing product rather than inventing one", async () => {
    await signInWithRole("STAFF");

    await expect(
      recordStockMovement(
        {
          productId: "does-not-exist",
          type: "STOCK_IN",
          quantity: 1,
          reference: { type: "MANUAL" },
        },
        UNKNOWN_COST,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
