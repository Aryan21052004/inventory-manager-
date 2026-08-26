import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@clerk/nextjs/server", async () => {
  const { clerkServerMock } = await import("./clerk-mock");
  return clerkServerMock;
});

import {
  DEFAULT_CUSTOMER_PARAMS,
  parseCustomerListParams,
  type CustomerListParams,
} from "@/lib/customer-query";
import { prisma } from "@/lib/prisma";
import {
  createCustomer,
  deleteCustomer,
  getCustomerDetail,
  listCustomers,
  loadCustomerStats,
  setCustomerStatus,
  updateCustomer,
} from "@/server/customers";
import { createOrder, loadCustomers, updateOrder } from "@/server/orders";

import { signOut } from "./clerk-mock";
import {
  resetDatabase,
  seedCustomer,
  seedProduct,
  signInWithRole,
} from "./database";

/**
 * The customers module.
 *
 * Against a real Postgres, because most of what is worth proving here is
 * Postgres behaviour: that the unique index rejects a second customer with the
 * same email while happily accepting any number with none, that a `Restrict`
 * foreign key stops an order's customer being deleted out from under it, that
 * an aggregate over a filtered subset of another table produces the number the
 * page claims. Mocking Prisma would only prove the mock agreed with the test.
 *
 * The rules under test, stated once:
 *
 *   Lifetime value is CONFIRMED + COMPLETED. Not drafts, not pending, not
 *   cancelled.
 *
 *   Any signed-in user may create and edit. Archiving and deleting are ADMIN.
 *
 *   Archiving removes somebody from the picker for a *new* order and does
 *   nothing else. Their orders keep pointing at them and stay editable.
 */

beforeEach(async () => {
  signOut();
  await resetDatabase();
});

/** The form fields, as strings — which is how they arrive from FormData. */
function customerForm(overrides: Record<string, string> = {}) {
  return {
    name: "Brightline Aviation",
    email: "parts@brightline.example",
    phone: "+1 555 0100",
    address: "Hangar 4, Fieldgate Airpark",
    ...overrides,
  };
}

function listParams(
  overrides: Partial<CustomerListParams> = {},
): CustomerListParams {
  return { ...DEFAULT_CUSTOMER_PARAMS, ...overrides };
}

/**
 * An order written straight to the table.
 *
 * The status is the point of most of these fixtures, and getting an order into
 * COMPLETED for real means raising it, confirming it — which moves stock — and
 * completing it. That is the orders module's job and it is tested there; here
 * the money and the status are the input, so they are set directly.
 */
async function seedOrder(
  customerId: string,
  status: "DRAFT" | "PENDING" | "CONFIRMED" | "COMPLETED" | "CANCELLED",
  total: string,
  orderNumber = `ORD-${Math.random().toString(36).slice(2, 10)}`,
) {
  return prisma.order.create({
    data: {
      orderNumber,
      customerId,
      status,
      subtotal: total,
      discount: "0.00",
      total,
    },
  });
}

// ---------------------------------------------------------------------------
// Creating
// ---------------------------------------------------------------------------

