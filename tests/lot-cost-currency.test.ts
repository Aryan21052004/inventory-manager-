import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@clerk/nextjs/server", async () => {
  const { clerkServerMock } = await import("./clerk-mock");
  return clerkServerMock;
});

import { prisma } from "@/lib/prisma";
import { declaredCostCurrency, declaredCostError } from "@/lib/validation/cost-basis";
import { adjustmentCost } from "@/lib/validation/adjustment";
import { openingStockCost } from "@/lib/validation/product";
import { createProduct as createCatalogueProduct, adjustStock } from "@/server/products";
import { createOrder } from "@/server/orders";
import { createPurchase, receivePurchase } from "@/server/purchases";
import { setCurrency } from "@/server/settings";

import {
  createSupplier,
  expectLotsReconcile,
  resetDatabase,
  seedCustomer,
  seedProduct,
  signInWithRole,
} from "./database";

/**
 * Where a stock lot's cost currency comes from.
 *
 * Every batch that records an acquisition cost has to say what that cost is
 * denominated in, and the point of these tests is that it never comes from the
 * installation setting. It comes from the document or the declaration that
 * established the cost — the purchase, the operator's own answer, or the
 * consumption layer a return is reversing.
 *
 * The setting is deliberately moved around inside several of these tests. That
 * is the regression they exist to catch: before per-record currency, changing
 * it re-read every stored amount, and nothing in the suite noticed.
 */

beforeEach(async () => {
  await resetDatabase();
});

describe("the declaration itself", () => {
  it("carries a currency on the KNOWN arm and none on UNKNOWN", () => {
    const known = adjustmentCost(
      { direction: "INCREASE", costBasis: "KNOWN", unitCost: 12.34 },
      "EUR",
    );
    expect(known).toEqual({
      basis: "KNOWN",
      unitCostCents: 1234,
      currency: "EUR",
    });
    expect(declaredCostCurrency(known!)).toBe("EUR");

    const unknown = adjustmentCost(
      {
        direction: "INCREASE",
        costBasis: "UNKNOWN",
        unknownCostReason: "Nobody can price these",
      },
      "EUR",
    );
    expect(unknown).not.toHaveProperty("currency");
    expect(declaredCostCurrency(unknown!)).toBeNull();
  });

  it("refuses a known cost whose currency did not survive the type system", () => {
    // The shape a JSON.parse or a stale caller can still produce.
    const forged = { basis: "KNOWN", unitCostCents: 500 } as never;

    expect(declaredCostError(forged, "These units")).toMatch(/currency/i);
  });

  it("gives opening stock the currency it is handed, not the setting", () => {
    expect(
      openingStockCost(
        { openingStockCostBasis: "KNOWN", openingStockUnitCost: 25 },
        "INR",
      ),
    ).toEqual({ basis: "KNOWN", unitCostCents: 2500, currency: "INR" });
  });
});

describe("purchase-created lots", () => {
  it("takes the purchase's currency, not the current setting", async () => {
    await signInWithRole("ADMIN");
    const supplier = await createSupplier();
    const product = await seedProduct({ sku: "LOT-CCY-1", stockQuantity: 0 });

    await setCurrency("EUR");

    const purchase = await createPurchase({
      supplierId: supplier.id,
      items: [{ productId: product.id, quantity: 10, unitCost: "4.00" }],
    });

    // Moved *after* the purchase is raised and before it is received: the lot
    // must follow the document, not whatever the setting says at receipt.
    await setCurrency("INR");
    await receivePurchase(purchase.id);

    const stored = await prisma.purchase.findUniqueOrThrow({
      where: { id: purchase.id },
      select: { currency: true },
    });

    const lot = await prisma.stockLot.findFirstOrThrow({
      where: { productId: product.id, costSource: "PURCHASE" },
      select: { unitCost: true, costCurrency: true },
    });

    expect(lot.unitCost?.toString()).toBe("4");
    expect(lot.costCurrency).toBe(stored.currency);
    await expectLotsReconcile();
  });
});

