import { beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { confirmOrder, createOrder, updateOrder } from "@/server/orders";
import {
  createPurchase,
  receivePurchase,
  updatePurchase,
} from "@/server/purchases";
import { setCurrency } from "@/server/settings";

import {
  createSupplier,
  resetDatabase,
  seedCustomer,
  seedProduct,
  signInWithRole,
} from "./database";

/**
 * Which currency a document is agreed in, and what it takes to change it.
 *
 * Two rules run through all of this. The installation default *proposes* a
 * currency for something being created and has no other authority: it never
 * re-reads a document already raised, and an explicit choice always wins over
 * it. And because there are no exchange rates anywhere in this system, a price
 * cannot be moved to another currency by re-labelling it — so a figure that
 * survives a currency change unchanged is refused unless somebody says they
 * meant it.
 *
 * Every guard here is asserted through the server functions, never through a
 * form. Hiding a control proves nothing about what a direct caller can do.
 */

async function orderCurrency(id: string) {
  return (
    await prisma.order.findUniqueOrThrow({
      where: { id },
      select: { currency: true },
    })
  ).currency;
}

async function purchaseCurrency(id: string) {
  return (
    await prisma.purchase.findUniqueOrThrow({
      where: { id },
      select: { currency: true },
    })
  ).currency;
}

beforeEach(async () => {
  await resetDatabase();
});

describe("choosing a currency at entry", () => {
  it("takes the explicit choice over the installation default", async () => {
    await signInWithRole("ADMIN");
    const supplier = await createSupplier();
    const customer = await seedCustomer({ name: "Explicit" });
    const product = await seedProduct({ sku: "DOC-1", stockQuantity: 5 });

    await setCurrency("USD");

    const order = await createOrder({
      customerId: customer.id,
      currency: "INR",
      items: [{ productId: product.id, quantity: 1, unitPrice: "500.00" }],
    });

    const purchase = await createPurchase({
      supplierId: supplier.id,
      currency: "EUR",
      items: [{ productId: product.id, quantity: 1, unitCost: "9.00" }],
    });

    expect(await orderCurrency(order.id)).toBe("INR");
    expect(await purchaseCurrency(purchase.id)).toBe("EUR");
  });

  it("falls back to the default only when nothing was chosen", async () => {
    await signInWithRole("ADMIN");
    const supplier = await createSupplier();
    const customer = await seedCustomer({ name: "Implicit" });
    const product = await seedProduct({ sku: "DOC-2", stockQuantity: 5 });

    await setCurrency("EUR");

    const order = await createOrder({
      customerId: customer.id,
      items: [{ productId: product.id, quantity: 1, unitPrice: "5.00" }],
    });
    const purchase = await createPurchase({
      supplierId: supplier.id,
      items: [{ productId: product.id, quantity: 1, unitCost: "2.00" }],
    });

    expect(await orderCurrency(order.id)).toBe("EUR");
    expect(await purchaseCurrency(purchase.id)).toBe("EUR");
  });
});

describe("changing currency while the document is editable", () => {
  it("keeps a re-entered price and records the new currency", async () => {
    await signInWithRole("ADMIN");
    const customer = await seedCustomer({ name: "Re-entered" });
    const product = await seedProduct({ sku: "DOC-3", stockQuantity: 5 });

    await setCurrency("USD");
    const order = await createOrder({
      customerId: customer.id,
      items: [{ productId: product.id, quantity: 2, unitPrice: "10.00" }],
    });

    // A price genuinely re-decided in the new currency: nothing carried.
    await updateOrder(order.id, {
      customerId: customer.id,
      currency: "INR",
      items: [{ productId: product.id, quantity: 2, unitPrice: "830.00" }],
    });

    expect(await orderCurrency(order.id)).toBe("INR");

    const line = await prisma.orderItem.findFirstOrThrow({
      where: { orderId: order.id },
      select: { unitPrice: true },
    });
    // Preserved exactly as typed — never converted, never rounded.
    expect(line.unitPrice.toString()).toBe("830");
  });

  it("refuses a price that survived the change untouched", async () => {
    await signInWithRole("ADMIN");
    const customer = await seedCustomer({ name: "Carried" });
    const product = await seedProduct({ sku: "DOC-4", stockQuantity: 5 });

    await setCurrency("USD");
    const order = await createOrder({
      customerId: customer.id,
      items: [{ productId: product.id, quantity: 2, unitPrice: "10.00" }],
    });

    await expect(
      updateOrder(order.id, {
        customerId: customer.id,
        currency: "INR",
        items: [{ productId: product.id, quantity: 2, unitPrice: "10.00" }],
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    // Refused outright: neither the currency nor the price moved.
    expect(await orderCurrency(order.id)).toBe("USD");
  });

  it("accepts the same figure once it is explicitly acknowledged", async () => {
    await signInWithRole("ADMIN");
    const customer = await seedCustomer({ name: "Acknowledged" });
    const product = await seedProduct({ sku: "DOC-5", stockQuantity: 5 });

    await setCurrency("USD");
    const order = await createOrder({
      customerId: customer.id,
      items: [{ productId: product.id, quantity: 2, unitPrice: "10.00" }],
    });

    await updateOrder(order.id, {
      customerId: customer.id,
      currency: "INR",
      pricesConfirmedForCurrencyChange: true,
      items: [{ productId: product.id, quantity: 2, unitPrice: "10.00" }],
    });

    expect(await orderCurrency(order.id)).toBe("INR");

    const line = await prisma.orderItem.findFirstOrThrow({
      where: { orderId: order.id },
      select: { unitPrice: true },
    });
    // The number is untouched. Only its stated currency changed, and only
    // because somebody said so.
    expect(line.unitPrice.toString()).toBe("10");
  });

  it("leaves the currency alone when an edit does not mention one", async () => {
    await signInWithRole("ADMIN");
    const customer = await seedCustomer({ name: "Unmentioned" });
    const product = await seedProduct({ sku: "DOC-6", stockQuantity: 5 });

    await setCurrency("EUR");
    const order = await createOrder({
      customerId: customer.id,
      items: [{ productId: product.id, quantity: 1, unitPrice: "7.00" }],
    });

    // The default moves, then an unrelated edit is saved with no currency.
    // The order must not be quietly re-denominated to today's default.
    await setCurrency("USD");
    await updateOrder(order.id, {
      customerId: customer.id,
      items: [{ productId: product.id, quantity: 3, unitPrice: "7.00" }],
    });

    expect(await orderCurrency(order.id)).toBe("EUR");
  });

  it("applies the same rules to a purchase's unit costs", async () => {
    await signInWithRole("ADMIN");
    const supplier = await createSupplier();
    const product = await seedProduct({ sku: "DOC-7", stockQuantity: 0 });

    await setCurrency("USD");
    const purchase = await createPurchase({
      supplierId: supplier.id,
      items: [{ productId: product.id, quantity: 4, unitCost: "12.00" }],
    });

    await expect(
      updatePurchase(purchase.id, {
        supplierId: supplier.id,
        currency: "EUR",
        items: [{ productId: product.id, quantity: 4, unitCost: "12.00" }],
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect(await purchaseCurrency(purchase.id)).toBe("USD");

    await updatePurchase(purchase.id, {
      supplierId: supplier.id,
      currency: "EUR",
      costsConfirmedForCurrencyChange: true,
      items: [{ productId: product.id, quantity: 4, unitCost: "12.00" }],
    });

    expect(await purchaseCurrency(purchase.id)).toBe("EUR");
  });
});

describe("the lifecycle freeze, enforced on the server", () => {
  it("refuses an order's currency change once it is confirmed", async () => {
    await signInWithRole("ADMIN");
    const customer = await seedCustomer({ name: "Frozen order" });
    const product = await seedProduct({ sku: "DOC-8", stockQuantity: 10 });

    await setCurrency("USD");
    const order = await createOrder({
      customerId: customer.id,
      items: [{ productId: product.id, quantity: 2, unitPrice: "10.00" }],
    });

    await confirmOrder(order.id);

    /*
     * Called directly, with a perfectly well-formed payload and an
     * acknowledgement. A hidden control would not have stopped this; the
     * status guard does.
     */
    await expect(
      updateOrder(order.id, {
        customerId: customer.id,
        currency: "INR",
        pricesConfirmedForCurrencyChange: true,
        items: [{ productId: product.id, quantity: 2, unitPrice: "10.00" }],
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect(await orderCurrency(order.id)).toBe("USD");
  });

  it("refuses a purchase's currency change once it is received", async () => {
    await signInWithRole("ADMIN");
    const supplier = await createSupplier();
    const product = await seedProduct({ sku: "DOC-9", stockQuantity: 0 });

    await setCurrency("USD");
    const purchase = await createPurchase({
      supplierId: supplier.id,
      items: [{ productId: product.id, quantity: 3, unitCost: "6.00" }],
    });

    await receivePurchase(purchase.id);

    await expect(
      updatePurchase(purchase.id, {
        supplierId: supplier.id,
        currency: "EUR",
        costsConfirmedForCurrencyChange: true,
        items: [{ productId: product.id, quantity: 3, unitCost: "6.00" }],
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect(await purchaseCurrency(purchase.id)).toBe("USD");

    // And the lots the receipt stamped still name the currency it was
    // received in, which is what the freeze exists to protect.
    const lot = await prisma.stockLot.findFirstOrThrow({
      where: { productId: product.id, costSource: "PURCHASE" },
      select: { costCurrency: true },
    });
    expect(lot.costCurrency).toBe("USD");
  });
});