describe("creating a customer", () => {
  it("stores every field", async () => {
    await signInWithRole("ADMIN");

    const created = await createCustomer(customerForm());

    const row = await prisma.customer.findUniqueOrThrow({
      where: { id: created.id },
    });

    expect(row.name).toBe("Brightline Aviation");
    expect(row.email).toBe("parts@brightline.example");
    expect(row.phone).toBe("+1 555 0100");
    expect(row.address).toBe("Hangar 4, Fieldgate Airpark");
  });

  it("starts every customer active", async () => {
    await signInWithRole("STAFF");

    const created = await createCustomer(customerForm());
    const row = await prisma.customer.findUniqueOrThrow({
      where: { id: created.id },
    });

    expect(row.status).toBe("ACTIVE");
  });

  it("lets a STAFF user add one", async () => {
    // The whole reason this is not ADMIN-only: an order needs a customer, both
    // roles raise orders, and a STAFF user who could sell to somebody but not
    // write down who they are would be stuck at the first step.
    await signInWithRole("STAFF");

    await expect(createCustomer(customerForm())).resolves.toMatchObject({
      name: "Brightline Aviation",
    });
  });

  it("refuses an unauthenticated caller", async () => {
    await expect(createCustomer(customerForm())).rejects.toThrow(
      /signed in|not configured/i,
    );

    expect(await prisma.customer.count()).toBe(0);
  });

  it("trims and lower-cases the email", async () => {
    await signInWithRole("STAFF");

    const created = await createCustomer(
      customerForm({ email: "  Parts@Brightline.Example  " }),
    );

    const row = await prisma.customer.findUniqueOrThrow({
      where: { id: created.id },
    });

    // Without this the unique index means nothing — the same mailbox in two
    // cases would be two customers.
    expect(row.email).toBe("parts@brightline.example");
  });

  it("stores a blank email as null rather than an empty string", async () => {
    await signInWithRole("STAFF");

    const created = await createCustomer(customerForm({ email: "" }));
    const row = await prisma.customer.findUniqueOrThrow({
      where: { id: created.id },
    });

    expect(row.email).toBeNull();
  });

  it("allows any number of customers with no email", async () => {
    await signInWithRole("STAFF");

    await createCustomer(customerForm({ name: "One", email: "" }));
    await createCustomer(customerForm({ name: "Two", email: "" }));
    await createCustomer(customerForm({ name: "Three", email: "" }));

    // Postgres permits repeated NULLs in a unique index, which is exactly the
    // behaviour wanted: many walk-in buyers, never two sharing an address.
    expect(await prisma.customer.count()).toBe(3);
  });

  it("stores blank optional fields as null", async () => {
    await signInWithRole("STAFF");

    const created = await createCustomer(
      customerForm({ phone: "", address: "" }),
    );

    const row = await prisma.customer.findUniqueOrThrow({
      where: { id: created.id },
    });

    expect(row.phone).toBeNull();
    expect(row.address).toBeNull();
  });
});

describe("input validation", () => {
  beforeEach(async () => {
    await signInWithRole("ADMIN");
  });

  it("requires a name", async () => {
    await expect(createCustomer(customerForm({ name: "   " }))).rejects.toThrow(
      /name is required/i,
    );
  });

  it("rejects a name over 200 characters", async () => {
    await expect(
      createCustomer(customerForm({ name: "a".repeat(201) })),
    ).rejects.toThrow(/200 characters/i);
  });

  it("rejects an email that is not an address", async () => {
    await expect(
      createCustomer(customerForm({ email: "not-an-address" })),
    ).rejects.toThrow(/valid email/i);
  });

  it("attributes the failure to the field that caused it", async () => {
    // The action wrapper turns `details.field` into `fieldErrors`, which is how
    // a message ends up under the right input rather than only in a toast.
    await expect(
      createCustomer(customerForm({ email: "nope" })),
    ).rejects.toMatchObject({ details: { field: "email" } });
  });

  it("rejects an address over 500 characters", async () => {
    await expect(
      createCustomer(customerForm({ address: "a".repeat(501) })),
    ).rejects.toThrow(/500 characters/i);
  });

  it("writes nothing when validation fails", async () => {
    await expect(createCustomer(customerForm({ name: "" }))).rejects.toThrow();
    expect(await prisma.customer.count()).toBe(0);
  });
});

describe("email uniqueness", () => {
  it("refuses a second customer with the same email", async () => {
    await signInWithRole("ADMIN");
    await createCustomer(customerForm());

    await expect(
      createCustomer(customerForm({ name: "Someone else" })),
    ).rejects.toThrow(/already uses/i);

    expect(await prisma.customer.count()).toBe(1);
  });

  it("catches a duplicate that differs only in case", async () => {
    await signInWithRole("ADMIN");
    await createCustomer(customerForm({ email: "buyer@example.com" }));

    await expect(
      createCustomer(
        customerForm({ name: "Other", email: "BUYER@EXAMPLE.COM" }),
      ),
    ).rejects.toThrow(/already uses/i);
  });

  it("attributes a duplicate to the email field", async () => {
    await signInWithRole("ADMIN");
    await createCustomer(customerForm());

    await expect(
      createCustomer(customerForm({ name: "Other" })),
    ).rejects.toMatchObject({ code: "CONFLICT", details: { field: "email" } });
  });
});

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

