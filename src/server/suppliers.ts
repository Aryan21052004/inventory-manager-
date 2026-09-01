import "server-only";

import type { Prisma } from "@/generated/prisma/client";
import type { PurchaseStatus, SupplierStatus } from "@/generated/prisma/enums";
import { AppError, NotFoundError, toSafeError, type SafeError } from "@/lib/errors";
import { SPEND_STATUSES } from "@/lib/money-basis";
import { prisma } from "@/lib/prisma";
import type { SupplierListParams, SupplierSortKey } from "@/lib/supplier-query";
import {
  createSupplierSchema,
  firstSupplierIssue,
  supplierStatusSchema,
  toSupplierFieldErrors,
  updateSupplierSchema,
  type SupplierFieldErrors,
} from "@/lib/validation/supplier";
import { requireRole, requireUser } from "@/server/auth";

/**
 * Everything the suppliers module does to the database.
 *
 * Deliberately free of any `next/*` import, like every other server module: the
 * actions in src/app/(app)/suppliers/actions.ts are thin wrappers, so the rules
 * that matter — who may write, what a duplicate email does, what makes a
 * supplier undeletable — are testable directly without faking a request.
 *
 * This module is also the single source of supplier options for the rest of the
 * application. Products and purchases used to each keep their own loader with a
 * different `select` and no notion of status; both now call
 * `loadSupplierOptions` here. One archiving rule, in one place.
 *
 * The rule that shapes the writes: **archiving is the normal end of a supplier
 * relationship, deletion is for a record created by mistake.** A supplier with
 * any purchase cannot be deleted at all — `Purchase.supplierId` is `Restrict`,
 * and that constraint is the last link in the `StockLot → Purchase → Supplier`
 * chain the costing layer depends on. A supplier with products could
 * technically be deleted, because that foreign key is `SetNull`, and it is
 * refused here precisely because it *would* succeed: it would blank the
 * sourcing on every catalogue row they supplied, with no ledger to explain it
 * afterwards.
 *
 * Nothing in this file writes a stock lot, a quantity, or a cost. Archiving a
 * supplier is a column update on one row.
 */

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface SupplierListItem {
  id: string;
  name: string;
  contactPerson: string | null;
  email: string | null;
  phone: string | null;
  /** Carried so the edit dialog can prefill without a second round trip. */
  address: string | null;
  accountNumber: string | null;
  typicalLeadTimeDays: number | null;
  status: SupplierStatus;
  createdAt: Date;
  /** Catalogue items currently sourced from them. */
  productCount: number;
  /** Every purchase ever raised with them, whatever became of it. */
  purchaseCount: number;
  /** Sum of their RECEIVED purchase totals — money actually spent. */
  totalPurchased: string;
}

