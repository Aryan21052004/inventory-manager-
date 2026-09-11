import "server-only";

import type { Prisma } from "@/generated/prisma/client";
import type { CustomerStatus, OrderStatus } from "@/generated/prisma/enums";
import type { Currency } from "@/lib/currency";
import type { CustomerListParams } from "@/lib/customer-query";
import {
  AppError,
  NotFoundError,
  toSafeError,
  type SafeError,
} from "@/lib/errors";
import { REVENUE_STATUSES as REVENUE } from "@/lib/money-basis";
import {
  groupTotals,
  NO_MONEY,
  sumByCurrency,
  type MoneyByCurrency,
} from "@/lib/money-by-currency";
import { prisma } from "@/lib/prisma";
import {
  createCustomerSchema,
  customerStatusSchema,
  firstCustomerIssue,
  toCustomerFieldErrors,
  updateCustomerSchema,
  type CustomerFieldErrors,
} from "@/lib/validation/customer";
import { requireRole, requireUser } from "@/server/auth";

/**
 * Everything the customers module does to the database.
 *
 * Free of any `next/*` import, like the other server modules: the actions in
 * src/app/(app)/customers/actions.ts are thin wrappers that call in here and
 * then revalidate, so the rules — who may write, what a duplicate email does,
 * that a customer with history cannot be deleted — are testable directly.
 *
 * Reads return a result object rather than throwing; writes throw `AppError`,
 * which the action wrapper turns into something the form can display.
 *
 * Two rules run through the whole file:
 *
 *   Lifetime value counts CONFIRMED and COMPLETED orders and nothing else.
 *   A draft is not a sale, a pending order has not been committed, and a
 *   cancelled one gave its stock back — counting any of them would inflate what
 *   a customer is worth. CONFIRMED is included rather than only COMPLETED
 *   because confirming is the point stock leaves: the goods are committed and
 *   the money is owed whether or not the delivery has been marked off.
 *
 *   Archiving is not deletion. An INACTIVE customer keeps every order they
 *   ever placed, still appears on those orders, and still opens from them. The
 *   status only decides whether they are offered when raising something new.
 */

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/*
 * The statuses that count towards what a customer has spent are not defined
 * here. They live in src/lib/money-basis.ts as `REVENUE_STATUSES` and are
 * imported above — this module having its own copy is how it came to differ
 * from the orders module's idea of "value" without anybody noticing.
 */

/**
 * The order statuses that are raised but not yet committed.
 *
 * Named for what it means rather than for "open", which had already been
 * claimed by a different idea: `OPEN_ORDER_STATUSES` in src/lib/money-basis.ts
 * is CONFIRMED — an order committed and awaiting shipment. This one is the
 * other end of the same lifecycle. Both were called "open"; only one could be.
 */
const UNCOMMITTED_ORDER_STATUSES = ["DRAFT", "PENDING"] as const;

export interface CustomerListItem {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  address: string | null;
  status: CustomerStatus;
  createdAt: Date;
  /** Every order ever raised for them, whatever became of it. */
  orderCount: number;
  /** Sum of their CONFIRMED and COMPLETED order totals. */
  lifetimeValueByCurrency: MoneyByCurrency;
}