describe("adjustment and opening-stock lots", () => {
  it("costs an increase in the declared currency", async () => {
    await signInWithRole("ADMIN");
    await setCurrency("EUR");
    const product = await seedProduct({ sku: "LOT-CCY-2", stockQuantity: 0 });

    await adjustStock({
      productId: product.id,
      quantity: "5",
      direction: "INCREASE",
      reason: "Found on the shelf",
      costBasis: "KNOWN",
      unitCost: "3.50",
    });

    const lot = await prisma.stockLot.findFirstOrThrow({
      where: { productId: product.id, costSource: "ADJUSTMENT" },
      select: { unitCost: true, costCurrency: true },
    });

    expect(lot.unitCost?.toString()).toBe("3.5");
    expect(lot.costCurrency).toBe("EUR");
  });

  it("never invents a currency for an unknown cost", async () => {
    await signInWithRole("ADMIN");
    await setCurrency("USD");
    const product = await seedProduct({ sku: "LOT-CCY-3", stockQuantity: 0 });

    await adjustStock({
      productId: product.id,
      quantity: "7",
      direction: "INCREASE",
      reason: "Counted in by hand",
      costBasis: "UNKNOWN",
      unknownCostReason: "Predates cost tracking",
    });

    const lot = await prisma.stockLot.findFirstOrThrow({
      where: { productId: product.id, costSource: "UNKNOWN" },
      select: { unitCost: true, costCurrency: true },
    });

    expect(lot.unitCost).toBeNull();
    expect(lot.costCurrency).toBeNull();
  });

  it("pairs opening stock's cost and currency, or leaves both null", async () => {
    await signInWithRole("ADMIN");
    const supplier = await createSupplier();
    await setCurrency("INR");

    await createCatalogueProduct({
      name: "Opened costed",
      sku: "OPEN-CCY-1",
      category: "Test",
      sellingPrice: "10.00",
      stockQuantity: "4",
      status: "ACTIVE",
      supplierId: supplier.id,
      openingStockCostBasis: "KNOWN",
      openingStockUnitCost: "2.00",
    });

    await createCatalogueProduct({
      name: "Opened uncosted",
      sku: "OPEN-CCY-2",
      category: "Test",
      sellingPrice: "10.00",
      stockQuantity: "4",
      status: "ACTIVE",
      supplierId: supplier.id,
      openingStockCostBasis: "UNKNOWN",
      openingStockUnknownReason: "Legacy stock, no paperwork",
    });

    const costed = await prisma.stockLot.findFirstOrThrow({
      where: { costSource: "OPENING" },
      select: { unitCost: true, costCurrency: true },
    });
    expect(costed.unitCost).not.toBeNull();
    expect(costed.costCurrency).toBe("INR");

    const uncosted = await prisma.stockLot.findFirstOrThrow({
      where: { costSource: "UNKNOWN" },
      select: { unitCost: true, costCurrency: true },
    });
    expect(uncosted.unitCost).toBeNull();
    expect(uncosted.costCurrency).toBeNull();
  });
});

describe("the default currency seeds new documents only", () => {
  it("stamps a new purchase and a new order with the current default", async () => {
    await signInWithRole("ADMIN");
    const supplier = await createSupplier();
    const customer = await seedCustomer({ name: "Defaults" });
    const product = await seedProduct({ sku: "DEF-CCY-1", stockQuantity: 5 });

    await setCurrency("EUR");

    const purchase = await createPurchase({
      supplierId: supplier.id,
      items: [{ productId: product.id, quantity: 2, unitCost: "3.00" }],
    });
    const order = await createOrder({
      customerId: customer.id,
      items: [{ productId: product.id, quantity: 1, unitPrice: "9.00" }],
    });

    expect(
      (
        await prisma.purchase.findUniqueOrThrow({
          where: { id: purchase.id },
          select: { currency: true },
        })
      ).currency,
    ).toBe("EUR");

    expect(
      (
        await prisma.order.findUniqueOrThrow({
          where: { id: order.id },
          select: { currency: true },
        })
      ).currency,
    ).toBe("EUR");
  });

  it("leaves documents already raised alone when the default moves", async () => {
    await signInWithRole("ADMIN");
    const supplier = await createSupplier();
    const customer = await seedCustomer({ name: "Untouched" });
    const product = await seedProduct({ sku: "DEF-CCY-2", stockQuantity: 5 });

    await setCurrency("USD");

    const purchase = await createPurchase({
      supplierId: supplier.id,
      items: [{ productId: product.id, quantity: 2, unitCost: "3.00" }],
    });
    const order = await createOrder({
      customerId: customer.id,
      items: [{ productId: product.id, quantity: 1, unitPrice: "9.00" }],
    });

    // The whole point of the rename: this seeds new entries and re-reads
    // nothing. Both documents keep the currency they were raised in.
    await setCurrency("INR");

    expect(
      (
        await prisma.purchase.findUniqueOrThrow({
          where: { id: purchase.id },
          select: { currency: true, total: true },
        })
      ).currency,
    ).toBe("USD");

    expect(
      (
        await prisma.order.findUniqueOrThrow({
          where: { id: order.id },
          select: { currency: true, total: true },
        })
      ).currency,
    ).toBe("USD");
  });
});