describe("editing a customer", () => {
  it("updates the contact details", async () => {
    await signInWithRole("ADMIN");
    const customer = await seedCustomer({ name: "Old Name" });

    await updateCustomer(
      customer.id,
      customerForm({ name: "New Name", phone: "+44 20 7946 0000" }),
    );

    const row = await prisma.customer.findUniqueOrThrow({
      where: { id: customer.id },
    });

    expect(row.name).toBe("New Name");
    expect(row.phone).toBe("+44 20 7946 0000");
  });

  it("lets a STAFF user edit", async () => {
    await signInWithRole("STAFF");
    const customer = await seedCustomer({ name: "Contoso" });

    await expect(
      updateCustomer(customer.id, customerForm({ name: "Contoso Aviation" })),
    ).resolves.toMatchObject({ name: "Contoso Aviation" });
  });

  it("cannot change the status", async () => {
    await signInWithRole("STAFF");
    const customer = await seedCustomer({ name: "Contoso" });

    // The update schema has no `status` field, so this extra key is discarded
    // rather than honoured. Archiving is ADMIN-only and goes through
    // `setCustomerStatus`; without this, the edit form would be the way round
    // that rule.
    await updateCustomer(customer.id, {
      ...customerForm(),
      status: "INACTIVE",
    });

    const row = await prisma.customer.findUniqueOrThrow({
      where: { id: customer.id },
    });

    expect(row.status).toBe("ACTIVE");
  });

  it("keeps an archived customer archived through an edit", async () => {
    await signInWithRole("STAFF");
    const customer = await seedCustomer({
      name: "Retired Buyer",
      status: "INACTIVE",
    });

    await updateCustomer(customer.id, customerForm({ name: "Renamed" }));

    const row = await prisma.customer.findUniqueOrThrow({
      where: { id: customer.id },
    });

    expect(row.name).toBe("Renamed");
    expect(row.status).toBe("INACTIVE");
  });

  it("refuses an email another customer already uses", async () => {
    await signInWithRole("ADMIN");
    await seedCustomer({ name: "First", email: "taken@example.com" });
    const second = await seedCustomer({ name: "Second" });

    await expect(
      updateCustomer(second.id, customerForm({ email: "taken@example.com" })),
    ).rejects.toThrow(/already uses/i);
  });

  it("reports an unknown id as not found", async () => {
    await signInWithRole("ADMIN");

    await expect(
      updateCustomer("does-not-exist", customerForm()),
    ).rejects.toThrow(/could not be found/i);
  });

  it("refuses an unauthenticated caller", async () => {
    const customer = await seedCustomer({ name: "Contoso" });

    await expect(
      updateCustomer(customer.id, customerForm({ name: "Hijacked" })),
    ).rejects.toThrow(/signed in|not configured/i);

    const row = await prisma.customer.findUniqueOrThrow({
      where: { id: customer.id },
    });
    expect(row.name).toBe("Contoso");
  });
});

// ---------------------------------------------------------------------------
// Archiving
// ---------------------------------------------------------------------------

describe("archiving a customer", () => {
  it("takes them out of circulation", async () => {
    await signInWithRole("ADMIN");
    const customer = await seedCustomer({ name: "Contoso" });

    const result = await setCustomerStatus(customer.id, {
      status: "INACTIVE",
    });

    expect(result.status).toBe("INACTIVE");
  });

  it("brings them back", async () => {
    await signInWithRole("ADMIN");
    const customer = await seedCustomer({
      name: "Contoso",
      status: "INACTIVE",
    });

    const result = await setCustomerStatus(customer.id, { status: "ACTIVE" });

    expect(result.status).toBe("ACTIVE");
  });

  it("is refused for a STAFF user", async () => {
    await signInWithRole("STAFF");
    const customer = await seedCustomer({ name: "Contoso" });

    await expect(
      setCustomerStatus(customer.id, { status: "INACTIVE" }),
    ).rejects.toThrow(/requires the ADMIN role/i);

    const row = await prisma.customer.findUniqueOrThrow({
      where: { id: customer.id },
    });
    expect(row.status).toBe("ACTIVE");
  });

  it("rejects a status that is not one of the two", async () => {
    await signInWithRole("ADMIN");
    const customer = await seedCustomer({ name: "Contoso" });

    await expect(
      setCustomerStatus(customer.id, { status: "DELETED" }),
    ).rejects.toThrow();
  });

  it("leaves their orders exactly where they were", async () => {
    await signInWithRole("ADMIN");
    const customer = await seedCustomer({ name: "Contoso" });
    const order = await seedOrder(customer.id, "COMPLETED", "500.00");

    await setCustomerStatus(customer.id, { status: "INACTIVE" });

    const row = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
    });

    expect(row.customerId).toBe(customer.id);
    expect(row.status).toBe("COMPLETED");
  });

  it("keeps counting their spend", async () => {
    await signInWithRole("ADMIN");
    const customer = await seedCustomer({ name: "Contoso" });
    await seedOrder(customer.id, "COMPLETED", "500.00");

    await setCustomerStatus(customer.id, { status: "INACTIVE" });

    const detail = await getCustomerDetail(customer.id);
    if (!detail.ok || !detail.data) throw new Error("expected a customer");

    // Archiving is not a soft delete. The history is still theirs.
    expect(detail.data.lifetimeValue).toBe("500.00");
    expect(detail.data.orderCount).toBe(1);
  });
});

