import { beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { declaredCostCurrency, declaredCostError } from "@/lib/validation/cost-basis";
import { adjustmentCost } from "@/lib/validation/adjustment";
import { openingStockCost } from "@/lib/validation/product";
import { createProduct as createCatalogueProduct, adjustStock } from "@/server/products";
import { createOrder } from "@/server/orders";
import {
  createPurchase,
  receivePurchase,
  searchPurchaseProducts,
} from "@/server/purchases";
import { prefillableAmount } from "@/lib/document-currency";
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

/**
 * The last invoice as a reminder, never as a default in another currency.
 *
 * The purchase builder offers what was paid last time. That figure came off a
 * real batch and carries that batch's currency, and when the two disagree the
 * form offers nothing rather than the number — because this figure does not
 * stay on a screen. It becomes `StockLot.unitCost`, frozen against the currency
 * of the purchase that received it, and read back afterwards as the cost of the
 * goods. A dollar amount booked in as rupees is not a display fault somebody
 * can correct later; it is a batch that costs out wrong for the rest of its
 * life, and the next purchase of the part is seeded from it in turn.
 *
 * So this test goes all the way to storage. The decision is checked where the
 * form makes it, and then the lots are read back to prove what the decision
 * kept out of them.
 */
describe("a cost last paid in another currency", () => {
  it("never becomes the acquisition cost of a purchase raised in a different one", async () => {
    await signInWithRole("ADMIN");
    const supplier = await createSupplier();
    const part = await seedProduct({
      sku: "LOT-CCY-PREFILL",
      stockQuantity: 0,
    });

    // A first delivery, paid for in dollars.
    await setCurrency("USD");
    const first = await createPurchase({
      supplierId: supplier.id,
      items: [{ productId: part.id, quantity: 10, unitCost: "40.00" }],
    });
    await receivePurchase(first.id);

    // What the builder would show beside this part next time, in its own
    // currency: the reference is real and worth seeing.
    const option = (await searchPurchaseProducts("LOT-CCY-PREFILL"))[0]!;
    expect(option.lastPaidUnitCost).toBe("40.00");
    expect(option.lastPaidCurrency).toBe("USD");

    // And what a rupee purchase may start a line at: nothing. No conversion
    // happens here or anywhere — the operator enters what was actually paid.
    expect(
      prefillableAmount({
        amount: option.lastPaidUnitCost,
        currency: option.lastPaidCurrency,
        documentCurrency: "INR",
      }),
    ).toBeNull();

    const second = await createPurchase({
      supplierId: supplier.id,
      currency: "INR",
      items: [{ productId: part.id, quantity: 4, unitCost: "3400.00" }],
    });
    await receivePurchase(second.id);

    const lots = await prisma.stockLot.findMany({
      where: { productId: part.id, costSource: "PURCHASE" },
      orderBy: { receivedAt: "asc" },
      select: {
        unitCost: true,
        costCurrency: true,
        quantityReceived: true,
      },
    });

    expect(lots).toHaveLength(2);

    // The dollar batch, unchanged by anything that happened afterwards.
    expect(Number(lots[0]!.unitCost)).toBe(40);
    expect(lots[0]!.costCurrency).toBe("USD");

    // The one this test exists for: the rupee batch carries the rupee figure
    // the operator typed, denominated in the currency of its own purchase.
    expect(Number(lots[1]!.unitCost)).toBe(3400);
    expect(lots[1]!.costCurrency).toBe("INR");

    // And the shape the defect would have taken appears nowhere: the dollar
    // magnitude wearing the rupee label.
    expect(
      lots.some(
        (lot) => lot.costCurrency === "INR" && Number(lot.unitCost) === 40,
      ),
    ).toBe(false);

    // Both deliveries arrived in full. None of this touches the shelf.
    expect(lots[0]!.quantityReceived).toBe(10);
    expect(lots[1]!.quantityReceived).toBe(4);

    await expectLotsReconcile();
  });
});