describe("the product's own price currency", () => {
  it("is set when a price is, and is null when there is none", async () => {
    await signInWithRole("ADMIN");
    const supplier = await createSupplier();
    await setCurrency("EUR");

    const priced = await createCatalogueProduct({
      name: "Priced",
      sku: "PRICE-CCY-1",
      category: "Test",
      sellingPrice: "19.99",
      stockQuantity: "0",
      status: "ACTIVE",
      supplierId: supplier.id,
    });

    const unpriced = await createCatalogueProduct({
      name: "Quoted only",
      sku: "PRICE-CCY-2",
      category: "Test",
      sellingPrice: "",
      stockQuantity: "0",
      status: "ACTIVE",
      supplierId: supplier.id,
    });

    const a = await prisma.product.findUniqueOrThrow({
      where: { id: priced.id },
      select: { sellingPrice: true, priceCurrency: true },
    });
    expect(a.sellingPrice).not.toBeNull();
    expect(a.priceCurrency).toBe("EUR");

    const b = await prisma.product.findUniqueOrThrow({
      where: { id: unpriced.id },
      select: { sellingPrice: true, priceCurrency: true },
    });
    expect(b.sellingPrice).toBeNull();
    expect(b.priceCurrency).toBeNull();
  });

  it("does not re-denominate an existing price when the default moves", async () => {
    await signInWithRole("ADMIN");
    const supplier = await createSupplier();
    await setCurrency("EUR");

    const product = await createCatalogueProduct({
      name: "Stable",
      sku: "PRICE-CCY-3",
      category: "Test",
      sellingPrice: "50.00",
      stockQuantity: "0",
      status: "ACTIVE",
      supplierId: supplier.id,
    });

    // The setting moves, then the product is edited for an unrelated reason.
    // Neither the number nor its currency may follow the setting.
    await setCurrency("USD");

    const { updateProduct } = await import("@/server/products");
    await updateProduct(product.id, {
      name: "Stable renamed",
      sku: "PRICE-CCY-3",
      category: "Test",
      sellingPrice: "50.00",
      status: "ACTIVE",
      supplierId: supplier.id,
    });

    const after = await prisma.product.findUniqueOrThrow({
      where: { id: product.id },
      select: { sellingPrice: true, priceCurrency: true },
    });

    expect(after.sellingPrice?.toString()).toBe("50");
    expect(after.priceCurrency).toBe("EUR");
  });

  it("clears the currency when the price is cleared", async () => {
    await signInWithRole("ADMIN");
    const supplier = await createSupplier();
    await setCurrency("USD");

    const product = await createCatalogueProduct({
      name: "Depriced",
      sku: "PRICE-CCY-4",
      category: "Test",
      sellingPrice: "12.00",
      stockQuantity: "0",
      status: "ACTIVE",
      supplierId: supplier.id,
    });

    const { updateProduct } = await import("@/server/products");
    await updateProduct(product.id, {
      name: "Depriced",
      sku: "PRICE-CCY-4",
      category: "Test",
      sellingPrice: "",
      status: "ACTIVE",
      supplierId: supplier.id,
    });

    const after = await prisma.product.findUniqueOrThrow({
      where: { id: product.id },
      select: { sellingPrice: true, priceCurrency: true },
    });

    expect(after.sellingPrice).toBeNull();
    expect(after.priceCurrency).toBeNull();
  });
});
