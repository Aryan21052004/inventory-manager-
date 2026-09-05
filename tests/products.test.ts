import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@clerk/nextjs/server", async () => {
  const { clerkServerMock } = await import("./clerk-mock");
  return clerkServerMock;
});

import { prisma } from "@/lib/prisma";
import {
  DEFAULT_LIST_PARAMS,
  hasActiveFilters,
  parseProductListParams,
  type ProductListParams,
} from "@/lib/product-query";
import {
  createProduct,
  deleteProduct,
  getProductDetail,
  listProducts,
  loadProductStats,
  updateProduct,
} from "@/server/products";

import { signOut } from "./clerk-mock";
import {
  createSupplier,
  resetDatabase,
  seedProduct,
  signInWithRole,
} from "./database";

/**
 * The products module.
 *
 * These run against a real Postgres, because most of what is worth proving here
 * is Postgres behaviour: that the unique index actually rejects a duplicate SKU,
 * that filters and sorts return what the query string asked for, that a
 * `Restrict` foreign key really does stop a delete. Mocking Prisma would only
 * prove that the mock was written to agree with the test.
 */

beforeEach(async () => {
  signOut();
  await resetDatabase();
});

/** The form fields, as strings — which is how they arrive from FormData. */
function productForm(overrides: Record<string, string> = {}) {
  return {
    name: "Mechanical Keyboard",
    sku: "KEY-001",
    description: "Tenkeyless, brown switches",
    category: "Peripherals",
    standardCost: "45.00",
    sellingPrice: "89.99",
    stockQuantity: "25",
    status: "ACTIVE",
    ...overrides,
  };
}

function listParams(overrides: Partial<ProductListParams> = {}) {
  return { ...DEFAULT_LIST_PARAMS, ...overrides };
}

// ---------------------------------------------------------------------------
// Creating
// ---------------------------------------------------------------------------

describe("creating a product", () => {
  it("stores the catalogue details an admin submitted", async () => {
    await signInWithRole("ADMIN");

    const created = await createProduct(productForm());

    const product = await prisma.product.findUniqueOrThrow({
      where: { id: created.id },
    });

    expect(product.name).toBe("Mechanical Keyboard");
    expect(product.sku).toBe("KEY-001");
    expect(product.category).toBe("Peripherals");
    expect(product.description).toBe("Tenkeyless, brown switches");
    // Money round-trips through Decimal, not through a float.
    expect(product.standardCost?.toString()).toBe("45");
    expect(product.sellingPrice?.toString()).toBe("89.99");
    expect(product.status).toBe("ACTIVE");
  });

  it("records the opening stock as a movement rather than writing it directly", async () => {
    const admin = await signInWithRole("ADMIN");

    const created = await createProduct(productForm({ stockQuantity: "25" }));

    const product = await prisma.product.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(product.stockQuantity).toBe(25);

    // The quantity is only trustworthy if the ledger explains it.
    const movements = await prisma.stockTransaction.findMany({
      where: { productId: created.id },
    });

    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({
      type: "STOCK_IN",
      quantity: 25,
      previousStock: 0,
      newStock: 25,
      createdBy: admin.id,
    });
  });

  it("writes no movement for a product that opens with nothing on hand", async () => {
    await signInWithRole("ADMIN");

    const created = await createProduct(productForm({ stockQuantity: "0" }));

    expect(await prisma.stockTransaction.count()).toBe(0);
    const product = await prisma.product.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(product.stockQuantity).toBe(0);
  });

  it("links a supplier when one is chosen", async () => {
    await signInWithRole("ADMIN");
    const supplier = await createSupplier("Keyboard Wholesale");

    const created = await createProduct(
      productForm({ supplierId: supplier.id }),
    );

    const product = await prisma.product.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(product.supplierId).toBe(supplier.id);
  });

  it("rejects a supplier that does not exist", async () => {
    await signInWithRole("ADMIN");

    await expect(
      createProduct(productForm({ supplierId: "no-such-supplier" })),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      details: { field: "supplierId" },
    });

    expect(await prisma.product.count()).toBe(0);
  });

  it("refuses a STAFF user", async () => {
    await signInWithRole("STAFF");

    await expect(createProduct(productForm())).rejects.toMatchObject({
      code: "FORBIDDEN",
      status: 403,
    });

    expect(await prisma.product.count()).toBe(0);
  });

  it("refuses an unauthenticated request", async () => {
    await expect(createProduct(productForm())).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });

    expect(await prisma.product.count()).toBe(0);
  });
});

