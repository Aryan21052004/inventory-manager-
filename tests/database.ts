import { prisma } from "@/lib/prisma";

import { fakeClerkUser, signInAs } from "./clerk-mock";

/**
 * Empties every table, children first — the foreign keys are Restrict, and a
 * wrong order fails loudly rather than silently orphaning rows.
 */
export async function resetDatabase(): Promise<void> {
  // Supply links first. They cascade from both lines they join, so the deletes
  // below would take them anyway — but clearing them explicitly keeps this
  // function's "children first" shape readable rather than relying on a
  // cascade two tables away.
  await prisma.supplyLink.deleteMany();
  await prisma.certificate.deleteMany();
  // The valuation layer hangs off the ledger, so it goes first: a consumption
  // points at both a lot and a transaction, and a lot points at a transaction
  // and a product. Restrict makes a wrong order fail loudly.
  await prisma.stockLotConsumption.deleteMany();
  /*
   * Return lots first, and separately.
   *
   * A returned batch points at the batch it came from through `originLotId`,
   * which is Restrict like everything else here — so a single bulk delete could
   * try to remove a source lot while its returned child still references it.
   * Clearing the children first makes the remaining delete a flat one.
   */
  await prisma.stockLot.deleteMany({ where: { originLotId: { not: null } } });
  await prisma.stockLot.deleteMany();
  await prisma.stockTransaction.deleteMany();
  // Returns point at orders with Restrict, so they go before the orders do.
  await prisma.return.deleteMany();
  await prisma.orderItem.deleteMany();
  await prisma.order.deleteMany();
  await prisma.purchaseItem.deleteMany();
  await prisma.purchase.deleteMany();
  await prisma.product.deleteMany();
  await prisma.customer.deleteMany();
  await prisma.supplier.deleteMany();
  await prisma.user.deleteMany();
}

/**
 * A product with a known opening balance to move stock against.
 *
 * `lotUnitCost` decides whether that balance has a known acquisition cost.
 * Left out, the stock is uncosted — see the note in `seedProduct` about why
 * that is the right default for a fixture.
 */
export async function createProduct(
  stockQuantity = 100,
  lotUnitCost?: string | null,
) {
  const product = await prisma.product.create({
    data: {
      sku: `TEST-${Math.random().toString(36).slice(2, 10)}`,
      name: "Test Widget",
      category: "Testing",
      sellingPrice: "12.50",
      stockQuantity,
    },
  });

  if (stockQuantity > 0) {
    const costed = lotUnitCost !== undefined && lotUnitCost !== null;

    await prisma.stockLot.create({
      data: {
        productId: product.id,
        unitCost: costed ? lotUnitCost : null,
        costSource: costed ? "OPENING" : "UNKNOWN",
        quantityReceived: stockQuantity,
        quantityRemaining: stockQuantity,
        sourceType: "MANUAL",
        sourceId: null,
        receivedAt: new Date(),
        stockTransactionId: null,
      },
    });
  }

  return product;
}

/**
 * The invariant the whole valuation layer rests on, as an assertion.
 *
 * `SUM(stock_lots.quantity_remaining) = products.stock_quantity`, for every
 * product. If this ever fails, the lots and the ledger have drifted apart and
 * the costing layer has stopped being an index over inventory and started being
 * a second, disagreeing copy of it.
 *
 * Called at the end of every test that moves stock. It is cheap, and it catches
 * the class of bug that would otherwise only surface as a mysteriously
 * mis-costed sale weeks later.
 */
export async function expectLotsReconcile(): Promise<void> {
  const rows = await prisma.$queryRaw<
    { sku: string; stock_quantity: number; lot_remaining: number }[]
  >`
    SELECT
      p.sku,
      p.stock_quantity,
      COALESCE((
        SELECT SUM(l.quantity_remaining)::int
        FROM stock_lots l
        WHERE l.product_id = p.id
      ), 0) AS lot_remaining
    FROM products p
    WHERE p.stock_quantity <> COALESCE((
      SELECT SUM(l.quantity_remaining)::int
      FROM stock_lots l
      WHERE l.product_id = p.id
    ), 0)
  `;

  if (rows.length > 0) {
    const detail = rows
      .map(
        (row) =>
          `${row.sku}: stock ${row.stock_quantity}, lots ${row.lot_remaining}`,
      )
      .join("; ");

    throw new Error(
      `Stock lots do not reconcile with stock quantities — ${detail}`,
    );
  }
}

/**
 * The other half of the reconciliation: a lot's remaining quantity must equal
 * what it received minus everything drawn from it.
 */
export async function expectConsumptionsReconcile(): Promise<void> {
  const rows = await prisma.$queryRaw<
    { id: string; quantity_remaining: number; expected: number }[]
  >`
    SELECT
      l.id,
      l.quantity_remaining,
      l.quantity_received - COALESCE((
        SELECT SUM(c.quantity)::int
        FROM stock_lot_consumptions c
        WHERE c.lot_id = l.id
      ), 0) AS expected
    FROM stock_lots l
    WHERE l.quantity_remaining <> l.quantity_received - COALESCE((
      SELECT SUM(c.quantity)::int
      FROM stock_lot_consumptions c
      WHERE c.lot_id = l.id
    ), 0)
  `;

  if (rows.length > 0) {
    throw new Error(
      `Lot consumption does not reconcile for ${rows.length} lot(s): ${rows
        .map((r) => `${r.id} has ${r.quantity_remaining}, expected ${r.expected}`)
        .join("; ")}`,
    );
  }
}

