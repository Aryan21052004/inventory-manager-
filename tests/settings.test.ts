import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@clerk/nextjs/server", async () => {
  const { clerkServerMock } = await import("./clerk-mock");
  return clerkServerMock;
});

import { DEFAULT_CURRENCY } from "@/lib/currency";
import { prisma } from "@/lib/prisma";
import { currencySettingSchema } from "@/lib/validation/settings";
import { getCurrency, setCurrency } from "@/server/settings";

import { signOut } from "./clerk-mock";
import { resetDatabase, seedProduct, signInWithRole } from "./database";

/**
 * The application currency setting.
 *
 * Two properties matter here and neither is about formatting. The first is that
 * only an administrator can change it. The second — the one this whole feature
 * rests on — is that changing it moves no money: every `Decimal` in the
 * database keeps the exact value it had, because there is no exchange rate in
 * this system and there must never be one.
 *
 * `resetDatabase` clears the singleton row between cases, so each test starts
 * from "nobody has chosen" rather than from whatever the previous one set.
 */

/**
 * Every monetary column in the database, as strings, for comparing before and
 * after a currency change.
 *
 * Read as `toString()` rather than as numbers on purpose: this has to prove the
 * *stored* values are untouched, and a float round-trip could hide a change in
 * the last place — exactly the kind of drift the Decimal columns exist to
 * prevent.
 */
async function moneySnapshot() {
  const [products, orders, orderItems, purchases, purchaseItems, lots, consumptions] =
    await Promise.all([
      prisma.product.findMany({
        select: { id: true, sellingPrice: true },
        orderBy: { id: "asc" },
      }),
      prisma.order.findMany({
        select: { id: true, subtotal: true, total: true },
        orderBy: { id: "asc" },
      }),
      prisma.orderItem.findMany({
        select: { id: true, unitPrice: true, total: true, costTotal: true },
        orderBy: { id: "asc" },
      }),
      prisma.purchase.findMany({
        select: { id: true, total: true },
        orderBy: { id: "asc" },
      }),
      prisma.purchaseItem.findMany({
        select: { id: true, unitCost: true, total: true },
        orderBy: { id: "asc" },
      }),
      prisma.stockLot.findMany({
        select: { id: true, unitCost: true },
        orderBy: { id: "asc" },
      }),
      prisma.stockLotConsumption.findMany({
        select: { id: true, unitCost: true, totalCost: true },
        orderBy: { id: "asc" },
      }),
    ]);

  const money = (value: { toString(): string } | null) =>
    value === null ? null : value.toString();

  return JSON.stringify({
    products: products.map((r) => [r.id, money(r.sellingPrice)]),
    orders: orders.map((r) => [r.id, money(r.subtotal), money(r.total)]),
    orderItems: orderItems.map((r) => [
      r.id,
      money(r.unitPrice),
      money(r.total),
      money(r.costTotal),
    ]),
    purchases: purchases.map((r) => [r.id, money(r.total)]),
    purchaseItems: purchaseItems.map((r) => [r.id, money(r.unitCost), money(r.total)]),
    lots: lots.map((r) => [r.id, money(r.unitCost)]),
    consumptions: consumptions.map((r) => [r.id, money(r.unitCost), money(r.totalCost)]),
  });
}

