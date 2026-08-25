import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@clerk/nextjs/server", async () => {
  const { clerkServerMock } = await import("./clerk-mock");
  return clerkServerMock;
});

import { prisma } from "@/lib/prisma";
import { adjustStock } from "@/server/products";

import { fakeClerkUser, signInAs, signOut } from "./clerk-mock";
import { resetDatabase, seedProduct, signInWithRole } from "./database";

/**
 * Manual stock adjustments.
 *
 * The feature is small — a quantity, a direction, a reason — and almost all of
 * what it has to get right is invisible in the happy path: that only an admin
 * can run it, that the ledger records who actually ran it rather than who the
 * request claimed, that the arithmetic cannot go below zero, and that none of
 * those hold only when requests arrive one at a time.
 *
 * The concurrency cases at the bottom are the reason these run against a real
 * Postgres. `FOR UPDATE` is the thing under test there, and a mock would have
 * to be written to behave as if it worked.
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

describe("authorisation", () => {
  it("lets an ADMIN adjust stock", async () => {
    await signInWithRole("ADMIN");
    const product = await seedProduct({ sku: "ADJ-001", stockQuantity: 200 });

    const outcome = await adjustStock(adjustmentForm(product.id));

    expect(outcome).toMatchObject({ previousStock: 200, newStock: 180 });

    const after = await prisma.product.findUniqueOrThrow({
      where: { id: product.id },
    });
    expect(after.stockQuantity).toBe(180);
  });

  it("refuses a STAFF user", async () => {
    await signInWithRole("STAFF");
    const product = await seedProduct({ sku: "ADJ-002", stockQuantity: 200 });

    await expect(adjustStock(adjustmentForm(product.id))).rejects.toMatchObject(
      { code: "FORBIDDEN", status: 403 },
    );

    // Refused means nothing happened — not that it happened and was logged.
    const after = await prisma.product.findUniqueOrThrow({
      where: { id: product.id },
    });
    expect(after.stockQuantity).toBe(200);
    expect(await prisma.stockTransaction.count()).toBe(0);
  });

  it("refuses an unauthenticated request", async () => {
    const product = await seedProduct({ sku: "ADJ-003", stockQuantity: 50 });

    await expect(adjustStock(adjustmentForm(product.id))).rejects.toMatchObject(
      { code: "UNAUTHORIZED" },
    );

    expect(await prisma.stockTransaction.count()).toBe(0);
  });

  it("is decided by the role in our database, not by anything in the request", async () => {
    await signInWithRole("STAFF");
    const product = await seedProduct({ sku: "ADJ-004", stockQuantity: 100 });

    // A request that says it is allowed. The server never reads a role from the
    // input — it reads the one stored against the Clerk id.
    await expect(
      adjustStock({
        ...adjustmentForm(product.id),
        role: "ADMIN",
        isAdmin: "true",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("the transaction it writes", () => {
  it("records the movement with both balances and the reason", async () => {
    const admin = await signInWithRole("ADMIN");
    const product = await seedProduct({ sku: "ADJ-010", stockQuantity: 200 });

    await adjustStock(
      adjustmentForm(product.id, {
        quantity: "20",
        direction: "DECREASE",
        reason: "Two pallets found damaged",
      }),
    );

    const movements = await prisma.stockTransaction.findMany({
      where: { productId: product.id },
    });

    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({
      type: "ADJUSTMENT",
      // The column stores the size of the move; `type` and the balances carry
      // the direction.
      quantity: 20,
      previousStock: 200,
      newStock: 180,
      referenceType: "MANUAL",
      referenceId: null,
      note: "Two pallets found damaged",
      createdBy: admin.id,
    });
  });

  it("records an increase in the same shape", async () => {
    await signInWithRole("ADMIN");
    const product = await seedProduct({ sku: "ADJ-011", stockQuantity: 10 });

    await adjustStock(
      adjustmentForm(product.id, { quantity: "5", direction: "INCREASE" }),
    );

    const movement = await prisma.stockTransaction.findFirstOrThrow({
      where: { productId: product.id },
    });

    expect(movement).toMatchObject({
      quantity: 5,
      previousStock: 10,
      newStock: 15,
    });
  });

  it("never moves stock without writing a movement", async () => {
    await signInWithRole("ADMIN");
    const product = await seedProduct({ sku: "ADJ-012", stockQuantity: 100 });

    await adjustStock(adjustmentForm(product.id, { quantity: "10" }));
    await adjustStock(
      adjustmentForm(product.id, { quantity: "30", direction: "INCREASE" }),
    );

    const movements = await prisma.stockTransaction.findMany({
      where: { productId: product.id },
      orderBy: { createdAt: "asc" },
    });
    const after = await prisma.product.findUniqueOrThrow({
      where: { id: product.id },
    });

    // The ledger replays to exactly the quantity the product carries.
    const replayed = movements.reduce(
      (balance, movement) => balance + (movement.newStock - movement.previousStock),
      100,
    );
    expect(replayed).toBe(after.stockQuantity);
    expect(after.stockQuantity).toBe(120);
  });
});

describe("attribution", () => {
  it("takes createdBy from the Clerk session", async () => {
    const admin = await signInWithRole("ADMIN");
    const product = await seedProduct({ sku: "ADJ-020", stockQuantity: 100 });

    await adjustStock(adjustmentForm(product.id, { quantity: "1" }));

    const movement = await prisma.stockTransaction.findFirstOrThrow({
      where: { productId: product.id },
      include: { createdByUser: true },
    });

    // The local database id, not the Clerk id — the foreign key points at our
    // users table.
    expect(movement.createdBy).toBe(admin.id);
    expect(movement.createdBy).not.toBe(admin.clerkId);
    expect(movement.createdByUser?.email).toBe(admin.email);
  });

  it("ignores a createdBy the client tried to supply", async () => {
    const actor = await signInWithRole("ADMIN");
    const somebodyElse = await prisma.user.create({
      data: {
        clerkId: "user_victim",
        name: "Victim",
        email: "victim@example.com",
        role: "ADMIN",
      },
    });
    const product = await seedProduct({ sku: "ADJ-021", stockQuantity: 100 });

    // Extra fields in the request body. The schema names what it accepts and
    // `createdBy` is not among them, so this reaches nothing.
    await adjustStock({
      ...adjustmentForm(product.id, { quantity: "5" }),
      createdBy: somebodyElse.id,
      userId: somebodyElse.id,
    });

    const movement = await prisma.stockTransaction.findFirstOrThrow({
      where: { productId: product.id },
    });

    expect(movement.createdBy).toBe(actor.id);
    expect(movement.createdBy).not.toBe(somebodyElse.id);
  });

  it("resolves a first-time Clerk account to a new local user", async () => {
    // Signed in, but with no local row yet. The movement still has to be
    // attributable, so the row has to be created on the way through.
    signInAs(fakeClerkUser("user_brand_new", "brandnew@example.com"));
    await prisma.user.create({
      data: {
        // The seeded placeholder an admin created before the Clerk account
        // existed; the first sign-in with a matching email claims it.
        clerkId: "unlinked_brandnew",
        name: "Brand New",
        email: "brandnew@example.com",
        role: "ADMIN",
      },
    });

    const product = await seedProduct({ sku: "ADJ-022", stockQuantity: 10 });

    await adjustStock(adjustmentForm(product.id, { quantity: "1" }));

    const claimed = await prisma.user.findUniqueOrThrow({
      where: { clerkId: "user_brand_new" },
    });
    const movement = await prisma.stockTransaction.findFirstOrThrow({
      where: { productId: product.id },
    });

    expect(movement.createdBy).toBe(claimed.id);
  });
});

describe("validation", () => {
  it("requires a reason", async () => {
    await signInWithRole("ADMIN");
    const product = await seedProduct({ sku: "ADJ-030", stockQuantity: 100 });

    await expect(
      adjustStock(adjustmentForm(product.id, { reason: "  " })),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      details: { field: "reason" },
    });

    expect(await prisma.stockTransaction.count()).toBe(0);
  });

  it("rejects a zero or negative quantity", async () => {
    await signInWithRole("ADMIN");
    const product = await seedProduct({ sku: "ADJ-031", stockQuantity: 100 });

    for (const quantity of ["0", "-5"]) {
      await expect(
        adjustStock(adjustmentForm(product.id, { quantity })),
      ).rejects.toMatchObject({
        code: "BAD_REQUEST",
        details: { field: "quantity" },
      });
    }

    // The direction carries the sign; a negative quantity would be a second,
    // contradictable source of truth for it.
    const after = await prisma.product.findUniqueOrThrow({
      where: { id: product.id },
    });
    expect(after.stockQuantity).toBe(100);
  });

  it("rejects a fractional quantity", async () => {
    await signInWithRole("ADMIN");
    const product = await seedProduct({ sku: "ADJ-032", stockQuantity: 100 });

    await expect(
      adjustStock(adjustmentForm(product.id, { quantity: "1.5" })),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("rejects a direction that is neither INCREASE nor DECREASE", async () => {
    await signInWithRole("ADMIN");
    const product = await seedProduct({ sku: "ADJ-033", stockQuantity: 100 });

    await expect(
      adjustStock(adjustmentForm(product.id, { direction: "SIDEWAYS" })),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("reports a product that does not exist", async () => {
    await signInWithRole("ADMIN");

    await expect(
      adjustStock(adjustmentForm("no-such-product")),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("stock can never go negative", () => {
  it("refuses a decrease larger than the balance", async () => {
    await signInWithRole("ADMIN");
    const product = await seedProduct({ sku: "NEG-001", stockQuantity: 5 });

    await expect(
      adjustStock(adjustmentForm(product.id, { quantity: "6" })),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_STOCK", status: 422 });

    const after = await prisma.product.findUniqueOrThrow({
      where: { id: product.id },
    });
    expect(after.stockQuantity).toBe(5);
    expect(await prisma.stockTransaction.count()).toBe(0);
  });

  it("allows a decrease to exactly zero", async () => {
    await signInWithRole("ADMIN");
    const product = await seedProduct({ sku: "NEG-002", stockQuantity: 5 });

    const outcome = await adjustStock(
      adjustmentForm(product.id, { quantity: "5" }),
    );

    expect(outcome.newStock).toBe(0);
  });
});

describe("concurrency", () => {
  /*
   * These are the cases that a read-then-write implementation passes when run
   * one at a time and fails the moment two requests overlap. Each one fires
   * genuinely simultaneous adjustments at a single product and then checks the
   * two things that would break: the balance, and whether the ledger still
   * forms an unbroken chain.
   */

  /** True when every movement's `previousStock` is the one before's `newStock`. */
  async function ledgerIsContiguous(productId: string, opening: number) {
    const movements = await prisma.stockTransaction.findMany({
      where: { productId },
      orderBy: { createdAt: "asc" },
    });

    let balance = opening;
    for (const movement of movements) {
      if (movement.previousStock !== balance) return false;
      balance = movement.newStock;
    }

    return true;
  }

  it("keeps the balance correct when adjustments overlap", async () => {
    await signInWithRole("ADMIN");
    const product = await seedProduct({ sku: "CON-001", stockQuantity: 200 });

    // Six at once. Without the row lock these read the same 200 and the last
    // write wins, leaving 190 instead of 140.
    await Promise.all(
      Array.from({ length: 6 }, () =>
        adjustStock(
          adjustmentForm(product.id, {
            quantity: "10",
            direction: "DECREASE",
          }),
        ),
      ),
    );

    const after = await prisma.product.findUniqueOrThrow({
      where: { id: product.id },
    });

    expect(after.stockQuantity).toBe(140);
    expect(await prisma.stockTransaction.count()).toBe(6);
    expect(await ledgerIsContiguous(product.id, 200)).toBe(true);
  });

  it("keeps increases and decreases in step when they overlap", async () => {
    await signInWithRole("ADMIN");
    const product = await seedProduct({ sku: "CON-002", stockQuantity: 100 });

    await Promise.all([
      ...Array.from({ length: 3 }, () =>
        adjustStock(
          adjustmentForm(product.id, { quantity: "7", direction: "INCREASE" }),
        ),
      ),
      ...Array.from({ length: 3 }, () =>
        adjustStock(
          adjustmentForm(product.id, { quantity: "4", direction: "DECREASE" }),
        ),
      ),
    ]);

    const after = await prisma.product.findUniqueOrThrow({
      where: { id: product.id },
    });

    // 100 + 21 − 12
    expect(after.stockQuantity).toBe(109);
    expect(await ledgerIsContiguous(product.id, 100)).toBe(true);
  });

  it("cannot be raced past zero", async () => {
    await signInWithRole("ADMIN");
    const product = await seedProduct({ sku: "CON-003", stockQuantity: 100 });

    // Four simultaneous requests for 30 units against 100 on hand. Three can
    // succeed; the fourth has to fail, and the balance must never dip below
    // zero on the way there.
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () =>
        adjustStock(
          adjustmentForm(product.id, {
            quantity: "30",
            direction: "DECREASE",
          }),
        ),
      ),
    );

    const succeeded = results.filter((result) => result.status === "fulfilled");
    const failed = results.filter((result) => result.status === "rejected");

    expect(succeeded).toHaveLength(3);
    expect(failed).toHaveLength(1);
    expect((failed[0] as PromiseRejectedResult).reason).toMatchObject({
      code: "INSUFFICIENT_STOCK",
    });

    const after = await prisma.product.findUniqueOrThrow({
      where: { id: product.id },
    });
    expect(after.stockQuantity).toBe(10);

    // The refused one left no trace, and the three that ran form a clean chain.
    expect(await prisma.stockTransaction.count()).toBe(3);
    expect(await ledgerIsContiguous(product.id, 100)).toBe(true);
  });
});
