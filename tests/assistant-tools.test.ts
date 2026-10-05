import { beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { toolsFor, type ToolInvocation } from "@/server/assistant/tools";
import { confirmOrder, createOrder } from "@/server/orders";
import {
  listProductsWithoutAvailableStock,
  loadStockAvailability,
} from "@/server/products";
import { createPurchase, receivePurchase } from "@/server/purchases";
import { lockProduct } from "@/server/stock";

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
 * The assistant's tools against a real database.
 *
 * Each tool is a thin wrapper over a loader the pages already use, so what is
 * worth proving here is the wrapping: that arguments are validated before
 * anything runs, that human identifiers resolve to exactly one record or say
 * why not, that availability means what the stock engine means by it, and
 * above all that money leaves every tool still split by currency.
 */

type Role = "ADMIN" | "STAFF";

const NOW = new Date();

async function call(
  name: string,
  args: Record<string, unknown> = {},
  role: Role = "ADMIN",
): Promise<ToolInvocation> {
  const tool = toolsFor(role).find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`No ${name} tool for ${role}`);
  return tool.invoke(args, { role, now: NOW });
}

/** A successful tool's output, typed loosely enough to walk in assertions. */
async function output(
  name: string,
  args: Record<string, unknown> = {},
  role: Role = "ADMIN",
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- assertions walk arbitrary JSON
): Promise<any> {
  const result = await call(name, args, role);
  if (!result.ok) throw new Error(`${name} failed: ${JSON.stringify(result.error)}`);
  return result.output;
}

/** Moves `quantity` units of a product into a quarantined batch, keeping the ledger invariant. */
async function quarantine(productId: string, quantity: number) {
  await prisma.stockLot.create({
    data: {
      productId,
      unitCost: null,
      costCurrency: null,
      costSource: "UNKNOWN",
      quantityReceived: quantity,
      quantityRemaining: quantity,
      sourceType: "MANUAL",
      sourceId: null,
      status: "QUARANTINED",
      receivedAt: new Date(),
    },
  });
  await prisma.product.update({
    where: { id: productId },
    data: { stockQuantity: { increment: quantity } },
  });
}

beforeEach(async () => {
  signOutSupabase();
  await resetDatabase();
  await signInWithRole("ADMIN");
});

describe("the tool list", () => {
  it("declares every tool with a valid Gemini function name and a description", () => {
    const tools = toolsFor("ADMIN");
    const names = tools.map((tool) => tool.name);

    expect(new Set(names).size).toBe(names.length);

    for (const tool of tools) {
      expect(tool.declaration.name).toBe(tool.name);
      expect(tool.name).toMatch(/^[a-z_][a-z0-9_]{0,63}$/);
      expect(tool.declaration.description?.length ?? 0).toBeGreaterThan(20);
    }
  });

  it("never offers the quarantine queue to STAFF", () => {
    const staff = toolsFor("STAFF").map((tool) => tool.name);
    const admin = toolsFor("ADMIN").map((tool) => tool.name);

    expect(admin).toContain("list_quarantined_stock");
    expect(staff).not.toContain("list_quarantined_stock");
    expect(admin.filter((name) => !staff.includes(name))).toEqual([
      "list_quarantined_stock",
    ]);
  });

  it("declares argument-less tools with no parameters at all", () => {
    const summary = toolsFor("ADMIN").find((tool) => tool.name === "get_inventory_summary")!;
    expect(summary.declaration.parameters).toBeUndefined();
  });
});

describe("arguments are validated before anything runs", () => {
  it("refuses an argument the tool does not declare", async () => {
    const result = await call("search_products", { query: "x", dropTable: "products" });
    expect(result).toMatchObject({ ok: false, error: { code: "INVALID_ARGUMENTS" } });
  });

  it("refuses a date that is not a real calendar day", async () => {
    const result = await call("search_orders", { from: "2026-02-31" });
    expect(result).toMatchObject({ ok: false, error: { code: "INVALID_ARGUMENTS" } });
  });

  it("refuses a value outside an enumeration", async () => {
    const result = await call("search_orders", { status: "SHIPPED" });
    expect(result).toMatchObject({ ok: false, error: { code: "INVALID_ARGUMENTS" } });
  });

  it("refuses a lookup with no identifier", async () => {
    const result = await call("get_product", {});
    expect(result).toMatchObject({ ok: false, error: { code: "INVALID_ARGUMENTS" } });
  });

  it("treats a null optional argument as absent", async () => {
    await seedProduct({ sku: "NULL-1" });
    const result = await output("search_products", { query: "NULL-1", status: null });
    expect(result.products).toHaveLength(1);
  });
});