describe("application currency setting", () => {
  beforeEach(async () => {
    await resetDatabase();
    signOut();
  });

  describe("the default", () => {
    it("is INR when the singleton row is absent", async () => {
      const rows = await prisma.appSetting.count();
      expect(rows).toBe(0);

      await expect(getCurrency()).resolves.toBe("INR");
    });

    it("matches the application default constant", async () => {
      await expect(getCurrency()).resolves.toBe(DEFAULT_CURRENCY);
    });

    /*
     * The migration seeds INR, and src/lib/currency.ts defaults to INR. Two
     * places stating the same fact is two places for it to drift, so this
     * pins them together.
     */
    it("agrees with the column default the migration wrote", async () => {
      const created = await prisma.appSetting.create({
        data: { id: "singleton" },
        select: { currency: true },
      });

      expect(created.currency).toBe(DEFAULT_CURRENCY);
    });
  });

  describe("authorisation", () => {
    it("lets an ADMIN change the currency", async () => {
      await signInWithRole("ADMIN");

      await expect(setCurrency("EUR")).resolves.toBe("EUR");
      await expect(getCurrency()).resolves.toBe("EUR");
    });

    it("refuses a STAFF user", async () => {
      await signInWithRole("STAFF");

      await expect(setCurrency("USD")).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
    });

    it("leaves the setting untouched when STAFF is refused", async () => {
      const admin = await signInWithRole("ADMIN");
      await setCurrency("EUR");

      signOut();
      await signInWithRole("STAFF");
      await expect(setCurrency("USD")).rejects.toMatchObject({
        code: "FORBIDDEN",
      });

      // Still what the admin set, not what the staff user asked for.
      const row = await prisma.appSetting.findUnique({
        where: { id: "singleton" },
        select: { currency: true, updatedBy: true },
      });
      expect(row?.currency).toBe("EUR");
      expect(row?.updatedBy).toBe(admin.id);
    });

    it("refuses an unauthenticated caller", async () => {
      signOut();

      await expect(setCurrency("USD")).rejects.toMatchObject({
        code: "UNAUTHORIZED",
      });
    });

    /*
     * STAFF can *read* it. The currency explains every figure on every screen
     * they use, so hiding it would make the numbers less legible without making
     * anything safer.
     */
    it("lets a STAFF user read the current currency", async () => {
      await signInWithRole("ADMIN");
      await setCurrency("USD");

      signOut();
      await signInWithRole("STAFF");
      await expect(getCurrency()).resolves.toBe("USD");
    });
  });

  describe("persistence", () => {
    it("persists the selection across reads", async () => {
      await signInWithRole("ADMIN");
      await setCurrency("USD");

      const row = await prisma.appSetting.findUnique({
        where: { id: "singleton" },
        select: { currency: true },
      });

      expect(row?.currency).toBe("USD");
    });

    it("records who changed it", async () => {
      const admin = await signInWithRole("ADMIN");
      await setCurrency("EUR");

      const row = await prisma.appSetting.findUnique({
        where: { id: "singleton" },
        select: { updatedBy: true },
      });

      expect(row?.updatedBy).toBe(admin.id);
    });

    it("round-trips every supported currency", async () => {
      await signInWithRole("ADMIN");

      for (const currency of ["USD", "INR", "EUR"] as const) {
        await setCurrency(currency);
        const row = await prisma.appSetting.findUnique({
          where: { id: "singleton" },
          select: { currency: true },
        });
        expect(row?.currency).toBe(currency);
      }
    });

    it("upserts rather than failing when the row is absent", async () => {
      await signInWithRole("ADMIN");
      expect(await prisma.appSetting.count()).toBe(0);

      await setCurrency("EUR");

      expect(await prisma.appSetting.count()).toBe(1);
    });

    /**
     * The single-row guarantee, enforced by the check constraint rather than by
     * the application remembering to use one id.
     */
    it("refuses a second settings row", async () => {
      await expect(
        prisma.appSetting.create({ data: { id: "another", currency: "USD" } }),
      ).rejects.toThrow();
    });
  });

  describe("no monetary data is converted", () => {
    /**
     * The business rule, asserted against the database rather than against a
     * screen: switching the currency must leave every stored amount identical,
     * to the digit.
     */
    it("leaves every monetary column byte-identical across a currency change", async () => {
      const admin = await signInWithRole("ADMIN");

      // A product with a reference price and a costed opening batch, so the
      // snapshot has something in the price, lot and consumption columns.
      await seedProduct({
        sku: "CUR-1",
        name: "Currency Fixture",
        sellingPrice: "1250.00",
        stockQuantity: 40,
        lotUnitCost: "800.00",
      });

      await setCurrency("INR");
      const before = await moneySnapshot();

      await setCurrency("USD");
      const afterUsd = await moneySnapshot();

      await setCurrency("EUR");
      const afterEur = await moneySnapshot();

      await setCurrency("INR");
      const backToInr = await moneySnapshot();

      expect(afterUsd).toBe(before);
      expect(afterEur).toBe(before);
      expect(backToInr).toBe(before);

      // And the values really are the ones that were written, not merely
      // consistent with each other.
      const product = await prisma.product.findFirst({
        where: { sku: "CUR-1" },
        select: { sellingPrice: true },
      });
      expect(product?.sellingPrice?.toString()).toBe("1250");

      const lot = await prisma.stockLot.findFirst({
        select: { unitCost: true },
      });
      expect(lot?.unitCost?.toString()).toBe("800");

      expect(admin.role).toBe("ADMIN");
    });

    it("changes nothing but the setting row itself", async () => {
      await signInWithRole("ADMIN");

      await seedProduct({
        sku: "CUR-2",
        name: "Second Fixture",
        sellingPrice: "99.99",
        stockQuantity: 5,
        lotUnitCost: "45.50",
      });

      const productsBefore = await prisma.product.findMany({
        orderBy: { id: "asc" },
      });
      const lotsBefore = await prisma.stockLot.findMany({ orderBy: { id: "asc" } });

      await setCurrency("EUR");

      const productsAfter = await prisma.product.findMany({
        orderBy: { id: "asc" },
      });
      const lotsAfter = await prisma.stockLot.findMany({ orderBy: { id: "asc" } });

      // Whole rows, not just the money: a currency change must not touch
      // `updatedAt` on anything either.
      expect(JSON.stringify(productsAfter)).toBe(JSON.stringify(productsBefore));
      expect(JSON.stringify(lotsAfter)).toBe(JSON.stringify(lotsBefore));
    });
  });

  describe("input validation", () => {
    it("accepts each supported code", () => {
      for (const currency of ["USD", "INR", "EUR"] as const) {
        expect(currencySettingSchema.safeParse({ currency }).success).toBe(true);
      }
    });

    /*
     * The form is a `<select>`, but the action behind it is an endpoint a
     * browser can call with anything at all — so the options in the markup are
     * a convenience, not a guarantee.
     */
    it("rejects an unsupported code", () => {
      for (const currency of ["GBP", "usd", "", "INR ", null, undefined, 42]) {
        expect(currencySettingSchema.safeParse({ currency }).success).toBe(false);
      }
    });
  });
});