describe("SKU uniqueness", () => {
  it("rejects a second product with the same SKU", async () => {
    await signInWithRole("ADMIN");

    await createProduct(productForm({ sku: "DUP-001" }));

    await expect(
      createProduct(
        productForm({ sku: "DUP-001", name: "Something else entirely" }),
      ),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      details: { field: "sku" },
    });

    expect(await prisma.product.count()).toBe(1);
  });

  it("leaves nothing behind when the duplicate is rejected", async () => {
    await signInWithRole("ADMIN");
    await createProduct(productForm({ sku: "DUP-002", stockQuantity: "10" }));

    await expect(
      createProduct(productForm({ sku: "DUP-002", stockQuantity: "999" })),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    // The failed create and its opening-stock movement are one transaction, so
    // a rejected SKU must not leave an orphaned ledger row behind.
    const movements = await prisma.stockTransaction.findMany();
    expect(movements).toHaveLength(1);
    expect(movements[0]!.quantity).toBe(10);
  });

  it("rejects an edit that would take another product's SKU", async () => {
    await signInWithRole("ADMIN");
    await seedProduct({ sku: "TAKEN-001" });
    const mine = await seedProduct({ sku: "MINE-001" });

    await expect(
      updateProduct(mine.id, {
        name: "Mine",
        sku: "TAKEN-001",
        category: "General",
        standardCost: "1.00",
        sellingPrice: "2.00",
        status: "ACTIVE",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT", details: { field: "sku" } });
  });
});

describe("input validation", () => {
  it("requires a product name", async () => {
    await signInWithRole("ADMIN");

    await expect(
      createProduct(productForm({ name: "   " })),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Product name is required",
    });
  });

  it("requires a SKU", async () => {
    await signInWithRole("ADMIN");

    await expect(createProduct(productForm({ sku: "" }))).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "SKU is required",
    });
  });

  it("rejects a negative standard cost", async () => {
    await signInWithRole("ADMIN");

    await expect(
      createProduct(productForm({ standardCost: "-1.00" })),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Standard cost cannot be negative",
      details: { field: "standardCost" },
    });

    expect(await prisma.product.count()).toBe(0);
  });

  it("rejects a negative selling price", async () => {
    await signInWithRole("ADMIN");

    await expect(
      createProduct(productForm({ sellingPrice: "-0.01" })),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Selling price cannot be negative",
      details: { field: "sellingPrice" },
    });
  });

  it("rejects a negative opening quantity", async () => {
    await signInWithRole("ADMIN");

    await expect(
      createProduct(productForm({ stockQuantity: "-5" })),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Initial stock cannot be negative",
      details: { field: "stockQuantity" },
    });

    expect(await prisma.product.count()).toBe(0);
  });

  it("rejects a fractional quantity", async () => {
    await signInWithRole("ADMIN");

    await expect(
      createProduct(productForm({ stockQuantity: "2.5" })),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Initial stock must be a whole number",
    });
  });

  it("treats a blank reference price as absent rather than as zero", async () => {
    await signInWithRole("ADMIN");

    /*
     * `Number("")` is 0, and the distinction matters as much here as it does on
     * the cost side. Zero is a price — it says the part is given away. Null says
     * the catalogue has no reference, which is the ordinary state for a part
     * that is only ever quoted per customer.
     *
     * This test used to assert the field was required. It stopped being so when
     * pricing moved to the order line; what is required now is the quote on the
     * line, not a list price on the product.
     */
    const created = await createProduct(
      productForm({ sellingPrice: "", stockQuantity: "0" }),
    );

    const product = await prisma.product.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(product.sellingPrice).toBeNull();
  });

  it("treats a blank standard cost as unknown rather than as zero", async () => {
    await signInWithRole("ADMIN");

    // The distinction the whole costing layer rests on. Zero is a cost — it
    // says the units were free. Null says nobody knows. A schema that coerced
    // a cleared field to 0 would erase that difference at the door.
    const created = await createProduct(
      productForm({ standardCost: "", stockQuantity: "0" }),
    );

    const product = await prisma.product.findUniqueOrThrow({
      where: { id: created.id },
    });

    expect(product.standardCost).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

describe("editing a product", () => {
  it("updates catalogue details", async () => {
    await signInWithRole("ADMIN");
    const product = await seedProduct({ sku: "EDIT-001", stockQuantity: 40 });
    const supplier = await createSupplier("New Supplier");

    await updateProduct(product.id, {
      name: "Renamed Widget",
      sku: "EDIT-002",
      description: "Now with a description",
      category: "Accessories",
      standardCost: "9.99",
      sellingPrice: "19.99",
      status: "INACTIVE",
      supplierId: supplier.id,
    });

    const updated = await prisma.product.findUniqueOrThrow({
      where: { id: product.id },
    });

    expect(updated.name).toBe("Renamed Widget");
    expect(updated.sku).toBe("EDIT-002");
    expect(updated.category).toBe("Accessories");
    expect(updated.status).toBe("INACTIVE");
    expect(updated.supplierId).toBe(supplier.id);
  });

  it("cannot change stock, even when the request asks it to", async () => {
    await signInWithRole("ADMIN");
    const product = await seedProduct({ sku: "EDIT-003", stockQuantity: 40 });

    // What a tampered request looks like: the field is not in the update
    // schema, so this is what it takes to express it at all — and it is
    // stripped before anything reaches the database.
    await updateProduct(product.id, {
      name: product.name,
      sku: product.sku,
      category: product.category,
      standardCost: "5.00",
      sellingPrice: "12.50",
      status: "ACTIVE",
      stockQuantity: "999999",
    });

    const after = await prisma.product.findUniqueOrThrow({
      where: { id: product.id },
    });

    expect(after.stockQuantity).toBe(40);
    // And no phantom movement was invented to justify a change that never
    // happened.
    expect(await prisma.stockTransaction.count()).toBe(0);
  });

  it("refuses a STAFF user", async () => {
    await signInWithRole("STAFF");
    const product = await seedProduct({ sku: "EDIT-004" });

    await expect(
      updateProduct(product.id, {
        name: "Renamed by staff",
        sku: "EDIT-004",
        category: "General",
        standardCost: "1.00",
        sellingPrice: "2.00",
        status: "ACTIVE",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const after = await prisma.product.findUniqueOrThrow({
      where: { id: product.id },
    });
    expect(after.name).toBe(product.name);
  });

  it("reports a product that no longer exists", async () => {
    await signInWithRole("ADMIN");

    await expect(
      updateProduct("does-not-exist", {
        name: "Ghost",
        sku: "GHOST-001",
        category: "General",
        standardCost: "1.00",
        sellingPrice: "2.00",
        status: "ACTIVE",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

// ---------------------------------------------------------------------------
// Deleting
// ---------------------------------------------------------------------------

describe("deleting a product", () => {
  it("removes a product that has never traded, along with its ledger", async () => {
    await signInWithRole("ADMIN");
    const created = await createProduct(
      productForm({ sku: "DEL-001", stockQuantity: "5" }),
    );

    await deleteProduct(created.id);

    expect(await prisma.product.count()).toBe(0);
    expect(await prisma.stockTransaction.count()).toBe(0);
  });

  it("refuses a product that appears on an order", async () => {
    await signInWithRole("ADMIN");
    const product = await seedProduct({ sku: "DEL-002" });

    const customer = await prisma.customer.create({
      data: { name: "A Customer" },
    });
    await prisma.order.create({
      data: {
        orderNumber: "ORD-0001",
        customerId: customer.id,
        subtotal: "10.00",
        total: "10.00",
        items: {
          create: [
            {
              productId: product.id,
              quantity: 1,
              unitPrice: "10.00",
              total: "10.00",
            },
          ],
        },
      },
    });

    await expect(deleteProduct(product.id)).rejects.toMatchObject({
      code: "CONFLICT",
    });

    // Refused means untouched — the order line still points at a real product.
    expect(await prisma.product.count()).toBe(1);
  });

  it("refuses a STAFF user", async () => {
    await signInWithRole("STAFF");
    const product = await seedProduct({ sku: "DEL-003" });

    await expect(deleteProduct(product.id)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(await prisma.product.count()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Stock quantity
// ---------------------------------------------------------------------------

describe("stock quantity", () => {
  it("reports the quantity on hand as a number, not a classification", async () => {
    // The point of removing the threshold feature: a product holding nothing
    // holds nothing, and a product holding four units holds four. The list
    // reports the count and stops there.
    await seedProduct({ sku: "QTY-000", stockQuantity: 0 });
    await seedProduct({ sku: "QTY-004", stockQuantity: 4 });
    await seedProduct({ sku: "QTY-400", stockQuantity: 400 });

    const result = await listProducts(listParams({ sort: "sku" }));
    if (!result.ok) throw new Error("expected the list to load");

    expect(
      result.data.items.map((item) => [item.sku, item.stockQuantity]),
    ).toEqual([
      ["QTY-000", 0],
      ["QTY-004", 4],
      ["QTY-400", 400],
    ]);

    // A product holding nothing is still an ordinary row, and nothing on it
    // classifies the number.
    for (const item of result.data.items) {
      expect(item).not.toHaveProperty("stockStatus");
      expect(item).not.toHaveProperty("minimumStock");
    }
  });

  it("ignores a stale stock filter left in a bookmarked URL", () => {
    // The old dashboard handed out links to /products?stock=LOW_STOCK, and
    // some are still in people's bookmarks. The parser discards what it does
    // not recognise, so one of those lands on an unfiltered list rather than
    // an error.
    const params = parseProductListParams({ stock: "LOW_STOCK" });

    expect(params).toEqual(DEFAULT_LIST_PARAMS);
    expect(hasActiveFilters(params)).toBe(false);
  });

  it("drops a stale minimum-stock sort key rather than failing", () => {
    expect(parseProductListParams({ sort: "minimumStock" }).sort).toBe(
      DEFAULT_LIST_PARAMS.sort,
    );
  });

  it("totals the catalogue and values it from the lots", async () => {
    await seedProduct({ sku: "T-1", stockQuantity: 40, lotUnitCost: "2.00" });
    await seedProduct({ sku: "T-2", stockQuantity: 10, lotUnitCost: "3.00" });
    await seedProduct({ sku: "T-3", stockQuantity: 0, lotUnitCost: "4.00" });

    const result = await loadProductStats();
    if (!result.ok) throw new Error("expected stats to load");

    expect(result.data.total).toBe(3);
    // Valued from the lots, not from a catalogue column: 40 × 2.00 + 10 × 3.00.
    // T-3 holds nothing, so its cost contributes nothing.
    expect(Number(result.data.stockValue)).toBe(110);
    expect(result.data.uncostedUnits).toBe(0);
    // And no threshold counts survive on the tiles.
    expect(result.data).not.toHaveProperty("lowStock");
    expect(result.data).not.toHaveProperty("outOfStock");
  });

  it("values only the units whose cost is known, and counts the rest", async () => {
    // The figure that used to be quietly wrong. Stock with no established
    // acquisition cost is excluded from the value rather than being multiplied
    // by whatever the catalogue happened to say.
    await seedProduct({
      sku: "V-1",
      stockQuantity: 10,
      lotUnitCost: "8000.00",
    });
    await seedProduct({
      sku: "V-2",
      stockQuantity: 5,
      standardCost: "9999.00",
      lotUnitCost: null,
    });

    const result = await loadProductStats();
    if (!result.ok) throw new Error("expected stats to load");

    expect(Number(result.data.stockValue)).toBe(80_000);
    expect(result.data.uncostedUnits).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Searching, filtering, sorting, paging
// ---------------------------------------------------------------------------

describe("search", () => {
  beforeEach(async () => {
    await seedProduct({ sku: "KEY-001", name: "Mechanical Keyboard" });
    await seedProduct({ sku: "MSE-001", name: "Wireless Mouse" });
    await seedProduct({ sku: "MON-001", name: "27-inch Monitor" });
  });

  it("matches on product name", async () => {
    const result = await listProducts(listParams({ search: "keyboard" }));
    if (!result.ok) throw new Error("expected the list to load");

    expect(result.data.items.map((item) => item.sku)).toEqual(["KEY-001"]);
    expect(result.data.total).toBe(1);
  });

  it("matches on SKU", async () => {
    const result = await listProducts(listParams({ search: "MSE-001" }));
    if (!result.ok) throw new Error("expected the list to load");

    expect(result.data.items.map((item) => item.name)).toEqual([
      "Wireless Mouse",
    ]);
  });

  it("ignores case, and matches part of a word", async () => {
    const result = await listProducts(listParams({ search: "MoUs" }));
    if (!result.ok) throw new Error("expected the list to load");

    expect(result.data.items).toHaveLength(1);
  });

  it("returns nothing rather than everything when there is no match", async () => {
    const result = await listProducts(listParams({ search: "zzzz" }));
    if (!result.ok) throw new Error("expected the list to load");

    expect(result.data.items).toHaveLength(0);
    expect(result.data.total).toBe(0);
  });
});

describe("filtering", () => {
  it("filters by category", async () => {
    await seedProduct({ sku: "C-1", category: "Peripherals" });
    await seedProduct({ sku: "C-2", category: "Peripherals" });
    await seedProduct({ sku: "C-3", category: "Displays" });

    const result = await listProducts(
      listParams({ category: "Peripherals", sort: "sku" }),
    );
    if (!result.ok) throw new Error("expected the list to load");

    expect(result.data.items.map((item) => item.sku)).toEqual(["C-1", "C-2"]);
    expect(result.data.total).toBe(2);
  });

  it("filters by product status", async () => {
    await seedProduct({ sku: "P-1", status: "ACTIVE" });
    await seedProduct({ sku: "P-2", status: "DISCONTINUED" });

    const result = await listProducts(listParams({ status: "DISCONTINUED" }));
    if (!result.ok) throw new Error("expected the list to load");

    expect(result.data.items.map((item) => item.sku)).toEqual(["P-2"]);
  });

  it("filters by supplier", async () => {
    const supplier = await createSupplier("Only Supplier");
    await seedProduct({ sku: "SUP-1", supplierId: supplier.id });
    await seedProduct({ sku: "SUP-2" });

    const result = await listProducts(
      listParams({ supplierId: supplier.id }),
    );
    if (!result.ok) throw new Error("expected the list to load");

    expect(result.data.items.map((item) => item.sku)).toEqual(["SUP-1"]);
    expect(result.data.items[0]!.supplierName).toBe("Only Supplier");
  });

  it("combines filters rather than replacing them", async () => {
    await seedProduct({
      sku: "COMBO-1",
      name: "Retired peripheral",
      category: "Peripherals",
      stockQuantity: 2,
      status: "DISCONTINUED",
    });
    await seedProduct({
      sku: "COMBO-2",
      name: "Stocked peripheral",
      category: "Peripherals",
      stockQuantity: 200,
      status: "ACTIVE",
    });
    await seedProduct({
      sku: "COMBO-3",
      name: "Retired display",
      category: "Displays",
      stockQuantity: 1,
      status: "DISCONTINUED",
    });

    const result = await listProducts(
      listParams({ category: "Peripherals", status: "DISCONTINUED" }),
    );
    if (!result.ok) throw new Error("expected the list to load");

    expect(result.data.items.map((item) => item.sku)).toEqual(["COMBO-1"]);
  });
});

describe("sorting and paging", () => {
  beforeEach(async () => {
    await seedProduct({ sku: "A-1", name: "Alpha", stockQuantity: 30 });
    await seedProduct({ sku: "B-1", name: "Bravo", stockQuantity: 10 });
    await seedProduct({ sku: "C-1", name: "Charlie", stockQuantity: 20 });
  });

  it("sorts ascending and descending", async () => {
    const ascending = await listProducts(
      listParams({ sort: "name", direction: "asc" }),
    );
    const descending = await listProducts(
      listParams({ sort: "name", direction: "desc" }),
    );

    if (!ascending.ok || !descending.ok) {
      throw new Error("expected the list to load");
    }

    expect(ascending.data.items.map((item) => item.name)).toEqual([
      "Alpha",
      "Bravo",
      "Charlie",
    ]);
    expect(descending.data.items.map((item) => item.name)).toEqual([
      "Charlie",
      "Bravo",
      "Alpha",
    ]);
  });

  it("sorts by a numeric column numerically", async () => {
    const result = await listProducts(
      listParams({ sort: "stockQuantity", direction: "desc" }),
    );
    if (!result.ok) throw new Error("expected the list to load");

    expect(result.data.items.map((item) => item.stockQuantity)).toEqual([
      30, 20, 10,
    ]);
  });

  it("splits the catalogue into pages without losing or repeating a row", async () => {
    const first = await listProducts(
      listParams({ pageSize: 10, page: 1, sort: "sku" }),
    );
    if (!first.ok) throw new Error("expected the list to load");
    expect(first.data.pageCount).toBe(1);

    // A page size the fixture actually exceeds.
    const paged = await listProducts({
      ...listParams({ sort: "sku" }),
      pageSize: 10,
      page: 2,
    });
    if (!paged.ok) throw new Error("expected the list to load");
    expect(paged.data.items).toHaveLength(0);
    // The total is the number of matching rows, not the number on this page.
    expect(paged.data.total).toBe(3);
  });

  it("reports the total across pages, not the page size", async () => {
    for (let index = 0; index < 12; index += 1) {
      await seedProduct({ sku: `PAGE-${String(index).padStart(2, "0")}` });
    }

    const result = await listProducts(
      listParams({ pageSize: 10, page: 1, sort: "sku" }),
    );
    if (!result.ok) throw new Error("expected the list to load");

    expect(result.data.items).toHaveLength(10);
    expect(result.data.total).toBe(15);
    expect(result.data.pageCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

describe("product detail", () => {
  it("returns null for an id that does not exist, rather than failing", async () => {
    const result = await getProductDetail("nope");

    expect(result).toEqual({ ok: true, data: null });
  });

  it("includes the quantity on hand, the supplier, and the movement history", async () => {
    const admin = await signInWithRole("ADMIN");
    const supplier = await createSupplier("Detail Supplies");

    const created = await createProduct(
      productForm({
        sku: "DET-001",
        stockQuantity: "4",
        supplierId: supplier.id,
      }),
    );

    const result = await getProductDetail(created.id);
    if (!result.ok || !result.data) throw new Error("expected a product");

    // The quantity is reported as it stands, and carries no classification.
    expect(result.data.stockQuantity).toBe(4);
    expect(result.data).not.toHaveProperty("stockStatus");
    expect(result.data).not.toHaveProperty("minimumStock");
    expect(result.data.supplierName).toBe("Detail Supplies");
    expect(result.data.movements).toHaveLength(1);
    expect(result.data.movements[0]).toMatchObject({
      type: "STOCK_IN",
      change: 4,
      newStock: 4,
      createdByName: admin.name,
    });
    expect(result.data.recentOrders).toEqual([]);
    expect(result.data.recentPurchases).toEqual([]);
  });
});