export interface SupplierListPage {
  items: SupplierListItem[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

export interface SupplierStats {
  total: number;
  active: number;
  archived: number;
  /** How many have ever been bought from — the rest are contacts, not vendors yet. */
  withPurchases: number;
  /** Procurement spend across every supplier, on the same RECEIVED basis. */
  totalPurchased: string;
}

export interface SupplierPurchaseLine {
  id: string;
  purchaseNumber: string;
  status: PurchaseStatus;
  total: string;
  itemCount: number;
  purchaseDate: Date;
  receivedAt: Date | null;
}

export interface SupplierProductLine {
  id: string;
  name: string;
  sku: string;
  category: string;
  stockQuantity: number;
  status: string;
}

/**
 * Stock still on the shelf that came from this supplier, and what it cost.
 *
 * Derived from the lots the costing layer already writes — no second inventory
 * calculation. A lot records the purchase that brought it in, and a purchase
 * records its supplier, so this is that chain read backwards.
 */
export interface SupplierStockOnHand {
  /** Units remaining across every lot traceable to this supplier. */
  units: number;
  /** Value of the units whose acquisition cost is known. */
  value: string;
  /** Units the value above covers. */
  costedUnits: number;
  /** Units with no established cost — excluded from the value, never guessed. */
  uncostedUnits: number;
  /** Distinct products represented. */
  productCount: number;
}

export interface SupplierDetail {
  id: string;
  name: string;
  contactPerson: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  accountNumber: string | null;
  typicalLeadTimeDays: number | null;
  status: SupplierStatus;
  createdAt: Date;
  updatedAt: Date;

  purchaseCount: number;
  receivedCount: number;
  totalPurchased: string;
  firstPurchaseAt: Date | null;
  lastPurchaseAt: Date | null;

  purchases: SupplierPurchaseLine[];
  hasMorePurchases: boolean;
  products: SupplierProductLine[];
  hasMoreProducts: boolean;
  stockOnHand: SupplierStockOnHand;

  /**
   * Whether a hard delete is possible: no purchases and no products. See the
   * note at the top of this file, and `deleteSupplier`.
   */
  deletable: boolean;
  productCount: number;
}

/** A supplier as a picker presents it. */
export interface SupplierOption {
  id: string;
  name: string;
  email: string | null;
  /**
   * Almost always ACTIVE — the pickers ask for active suppliers. It can be
   * INACTIVE for exactly one entry: the supplier already on the document or
   * product being edited, kept in the list so an existing record stays
   * saveable. See `loadSupplierOptions`.
   */
  status: SupplierStatus;
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: SafeError };

/**
 * A supplier that has traded is somebody with a lot of purchases, and the
 * detail page is a summary rather than an archive. The full list is one click
 * away behind the purchases filter, which pages properly.
 */
const PURCHASE_HISTORY_LIMIT = 25;
const PRODUCT_LIST_LIMIT = 50;

/*
 * Only received purchases count as money actually spent. A draft is a plan, and
 * a cancelled purchase is one that did not happen.
 *
 * Defined in src/lib/money-basis.ts rather than here: the dashboard needs the
 * same rule, and a private copy in this module was already the second place
 * that answer lived.
 */

// ---------------------------------------------------------------------------
// Query building
// ---------------------------------------------------------------------------

function buildWhere(params: SupplierListParams): Prisma.SupplierWhereInput {
  const filters: Prisma.SupplierWhereInput[] = [];

  if (params.search) {
    /*
     * One box, five columns. Whoever is looking for a supplier has whichever
     * detail is in front of them — the company name, the person they spoke to,
     * the address on the invoice, or the account number printed on it — and
     * should not have to tell the application which kind of thing they typed.
     */
    filters.push({
      OR: [
        { name: { contains: params.search, mode: "insensitive" } },
        { contactPerson: { contains: params.search, mode: "insensitive" } },
        { email: { contains: params.search, mode: "insensitive" } },
        { phone: { contains: params.search, mode: "insensitive" } },
        { accountNumber: { contains: params.search, mode: "insensitive" } },
      ],
    });
  }

  if (params.status) filters.push({ status: params.status });

  return filters.length > 0 ? { AND: filters } : {};
}

function buildOrderBy(
  params: SupplierListParams,
): Prisma.SupplierOrderByWithRelationInput[] {
  const direction = params.direction;

  let primary: Prisma.SupplierOrderByWithRelationInput;

  switch (params.sort) {
    case "purchases":
      // A relation count rather than a column. Postgres does the counting.
      primary = { purchases: { _count: direction } };
      break;
    case "email":
      // Nulls last in both directions: a page of suppliers who gave no email
      // address is not what anyone means by "sort by email".
      primary = { email: { sort: direction, nulls: "last" } };
      break;
    case "accountNumber":
      primary = { accountNumber: { sort: direction, nulls: "last" } };
      break;
    case "leadTime":
      // Nulls last again, and here it matters more: an unknown lead time is
      // not a fast one, and sorting ascending to find quick suppliers must not
      // surface every supplier nobody has recorded a lead time for.
      primary = { typicalLeadTimeDays: { sort: direction, nulls: "last" } };
      break;
    case "createdAt":
      primary = { createdAt: direction };
      break;
    case "name":
      primary = { name: direction };
      break;
  }

  // A stable tiebreak. Without one, two suppliers with the same purchase count
  // — far more likely than the same name — come back in whatever order Postgres
  // feels like, and a row can appear on two pages or on neither.
  return params.sort === "name"
    ? [primary, { id: "asc" }]
    : [primary, { name: "asc" }, { id: "asc" }];
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Procurement spend for a set of suppliers, in one query.
 *
 * Called with the ids on the page rather than the whole table, which is what
 * keeps it affordable: the list pages in Postgres, and this aggregates over the
 * ten or twenty rows that came back. It is also why total purchased is not a
 * sort key — sorting by it would mean aggregating every purchase in the system
 * on every page load, for every filter combination, in raw SQL.
 */
async function spendBySupplier(
  supplierIds: string[],
): Promise<Map<string, string>> {
  if (supplierIds.length === 0) return new Map();

  const rows = await prisma.purchase.groupBy({
    by: ["supplierId"],
    where: {
      supplierId: { in: supplierIds },
      status: { in: [...SPEND_STATUSES] },
    },
    _sum: { total: true },
  });

  return new Map(
    rows.map((row) => [row.supplierId, row._sum.total?.toString() ?? "0"]),
  );
}

export async function listSuppliers(
  params: SupplierListParams,
): Promise<Result<SupplierListPage>> {
  try {
    const where = buildWhere(params);

    const [total, rows] = await Promise.all([
      prisma.supplier.count({ where }),
      prisma.supplier.findMany({
        where,
        orderBy: buildOrderBy(params),
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
        select: {
          id: true,
          name: true,
          contactPerson: true,
          email: true,
          phone: true,
          address: true,
          accountNumber: true,
          typicalLeadTimeDays: true,
          status: true,
          createdAt: true,
          _count: { select: { products: true, purchases: true } },
        },
      }),
    ]);

    const spend = await spendBySupplier(rows.map((row) => row.id));

    return {
      ok: true,
      data: {
        items: rows.map((row) => ({
          id: row.id,
          name: row.name,
          contactPerson: row.contactPerson,
          email: row.email,
          phone: row.phone,
          address: row.address,
          accountNumber: row.accountNumber,
          typicalLeadTimeDays: row.typicalLeadTimeDays,
          status: row.status,
          createdAt: row.createdAt,
          productCount: row._count.products,
          purchaseCount: row._count.purchases,
          totalPurchased: spend.get(row.id) ?? "0",
        })),
        total,
        page: params.page,
        pageSize: params.pageSize,
        pageCount: Math.max(1, Math.ceil(total / params.pageSize)),
      },
    };
  } catch (error) {
    return { ok: false, error: toSafeError(error, "listSuppliers") };
  }
}

interface SupplierStatsRow {
  total: number;
  active: number;
  archived: number;
  with_purchases: number;
}

export async function loadSupplierStats(): Promise<Result<SupplierStats>> {
  try {
    const [rows, spend] = await Promise.all([
      /*
       * One pass over suppliers for the four counts. `with_purchases` is an
       * EXISTS rather than a join so a supplier with fifty purchases still
       * counts once, which a naive join would get wrong.
       */
      prisma.$queryRaw<SupplierStatsRow[]>`
        SELECT
          COUNT(*)::int                                          AS total,
          COUNT(*) FILTER (WHERE status = 'ACTIVE')::int         AS active,
          COUNT(*) FILTER (WHERE status = 'INACTIVE')::int       AS archived,
          COUNT(*) FILTER (
            WHERE EXISTS (
              SELECT 1 FROM purchases p WHERE p.supplier_id = suppliers.id
            )
          )::int                                                 AS with_purchases
        FROM suppliers
      `,
      prisma.purchase.aggregate({
        where: { status: { in: [...SPEND_STATUSES] } },
        _sum: { total: true },
      }),
    ]);

    const totals = rows[0] ?? {
      total: 0,
      active: 0,
      archived: 0,
      with_purchases: 0,
    };

    return {
      ok: true,
      data: {
        total: totals.total,
        active: totals.active,
        archived: totals.archived,
        withPurchases: totals.with_purchases,
        totalPurchased: spend._sum.total?.toString() ?? "0",
      },
    };
  } catch (error) {
    return { ok: false, error: toSafeError(error, "loadSupplierStats") };
  }
}

/**
 * Stock still held that came from one supplier, read out of the existing lots.
 *
 * This is a *read* of the costing layer, not a second one. `StockLot` already
 * records what each batch cost and how much of it is left; `sourceId` already
 * records the purchase that brought it in. All this does is follow that pointer
 * back to the supplier and total what it finds.
 *
 * `sourceId` is polymorphic rather than a foreign key — the same arrangement
 * the stock ledger uses — so the join is written explicitly against
 * `source_type = 'PURCHASE'`. Costed and uncosted units are counted separately
 * and never mixed: stock whose acquisition cost was never established is
 * excluded from the value and reported as a count, exactly as it is everywhere
 * else in the application.
 */
interface StockOnHandRow {
  units: number;
  costed_units: number;
  uncosted_units: number;
  value: string;
  product_count: number;
}

async function loadStockOnHand(
  supplierId: string,
): Promise<SupplierStockOnHand> {
  const rows = await prisma.$queryRaw<StockOnHandRow[]>`
    SELECT
      COALESCE(SUM(l.quantity_remaining), 0)::int                   AS units,
      COALESCE(SUM(l.quantity_remaining)
        FILTER (WHERE l.unit_cost IS NOT NULL), 0)::int             AS costed_units,
      COALESCE(SUM(l.quantity_remaining)
        FILTER (WHERE l.unit_cost IS NULL), 0)::int                 AS uncosted_units,
      COALESCE(SUM(l.quantity_remaining * l.unit_cost)
        FILTER (WHERE l.unit_cost IS NOT NULL), 0)::text            AS value,
      COUNT(DISTINCT l.product_id)::int                             AS product_count
    FROM stock_lots l
    JOIN purchases p
      ON p.id = l.source_id
     AND l.source_type = 'PURCHASE'
    WHERE p.supplier_id = ${supplierId}
      AND l.quantity_remaining > 0
  `;

  const row = rows[0] ?? {
    units: 0,
    costed_units: 0,
    uncosted_units: 0,
    value: "0",
    product_count: 0,
  };

  return {
    units: row.units,
    value: row.value,
    costedUnits: row.costed_units,
    uncostedUnits: row.uncosted_units,
    productCount: row.product_count,
  };
}

export async function getSupplierDetail(
  id: string,
): Promise<Result<SupplierDetail | null>> {
  try {
    const supplier = await prisma.supplier.findUnique({ where: { id } });

    if (!supplier) return { ok: true, data: null };

    const [
      aggregate,
      received,
      bounds,
      purchases,
      purchaseCount,
      products,
      productCount,
      stockOnHand,
    ] = await Promise.all([
      prisma.purchase.aggregate({
        where: { supplierId: id },
        _count: { _all: true },
      }),
      prisma.purchase.aggregate({
        where: { supplierId: id, status: { in: [...SPEND_STATUSES] } },
        _count: { _all: true },
        _sum: { total: true },
      }),
      prisma.purchase.aggregate({
        where: { supplierId: id },
        _min: { purchaseDate: true },
        _max: { purchaseDate: true },
      }),
      prisma.purchase.findMany({
        where: { supplierId: id },
        orderBy: [{ purchaseDate: "desc" }, { id: "desc" }],
        take: PURCHASE_HISTORY_LIMIT,
        select: {
          id: true,
          purchaseNumber: true,
          status: true,
          total: true,
          purchaseDate: true,
          receivedAt: true,
          _count: { select: { items: true } },
        },
      }),
      prisma.purchase.count({ where: { supplierId: id } }),
      prisma.product.findMany({
        where: { supplierId: id },
        orderBy: [{ name: "asc" }, { id: "asc" }],
        take: PRODUCT_LIST_LIMIT,
        select: {
          id: true,
          name: true,
          sku: true,
          category: true,
          stockQuantity: true,
          status: true,
        },
      }),
      prisma.product.count({ where: { supplierId: id } }),
      loadStockOnHand(id),
    ]);

    return {
      ok: true,
      data: {
        id: supplier.id,
        name: supplier.name,
        contactPerson: supplier.contactPerson,
        email: supplier.email,
        phone: supplier.phone,
        address: supplier.address,
        accountNumber: supplier.accountNumber,
        typicalLeadTimeDays: supplier.typicalLeadTimeDays,
        status: supplier.status,
        createdAt: supplier.createdAt,
        updatedAt: supplier.updatedAt,

        purchaseCount: aggregate._count._all,
        receivedCount: received._count._all,
        totalPurchased: received._sum.total?.toString() ?? "0",
        firstPurchaseAt: bounds._min.purchaseDate,
        lastPurchaseAt: bounds._max.purchaseDate,

        purchases: purchases.map((row) => ({
          id: row.id,
          purchaseNumber: row.purchaseNumber,
          status: row.status,
          total: row.total.toString(),
          itemCount: row._count.items,
          purchaseDate: row.purchaseDate,
          receivedAt: row.receivedAt,
        })),
        hasMorePurchases: purchaseCount > purchases.length,
        products: products.map((row) => ({
          id: row.id,
          name: row.name,
          sku: row.sku,
          category: row.category,
          stockQuantity: row.stockQuantity,
          status: row.status,
        })),
        hasMoreProducts: productCount > products.length,
        stockOnHand,

        // Both must be zero. See `deleteSupplier`.
        deletable: purchaseCount === 0 && productCount === 0,
        productCount,
      },
    };
  } catch (error) {
    return { ok: false, error: toSafeError(error, "getSupplierDetail") };
  }
}

/**
 * Suppliers a picker may offer.
 *
 * ACTIVE only, plus one exception that matters: `includeId` keeps a named
 * supplier in the list whatever their status. Without it, archiving a supplier
 * would strand every document and product already pointing at them — open a
 * draft purchase raised against an archived supplier and the select would find
 * no matching option, silently blanking a field the save then rejects.
 * Archiving is meant to stop *new* business, not to make existing records
 * unsaveable.
 *
 * The same loader serves the purchase builder and the product form, which is
 * the point: there is one rule about which suppliers may be chosen, and it does
 * not depend on which screen is asking.
 */
export async function loadSupplierOptions(
  includeId?: string | readonly string[] | null,
): Promise<SupplierOption[]> {
  try {
    const kept = (
      typeof includeId === "string" ? [includeId] : (includeId ?? [])
    ).filter(Boolean);

    return await prisma.supplier.findMany({
      where:
        kept.length > 0
          ? { OR: [{ status: "ACTIVE" }, { id: { in: [...kept] } }] }
          : { status: "ACTIVE" },
      orderBy: { name: "asc" },
      select: { id: true, name: true, email: true, status: true },
    });
  } catch (error) {
    toSafeError(error, "loadSupplierOptions");
    return [];
  }
}

/**
 * Every supplier, for a filter dropdown.
 *
 * Distinct from `loadSupplierOptions` on purpose, and the difference is not a
 * detail. A picker asks "who may we place new business with", so it excludes
 * archived suppliers. A filter asks "whose records am I looking for", and
 * excluding archived suppliers there would make their history unreachable —
 * the moment somebody archives a vendor, every purchase ever placed with them
 * would drop out of the only control that could find it.
 *
 * Status travels with each row so the filter can label archived entries rather
 * than presenting them as though they were still in circulation.
 */
export async function loadSupplierFilterOptions(): Promise<SupplierOption[]> {
  try {
    return await prisma.supplier.findMany({
      orderBy: { name: "asc" },
      select: { id: true, name: true, email: true, status: true },
    });
  } catch (error) {
    toSafeError(error, "loadSupplierFilterOptions");
    return [];
  }
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

function badRequest(
  field: keyof SupplierFieldErrors,
  message: string,
): AppError {
  return new AppError("BAD_REQUEST", message, { field });
}

const DUPLICATE_EMAIL = (email: string) =>
  new AppError(
    "CONFLICT",
    `Another supplier already uses ${email}. Emails have to be unique so the same vendor cannot end up on two records.`,
    { field: "email" satisfies keyof SupplierFieldErrors },
  );

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "P2002"
  );
}

function isMissingRecord(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "P2025"
  );
}

function parseOrThrow<T>(
  schema: { safeParse: (input: unknown) => { success: boolean; data?: T; error?: unknown } },
  input: unknown,
): T {
  const parsed = schema.safeParse(input);

  if (!parsed.success) {
    const error = parsed.error as Parameters<typeof toSupplierFieldErrors>[0];
    const errors = toSupplierFieldErrors(error);
    const field = Object.keys(errors)[0] as
      | keyof SupplierFieldErrors
      | undefined;

    throw new AppError("BAD_REQUEST", firstSupplierIssue(error), { field });
  }

  return parsed.data as T;
}

/**
 * Adds a supplier.
 *
 * Any signed-in user may. Adding a vendor to the directory is ordinary work,
 * and the operations that take one *out* of circulation are the ones reserved
 * for an administrator.
 *
 * Email uniqueness is left to the unique index rather than checked first. A
 * check followed by an insert has a gap between them, and two people adding the
 * same supplier at once would both find nothing and both proceed; the index is
 * the only thing that can actually arbitrate.
 */
export async function createSupplier(
  input: unknown,
): Promise<{ id: string; name: string }> {
  await requireUser();

  const data = parseOrThrow(createSupplierSchema, input);

  try {
    return await prisma.supplier.create({
      data: {
        name: data.name,
        contactPerson: data.contactPerson,
        email: data.email,
        phone: data.phone,
        address: data.address,
        accountNumber: data.accountNumber,
        typicalLeadTimeDays: data.typicalLeadTimeDays,
        // Not an input. A supplier is created in circulation; taking them out
        // of it is a separate, ADMIN-only operation with its own control.
        status: "ACTIVE",
      },
      select: { id: true, name: true },
    });
  } catch (error) {
    if (isUniqueViolation(error) && data.email) throw DUPLICATE_EMAIL(data.email);
    throw error;
  }
}

/**
 * Edits a supplier's details.
 *
 * `status` is not in the update schema and is not written here. Editing a
 * supplier is a directory operation; archiving one takes them out of both
 * pickers and is restricted to ADMIN, so routing it through here would be a
 * second, unguarded way to do it.
 */
export async function updateSupplier(
  id: string,
  input: unknown,
): Promise<{ id: string; name: string }> {
  await requireUser();

  const data = parseOrThrow(updateSupplierSchema, input);

  try {
    return await prisma.supplier.update({
      where: { id },
      data: {
        name: data.name,
        contactPerson: data.contactPerson,
        email: data.email,
        phone: data.phone,
        address: data.address,
        accountNumber: data.accountNumber,
        typicalLeadTimeDays: data.typicalLeadTimeDays,
      },
      select: { id: true, name: true },
    });
  } catch (error) {
    if (isUniqueViolation(error) && data.email) throw DUPLICATE_EMAIL(data.email);
    if (isMissingRecord(error)) throw new NotFoundError("Supplier");
    throw error;
  }
}

/**
 * Archives a supplier, or puts them back into circulation.
 *
 * ADMIN only, and for the same reason the equivalent customer operation is:
 * this is the control that decides whether new business can be placed with
 * somebody, and it is read in the two places that matter — the purchase
 * builder's supplier picker and the product form's.
 *
 * What it does *not* do is worth stating, because the costing layer depends on
 * it: archiving writes one column on one row. It does not touch a purchase, a
 * stock lot, a quantity, or an acquisition cost. Every unit on the shelf that
 * came from this supplier still knows what it cost and which delivery it
 * arrived on, and the `StockLot → Purchase → Supplier` chain still resolves.
 */
export async function setSupplierStatus(
  id: string,
  input: unknown,
): Promise<{ id: string; name: string; status: SupplierStatus }> {
  await requireRole("ADMIN");

  const parsed = supplierStatusSchema.safeParse(input);

  if (!parsed.success) {
    throw badRequest("name", "That is not a supplier status.");
  }

  try {
    return await prisma.supplier.update({
      where: { id },
      data: { status: parsed.data.status },
      select: { id: true, name: true, status: true },
    });
  } catch (error) {
    if (isMissingRecord(error)) throw new NotFoundError("Supplier");
    throw error;
  }
}

/**
 * Deletes a supplier — but only one that nothing references.
 *
 * Both counts have to be zero, and the two conditions are refused for different
 * reasons.
 *
 * A supplier with **purchases** cannot be deleted because those documents have
 * to keep saying who supplied the goods. `Purchase.supplierId` is `Restrict`,
 * so Postgres would refuse this anyway — the check exists to say so in a
 * sentence somebody can act on, rather than surfacing a foreign key violation.
 * It is also the last link in the provenance chain: a stock lot points at the
 * purchase that brought it in, and that purchase points here.
 *
 * A supplier with **products** is the case worth being careful about, because
 * the database would *not* stop it. `Product.supplierId` is `SetNull`, so the
 * delete would succeed and silently blank the sourcing on every catalogue row
 * they supplied — an unaudited edit to the catalogue with nothing to explain it
 * afterwards. That foreign key stays as it is, as defence in depth against a
 * raw SQL delete; this check is what makes the application refuse first.
 *
 * Counting and deleting happen in one transaction, so a purchase raised
 * between the check and the delete cannot slip through.
 */
export async function deleteSupplier(
  id: string,
): Promise<{ id: string; name: string }> {
  await requireRole("ADMIN");

  return prisma.$transaction(async (tx) => {
    const supplier = await tx.supplier.findUnique({
      where: { id },
      select: { id: true, name: true },
    });

    if (!supplier) throw new NotFoundError("Supplier");

    const [purchases, products] = await Promise.all([
      tx.purchase.count({ where: { supplierId: id } }),
      tx.product.count({ where: { supplierId: id } }),
    ]);

    if (purchases > 0) {
      throw new AppError(
        "CONFLICT",
        `"${supplier.name}" has ${purchases} purchase${purchases === 1 ? "" : "s"} on record, so they cannot be deleted — those documents have to keep saying who the goods came from, and the stock they delivered is costed against them. Archive them instead: that takes them out of the supplier pickers and leaves the history intact.`,
      );
    }

    if (products > 0) {
      throw new AppError(
        "CONFLICT",
        `${products} product${products === 1 ? " is" : "s are"} sourced from "${supplier.name}", so they cannot be deleted — doing so would quietly clear the supplier from ${products === 1 ? "that catalogue item" : "those catalogue items"} with nothing to explain it. Reassign ${products === 1 ? "it" : "them"} to another supplier first, or archive this one instead.`,
      );
    }

    await tx.supplier.delete({ where: { id } });

    return supplier;
  });
}

export type { SupplierSortKey };