export interface CustomerListPage {
  items: CustomerListItem[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

export interface CustomerStats {
  total: number;
  active: number;
  archived: number;
  /** How many have ever ordered — the rest are contacts, not buyers yet. */
  withOrders: number;
  /** Revenue across every customer, on the same CONFIRMED + COMPLETED basis. */
  lifetimeValueByCurrency: MoneyByCurrency;
}

export interface CustomerOrderLine {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  total: string;
  /** The currency the order was raised in. Null on a legacy order. */
  currency: Currency | null;
  itemCount: number;
  createdAt: Date;
}

export interface CustomerDetail {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  address: string | null;
  status: CustomerStatus;
  createdAt: Date;
  updatedAt: Date;

  orderCount: number;
  /** CONFIRMED + COMPLETED. */
  lifetimeValueByCurrency: MoneyByCurrency;
  /** DRAFT + PENDING — raised, not yet committed. */
  openValueByCurrency: MoneyByCurrency;
  /** How many orders sit in each status. */
  statusCounts: Record<OrderStatus, number>;
  lastOrderAt: Date | null;

  /** Their orders, most recent first, capped — see `ORDER_HISTORY_LIMIT`. */
  orders: CustomerOrderLine[];
  /** True when the history above is only part of it. */
  hasMoreOrders: boolean;
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: SafeError };

/**
 * A customer that has traded is somebody with a lot of orders, and the detail
 * page is a summary, not an archive. The full list is one click away behind the
 * orders filter, which pages properly.
 */
const ORDER_HISTORY_LIMIT = 25;

// ---------------------------------------------------------------------------
// Query building
// ---------------------------------------------------------------------------

function buildWhere(params: CustomerListParams): Prisma.CustomerWhereInput {
  const filters: Prisma.CustomerWhereInput[] = [];

  if (params.search) {
    /*
     * One box, three columns. Whoever is looking for a customer has whichever
     * detail the caller gave them — a name, the address they email, or the
     * number on the invoice — and should not have to tell the application
     * which kind of thing they just typed.
     */
    filters.push({
      OR: [
        { name: { contains: params.search, mode: "insensitive" } },
        { email: { contains: params.search, mode: "insensitive" } },
        { phone: { contains: params.search, mode: "insensitive" } },
      ],
    });
  }

  if (params.status) filters.push({ status: params.status });

  return filters.length > 0 ? { AND: filters } : {};
}

function buildOrderBy(
  params: CustomerListParams,
): Prisma.CustomerOrderByWithRelationInput[] {
  const direction = params.direction;

  let primary: Prisma.CustomerOrderByWithRelationInput;

  switch (params.sort) {
    case "orders":
      // A relation count rather than a column. Postgres does the counting.
      primary = { orders: { _count: direction } };
      break;
    case "email":
      // Nulls last in both directions: a page of customers who gave no email
      // address is not what anyone means by "sort by email".
      primary = { email: { sort: direction, nulls: "last" } };
      break;
    case "createdAt":
      primary = { createdAt: direction };
      break;
    case "name":
      primary = { name: direction };
      break;
  }

  // A stable tiebreak. Without one, two customers with the same name — or the
  // same order count, which is far more likely — come back in whatever order
  // Postgres feels like, and a row can appear on two pages or on neither.
  return params.sort === "name" ? [primary, { id: "asc" }] : [primary, { name: "asc" }, { id: "asc" }];
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Lifetime value for a set of customers, in one query.
 *
 * Called with the ids on the page rather than the whole table, which is what
 * keeps this affordable: the list pages in Postgres, and this aggregates over
 * the ten or twenty rows that came back. It is the reason lifetime value is not
 * a sort key — sorting by it would mean aggregating the entire customer base on
 * every page load, for every filter combination, in raw SQL.
 */
async function revenueByCustomer(
  customerIds: string[],
): Promise<Map<string, MoneyByCurrency>> {
  if (customerIds.length === 0) return new Map();

  const rows = await prisma.order.groupBy({
    by: ["customerId", "currency"],
    where: {
      customerId: { in: customerIds },
      status: { in: [...REVENUE] },
    },
    _sum: { total: true },
  });

  /*
   * One entry per customer, each holding a total per currency. Postgres has
   * already grouped by (customer, currency), so a customer who has ordered in
   * both dollars and euros comes back with two figures and no attempt is made
   * to reconcile them.
   */
  const byCustomer = new Map<
    string,
    { currency: Currency | null; amount: string }[]
  >();

  for (const row of rows) {
    const list = byCustomer.get(row.customerId) ?? [];
    list.push({
      currency: row.currency,
      amount: row._sum.total?.toString() ?? "0",
    });
    byCustomer.set(row.customerId, list);
  }

  return new Map(
    [...byCustomer].map(([id, list]) => [id, groupTotals(list)] as const),
  );
}

export async function listCustomers(
  params: CustomerListParams,
): Promise<Result<CustomerListPage>> {
  try {
    const where = buildWhere(params);

    const [total, rows] = await Promise.all([
      prisma.customer.count({ where }),
      prisma.customer.findMany({
        where,
        orderBy: buildOrderBy(params),
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
          address: true,
          status: true,
          createdAt: true,
          _count: { select: { orders: true } },
        },
      }),
    ]);

    const revenue = await revenueByCustomer(rows.map((row) => row.id));

    return {
      ok: true,
      data: {
        items: rows.map((row) => ({
          id: row.id,
          name: row.name,
          email: row.email,
          phone: row.phone,
          address: row.address,
          status: row.status,
          createdAt: row.createdAt,
          orderCount: row._count.orders,
          lifetimeValueByCurrency: revenue.get(row.id) ?? NO_MONEY,
        })),
        total,
        page: params.page,
        pageSize: params.pageSize,
        pageCount: Math.max(1, Math.ceil(total / params.pageSize)),
      },
    };
  } catch (error) {
    return { ok: false, error: toSafeError(error, "listCustomers") };
  }
}

interface CustomerStatsRow {
  total: number;
  active: number;
  archived: number;
  with_orders: number;
}

/**
 * Revenue split by the currency the order was raised in.
 *
 * A second query rather than another subselect in the one above, because the
 * counts produce exactly one row and this produces one row per currency. There
 * is no exchange rate anywhere in this application, so the two cannot be
 * flattened back into a single figure.
 */
interface CustomerRevenueRow {
  currency: Currency | null;
  lifetime_value: string;
}

/**
 * The figures above the list.
 *
 * Across every customer, not the filtered set — the tiles describe the customer
 * base, and a number that moved every time someone typed in the search box
 * would be describing the search instead.
 */
export async function loadCustomerStats(): Promise<Result<CustomerStats>> {
  try {
    const [rows, revenue] = await Promise.all([
      prisma.$queryRaw<CustomerStatsRow[]>`
        SELECT
          COUNT(*)::int                                        AS total,
          COUNT(*) FILTER (WHERE c.status = 'ACTIVE')::int     AS active,
          COUNT(*) FILTER (WHERE c.status = 'INACTIVE')::int   AS archived,
          COUNT(*) FILTER (
            WHERE EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id)
          )::int                                               AS with_orders
        FROM customers c
      `,
      prisma.$queryRaw<CustomerRevenueRow[]>`
        SELECT
          o.currency                AS currency,
          SUM(o.total)::text        AS lifetime_value
        FROM orders o
        WHERE o.status IN ('CONFIRMED', 'COMPLETED')
        GROUP BY o.currency
      `,
    ]);

    const totals = rows[0] ?? {
      total: 0,
      active: 0,
      archived: 0,
      with_orders: 0,
    };

    return {
      ok: true,
      data: {
        total: totals.total,
        active: totals.active,
        archived: totals.archived,
        withOrders: totals.with_orders,
        lifetimeValueByCurrency: groupTotals(
          revenue.map((row) => ({
            currency: row.currency,
            amount: row.lifetime_value,
          })),
        ),
      },
    };
  } catch (error) {
    return { ok: false, error: toSafeError(error, "loadCustomerStats") };
  }
}

const NO_ORDERS: Record<OrderStatus, number> = {
  DRAFT: 0,
  PENDING: 0,
  CONFIRMED: 0,
  COMPLETED: 0,
  CANCELLED: 0,
};

/** Everything the detail page shows, in one round trip. */
export async function getCustomerDetail(
  id: string,
): Promise<Result<CustomerDetail | null>> {
  try {
    const customer = await prisma.customer.findUnique({ where: { id } });

    // Null rather than an error: the page turns this into a 404, which is what
    // a link to a deleted customer should produce.
    if (!customer) return { ok: true, data: null };

    const [byStatus, orders, orderCount] = await Promise.all([
      prisma.order.groupBy({
        by: ["status", "currency"],
        where: { customerId: id },
        _count: { _all: true },
        _sum: { total: true },
      }),
      prisma.order.findMany({
        where: { customerId: id },
        orderBy: { createdAt: "desc" },
        take: ORDER_HISTORY_LIMIT,
        select: {
          id: true,
          orderNumber: true,
          status: true,
          total: true,
          currency: true,
          createdAt: true,
          items: { select: { id: true } },
        },
      }),
      prisma.order.count({ where: { customerId: id } }),
    ]);

    /*
     * Grouped by (status, currency) rather than by status alone. The counts
     * still add up across the whole customer — a count of orders is a count
     * whatever they were priced in — but the two money figures accumulate one
     * bucket per currency and are never added together.
     */
    const statusCounts = { ...NO_ORDERS };
    const lifetime: { currency: Currency | null; amount: string }[] = [];
    const open: { currency: Currency | null; amount: string }[] = [];

    for (const group of byStatus) {
      statusCounts[group.status] += group._count._all;

      const entry = {
        currency: group.currency,
        amount: group._sum.total?.toString() ?? "0",
      };

      if ((REVENUE as readonly string[]).includes(group.status)) {
        lifetime.push(entry);
      } else if (
        (UNCOMMITTED_ORDER_STATUSES as readonly string[]).includes(group.status)
      ) {
        open.push(entry);
      }
    }

    return {
      ok: true,
      data: {
        id: customer.id,
        name: customer.name,
        email: customer.email,
        phone: customer.phone,
        address: customer.address,
        status: customer.status,
        createdAt: customer.createdAt,
        updatedAt: customer.updatedAt,

        orderCount,
        lifetimeValueByCurrency: sumByCurrency(lifetime),
        openValueByCurrency: sumByCurrency(open),
        statusCounts,
        lastOrderAt: orders[0]?.createdAt ?? null,

        orders: orders.map((order) => ({
          id: order.id,
          orderNumber: order.orderNumber,
          status: order.status,
          total: order.total.toString(),
          currency: order.currency,
          itemCount: order.items.length,
          createdAt: order.createdAt,
        })),
        hasMoreOrders: orderCount > orders.length,
      },
    };
  } catch (error) {
    return { ok: false, error: toSafeError(error, "getCustomerDetail") };
  }
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * A validation failure the form can attribute to a field. Thrown rather than
 * returned so every write path fails the same way; the action wrapper turns it
 * back into `fieldErrors` for the form.
 */
function fieldError(
  code: "BAD_REQUEST" | "CONFLICT" | "NOT_FOUND",
  field: keyof CustomerFieldErrors,
  message: string,
): AppError {
  return new AppError(code, message, { field });
}

/** Prisma's unique-constraint code, matched structurally — see server/auth.ts. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "P2002"
  );
}

/** Prisma's "record required but not found" code. */
function isMissingRecord(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "P2025"
  );
}

const DUPLICATE_EMAIL = (email: string) =>
  fieldError(
    "CONFLICT",
    "email",
    `Another customer already uses ${email}. Email addresses must be unique — search for them instead of adding a second record.`,
  );

/**
 * A schema failure, shaped so the form can put the message under the input that
 * caused it. Shared by create and update so the two cannot drift — a rule that
 * holds when a customer is added has to hold when they are edited, or the edit
 * form becomes the way around it.
 */
function invalidInput(error: Parameters<typeof toCustomerFieldErrors>[0]): AppError {
  const errors = toCustomerFieldErrors(error);
  const field = Object.keys(errors)[0] as keyof CustomerFieldErrors | undefined;

  return new AppError("BAD_REQUEST", firstCustomerIssue(error), { field });
}

/**
 * Adds a customer.
 *
 * Any signed-in user, not just an ADMIN. Raising an order is ordinary work that
 * both roles do, an order requires a customer, and there is no version of this
 * application where a STAFF user can sell to somebody but not write down who
 * they are.
 *
 * Email uniqueness is enforced by the unique index rather than by looking
 * first. A check followed by an insert has a gap between them, and two people
 * adding the same buyer at once would both find nothing and both proceed; the
 * index is the only thing that can actually arbitrate.
 */
export async function createCustomer(
  input: unknown,
): Promise<{ id: string; name: string }> {
  await requireUser();

  const parsed = createCustomerSchema.safeParse(input);
  if (!parsed.success) throw invalidInput(parsed.error);

  const data = parsed.data;

  try {
    return await prisma.customer.create({
      data: {
        name: data.name,
        email: data.email,
        phone: data.phone,
        address: data.address,
      },
      select: { id: true, name: true },
    });
  } catch (error) {
    if (isUniqueViolation(error) && data.email) {
      throw DUPLICATE_EMAIL(data.email);
    }
    throw error;
  }
}

/**
 * Corrects a customer's details.
 *
 * Cannot change their status — that is not an edit, and the schema this parses
 * with has no such field. Archiving is `setCustomerStatus`, which is ADMIN
 * only, so a STAFF user posting `status` to this action changes nothing rather
 * than quietly taking a customer out of circulation.
 */
export async function updateCustomer(
  id: string,
  input: unknown,
): Promise<{ id: string; name: string }> {
  await requireUser();

  const parsed = updateCustomerSchema.safeParse(input);
  if (!parsed.success) throw invalidInput(parsed.error);

  const data = parsed.data;

  try {
    return await prisma.customer.update({
      where: { id },
      data: {
        name: data.name,
        email: data.email,
        phone: data.phone,
        address: data.address,
      },
      select: { id: true, name: true },
    });
  } catch (error) {
    if (isUniqueViolation(error) && data.email) {
      throw DUPLICATE_EMAIL(data.email);
    }
    if (isMissingRecord(error)) throw new NotFoundError("Customer");
    throw error;
  }
}

/**
 * Archives a customer, or brings them back.
 *
 * ADMIN only. Archiving takes a record out of circulation for everyone in the
 * workspace, which is the same class of decision as retiring a product, and the
 * role comment on `UserRole` is explicit that day-to-day work does not include
 * managing records this way.
 *
 * Nothing about their history changes. Their orders keep pointing at them, the
 * order pages keep displaying them, and their totals keep counting — the status
 * is read in exactly one place that matters, the picker for a *new* order.
 */
export async function setCustomerStatus(
  id: string,
  input: unknown,
): Promise<{ id: string; name: string; status: CustomerStatus }> {
  await requireRole("ADMIN");

  const parsed = customerStatusSchema.safeParse(input);

  if (!parsed.success) {
    throw new AppError("BAD_REQUEST", firstCustomerIssue(parsed.error));
  }

  try {
    return await prisma.customer.update({
      where: { id },
      data: { status: parsed.data.status },
      select: { id: true, name: true, status: true },
    });
  } catch (error) {
    if (isMissingRecord(error)) throw new NotFoundError("Customer");
    throw error;
  }
}

/**
 * Deletes a customer — but only one that has never ordered.
 *
 * The moment an order exists for them, this record is part of that document's
 * meaning: the order says who it was for, and a deleted customer would make it
 * say nothing. `orders.customer_id` is Restrict, so the database would refuse
 * anyway; checking here turns a constraint violation nobody can read into a
 * sentence that says what to do instead.
 *
 * A customer who has never ordered is a different thing: a typo, a duplicate, a
 * contact added by mistake. There is no history to protect, so they go.
 */
export async function deleteCustomer(
  id: string,
): Promise<{ id: string; name: string }> {
  await requireRole("ADMIN");

  return prisma.$transaction(async (tx) => {
    const customer = await tx.customer.findUnique({
      where: { id },
      select: { id: true, name: true },
    });

    if (!customer) throw new NotFoundError("Customer");

    const orders = await tx.order.count({ where: { customerId: id } });

    if (orders > 0) {
      throw new AppError(
        "CONFLICT",
        `"${customer.name}" has ${orders} order${orders === 1 ? "" : "s"} on record, so they cannot be deleted — those orders have to keep saying who they were for. Archive them instead: that takes them out of the customer picker and leaves the history intact.`,
      );
    }

    await tx.customer.delete({ where: { id } });

    return customer;
  });
}