describe("the order picker", () => {
  it("offers active customers", async () => {
    await signInWithRole("STAFF");
    await seedCustomer({ name: "Active Buyer" });

    const options = await loadCustomers();

    expect(options.map((option) => option.name)).toEqual(["Active Buyer"]);
  });

  it("leaves archived customers out", async () => {
    await signInWithRole("STAFF");
    await seedCustomer({ name: "Active Buyer" });
    await seedCustomer({ name: "Retired Buyer", status: "INACTIVE" });

    const options = await loadCustomers();

    expect(options.map((option) => option.name)).toEqual(["Active Buyer"]);
  });

  it("includes an archived customer when asked for by id", async () => {
    await signInWithRole("STAFF");
    await seedCustomer({ name: "Active Buyer" });
    const retired = await seedCustomer({
      name: "Retired Buyer",
      status: "INACTIVE",
    });

    // What keeps an order raised before the archiving editable: the edit page
    // asks for the order's own customer by id, so the form can still show who
    // it is for instead of silently reassigning it.
    const options = await loadCustomers(retired.id);

    expect(options.map((option) => option.name)).toEqual([
      "Active Buyer",
      "Retired Buyer",
    ]);
    expect(options.find((option) => option.id === retired.id)?.status).toBe(
      "INACTIVE",
    );
  });

  it("does not duplicate an active customer asked for by id", async () => {
    await signInWithRole("STAFF");
    const active = await seedCustomer({ name: "Active Buyer" });

    const options = await loadCustomers(active.id);

    expect(options).toHaveLength(1);
  });

  it("offers them again once reactivated", async () => {
    await signInWithRole("ADMIN");
    const customer = await seedCustomer({
      name: "Retired Buyer",
      status: "INACTIVE",
    });

    expect(await loadCustomers()).toHaveLength(0);

    await setCustomerStatus(customer.id, { status: "ACTIVE" });

    expect(await loadCustomers()).toHaveLength(1);
  });
});