describe("availability means what the stock engine means", () => {
  it("matches lockProduct's saleable figure, without taking its lock", async () => {
    const plain = await seedProduct({ sku: "AV-PLAIN", stockQuantity: 8, lotUnitCost: "10.00" });
    const mixed = await seedProduct({ sku: "AV-MIXED", stockQuantity: 5, lotUnitCost: "10.00" });
    await quarantine(mixed.id, 3);
    const blocked = await seedProduct({ sku: "AV-BLOCKED", stockQuantity: 0 });
    await quarantine(blocked.id, 4);

    const availability = await loadStockAvailability([plain.id, mixed.id, blocked.id]);
    if (!availability.ok) throw new Error("expected availability");

    for (const product of [plain, mixed, blocked]) {
      const locked = await prisma.$transaction((tx) => lockProduct(tx, product.id));
      const read = availability.data.get(product.id)!;

      expect(read.stockQuantity).toBe(locked.stockQuantity);
      expect(read.blockedQuantity).toBe(locked.blockedQuantity);
      expect(read.saleableQuantity).toBe(locked.saleableQuantity);
    }
  });

  it("refuses a signed-out caller rather than answering", async () => {
    const product = await seedProduct({ sku: "AV-AUTH" });
    signOutSupabase();

    const result = await loadStockAvailability([product.id]);
    expect(result).toMatchObject({ ok: false, error: { code: "UNAUTHORIZED" } });

    const list = await listProductsWithoutAvailableStock({
      includeRetired: false,
      page: 1,
      pageSize: 25,
    });
    expect(list).toMatchObject({ ok: false, error: { code: "UNAUTHORIZED" } });
  });

  it("lists empty and fully blocked products, most-owed first, and nothing saleable", async () => {
    await seedProduct({ sku: "NA-STOCKED", stockQuantity: 5 });
    const empty = await seedProduct({ sku: "NA-EMPTY", stockQuantity: 0 });
    const blocked = await seedProduct({ sku: "NA-BLOCKED", stockQuantity: 0 });
    await quarantine(blocked.id, 2);
    await seedProduct({ sku: "NA-RETIRED", stockQuantity: 0, status: "DISCONTINUED" });

    // A confirmed order owing 3 units of the empty product.
    const customer = await seedCustomer({ name: "Waiting Customer" });
    const order = await createOrder({
      customerId: customer.id,
      items: await quoted([{ productId: empty.id, quantity: 3 }]),
    });
    await confirmOrder(order.id);

    const result = await output("list_products_without_available_stock");
    const skus = result.products.map((row: { sku: string }) => row.sku);

    expect(skus).toEqual(["NA-EMPTY", "NA-BLOCKED"]);
    expect(result.products[0]).toMatchObject({ saleable: 0, unitsOwedToCustomers: 3 });
    expect(result.products[1]).toMatchObject({ onHand: 2, blocked: 2, saleable: 0 });

    const everything = await output("list_products_without_available_stock", {
      includeInactive: true,
    });
    expect(everything.products.map((row: { sku: string }) => row.sku)).toContain("NA-RETIRED");
  });
});

describe("get_product", () => {
  it("finds a part by exact SKU and separates physical from saleable stock", async () => {
    const product = await seedProduct({ sku: "ABC123", stockQuantity: 10, lotUnitCost: "50.00" });
    await seedProduct({ sku: "ABC1234", stockQuantity: 1 });
    await quarantine(product.id, 4);

    const result = await output("get_product", { sku: "abc123" });

    expect(result.found).toBe(true);
    expect(result.product.sku).toBe("ABC123");
    expect(result.product.stock).toMatchObject({
      onHand: 14,
      saleable: 10,
      blocked: 4,
      quarantined: 4,
      rejected: 0,
    });
    expect(result.product.link).toBe(`/products/${product.id}`);
  });

  it("keeps stock value split by the currency each batch was bought in", async () => {
    const product = await seedProduct({ sku: "FX-1", stockQuantity: 2, lotUnitCost: "100.00" });
    await prisma.stockLot.create({
      data: {
        productId: product.id,
        unitCost: "5000.00",
        costCurrency: "INR",
        costSource: "OPENING",
        quantityReceived: 3,
        quantityRemaining: 3,
        sourceType: "MANUAL",
        receivedAt: new Date(),
      },
    });
    await prisma.product.update({
      where: { id: product.id },
      data: { stockQuantity: 5 },
    });

    const result = await output("get_product", { sku: "FX-1" });

    expect(result.product.valueAtCost.value.byCurrency).toEqual([
      { currency: "USD", amount: "200.00" },
      { currency: "INR", amount: "15000.00" },
    ]);
  });

  it("says a part number does not exist rather than picking a near one", async () => {
    await seedProduct({ sku: "ABC1234" });

    const result = await output("get_product", { sku: "ABC123" });

    expect(result.found).toBe(false);
    expect(result.similar).toEqual([{ sku: "ABC1234", name: "Product ABC1234" }]);
  });
});

