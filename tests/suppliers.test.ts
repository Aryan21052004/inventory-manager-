import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@clerk/nextjs/server", async () => {
  const { clerkServerMock } = await import("./clerk-mock");
  return clerkServerMock;
});

import { prisma } from "@/lib/prisma";
import { DEFAULT_SUPPLIER_PARAMS } from "@/lib/supplier-query";
import {
  createSupplier as createSupplierRecord,
  deleteSupplier,
  getSupplierDetail,
  listSuppliers,
  loadSupplierOptions,
  loadSupplierStats,
  setSupplierStatus,
  updateSupplier,
} from "@/server/suppliers";
import { createPurchase, receivePurchase, updatePurchase } from "@/server/purchases";
import {
  createProduct,
  getProductDetail,
  updateProduct,
} from "@/server/products";
import { NO_SUPPLIER } from "@/lib/validation/product";

import { signOut } from "./clerk-mock";
import {
  createSupplier as seedSupplier,
  expectLotsReconcile,
  resetDatabase,
  seedProduct,
  signInWithRole,
} from "./database";

/**
 * Suppliers, and the two relationships that make them different from customers.
 *
 * A customer is referenced by one thing. A supplier is referenced by two, with
 * different foreign keys and different consequences, and almost everything
 * worth proving here follows from that:
 *
 *   `Purchase.supplierId` is NOT NULL and `Restrict`, so the database itself
 *   refuses to lose the supplier on a document — and that constraint is the
 *   last link in the `StockLot → Purchase → Supplier` chain the costing layer
 *   depends on.
 *
 *   `Product.supplierId` is nullable and `SetNull`, so deleting a supplier
 *   with products would *succeed* and silently blank the sourcing on every one
 *   of them. That is the destructive case that looks harmless, and refusing it
 *   is application logic rather than a constraint.
 *
 * The other half of the file is about archiving: that it stops new business
 * without invalidating anything already agreed, and that it does not touch a
 * single lot, quantity or acquisition cost.
 */

beforeEach(async () => {
  signOut();
  await resetDatabase();
});

function supplierForm(overrides: Record<string, string> = {}) {
  return {
    name: "Kestrel Aerospace",
    contactPerson: "Priya Raghunathan",
    email: "orders@kestrel.example",
    phone: "+44 20 7946 0112",
    address: "Unit 14, Brightmoor Estate, Slough",
    accountNumber: "KES-4471",
    typicalLeadTimeDays: "7",
    ...overrides,
  };
}

/** The product form fields, as strings — which is how they arrive from FormData. */
function productForm(overrides: Record<string, string> = {}) {
  return {
    name: "Bracket",
    sku: "BRK-1",
    category: "Airframe",
    standardCost: "",
    sellingPrice: "12.50",
    stockQuantity: "0",
    minimumStock: "0",
    status: "ACTIVE",
    supplierId: NO_SUPPLIER,
    ...overrides,
  };
}

function listParams(overrides: Record<string, unknown> = {}) {
  return { ...DEFAULT_SUPPLIER_PARAMS, ...overrides };
}

async function part(sku: string, supplierId?: string | null) {
  return seedProduct({
    sku,
    name: `Part ${sku}`,
    stockQuantity: 0,
    minimumStock: 0,
    supplierId: supplierId ?? null,
  });
}

// ---------------------------------------------------------------------------
// Creating and editing
// ---------------------------------------------------------------------------

