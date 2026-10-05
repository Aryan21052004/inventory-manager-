import { beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { DEFAULT_LIST_PARAMS } from "@/lib/product-query";
import { DEFAULT_ORDER_PARAMS } from "@/lib/order-query";
import { DEFAULT_PURCHASE_PARAMS } from "@/lib/purchase-query";
import { getCustomerDetail } from "@/server/customers";
import { listQuarantinedLots } from "@/server/lots";
import {
  confirmOrder,
  createOrder,
  getOrderDetail,
  listOrders,
  searchOrderProducts,
} from "@/server/orders";
import { getProductDetail, listProducts } from "@/server/products";
import {
  createPurchase,
  getPurchaseDetail,
  listPurchases,
  receivePurchase,
  searchPurchaseProducts,
} from "@/server/purchases";
import { recordSalesReturn } from "@/server/returns";
import { setCurrency } from "@/server/settings";
import { getSupplierDetail } from "@/server/suppliers";

import { signOutSupabase } from "./supabase-auth-mock";
import {
  createSupplier,
  quoted,
  resetDatabase,
  seedCustomer,
  seedProduct,
  signInWithRole,
} from "./database";

/**
 * The currency a record was written in belongs to the record.
 *
 * Every loader here hands a screen a single historical monetary amount — an
 * order's total, a batch's unit cost, a catalogue price. Each of those used to
 * arrive as a bare decimal, leaving the page to label it with
 * `AppSetting.defaultCurrency`. That is the defect this suite exists to keep
 * closed: changing one installation setting silently relabelled every figure
 * ever recorded, with the stored numbers untouched and nothing on screen to
 * say what had happened.
 *
 * The shape of every test is the same, and deliberately so. Write something
 * under currency A. Move the installation default to B — and to C, so a test
 * cannot pass by accident on a two-currency coincidence. Read it back and
 * assert it still says A.
 *
 * The null cases matter just as much. A row recorded before these columns
 * existed has no currency, and `null` must survive the round trip: the moment
 * a loader fills it in from the setting, history is being rewritten again.
 */

beforeEach(async () => {
  signOutSupabase();
  await resetDatabase();
  await signInWithRole("ADMIN");
});

/** Buys stock through the real path, in whatever the default is set to. */
async function buy(params: {
  supplierId: string;
  productId: string;
  quantity: number;
  unitCost: string;
  currency: "USD" | "INR" | "EUR";
}) {
  await setCurrency(params.currency);

  const purchase = await createPurchase({
    supplierId: params.supplierId,
    items: [
      {
        productId: params.productId,
        quantity: params.quantity,
        unitCost: params.unitCost,
      },
    ],
  });

  await receivePurchase(purchase.id);
  return purchase;
}

/** Sells through the real path, in whatever the default is set to. */
async function sell(params: {
  customerId: string;
  productId: string;
  quantity: number;
  currency: "USD" | "INR" | "EUR";
}) {
  await setCurrency(params.currency);

  const order = await createOrder({
    customerId: params.customerId,
    items: await quoted([
      { productId: params.productId, quantity: params.quantity },
    ]),
  });

  await confirmOrder(order.id);
  return order;
}

function unwrap<T>(
  result: { ok: true; data: T } | { ok: false; error: unknown },
): T {
  if (!result.ok) throw new Error("expected the loader to succeed");
  return result.data;
}

/** Moves the installation default somewhere else entirely, twice. */
async function driftTheSetting() {
  await setCurrency("EUR");
  await setCurrency("INR");
}

// ---------------------------------------------------------------------------
// Catalogue price — Product.priceCurrency
// ---------------------------------------------------------------------------

describe("a catalogue price keeps the currency it was set in", () => {
  it("reports it on the list and the detail alike", async () => {
    // `seedProduct` prices in USD, whatever the setting says.
    const product = await seedProduct({
      sku: "PRICE-1",
      sellingPrice: "125.00",
      stockQuantity: 0,
    });

    await driftTheSetting();

    const page = unwrap(await listProducts(DEFAULT_LIST_PARAMS));
    expect(page.items[0]!.priceCurrency).toBe("USD");
    expect(page.items[0]!.sellingPrice).toBe("125");

    const detail = unwrap(await getProductDetail(product.id))!;
    expect(detail.priceCurrency).toBe("USD");
    expect(detail.sellingPrice).toBe("125");
  });

  it("keeps an unpriced product's currency null rather than filling it in", async () => {
    const product = await seedProduct({
      sku: "PRICE-2",
      sellingPrice: null,
      stockQuantity: 0,
    });

    await driftTheSetting();

    const detail = unwrap(await getProductDetail(product.id))!;
    expect(detail.sellingPrice).toBeNull();
    expect(detail.priceCurrency).toBeNull();
  });

  it("offers it to the order builder in its own currency", async () => {
    await seedProduct({
      sku: "PRICE-3",
      name: "Pickable Part",
      sellingPrice: "40.00",
      stockQuantity: 5,
    });

    await driftTheSetting();

    const [option] = await searchOrderProducts("Pickable");
    expect(option!.priceCurrency).toBe("USD");
  });
});

// ---------------------------------------------------------------------------
// Batch cost — StockLot.costCurrency
// ---------------------------------------------------------------------------

describe("a batch keeps the currency it was bought in", () => {
  it("reports it on the product's lot table", async () => {
    const supplier = await createSupplier();
    const product = await seedProduct({ sku: "LOT-1", stockQuantity: 0 });

    await buy({
      supplierId: supplier.id,
      productId: product.id,
      quantity: 10,
      unitCost: "40.00",
      currency: "USD",
    });

    await driftTheSetting();

    const detail = unwrap(await getProductDetail(product.id))!;
    const lot = detail.lots[0]!;

    expect(lot.unitCost).toBe("40");
    expect(lot.costCurrency).toBe("USD");
  });

  it("keeps an uncosted batch's currency null", async () => {
    // `lotUnitCost: null` seeds a batch that predates cost tracking.
    const product = await seedProduct({
      sku: "LOT-2",
      stockQuantity: 6,
      lotUnitCost: null,
    });

    await driftTheSetting();

    const lot = unwrap(await getProductDetail(product.id))!.lots[0]!;

    expect(lot.unitCost).toBeNull();
    expect(lot.costCurrency).toBeNull();
  });

  it("carries it onto a quarantined batch a customer sent back", async () => {
    const supplier = await createSupplier();
    const customer = await seedCustomer({ name: "Returner Ltd" });
    const product = await seedProduct({
      sku: "LOT-3",
      sellingPrice: "100.00",
      stockQuantity: 0,
    });

    await buy({
      supplierId: supplier.id,
      productId: product.id,
      quantity: 10,
      unitCost: "40.00",
      currency: "USD",
    });
    const order = await sell({
      customerId: customer.id,
      productId: product.id,
      quantity: 5,
      currency: "USD",
    });
    const line = await prisma.orderItem.findFirstOrThrow({
      where: { orderId: order.id },
      select: { id: true },
    });

    const outcome = await recordSalesReturn({
      orderId: order.id,
      reason: "Wrong part shipped",
      lines: [{ orderItemId: line.id, quantity: "2" }],
    });

    await driftTheSetting();

    /*
     * A return cannot invent a currency any more than it can invent a rate:
     * the cost comes back from the draw it reverses, and so does its label.
     */
    expect(outcome.lines[0]!.lots[0]!.costCurrency).toBe("USD");

    const quarantined = await listQuarantinedLots();
    const returned = quarantined.find((row) => row.sku === "LOT-3");

    expect(returned).toBeDefined();
    expect(returned!.costCurrency).toBe("USD");
  });
});

// ---------------------------------------------------------------------------
// Order totals — Order.currency
// ---------------------------------------------------------------------------

describe("an order keeps the currency it was raised in", () => {
  it("reports it on the list, the customer's history and the product's", async () => {
    const supplier = await createSupplier();
    const customer = await seedCustomer({ name: "Contoso" });
    const product = await seedProduct({
      sku: "ORD-1",
      sellingPrice: "100.00",
      stockQuantity: 0,
    });

    await buy({
      supplierId: supplier.id,
      productId: product.id,
      quantity: 20,
      unitCost: "10.00",
      currency: "USD",
    });
    await sell({
      customerId: customer.id,
      productId: product.id,
      quantity: 5,
      currency: "USD",
    });

    await driftTheSetting();

    const list = unwrap(await listOrders(DEFAULT_ORDER_PARAMS));
    expect(list.items[0]!.currency).toBe("USD");
    expect(list.items[0]!.total).toBe("500");

    const customerDetail = unwrap(await getCustomerDetail(customer.id))!;
    expect(customerDetail.orders[0]!.currency).toBe("USD");

    const productDetail = unwrap(await getProductDetail(product.id))!;
    expect(productDetail.recentOrders[0]!.currency).toBe("USD");
  });

  it("keeps a legacy order's currency null everywhere it appears", async () => {
    const customer = await seedCustomer({ name: "Legacy Buyer" });

    await prisma.order.create({
      data: {
        orderNumber: "ORD-LEGACY-1",
        customerId: customer.id,
        status: "COMPLETED",
        subtotal: "750.00",
        total: "750.00",
        currency: null,
      },
    });

    await driftTheSetting();

    expect(
      unwrap(await listOrders(DEFAULT_ORDER_PARAMS)).items[0]!.currency,
    ).toBeNull();
    expect(
      unwrap(await getCustomerDetail(customer.id))!.orders[0]!.currency,
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Purchase totals — Purchase.currency
// ---------------------------------------------------------------------------

describe("a purchase keeps the currency it was raised in", () => {
  it("reports it on the list, the supplier's history and the product's", async () => {
    const supplier = await createSupplier();
    const product = await seedProduct({ sku: "PUR-1", stockQuantity: 0 });

    await buy({
      supplierId: supplier.id,
      productId: product.id,
      quantity: 4,
      unitCost: "250.00",
      currency: "USD",
    });

    await driftTheSetting();

    const list = unwrap(await listPurchases(DEFAULT_PURCHASE_PARAMS));
    expect(list.items[0]!.currency).toBe("USD");
    expect(list.items[0]!.total).toBe("1000");

    const supplierDetail = unwrap(await getSupplierDetail(supplier.id))!;
    expect(supplierDetail.purchases[0]!.currency).toBe("USD");

    const productDetail = unwrap(await getProductDetail(product.id))!;
    expect(productDetail.recentPurchases[0]!.currency).toBe("USD");
  });

  it("reports it on the supplier panel of a purchase's own page", async () => {
    const supplier = await createSupplier();
    const product = await seedProduct({ sku: "PUR-2", stockQuantity: 0 });

    const purchase = await buy({
      supplierId: supplier.id,
      productId: product.id,
      quantity: 2,
      unitCost: "300.00",
      currency: "EUR",
    });

    await setCurrency("USD");
    await setCurrency("INR");

    const detail = unwrap(await getPurchaseDetail(purchase.id))!;
    expect(detail.supplier.recentPurchases[0]!.currency).toBe("EUR");
  });

  it("offers the last paid cost to the purchase builder in its own currency", async () => {
    const supplier = await createSupplier();
    const product = await seedProduct({
      sku: "PUR-3",
      name: "Restockable Part",
      stockQuantity: 0,
    });

    await buy({
      supplierId: supplier.id,
      productId: product.id,
      quantity: 3,
      unitCost: "70.00",
      currency: "EUR",
    });

    await driftTheSetting();

    const [option] = await searchPurchaseProducts("Restockable");

    expect(option!.lastPaidUnitCost).toBe("70.00");
    expect(option!.lastPaidCurrency).toBe("EUR");
  });

  it("keeps a legacy purchase's currency null", async () => {
    const supplier = await createSupplier();

    await prisma.purchase.create({
      data: {
        purchaseNumber: "PO-LEGACY-1",
        supplierId: supplier.id,
        status: "RECEIVED",
        total: "900.00",
        currency: null,
        purchaseDate: new Date(),
      },
    });

    await driftTheSetting();

    expect(
      unwrap(await listPurchases(DEFAULT_PURCHASE_PARAMS)).items[0]!.currency,
    ).toBeNull();
    expect(
      unwrap(await getSupplierDetail(supplier.id))!.purchases[0]!.currency,
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Two currencies at once
// ---------------------------------------------------------------------------

describe("records raised under different settings", () => {
  it("each keep their own, so no single setting could describe them", async () => {
    const supplier = await createSupplier();
    const product = await seedProduct({ sku: "MIX-1", stockQuantity: 0 });

    await buy({
      supplierId: supplier.id,
      productId: product.id,
      quantity: 2,
      unitCost: "50.00",
      currency: "USD",
    });
    await buy({
      supplierId: supplier.id,
      productId: product.id,
      quantity: 3,
      unitCost: "900.00",
      currency: "INR",
    });

    const detail = unwrap(await getProductDetail(product.id))!;
    const currencies = detail.lots.map((lot) => lot.costCurrency).sort();

    expect(currencies).toEqual(["INR", "USD"]);

    const purchases = unwrap(
      await listPurchases(DEFAULT_PURCHASE_PARAMS),
    ).items.map((row) => row.currency);

    expect(new Set(purchases)).toEqual(new Set(["USD", "INR"]));
  });
});

// ---------------------------------------------------------------------------
// The customer's other orders, on an order's own page
// ---------------------------------------------------------------------------

describe("an order's view of the customer's other orders", () => {
  it("shows each of them in the currency it was raised in", async () => {
    const supplier = await createSupplier();
    const customer = await seedCustomer({ name: "Repeat Buyer" });
    const product = await seedProduct({
      sku: "HIST-1",
      sellingPrice: "100.00",
      stockQuantity: 0,
    });

    await buy({
      supplierId: supplier.id,
      productId: product.id,
      quantity: 30,
      unitCost: "10.00",
      currency: "USD",
    });

    /*
     * Three orders from one customer, raised under three different settings.
     * The history panel on any one of them shows the other two — and a single
     * installation currency could not describe them, which is the whole point.
     */
    const first = await sell({
      customerId: customer.id,
      productId: product.id,
      quantity: 1,
      currency: "USD",
    });
    await sell({
      customerId: customer.id,
      productId: product.id,
      quantity: 2,
      currency: "EUR",
    });
    await sell({
      customerId: customer.id,
      productId: product.id,
      quantity: 3,
      currency: "INR",
    });

    const detail = unwrap(await getOrderDetail(first.id))!;
    const history = detail.customerHistory;

    expect(history).toHaveLength(2);
    expect(new Set(history.map((entry) => entry.currency))).toEqual(
      new Set(["EUR", "INR"]),
    );

    // And the order being viewed keeps its own, independently of them.
    expect(detail.currency).toBe("USD");
  });

  it("keeps a legacy order in the history at null", async () => {
    const customer = await seedCustomer({ name: "Long-Standing Buyer" });

    await prisma.order.createMany({
      data: [
        {
          orderNumber: "ORD-HIST-NOW",
          customerId: customer.id,
          status: "COMPLETED",
          subtotal: "100.00",
          total: "100.00",
          currency: "USD",
        },
        {
          orderNumber: "ORD-HIST-LEGACY",
          customerId: customer.id,
          status: "COMPLETED",
          subtotal: "400.00",
          total: "400.00",
          currency: null,
        },
      ],
    });

    const current = await prisma.order.findFirstOrThrow({
      where: { orderNumber: "ORD-HIST-NOW" },
      select: { id: true },
    });

    await driftTheSetting();

    const history = unwrap(await getOrderDetail(current.id))!.customerHistory;

    expect(history).toHaveLength(1);
    expect(history[0]!.currency).toBeNull();
    expect(Number(history[0]!.total)).toBe(400);
  });
});