describe("orders", () => {
  it("explains why a draft cannot be completed, and what a confirmed one still owes", async () => {
    const product = await seedProduct({ sku: "ORD-1", stockQuantity: 2, lotUnitCost: "10.00" });
    const customer = await seedCustomer({ name: "Acme Airlines", email: "ops@acme.example" });

    const order = await createOrder({
      customerId: customer.id,
      items: await quoted([{ productId: product.id, quantity: 5, unitPrice: "20.00" }]),
    });

    const draft = await output("get_order", { orderNumber: order.orderNumber.toLowerCase() });
    expect(draft.order.status).toBe("DRAFT");
    expect(draft.order.lifecycle.complete.allowed).toBe(false);
    expect(draft.order.lifecycle.complete.reason).toMatch(/draft to completed/i);
    expect(draft.order.lifecycle.confirm.allowed).toBe(true);

    await confirmOrder(order.id);

    const confirmed = await output("get_order", { orderId: order.id });
    const line = confirmed.order.lines[0];

    expect(confirmed.order.lifecycle.complete).toEqual({ allowed: true, reason: null });
    expect(confirmed.order.lifecycle.fulfilOutstanding.allowed).toBe(true);
    expect(line).toMatchObject({ quantity: 5, shipped: 2, outstanding: 3 });
    expect(line.stockForOutstanding).toMatchObject({ onHand: 0, saleable: 0, shippableNow: 0 });
    // Customer contact details stay out of what the model is sent.
    expect(JSON.stringify(confirmed)).not.toContain("ops@acme.example");
  });

  it("lists recent orders with each order's own currency", async () => {
    const product = await seedProduct({ sku: "ORD-2", stockQuantity: 10 });
    const customer = await seedCustomer({ name: "Buyer" });

    await createOrder({
      customerId: customer.id,
      currency: "EUR",
      items: await quoted([{ productId: product.id, quantity: 1, unitPrice: "9.00" }]),
    });

    const result = await output("search_orders");

    expect(result.totalMatching).toBe(1);
    expect(result.orders[0].total.byCurrency).toEqual([{ currency: "EUR", amount: "9.00" }]);
  });
});

describe("reports", () => {
  it("reports this month's revenue per currency, never added together", async () => {
    const product = await seedProduct({ sku: "REV-1", stockQuantity: 10 });
    const customer = await seedCustomer({ name: "Revenue Customer" });

    for (const [currency, price] of [
      ["USD", "100.00"],
      ["INR", "8000.00"],
    ] as const) {
      const order = await createOrder({
        customerId: customer.id,
        currency,
        items: await quoted([{ productId: product.id, quantity: 1, unitPrice: price }]),
      });
      await confirmOrder(order.id);
    }

    const result = await output("get_sales_report", { period: "this_month" });

    expect(result.totals.orders).toBe(2);
    expect(result.totals.unitsSold).toBe(2);
    expect(result.totals.revenue.byCurrency).toEqual([
      { currency: "USD", amount: "100.00" },
      { currency: "INR", amount: "8000.00" },
    ]);
    expect(result.period.from).toBe(`${NOW.toISOString().slice(0, 7)}-01`);
  });

  it("answers what was bought from a supplier named in plain words", async () => {
    const boeing = await createSupplier("Boeing Distribution");
    await createSupplier("Airbus Parts");
    const product = await seedProduct({ sku: "BUY-1", stockQuantity: 0 });

    const purchase = await createPurchase({
      supplierId: boeing.id,
      currency: "USD",
      items: [{ productId: product.id, quantity: 4, unitCost: "25.00" }],
    });
    await receivePurchase(purchase.id);

    const result = await output("get_purchase_spend_report", {
      supplierName: "boeing distribution",
      groupBy: "product",
      period: "all_time",
    });

    expect(result.totals.receivedSpend.byCurrency).toEqual([
      { currency: "USD", amount: "100.00" },
    ]);
    expect(result.rows[0]).toMatchObject({ label: "Product BUY-1", units: 4 });
  });

  it("asks which supplier is meant when a name matches several", async () => {
    await createSupplier("Boeing East");
    await createSupplier("Boeing West");

    const result = await output("search_purchases", { supplierName: "Boeing" });

    expect(result).toMatchObject({ found: false, ambiguous: true });
    expect(result.candidates).toHaveLength(2);
  });

  it("states no margin when nothing sold has a known cost", async () => {
    const product = await seedProduct({ sku: "COST-1", stockQuantity: 5 });
    const customer = await seedCustomer({ name: "Costing Customer" });
    const order = await createOrder({
      customerId: customer.id,
      items: await quoted([{ productId: product.id, quantity: 2 }]),
    });
    await confirmOrder(order.id);

    const result = await output("get_costing_snapshot");

    expect(result.margin).toBeNull();
    expect(result.marginUnavailableReason).toMatch(/no shipped units/i);
    expect(result.unitsShippedWithUnknownCost).toBe(2);
  });
});

describe("role-restricted data", () => {
  it("refuses the quarantine queue to STAFF even when invoked directly", async () => {
    await signInWithRole("STAFF");

    const adminTool = toolsFor("ADMIN").find((tool) => tool.name === "list_quarantined_stock")!;
    const result = await adminTool.invoke({}, { role: "STAFF", now: NOW });

    expect(result).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
  });

  it("shows the queue to an ADMIN", async () => {
    const result = await output("list_quarantined_stock");
    expect(result).toMatchObject({ batches: 0, unitsAwaitingInspection: 0 });
  });
});