describe("archiving and existing orders", () => {
  it("does not stop a draft being edited", async () => {
    await signInWithRole("ADMIN");

    const customer = await seedCustomer({ name: "Contoso" });
    const product = await seedProduct({
      sku: "PART-1",
      stockQuantity: 50,
      sellingPrice: "10.00",
    });

    const order = await createOrder({
      customerId: customer.id,
      items: [{ productId: product.id, quantity: 2 }],
      discount: "0.00",
    });

    await setCustomerStatus(customer.id, { status: "INACTIVE" });

    /*
     * The rule this pins: `updateOrder` checks the customer *exists*, not that
     * they are active. Tightening that check to ACTIVE would make every draft
     * belonging to an archived customer permanently unsaveable — the customer
     * cannot be changed on an update, so there would be no way out of it.
     */
    const updated = await updateOrder(order.id, {
      customerId: customer.id,
      items: [{ productId: product.id, quantity: 5 }],
      discount: "0.00",
    });

    expect(Number(updated.total)).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// Deleting
// ---------------------------------------------------------------------------

describe("deleting a customer", () => {
  it("removes one who has never ordered", async () => {
    await signInWithRole("ADMIN");
    const customer = await seedCustomer({ name: "Added by mistake" });

    await deleteCustomer(customer.id);

    expect(await prisma.customer.count()).toBe(0);
  });

  it("refuses one with orders, and says to archive instead", async () => {
    await signInWithRole("ADMIN");
    const customer = await seedCustomer({ name: "Contoso" });
    await seedOrder(customer.id, "COMPLETED", "100.00");

    await expect(deleteCustomer(customer.id)).rejects.toThrow(/archive/i);

    expect(await prisma.customer.count()).toBe(1);
  });

  it("refuses one whose only order was cancelled", async () => {
    await signInWithRole("ADMIN");
    const customer = await seedCustomer({ name: "Contoso" });
    await seedOrder(customer.id, "CANCELLED", "100.00");

    // A cancelled order is still a document that has to keep saying who it was
    // for — "never ordered" means no row, not no revenue.
    await expect(deleteCustomer(customer.id)).rejects.toThrow(/cannot be deleted/i);
  });

  it("leaves the order untouched when it refuses", async () => {
    await signInWithRole("ADMIN");
    const customer = await seedCustomer({ name: "Contoso" });
    const order = await seedOrder(customer.id, "CONFIRMED", "100.00");

    await expect(deleteCustomer(customer.id)).rejects.toThrow();

    const row = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
    });
    expect(row.customerId).toBe(customer.id);
  });

  it("is refused for a STAFF user", async () => {
    await signInWithRole("STAFF");
    const customer = await seedCustomer({ name: "Contoso" });

    await expect(deleteCustomer(customer.id)).rejects.toThrow(
      /requires the ADMIN role/i,
    );

    expect(await prisma.customer.count()).toBe(1);
  });

  it("reports an unknown id as not found", async () => {
    await signInWithRole("ADMIN");

    await expect(deleteCustomer("does-not-exist")).rejects.toThrow(
      /could not be found/i,
    );
  });
});

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

describe("searching", () => {
  beforeEach(async () => {
    await signInWithRole("STAFF");
    await seedCustomer({
      name: "Brightline Aviation",
      email: "parts@brightline.example",
      phone: "+1 555 0100",
    });
    await seedCustomer({
      name: "Calder Rotorcraft",
      email: "buying@calder.example",
      phone: "+1 555 0200",
    });
  });

  it("matches on the name", async () => {
    const result = await listCustomers(listParams({ search: "bright" }));
    if (!result.ok) throw new Error("expected a page");

    expect(result.data.items.map((item) => item.name)).toEqual([
      "Brightline Aviation",
    ]);
  });

  it("matches on the email", async () => {
    const result = await listCustomers(listParams({ search: "calder.example" }));
    if (!result.ok) throw new Error("expected a page");

    expect(result.data.items.map((item) => item.name)).toEqual([
      "Calder Rotorcraft",
    ]);
  });

  it("matches on the phone number", async () => {
    const result = await listCustomers(listParams({ search: "555 0200" }));
    if (!result.ok) throw new Error("expected a page");

    expect(result.data.items.map((item) => item.name)).toEqual([
      "Calder Rotorcraft",
    ]);
  });

  it("ignores case", async () => {
    const result = await listCustomers(listParams({ search: "BRIGHTLINE" }));
    if (!result.ok) throw new Error("expected a page");

    expect(result.data.total).toBe(1);
  });

  it("returns nothing for a term that matches nobody", async () => {
    const result = await listCustomers(listParams({ search: "zzzz" }));
    if (!result.ok) throw new Error("expected a page");

    expect(result.data.items).toEqual([]);
    expect(result.data.total).toBe(0);
  });
});

describe("filtering by status", () => {
  beforeEach(async () => {
    await signInWithRole("STAFF");
    await seedCustomer({ name: "Active One" });
    await seedCustomer({ name: "Active Two" });
    await seedCustomer({ name: "Archived One", status: "INACTIVE" });
  });

  it("shows everyone when unfiltered", async () => {
    const result = await listCustomers(listParams());
    if (!result.ok) throw new Error("expected a page");

    // The directory is not the picker: an archived customer still has a record
    // to open, and hiding them by default would make them unreachable.
    expect(result.data.total).toBe(3);
  });

  it("narrows to the active ones", async () => {
    const result = await listCustomers(listParams({ status: "ACTIVE" }));
    if (!result.ok) throw new Error("expected a page");

    expect(result.data.total).toBe(2);
  });

  it("narrows to the archived ones", async () => {
    const result = await listCustomers(listParams({ status: "INACTIVE" }));
    if (!result.ok) throw new Error("expected a page");

    expect(result.data.items.map((item) => item.name)).toEqual(["Archived One"]);
  });
});

describe("lifetime value", () => {
  it("counts confirmed and completed orders only", async () => {
    await signInWithRole("STAFF");
    const customer = await seedCustomer({ name: "Contoso" });

    await seedOrder(customer.id, "DRAFT", "10.00");
    await seedOrder(customer.id, "PENDING", "20.00");
    await seedOrder(customer.id, "CONFIRMED", "100.00");
    await seedOrder(customer.id, "COMPLETED", "200.00");
    await seedOrder(customer.id, "CANCELLED", "400.00");

    const result = await listCustomers(listParams());
    if (!result.ok) throw new Error("expected a page");

    expect(Number(result.data.items[0]?.lifetimeValue)).toBe(300);
  });

  it("counts every order towards the order count", async () => {
    await signInWithRole("STAFF");
    const customer = await seedCustomer({ name: "Contoso" });

    await seedOrder(customer.id, "DRAFT", "10.00");
    await seedOrder(customer.id, "CANCELLED", "400.00");

    const result = await listCustomers(listParams());
    if (!result.ok) throw new Error("expected a page");

    // Two different questions. "How many orders" is history; "what are they
    // worth" is revenue, and a cancelled order is one of the first but not the
    // second.
    expect(result.data.items[0]?.orderCount).toBe(2);
    expect(Number(result.data.items[0]?.lifetimeValue)).toBe(0);
  });

  it("is zero for a customer who has never ordered", async () => {
    await signInWithRole("STAFF");
    await seedCustomer({ name: "Contact Only" });

    const result = await listCustomers(listParams());
    if (!result.ok) throw new Error("expected a page");

    expect(Number(result.data.items[0]?.lifetimeValue)).toBe(0);
    expect(result.data.items[0]?.orderCount).toBe(0);
  });

  it("does not leak one customer's revenue into another's", async () => {
    await signInWithRole("STAFF");
    const first = await seedCustomer({ name: "Aaa Buyer" });
    const second = await seedCustomer({ name: "Bbb Buyer" });

    await seedOrder(first.id, "COMPLETED", "100.00");
    await seedOrder(second.id, "COMPLETED", "250.00");

    const result = await listCustomers(listParams());
    if (!result.ok) throw new Error("expected a page");

    expect(Number(result.data.items[0]?.lifetimeValue)).toBe(100);
    expect(Number(result.data.items[1]?.lifetimeValue)).toBe(250);
  });
});

describe("sorting and paging", () => {
  beforeEach(async () => {
    await signInWithRole("STAFF");
  });

  it("sorts by name ascending by default", async () => {
    await seedCustomer({ name: "Charlie" });
    await seedCustomer({ name: "Alpha" });
    await seedCustomer({ name: "Bravo" });

    const result = await listCustomers(listParams());
    if (!result.ok) throw new Error("expected a page");

    expect(result.data.items.map((item) => item.name)).toEqual([
      "Alpha",
      "Bravo",
      "Charlie",
    ]);
  });

  it("reverses on descending", async () => {
    await seedCustomer({ name: "Alpha" });
    await seedCustomer({ name: "Bravo" });

    const result = await listCustomers(listParams({ direction: "desc" }));
    if (!result.ok) throw new Error("expected a page");

    expect(result.data.items.map((item) => item.name)).toEqual([
      "Bravo",
      "Alpha",
    ]);
  });

  it("sorts by order count", async () => {
    const busy = await seedCustomer({ name: "Busy" });
    const quiet = await seedCustomer({ name: "Quiet" });

    await seedOrder(busy.id, "COMPLETED", "10.00");
    await seedOrder(busy.id, "DRAFT", "10.00");
    await seedOrder(quiet.id, "DRAFT", "10.00");

    const result = await listCustomers(
      listParams({ sort: "orders", direction: "desc" }),
    );
    if (!result.ok) throw new Error("expected a page");

    expect(result.data.items.map((item) => item.name)).toEqual([
      "Busy",
      "Quiet",
    ]);
  });

  it("puts customers with no email last when sorting by email", async () => {
    await seedCustomer({ name: "No Email" });
    await seedCustomer({ name: "Has Email", email: "zzz@example.com" });

    const result = await listCustomers(listParams({ sort: "email" }));
    if (!result.ok) throw new Error("expected a page");

    // A page of blanks is not what anyone means by "sort by email".
    expect(result.data.items.map((item) => item.name)).toEqual([
      "Has Email",
      "No Email",
    ]);
  });

  it("reports the total across every page, not the page size", async () => {
    for (let index = 0; index < 12; index += 1) {
      await seedCustomer({ name: `Customer ${String(index).padStart(2, "0")}` });
    }

    const result = await listCustomers(listParams({ pageSize: 5 }));
    if (!result.ok) throw new Error("expected a page");

    expect(result.data.items).toHaveLength(5);
    expect(result.data.total).toBe(12);
    expect(result.data.pageCount).toBe(3);
  });

  it("loses nobody and repeats nobody across pages", async () => {
    for (let index = 0; index < 12; index += 1) {
      await seedCustomer({ name: `Customer ${String(index).padStart(2, "0")}` });
    }

    const seen: string[] = [];
    for (const page of [1, 2, 3]) {
      const result = await listCustomers(listParams({ page, pageSize: 5 }));
      if (!result.ok) throw new Error("expected a page");
      seen.push(...result.data.items.map((item) => item.id));
    }

    expect(seen).toHaveLength(12);
    expect(new Set(seen).size).toBe(12);
  });

  it("returns an empty page past the end", async () => {
    await seedCustomer({ name: "Only One" });

    const result = await listCustomers(listParams({ page: 9 }));
    if (!result.ok) throw new Error("expected a page");

    expect(result.data.items).toEqual([]);
    expect(result.data.total).toBe(1);
  });

  it("counts the filtered set, not the table", async () => {
    await seedCustomer({ name: "Active One" });
    await seedCustomer({ name: "Archived One", status: "INACTIVE" });
    await seedCustomer({ name: "Archived Two", status: "INACTIVE" });

    const result = await listCustomers(listParams({ status: "INACTIVE" }));
    if (!result.ok) throw new Error("expected a page");

    expect(result.data.total).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

describe("the figures above the list", () => {
  it("counts active and archived separately", async () => {
    await signInWithRole("STAFF");
    await seedCustomer({ name: "Active One" });
    await seedCustomer({ name: "Active Two" });
    await seedCustomer({ name: "Archived", status: "INACTIVE" });

    const result = await loadCustomerStats();
    if (!result.ok) throw new Error("expected stats");

    expect(result.data.total).toBe(3);
    expect(result.data.active).toBe(2);
    expect(result.data.archived).toBe(1);
  });

  it("counts how many have ever ordered", async () => {
    await signInWithRole("STAFF");
    const buyer = await seedCustomer({ name: "Buyer" });
    await seedCustomer({ name: "Contact Only" });
    await seedOrder(buyer.id, "DRAFT", "10.00");

    const result = await loadCustomerStats();
    if (!result.ok) throw new Error("expected stats");

    // A draft is not revenue, but it is an order — this tile answers "who has
    // ever bought anything", not "who has paid".
    expect(result.data.withOrders).toBe(1);
  });

  it("totals revenue on the same confirmed-and-completed basis", async () => {
    await signInWithRole("STAFF");
    const first = await seedCustomer({ name: "First" });
    const second = await seedCustomer({ name: "Second" });

    await seedOrder(first.id, "CONFIRMED", "100.00");
    await seedOrder(second.id, "COMPLETED", "50.00");
    await seedOrder(second.id, "CANCELLED", "999.00");

    const result = await loadCustomerStats();
    if (!result.ok) throw new Error("expected stats");

    expect(Number(result.data.lifetimeValue)).toBe(150);
  });

  it("reports zeroes for an empty directory", async () => {
    await signInWithRole("STAFF");

    const result = await loadCustomerStats();
    if (!result.ok) throw new Error("expected stats");

    expect(result.data.total).toBe(0);
    expect(Number(result.data.lifetimeValue)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

describe("customer detail", () => {
  it("carries the contact details and the totals", async () => {
    await signInWithRole("STAFF");
    const customer = await seedCustomer({
      name: "Brightline Aviation",
      email: "parts@brightline.example",
      phone: "+1 555 0100",
      address: "Hangar 4",
    });

    await seedOrder(customer.id, "COMPLETED", "200.00");
    await seedOrder(customer.id, "CONFIRMED", "100.00");
    await seedOrder(customer.id, "DRAFT", "40.00");
    await seedOrder(customer.id, "PENDING", "10.00");

    const result = await getCustomerDetail(customer.id);
    if (!result.ok || !result.data) throw new Error("expected a customer");

    expect(result.data.email).toBe("parts@brightline.example");
    expect(result.data.phone).toBe("+1 555 0100");
    expect(result.data.address).toBe("Hangar 4");
    expect(result.data.orderCount).toBe(4);
    expect(Number(result.data.lifetimeValue)).toBe(300);
    // Raised but not committed — kept apart from revenue rather than added to
    // it, so the two numbers never quietly merge.
    expect(Number(result.data.openValue)).toBe(50);
  });

  it("breaks the orders down by status", async () => {
    await signInWithRole("STAFF");
    const customer = await seedCustomer({ name: "Contoso" });

    await seedOrder(customer.id, "DRAFT", "10.00");
    await seedOrder(customer.id, "DRAFT", "10.00");
    await seedOrder(customer.id, "CANCELLED", "10.00");

    const result = await getCustomerDetail(customer.id);
    if (!result.ok || !result.data) throw new Error("expected a customer");

    expect(result.data.statusCounts.DRAFT).toBe(2);
    expect(result.data.statusCounts.CANCELLED).toBe(1);
    expect(result.data.statusCounts.COMPLETED).toBe(0);
  });

  it("reports the most recent order date", async () => {
    await signInWithRole("STAFF");
    const customer = await seedCustomer({ name: "Contoso" });

    const older = await seedOrder(customer.id, "COMPLETED", "10.00");
    await prisma.order.update({
      where: { id: older.id },
      data: { createdAt: new Date("2026-01-01T00:00:00.000Z") },
    });

    const newer = await seedOrder(customer.id, "COMPLETED", "20.00");
    await prisma.order.update({
      where: { id: newer.id },
      data: { createdAt: new Date("2026-06-01T00:00:00.000Z") },
    });

    const result = await getCustomerDetail(customer.id);
    if (!result.ok || !result.data) throw new Error("expected a customer");

    expect(result.data.lastOrderAt?.toISOString()).toBe(
      "2026-06-01T00:00:00.000Z",
    );
    expect(result.data.orders[0]?.id).toBe(newer.id);
  });

  it("has no last-order date for someone who has never ordered", async () => {
    await signInWithRole("STAFF");
    const customer = await seedCustomer({ name: "Contact Only" });

    const result = await getCustomerDetail(customer.id);
    if (!result.ok || !result.data) throw new Error("expected a customer");

    expect(result.data.lastOrderAt).toBeNull();
    expect(result.data.orders).toEqual([]);
    expect(result.data.hasMoreOrders).toBe(false);
  });

  it("caps the history and says there is more", async () => {
    await signInWithRole("STAFF");
    const customer = await seedCustomer({ name: "Contoso" });

    for (let index = 0; index < 27; index += 1) {
      await seedOrder(customer.id, "COMPLETED", "10.00");
    }

    const result = await getCustomerDetail(customer.id);
    if (!result.ok || !result.data) throw new Error("expected a customer");

    // The panel is a summary; the orders list is where the full history pages
    // properly.
    expect(result.data.orders).toHaveLength(25);
    expect(result.data.orderCount).toBe(27);
    expect(result.data.hasMoreOrders).toBe(true);
  });

  it("returns null for an id that does not exist", async () => {
    await signInWithRole("STAFF");

    const result = await getCustomerDetail("does-not-exist");

    expect(result).toEqual({ ok: true, data: null });
  });
});

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

describe("reading the query string", () => {
  it("falls back to the defaults when nothing is given", () => {
    expect(parseCustomerListParams({})).toEqual(DEFAULT_CUSTOMER_PARAMS);
  });

  it("reads the search, status, sort and direction", () => {
    const params = parseCustomerListParams({
      q: "brightline",
      status: "INACTIVE",
      sort: "orders",
      dir: "desc",
    });

    expect(params).toMatchObject({
      search: "brightline",
      status: "INACTIVE",
      sort: "orders",
      direction: "desc",
    });
  });

  it("discards a status that is not one of the two", () => {
    expect(parseCustomerListParams({ status: "DELETED" }).status).toBeNull();
  });

  it("discards a sort key outside the whitelist", () => {
    // A query string is user input, and the one people edit by hand. Nothing
    // unrecognised reaches the query builder.
    expect(parseCustomerListParams({ sort: "; DROP TABLE" }).sort).toBe("name");
  });

  it("discards a page size that is not offered", () => {
    expect(parseCustomerListParams({ size: "7" }).pageSize).toBe(
      DEFAULT_CUSTOMER_PARAMS.pageSize,
    );
  });

  it("treats a mangled page number as page one", () => {
    expect(parseCustomerListParams({ page: "-3" }).page).toBe(1);
    expect(parseCustomerListParams({ page: "banana" }).page).toBe(1);
  });
});