describe("creating a supplier", () => {
  it("stores every field a signed-in user submitted", async () => {
    await signInWithRole("STAFF");

    const created = await createSupplierRecord(supplierForm());
    const row = await prisma.supplier.findUniqueOrThrow({
      where: { id: created.id },
    });

    expect(row.name).toBe("Kestrel Aerospace");
    expect(row.contactPerson).toBe("Priya Raghunathan");
    expect(row.email).toBe("orders@kestrel.example");
    expect(row.accountNumber).toBe("KES-4471");
    expect(row.typicalLeadTimeDays).toBe(7);
    // Created in circulation. Taking them out of it is a separate operation.
    expect(row.status).toBe("ACTIVE");
  });

  it("is open to STAFF — a purchase needs a supplier, and both roles raise purchases", async () => {
    await signInWithRole("STAFF");
    await expect(createSupplierRecord(supplierForm())).resolves.toMatchObject({
      name: "Kestrel Aerospace",
    });
  });

  it("refuses an unauthenticated caller", async () => {
    await expect(createSupplierRecord(supplierForm())).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(await prisma.supplier.count()).toBe(0);
  });

  it("requires a name", async () => {
    await signInWithRole("STAFF");

    await expect(
      createSupplierRecord(supplierForm({ name: "   " })),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Supplier name is required",
    });
    expect(await prisma.supplier.count()).toBe(0);
  });

  it("treats a blank optional field as absent rather than empty", async () => {
    await signInWithRole("STAFF");

    const created = await createSupplierRecord(
      supplierForm({ accountNumber: "", typicalLeadTimeDays: "", phone: "" }),
    );
    const row = await prisma.supplier.findUniqueOrThrow({
      where: { id: created.id },
    });

    expect(row.accountNumber).toBeNull();
    expect(row.typicalLeadTimeDays).toBeNull();
    expect(row.phone).toBeNull();
  });

  it("rejects a negative lead time", async () => {
    await signInWithRole("STAFF");

    await expect(
      createSupplierRecord(supplierForm({ typicalLeadTimeDays: "-3" })),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      details: { field: "typicalLeadTimeDays" },
    });
  });

  it("rejects a malformed email", async () => {
    await signInWithRole("STAFF");

    await expect(
      createSupplierRecord(supplierForm({ email: "not-an-email" })),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      details: { field: "email" },
    });
  });

  it("lets the unique index arbitrate a duplicate email", async () => {
    await signInWithRole("STAFF");
    await createSupplierRecord(supplierForm());

    await expect(
      createSupplierRecord(
        supplierForm({ name: "Someone else", accountNumber: "OTHER-1" }),
      ),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      details: { field: "email" },
    });

    expect(await prisma.supplier.count()).toBe(1);
  });

  it("normalises email case, so the index cannot be sidestepped", async () => {
    await signInWithRole("STAFF");
    await createSupplierRecord(supplierForm({ email: "Orders@Kestrel.example" }));

    const row = await prisma.supplier.findFirstOrThrow();
    expect(row.email).toBe("orders@kestrel.example");

    await expect(
      createSupplierRecord(
        supplierForm({ name: "Second", email: "ORDERS@KESTREL.EXAMPLE" }),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("allows many suppliers without an email", async () => {
    await signInWithRole("STAFF");
    await createSupplierRecord(supplierForm({ name: "One", email: "" }));
    await createSupplierRecord(supplierForm({ name: "Two", email: "" }));

    expect(await prisma.supplier.count()).toBe(2);
  });
});

describe("editing a supplier", () => {
  it("updates details without touching status", async () => {
    await signInWithRole("STAFF");
    const supplier = await seedSupplier("Old Name", { status: "INACTIVE" });

    await updateSupplier(supplier.id, supplierForm({ name: "New Name" }));

    const row = await prisma.supplier.findUniqueOrThrow({
      where: { id: supplier.id },
    });
    expect(row.name).toBe("New Name");
    // Archiving is not an edit, and the update schema cannot carry it.
    expect(row.status).toBe("INACTIVE");
  });

  it("ignores a status smuggled into the form data", async () => {
    await signInWithRole("STAFF");
    const supplier = await seedSupplier("Vendor");

    await updateSupplier(supplier.id, {
      ...supplierForm(),
      status: "INACTIVE",
    });

    const row = await prisma.supplier.findUniqueOrThrow({
      where: { id: supplier.id },
    });
    expect(row.status).toBe("ACTIVE");
  });

  it("reports a supplier that no longer exists", async () => {
    await signInWithRole("STAFF");
    await expect(
      updateSupplier("does-not-exist", supplierForm()),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

describe("permission boundaries", () => {
  it("archiving is ADMIN only", async () => {
    await signInWithRole("STAFF");
    const supplier = await seedSupplier("Vendor");

    await expect(
      setSupplierStatus(supplier.id, { status: "INACTIVE" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const row = await prisma.supplier.findUniqueOrThrow({
      where: { id: supplier.id },
    });
    expect(row.status).toBe("ACTIVE");
  });

  it("reactivating is ADMIN only", async () => {
    await signInWithRole("STAFF");
    const supplier = await seedSupplier("Vendor", { status: "INACTIVE" });

    await expect(
      setSupplierStatus(supplier.id, { status: "ACTIVE" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("deleting is ADMIN only", async () => {
    await signInWithRole("STAFF");
    const supplier = await seedSupplier("Vendor");

    await expect(deleteSupplier(supplier.id)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(await prisma.supplier.count()).toBe(1);
  });

  it("an ADMIN may archive, reactivate and delete", async () => {
    await signInWithRole("ADMIN");
    const supplier = await seedSupplier("Vendor");

    await setSupplierStatus(supplier.id, { status: "INACTIVE" });
    expect(
      (await prisma.supplier.findUniqueOrThrow({ where: { id: supplier.id } }))
        .status,
    ).toBe("INACTIVE");

    await setSupplierStatus(supplier.id, { status: "ACTIVE" });
    expect(
      (await prisma.supplier.findUniqueOrThrow({ where: { id: supplier.id } }))
        .status,
    ).toBe("ACTIVE");

    await deleteSupplier(supplier.id);
    expect(await prisma.supplier.count()).toBe(0);
  });

  it("refuses an unauthenticated archive", async () => {
    const supplier = await seedSupplier("Vendor");
    await expect(
      setSupplierStatus(supplier.id, { status: "INACTIVE" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});

// ---------------------------------------------------------------------------
// Deletion — the two conditions, refused for different reasons
// ---------------------------------------------------------------------------

describe("deleting a supplier", () => {
  it("succeeds when nothing references them", async () => {
    await signInWithRole("ADMIN");
    const supplier = await seedSupplier("Added by mistake");

    await expect(deleteSupplier(supplier.id)).resolves.toMatchObject({
      name: "Added by mistake",
    });
    expect(await prisma.supplier.count()).toBe(0);
  });

  it("is refused when they have purchases", async () => {
    await signInWithRole("ADMIN");
    const supplier = await seedSupplier("Vendor");
    const product = await part("A-1");

    await createPurchase({
      supplierId: supplier.id,
      items: [{ productId: product.id, quantity: 5, unitCost: "10.00" }],
    });

    await expect(deleteSupplier(supplier.id)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(await prisma.supplier.count()).toBe(1);
  });

  it("is refused when they have products, and no sourcing is blanked", async () => {
    /*
     * The case the database would happily allow. `Product.supplierId` is
     * SetNull, so without this check the delete would succeed and quietly clear
     * the supplier from every catalogue row they supply.
     */
    await signInWithRole("ADMIN");
    const supplier = await seedSupplier("Vendor");
    const a = await part("A-1", supplier.id);
    const b = await part("B-1", supplier.id);

    await expect(deleteSupplier(supplier.id)).rejects.toMatchObject({
      code: "CONFLICT",
    });

    // Still there, and still pointing where they were.
    expect(await prisma.supplier.count()).toBe(1);
    for (const product of [a, b]) {
      const row = await prisma.product.findUniqueOrThrow({
        where: { id: product.id },
      });
      expect(row.supplierId).toBe(supplier.id);
    }
  });

  it("names the products in the refusal so it can be acted on", async () => {
    await signInWithRole("ADMIN");
    const supplier = await seedSupplier("Vendor");
    await part("A-1", supplier.id);

    await expect(deleteSupplier(supplier.id)).rejects.toThrow(/1 product is/);
  });

  it("reports a supplier that does not exist", async () => {
    await signInWithRole("ADMIN");
    await expect(deleteSupplier("nope")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

// ---------------------------------------------------------------------------
// Archiving and the pickers
// ---------------------------------------------------------------------------

describe("archived suppliers and the pickers", () => {
  it("are left out of the options a picker offers", async () => {
    await signInWithRole("ADMIN");
    const active = await seedSupplier("Active Vendor");
    const archived = await seedSupplier("Archived Vendor", {
      status: "INACTIVE",
    });

    const options = await loadSupplierOptions();
    const ids = options.map((option) => option.id);

    expect(ids).toContain(active.id);
    expect(ids).not.toContain(archived.id);
  });

  it("are kept when named by includeId, so an existing record stays saveable", async () => {
    await signInWithRole("ADMIN");
    const active = await seedSupplier("Active Vendor");
    const archived = await seedSupplier("Archived Vendor", {
      status: "INACTIVE",
    });

    const options = await loadSupplierOptions(archived.id);
    const ids = options.map((option) => option.id);

    expect(ids).toContain(active.id);
    expect(ids).toContain(archived.id);
    expect(
      options.find((option) => option.id === archived.id)?.status,
    ).toBe("INACTIVE");
  });

  it("accepts several ids, for a page showing many records at once", async () => {
    await signInWithRole("ADMIN");
    const one = await seedSupplier("Archived One", { status: "INACTIVE" });
    const two = await seedSupplier("Archived Two", { status: "INACTIVE" });

    const ids = (await loadSupplierOptions([one.id, two.id])).map((o) => o.id);
    expect(ids).toContain(one.id);
    expect(ids).toContain(two.id);
  });
});

// ---------------------------------------------------------------------------
// Purchases
// ---------------------------------------------------------------------------

describe("archived suppliers and purchases", () => {
  it("cannot be used for a new purchase", async () => {
    await signInWithRole("ADMIN");
    const supplier = await seedSupplier("Vendor", { status: "INACTIVE" });
    const product = await part("A-1");

    await expect(
      createPurchase({
        supplierId: supplier.id,
        items: [{ productId: product.id, quantity: 5, unitCost: "10.00" }],
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      details: { field: "supplierId" },
    });

    expect(await prisma.purchase.count()).toBe(0);
  });

  it("stay valid on a purchase already raised with them", async () => {
    await signInWithRole("ADMIN");
    const supplier = await seedSupplier("Vendor");
    const product = await part("A-1");

    const purchase = await createPurchase({
      supplierId: supplier.id,
      items: [{ productId: product.id, quantity: 5, unitCost: "10.00" }],
    });

    await setSupplierStatus(supplier.id, { status: "INACTIVE" });

    // The draft is still editable, with the archived supplier still on it.
    await expect(
      updatePurchase(purchase.id, {
        supplierId: supplier.id,
        items: [{ productId: product.id, quantity: 8, unitCost: "10.00" }],
      }),
    ).resolves.toMatchObject({ id: purchase.id });

    const row = await prisma.purchase.findUniqueOrThrow({
      where: { id: purchase.id },
      include: { items: true },
    });
    expect(row.supplierId).toBe(supplier.id);
    expect(row.items[0]!.quantity).toBe(8);
  });

  it("cannot have a purchase moved *to* them", async () => {
    await signInWithRole("ADMIN");
    const active = await seedSupplier("Active Vendor");
    const archived = await seedSupplier("Archived Vendor", {
      status: "INACTIVE",
    });
    const product = await part("A-1");

    const purchase = await createPurchase({
      supplierId: active.id,
      items: [{ productId: product.id, quantity: 5, unitCost: "10.00" }],
    });

    await expect(
      updatePurchase(purchase.id, {
        supplierId: archived.id,
        items: [{ productId: product.id, quantity: 5, unitCost: "10.00" }],
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      details: { field: "supplierId" },
    });
  });

  it("can still have their pending delivery received", async () => {
    /*
     * Archiving stops new business; it does not stop goods that are physically
     * in transit from arriving. Refusing here would leave stock on a loading
     * bay with no way to book it in.
     */
    await signInWithRole("ADMIN");
    const supplier = await seedSupplier("Vendor");
    const product = await part("A-1");

    const purchase = await createPurchase({
      supplierId: supplier.id,
      items: [{ productId: product.id, quantity: 10, unitCost: "8000.00" }],
    });

    await setSupplierStatus(supplier.id, { status: "INACTIVE" });

    const outcome = await receivePurchase(purchase.id);
    expect(outcome.status).toBe("RECEIVED");

    const after = await prisma.product.findUniqueOrThrow({
      where: { id: product.id },
    });
    expect(after.stockQuantity).toBe(10);
    await expectLotsReconcile();
  });
});

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

describe("archived suppliers and products", () => {
  it("are not offered when assigning a supplier to a new product", async () => {
    await signInWithRole("ADMIN");
    const archived = await seedSupplier("Archived Vendor", {
      status: "INACTIVE",
    });

    const ids = (await loadSupplierOptions()).map((option) => option.id);
    expect(ids).not.toContain(archived.id);
  });

  it("remain available when editing a product already sourced from them", async () => {
    await signInWithRole("ADMIN");
    const archived = await seedSupplier("Archived Vendor", {
      status: "INACTIVE",
    });
    const product = await part("A-1", archived.id);

    // What the product detail page passes: the product's own supplier id.
    const ids = (await loadSupplierOptions(product.supplierId)).map((o) => o.id);
    expect(ids).toContain(archived.id);
  });

  it("do not block editing a product that already names them", async () => {
    await signInWithRole("ADMIN");
    const archived = await seedSupplier("Archived Vendor", {
      status: "INACTIVE",
    });
    const product = await part("A-1", archived.id);

    await expect(
      updateProduct(product.id, {
        name: "Renamed part",
        sku: product.sku,
        category: product.category,
        standardCost: "5.00",
        sellingPrice: "12.50",
        minimumStock: "0",
        status: "ACTIVE",
        supplierId: archived.id,
      }),
    ).resolves.toMatchObject({ id: product.id });

    const after = await prisma.product.findUniqueOrThrow({
      where: { id: product.id },
    });
    expect(after.name).toBe("Renamed part");
    expect(after.supplierId).toBe(archived.id);
  });

  it("cannot be assigned to a newly created product", async () => {
    /*
     * The rule lives on the server, not in the picker.
     *
     * The product form already leaves archived suppliers out of its dropdown,
     * but that is a convenience: `createProduct` is a server action reachable
     * with any `supplierId` somebody cares to send, and a stale form would send
     * one in good faith. Sourcing a new catalogue item from an archived
     * supplier is new business, and it is refused where it cannot be edited on
     * the way in.
     */
    await signInWithRole("ADMIN");
    const archived = await seedSupplier("Archived Vendor", {
      status: "INACTIVE",
    });

    await expect(
      createProduct(productForm({ supplierId: archived.id })),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      details: { field: "supplierId" },
    });

    // Nothing written — not the product, and not an orphaned opening balance.
    expect(await prisma.product.count()).toBe(0);
    expect(await prisma.stockTransaction.count()).toBe(0);
  });

  it("names the archived supplier in the refusal", async () => {
    await signInWithRole("ADMIN");
    const archived = await seedSupplier("Archived Vendor", {
      status: "INACTIVE",
    });

    await expect(
      createProduct(productForm({ supplierId: archived.id })),
    ).rejects.toThrow(/Archived Vendor/);
  });
});

describe("assigning a supplier to a new product", () => {
  it("succeeds with an ACTIVE supplier", async () => {
    await signInWithRole("ADMIN");
    const active = await seedSupplier("Active Vendor");

    const created = await createProduct(
      productForm({ sku: "OK-ACTIVE", supplierId: active.id }),
    );

    const row = await prisma.product.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(row.supplierId).toBe(active.id);
  });

  it("succeeds with no supplier at all", async () => {
    await signInWithRole("ADMIN");

    const created = await createProduct(
      productForm({ sku: "OK-NONE", supplierId: NO_SUPPLIER }),
    );

    const row = await prisma.product.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(row.supplierId).toBeNull();
  });

  it("is rejected with an INACTIVE supplier", async () => {
    await signInWithRole("ADMIN");
    const archived = await seedSupplier("Archived Vendor", {
      status: "INACTIVE",
    });

    await expect(
      createProduct(productForm({ sku: "NOPE", supplierId: archived.id })),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      details: { field: "supplierId" },
    });
  });

  it("still reports a supplier id that matches nobody", async () => {
    await signInWithRole("ADMIN");

    await expect(
      createProduct(productForm({ sku: "GHOST", supplierId: "no-such-id" })),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      details: { field: "supplierId" },
    });
  });

  it("leaves a product already sourced from an archived supplier readable and editable", async () => {
    /*
     * The other half of the rule. Archiving stops new assignments; it does not
     * reach back into the catalogue and strand what already points at them.
     */
    await signInWithRole("ADMIN");
    const supplier = await seedSupplier("Vendor");

    const created = await createProduct(
      productForm({ sku: "EXISTING-1", supplierId: supplier.id }),
    );

    await setSupplierStatus(supplier.id, { status: "INACTIVE" });

    // Readable, and still naming them.
    const detail = await getProductDetail(created.id);
    if (!detail.ok || !detail.data) throw new Error("expected a product");
    expect(detail.data.supplierId).toBe(supplier.id);
    expect(detail.data.supplierName).toBe("Vendor");

    // Editable, keeping the relationship.
    await expect(
      updateProduct(created.id, {
        name: "Renamed",
        sku: "EXISTING-1",
        category: "Airframe",
        standardCost: "5.00",
        sellingPrice: "12.50",
        minimumStock: "0",
        status: "ACTIVE",
        supplierId: supplier.id,
      }),
    ).resolves.toMatchObject({ id: created.id });

    const after = await prisma.product.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(after.name).toBe("Renamed");
    expect(after.supplierId).toBe(supplier.id);
  });
});

// ---------------------------------------------------------------------------
// Changing a product's supplier
// ---------------------------------------------------------------------------

describe("changing the supplier on an existing product", () => {
  /**
   * The rule in one sentence: an archived supplier may be **kept**, never newly
   * **chosen**. Every case below is a transition across that line, or
   * deliberately alongside it.
   */
  async function editWithSupplier(
    product: { id: string; sku: string; category: string },
    supplierId: string,
  ) {
    return updateProduct(product.id, {
      name: "Edited",
      sku: product.sku,
      category: product.category,
      standardCost: "5.00",
      sellingPrice: "12.50",
      minimumStock: "0",
      status: "ACTIVE",
      supplierId,
    });
  }

  it("ACTIVE → ACTIVE is allowed", async () => {
    await signInWithRole("ADMIN");
    const from = await seedSupplier("From Vendor");
    const to = await seedSupplier("To Vendor");
    const product = await part("MOVE-1", from.id);

    await expect(editWithSupplier(product, to.id)).resolves.toMatchObject({
      id: product.id,
    });

    const after = await prisma.product.findUniqueOrThrow({
      where: { id: product.id },
    });
    expect(after.supplierId).toBe(to.id);
  });

  it("ACTIVE → INACTIVE is rejected", async () => {
    await signInWithRole("ADMIN");
    const from = await seedSupplier("From Vendor");
    const archived = await seedSupplier("Archived Vendor", {
      status: "INACTIVE",
    });
    const product = await part("MOVE-2", from.id);

    await expect(editWithSupplier(product, archived.id)).rejects.toMatchObject({
      code: "BAD_REQUEST",
      details: { field: "supplierId" },
    });
  });

  it("keeping the same INACTIVE supplier is allowed", async () => {
    await signInWithRole("ADMIN");
    const archived = await seedSupplier("Archived Vendor", {
      status: "INACTIVE",
    });
    const product = await part("MOVE-3", archived.id);

    await expect(editWithSupplier(product, archived.id)).resolves.toMatchObject(
      { id: product.id },
    );

    const after = await prisma.product.findUniqueOrThrow({
      where: { id: product.id },
    });
    expect(after.name).toBe("Edited");
    expect(after.supplierId).toBe(archived.id);
  });

  it("INACTIVE → ACTIVE is allowed", async () => {
    await signInWithRole("ADMIN");
    const archived = await seedSupplier("Archived Vendor", {
      status: "INACTIVE",
    });
    const active = await seedSupplier("Active Vendor");
    const product = await part("MOVE-4", archived.id);

    await expect(editWithSupplier(product, active.id)).resolves.toMatchObject({
      id: product.id,
    });

    const after = await prisma.product.findUniqueOrThrow({
      where: { id: product.id },
    });
    expect(after.supplierId).toBe(active.id);
  });

  it("ACTIVE → none is allowed", async () => {
    await signInWithRole("ADMIN");
    const from = await seedSupplier("From Vendor");
    const product = await part("MOVE-5", from.id);

    await expect(
      editWithSupplier(product, NO_SUPPLIER),
    ).resolves.toMatchObject({ id: product.id });

    const after = await prisma.product.findUniqueOrThrow({
      where: { id: product.id },
    });
    expect(after.supplierId).toBeNull();
  });

  it("INACTIVE → none is allowed, and cannot be undone by re-selecting", async () => {
    // Dropping an archived supplier is fine; picking them back up afterwards is
    // a new relationship, and is refused like any other.
    await signInWithRole("ADMIN");
    const archived = await seedSupplier("Archived Vendor", {
      status: "INACTIVE",
    });
    const product = await part("MOVE-6", archived.id);

    await editWithSupplier(product, NO_SUPPLIER);
    expect(
      (await prisma.product.findUniqueOrThrow({ where: { id: product.id } }))
        .supplierId,
    ).toBeNull();

    await expect(editWithSupplier(product, archived.id)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("a rejected change leaves the product exactly as it was", async () => {
    await signInWithRole("ADMIN");
    const from = await seedSupplier("From Vendor");
    const archived = await seedSupplier("Archived Vendor", {
      status: "INACTIVE",
    });
    const product = await part("MOVE-7", from.id);

    const before = await prisma.product.findUniqueOrThrow({
      where: { id: product.id },
    });

    await expect(editWithSupplier(product, archived.id)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });

    const after = await prisma.product.findUniqueOrThrow({
      where: { id: product.id },
    });

    // Not just the supplier — the whole row, including the name the edit tried
    // to change. The transaction rolled back rather than half-applying.
    expect(after.name).toBe(before.name);
    expect(after.sellingPrice.toString()).toBe(before.sellingPrice.toString());
    expect(after.supplierId).toBe(from.id);
  });

  it("a rejected change writes no inventory movement", async () => {
    await signInWithRole("ADMIN");
    const from = await seedSupplier("From Vendor");
    const archived = await seedSupplier("Archived Vendor", {
      status: "INACTIVE",
    });
    const product = await part("MOVE-8", from.id);

    const movementsBefore = await prisma.stockTransaction.count();
    const lotsBefore = await prisma.stockLot.count();

    await expect(editWithSupplier(product, archived.id)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });

    expect(await prisma.stockTransaction.count()).toBe(movementsBefore);
    expect(await prisma.stockLot.count()).toBe(lotsBefore);
    await expectLotsReconcile();
  });

  it("still reports a supplier id that matches nobody", async () => {
    await signInWithRole("ADMIN");
    const from = await seedSupplier("From Vendor");
    const product = await part("MOVE-9", from.id);

    await expect(
      editWithSupplier(product, "no-such-supplier"),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      details: { field: "supplierId" },
    });
  });
});

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

describe("archiving does not disturb inventory or provenance", () => {
  it("leaves stock lots, quantities and costs exactly as they were", async () => {
    await signInWithRole("ADMIN");
    const supplier = await seedSupplier("Vendor");
    const product = await part("A-1");

    const purchase = await createPurchase({
      supplierId: supplier.id,
      items: [{ productId: product.id, quantity: 10, unitCost: "8000.00" }],
    });
    await receivePurchase(purchase.id);

    const lotsBefore = await prisma.stockLot.findMany({
      orderBy: { id: "asc" },
    });
    const stockBefore = (
      await prisma.product.findUniqueOrThrow({ where: { id: product.id } })
    ).stockQuantity;

    await setSupplierStatus(supplier.id, { status: "INACTIVE" });

    const lotsAfter = await prisma.stockLot.findMany({ orderBy: { id: "asc" } });
    const stockAfter = (
      await prisma.product.findUniqueOrThrow({ where: { id: product.id } })
    ).stockQuantity;

    expect(lotsAfter).toEqual(lotsBefore);
    expect(stockAfter).toBe(stockBefore);
    expect(lotsAfter[0]!.unitCost?.toString()).toBe("8000");
    await expectLotsReconcile();
  });

  it("keeps the lot → purchase → supplier chain resolvable", async () => {
    await signInWithRole("ADMIN");
    const supplier = await seedSupplier("Vendor");
    const product = await part("A-1");

    const purchase = await createPurchase({
      supplierId: supplier.id,
      items: [{ productId: product.id, quantity: 10, unitCost: "8000.00" }],
    });
    await receivePurchase(purchase.id);
    await setSupplierStatus(supplier.id, { status: "INACTIVE" });

    const lot = await prisma.stockLot.findFirstOrThrow();
    expect(lot.sourceType).toBe("PURCHASE");

    const source = await prisma.purchase.findUniqueOrThrow({
      where: { id: lot.sourceId! },
      include: { supplier: true },
    });

    expect(source.id).toBe(purchase.id);
    expect(source.supplier.id).toBe(supplier.id);
    expect(source.supplier.status).toBe("INACTIVE");
  });
});

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

describe("the suppliers list", () => {
  it("searches name, contact person, email and account number", async () => {
    await signInWithRole("ADMIN");
    await seedSupplier("Kestrel Aerospace", {
      contactPerson: "Priya Raghunathan",
      accountNumber: "KES-4471",
      email: "orders@kestrel.example",
    });
    await seedSupplier("Northwind Components", {
      contactPerson: "Tomas Lindqvist",
      accountNumber: "NW-2200",
      email: "sales@northwind.example",
    });

    for (const [term, expected] of [
      ["kestrel", "Kestrel Aerospace"],
      ["priya", "Kestrel Aerospace"],
      ["NW-2200", "Northwind Components"],
      ["sales@northwind", "Northwind Components"],
    ] as const) {
      const result = await listSuppliers(listParams({ search: term }));
      if (!result.ok) throw new Error("expected a list");
      expect(result.data.items.map((row) => row.name)).toEqual([expected]);
    }
  });

  it("filters by status", async () => {
    await signInWithRole("ADMIN");
    await seedSupplier("Active Vendor");
    await seedSupplier("Archived Vendor", { status: "INACTIVE" });

    const archived = await listSuppliers(listParams({ status: "INACTIVE" }));
    if (!archived.ok) throw new Error("expected a list");
    expect(archived.data.items.map((row) => row.name)).toEqual([
      "Archived Vendor",
    ]);

    const all = await listSuppliers(listParams());
    if (!all.ok) throw new Error("expected a list");
    expect(all.data.total).toBe(2);
  });

  it("sorts by name, lead time and purchase count", async () => {
    await signInWithRole("ADMIN");
    const b = await seedSupplier("Bravo", { typicalLeadTimeDays: 3 });
    const a = await seedSupplier("Alpha", { typicalLeadTimeDays: 21 });
    // No lead time recorded — must sort last, not first.
    await seedSupplier("Charlie");

    const product = await part("A-1");
    await createPurchase({
      supplierId: b.id,
      items: [{ productId: product.id, quantity: 1, unitCost: "1.00" }],
    });

    const byName = await listSuppliers(listParams({ sort: "name" }));
    if (!byName.ok) throw new Error("expected a list");
    expect(byName.data.items.map((r) => r.name)).toEqual([
      "Alpha",
      "Bravo",
      "Charlie",
    ]);

    const byLead = await listSuppliers(
      listParams({ sort: "leadTime", direction: "asc" }),
    );
    if (!byLead.ok) throw new Error("expected a list");
    // Nulls last: an unrecorded lead time is not a fast one.
    expect(byLead.data.items.map((r) => r.name)).toEqual([
      "Bravo",
      "Alpha",
      "Charlie",
    ]);

    const byPurchases = await listSuppliers(
      listParams({ sort: "purchases", direction: "desc" }),
    );
    if (!byPurchases.ok) throw new Error("expected a list");
    expect(byPurchases.data.items[0]!.name).toBe("Bravo");
    expect(byPurchases.data.items[0]!.id).toBe(b.id);
    expect(a.id).toBeTruthy();
  });

  it("pages", async () => {
    await signInWithRole("ADMIN");
    for (let index = 0; index < 7; index += 1) {
      await seedSupplier(`Vendor ${String(index).padStart(2, "0")}`);
    }

    const first = await listSuppliers(listParams({ pageSize: 3, page: 1 }));
    if (!first.ok) throw new Error("expected a list");
    expect(first.data.items).toHaveLength(3);
    expect(first.data.total).toBe(7);
    expect(first.data.pageCount).toBe(3);

    const last = await listSuppliers(listParams({ pageSize: 3, page: 3 }));
    if (!last.ok) throw new Error("expected a list");
    expect(last.data.items).toHaveLength(1);
  });

  it("counts products and received spend per row", async () => {
    await signInWithRole("ADMIN");
    const supplier = await seedSupplier("Vendor");
    const product = await part("A-1", supplier.id);

    const received = await createPurchase({
      supplierId: supplier.id,
      items: [{ productId: product.id, quantity: 10, unitCost: "10.00" }],
    });
    await receivePurchase(received.id);

    // A draft is a plan, not money spent.
    await createPurchase({
      supplierId: supplier.id,
      items: [{ productId: product.id, quantity: 5, unitCost: "10.00" }],
    });

    const result = await listSuppliers(listParams());
    if (!result.ok) throw new Error("expected a list");

    const row = result.data.items[0]!;
    expect(row.productCount).toBe(1);
    expect(row.purchaseCount).toBe(2);
    expect(Number(row.totalPurchased)).toBe(100);
  });
});

describe("supplier statistics", () => {
  it("counts active, archived and traded-with suppliers", async () => {
    await signInWithRole("ADMIN");
    const traded = await seedSupplier("Traded");
    await seedSupplier("Never used");
    await seedSupplier("Archived", { status: "INACTIVE" });

    const product = await part("A-1");
    const purchase = await createPurchase({
      supplierId: traded.id,
      items: [{ productId: product.id, quantity: 4, unitCost: "25.00" }],
    });
    await receivePurchase(purchase.id);

    const stats = await loadSupplierStats();
    if (!stats.ok) throw new Error("expected stats");

    expect(stats.data.total).toBe(3);
    expect(stats.data.active).toBe(2);
    expect(stats.data.archived).toBe(1);
    expect(stats.data.withPurchases).toBe(1);
    expect(Number(stats.data.totalPurchased)).toBe(100);
  });

  it("counts a supplier with many purchases once", async () => {
    await signInWithRole("ADMIN");
    const supplier = await seedSupplier("Vendor");
    const product = await part("A-1");

    for (let index = 0; index < 3; index += 1) {
      await createPurchase({
        supplierId: supplier.id,
        items: [{ productId: product.id, quantity: 1, unitCost: "1.00" }],
      });
    }

    const stats = await loadSupplierStats();
    if (!stats.ok) throw new Error("expected stats");
    expect(stats.data.withPurchases).toBe(1);
  });
});

describe("supplier detail", () => {
  it("reports stock on hand from the existing lots", async () => {
    await signInWithRole("ADMIN");
    const supplier = await seedSupplier("Vendor");
    const a = await part("A-1", supplier.id);
    const b = await part("B-1", supplier.id);

    const first = await createPurchase({
      supplierId: supplier.id,
      items: [
        { productId: a.id, quantity: 10, unitCost: "8000.00" },
        { productId: b.id, quantity: 5, unitCost: "300.00" },
      ],
    });
    await receivePurchase(first.id);

    const result = await getSupplierDetail(supplier.id);
    if (!result.ok || !result.data) throw new Error("expected a supplier");

    const stock = result.data.stockOnHand;
    // 10 × 8000 + 5 × 300 = 81,500
    expect(stock.units).toBe(15);
    expect(Number(stock.value)).toBe(81_500);
    expect(stock.costedUnits).toBe(15);
    expect(stock.uncostedUnits).toBe(0);
    expect(stock.productCount).toBe(2);
  });

  it("excludes uncosted stock from the value and counts it separately", async () => {
    /*
     * Stock a fixture conjured into existence has no purchase behind it, so it
     * is not traceable to any supplier — and lots whose cost was never
     * established must never be valued at a guess. Both rules are visible here.
     */
    await signInWithRole("ADMIN");
    const supplier = await seedSupplier("Vendor");

    const product = await seedProduct({
      sku: "A-1",
      stockQuantity: 40,
      minimumStock: 0,
      supplierId: supplier.id,
      lotUnitCost: null,
    });

    const purchase = await createPurchase({
      supplierId: supplier.id,
      items: [{ productId: product.id, quantity: 10, unitCost: "8000.00" }],
    });
    await receivePurchase(purchase.id);

    const result = await getSupplierDetail(supplier.id);
    if (!result.ok || !result.data) throw new Error("expected a supplier");

    // The pre-existing 40 units are not traceable to this supplier at all.
    expect(result.data.stockOnHand.units).toBe(10);
    expect(Number(result.data.stockOnHand.value)).toBe(80_000);
    expect(result.data.stockOnHand.uncostedUnits).toBe(0);
  });

  it("reports deletability from both counts", async () => {
    await signInWithRole("ADMIN");
    const clean = await seedSupplier("Clean");
    const withProduct = await seedSupplier("Has a product");
    await part("A-1", withProduct.id);

    const cleanDetail = await getSupplierDetail(clean.id);
    if (!cleanDetail.ok || !cleanDetail.data) throw new Error("expected");
    expect(cleanDetail.data.deletable).toBe(true);

    const blockedDetail = await getSupplierDetail(withProduct.id);
    if (!blockedDetail.ok || !blockedDetail.data) throw new Error("expected");
    expect(blockedDetail.data.deletable).toBe(false);
    expect(blockedDetail.data.productCount).toBe(1);
  });

  it("returns null for an id that does not exist", async () => {
    await signInWithRole("ADMIN");
    const result = await getSupplierDetail("nope");
    expect(result.ok && result.data).toBeNull();
  });
});