/**
 * The order line's own chain, as an assertion.
 *
 *     0 <= costedQuantity <= fulfilledQuantity <= quantity
 *
 * Two claims in one. That a line never ships more than was ordered, and that
 * it never costs more units than it shipped — the second being the one worth
 * guarding, because "unfulfilled" and "uncosted" are different absences and
 * the whole fulfilment model rests on keeping them apart. A unit that never
 * left has no acquisition cost to know, and letting it into a coverage figure
 * would report a fulfilment gap as a costing failure.
 *
 * The database enforces both through check constraints, so this is a second
 * line of defence rather than the only one. It earns its place by failing at
 * the assertion in the test that broke the rule, rather than as a constraint
 * violation from whichever write happened to come next.
 */
export async function expectFulfilmentReconciles(): Promise<void> {
  const rows = await prisma.$queryRaw<
    {
      order_number: string;
      quantity: number;
      fulfilled_quantity: number;
      costed_quantity: number;
    }[]
  >`
    SELECT
      o.order_number,
      oi.quantity,
      oi.fulfilled_quantity,
      oi.costed_quantity
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    WHERE NOT (
      oi.costed_quantity >= 0
      AND oi.costed_quantity <= oi.fulfilled_quantity
      AND oi.fulfilled_quantity <= oi.quantity
    )
  `;

  if (rows.length > 0) {
    const detail = rows
      .map(
        (row) =>
          `${row.order_number}: ordered ${row.quantity}, fulfilled ${row.fulfilled_quantity}, costed ${row.costed_quantity}`,
      )
      .join("; ");

    throw new Error(
      `Order lines break 0 <= costed <= fulfilled <= quantity — ${detail}`,
    );
  }
}

/**
 * The other half: what a line claims to have shipped must be what the ledger
 * says left.
 *
 * `fulfilledQuantity` is a denormalisation of the STOCK_OUT rows written
 * against the order, netted against any REVERSAL. The ledger is the record of
 * what actually moved, so if the two disagree the column is the one that is
 * wrong — and a silent drift here would mis-state cost coverage on every
 * report reading it.
 *
 * Only realised orders are checked. A cancelled order has had its fulfilment
 * reset to zero and its movements reversed, which nets to zero on both sides;
 * a draft has neither.
 */
export async function expectFulfilmentMatchesLedger(): Promise<void> {
  const rows = await prisma.$queryRaw<
    {
      order_number: string;
      fulfilled_quantity: number;
      ledger: number;
    }[]
  >`
    SELECT
      o.order_number,
      oi.fulfilled_quantity,
      COALESCE((
        SELECT SUM(
          CASE WHEN st.type = 'STOCK_OUT' THEN st.quantity ELSE -st.quantity END
        )::int
        FROM stock_transactions st
        WHERE st.reference_type = 'ORDER'
          AND st.reference_id = o.id
          AND st.product_id = oi.product_id
      ), 0) AS ledger
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    WHERE o.status IN ('CONFIRMED', 'COMPLETED')
      AND oi.fulfilled_quantity <> COALESCE((
        SELECT SUM(
          CASE WHEN st.type = 'STOCK_OUT' THEN st.quantity ELSE -st.quantity END
        )::int
        FROM stock_transactions st
        WHERE st.reference_type = 'ORDER'
          AND st.reference_id = o.id
          AND st.product_id = oi.product_id
      ), 0)
  `;

  if (rows.length > 0) {
    const detail = rows
      .map(
        (row) =>
          `${row.order_number}: fulfilled ${row.fulfilled_quantity}, ledger ${row.ledger}`,
      )
      .join("; ");

    throw new Error(
      `Fulfilled quantities do not match the stock ledger — ${detail}`,
    );
  }
}

/**
 * A product written straight to the table, bypassing the stock engine.
 *
 * Only for fixtures. The tests that care about *how* stock gets written call
 * the real functions; the ones that only need a row in a particular state —
 * a catalogue to search, a product holding nothing — set it up here so the
 * arrangement does not depend on the code under test.
 */
export async function seedProduct(overrides: {
  sku: string;
  name?: string;
  category?: string;
  /**
   * The catalogue's reference price. Pass `null` for a part that is only ever
   * quoted per order — the state the business actually has for some items.
   */
  sellingPrice?: string | null;
  stockQuantity?: number;
  status?: "ACTIVE" | "INACTIVE" | "DISCONTINUED";
  supplierId?: string | null;
  /**
   * What the seeded stock cost per unit. Omit for stock with no known cost —
   * which is what a fixture should use when the test is about quantities and
   * has no opinion about money.
   */
  lotUnitCost?: string | null;
}) {
  const stockQuantity = overrides.stockQuantity ?? 100;

  const product = await prisma.product.create({
    data: {
      name: overrides.name ?? `Product ${overrides.sku}`,
      sku: overrides.sku,
      category: overrides.category ?? "General",
      sellingPrice:
        overrides.sellingPrice === undefined ? "12.50" : overrides.sellingPrice,
      stockQuantity,
      status: overrides.status ?? "ACTIVE",
      supplierId: overrides.supplierId ?? null,
    },
  });

  /*
   * A lot to match the balance, so the fixture leaves the database in a state
   * that satisfies SUM(quantityRemaining) = stockQuantity.
   *
   * Fixtures write the product row directly rather than going through the stock
   * engine, which means they bypass the code that would normally create the
   * lot. Without this, every test using `seedProduct` would start from a
   * database that already violates the one invariant the valuation layer rests
   * on — and the first sale against it would fail for reasons having nothing to
   * do with what the test was checking.
   *
   * Uncosted unless the caller says otherwise, which is both the honest default
   * for stock conjured into existence and a useful one: it keeps the partial-
   * cost paths exercised by tests that were not written with money in mind.
   */
  if (stockQuantity > 0) {
    const costed =
      overrides.lotUnitCost !== undefined && overrides.lotUnitCost !== null;

    await prisma.stockLot.create({
      data: {
        productId: product.id,
        unitCost: costed ? overrides.lotUnitCost! : null,
        costSource: costed ? "OPENING" : "UNKNOWN",
        quantityReceived: stockQuantity,
        quantityRemaining: stockQuantity,
        sourceType: "MANUAL",
        sourceId: null,
        receivedAt: new Date(),
        stockTransactionId: null,
      },
    });
  }

  return product;
}

/**
 * A customer written straight to the table, bypassing the write layer.
 *
 * Only for fixtures. The tests that care about *how* a customer is created call
 * `createCustomer` for real; the ones that only need somebody to hang an order
 * on — a directory to search, an archived record to check is excluded — arrange
 * it here so the setup does not depend on the code under test.
 */
export async function seedCustomer(overrides: {
  name: string;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  status?: "ACTIVE" | "INACTIVE";
}) {
  return prisma.customer.create({
    data: {
      name: overrides.name,
      email: overrides.email ?? null,
      phone: overrides.phone ?? null,
      address: overrides.address ?? null,
      status: overrides.status ?? "ACTIVE",
    },
  });
}

export async function createSupplier(
  name = "Acme Supply Co",
  overrides: {
    status?: "ACTIVE" | "INACTIVE";
    contactPerson?: string | null;
    accountNumber?: string | null;
    typicalLeadTimeDays?: number | null;
    email?: string | null;
  } = {},
) {
  return prisma.supplier.create({
    data: {
      name,
      email:
        overrides.email === undefined
          ? `${Math.random().toString(36).slice(2, 10)}@example.com`
          : overrides.email,
      contactPerson: overrides.contactPerson ?? null,
      accountNumber: overrides.accountNumber ?? null,
      typicalLeadTimeDays: overrides.typicalLeadTimeDays ?? null,
      status: overrides.status ?? "ACTIVE",
    },
  });
}

/**
 * Signs in as a Clerk user backed by a local record with the given role.
 *
 * The two halves matter: the Clerk session supplies the identity, and the local
 * row supplies the role and the id that foreign keys point at. Tests that skip
 * the local row are testing something else — that the first request from a new
 * Clerk account creates one.
 */
export async function signInWithRole(role: "ADMIN" | "STAFF") {
  const local = await prisma.user.create({
    data: {
      clerkId: `user_${role.toLowerCase()}_${Math.random().toString(36).slice(2, 8)}`,
      name: `${role} Person`,
      email: `${role.toLowerCase()}-${Math.random().toString(36).slice(2, 8)}@example.com`,
      role,
    },
  });

  signInAs(fakeClerkUser(local.clerkId, local.email));
  return local;
}

/**
 * Order lines with a quoted price filled in from each product's reference.
 *
 * `OrderItem.unitPrice` is the price this customer was quoted, and it is a
 * required input — the server no longer derives it from the catalogue, which is
 * the whole point of the change. Most tests have no opinion about the number
 * and only care that an order exists, so this supplies the product's reference
 * price and keeps them reading the way they did before.
 *
 * A test that *does* care passes `unitPrice` explicitly and this leaves it
 * alone. Products with no reference price fall back to "0", which is a valid
 * quote and keeps a fixture from silently depending on one.
 */
export async function quoted(
  items: readonly { productId: string; quantity: number; unitPrice?: string }[],
): Promise<{ productId: string; quantity: number; unitPrice: string }[]> {
  const products = await prisma.product.findMany({
    where: { id: { in: [...new Set(items.map((item) => item.productId))] } },
    select: { id: true, sellingPrice: true },
  });

  const reference = new Map(
    products.map((row) => [row.id, row.sellingPrice?.toString() ?? "0"] as const),
  );

  return items.map((item) => ({
    productId: item.productId,
    quantity: item.quantity,
    unitPrice: item.unitPrice ?? reference.get(item.productId) ?? "0",
  }));
}
