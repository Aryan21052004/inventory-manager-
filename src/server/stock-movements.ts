import "server-only";

import type { Prisma } from "@/generated/prisma/client";
import type {
  StockReferenceType,
  StockTransactionType,
} from "@/generated/prisma/enums";
import { toSafeError, type SafeError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import type {
  MovementListParams,
  MovementSortKey,
} from "@/lib/stock-movement-query";

/**
 * Read-only queries over the stock ledger.
 *
 * This module does not write anything. Stock is still written exclusively
 * through the engine in src/server/stock.ts, which orders, purchases and manual
 * adjustments all call. This module reads the result.
 *
 * The shapes are designed for the list page — they carry everything a table row
 * needs without a second round trip, including the signed change (positive for
 * inflows, negative for outflows) and a pre-built href for the source document.
 */

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface MovementListItem {
  id: string;
  createdAt: Date;
  type: StockTransactionType;
  /** Signed: positive for inflows, negative for outflows. */
  change: number;
  previousStock: number;
  newStock: number;
  productId: string;
  productName: string;
  productSku: string;
  referenceType: StockReferenceType;
  referenceId: string | null;
  /** Pre-built href: `/orders/xyz` or `/purchases/xyz` or null. */
  referenceHref: string | null;
  /** A human label for the reference: the order/purchase number, or null. */
  referenceLabel: string | null;
  note: string | null;
  createdByName: string | null;
}

export interface MovementListPage {
  items: MovementListItem[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

export interface MovementStats {
  total: number;
  stockIn: number;
  stockOut: number;
  adjustments: number;
  /** Net units moved across all time (inflows minus outflows). */
  netChange: number;
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: SafeError };

// ---------------------------------------------------------------------------
// Query building
// ---------------------------------------------------------------------------

const SORT_COLUMNS: Record<Exclude<MovementSortKey, "product">, string> = {
  createdAt: "createdAt",
  type: "type",
  quantity: "quantity",
  newStock: "newStock",
};

function buildWhere(
  params: MovementListParams,
): Prisma.StockTransactionWhereInput {
  const filters: Prisma.StockTransactionWhereInput[] = [];

  if (params.search) {
    filters.push({
      product: {
        OR: [
          { name: { contains: params.search, mode: "insensitive" } },
          { sku: { contains: params.search, mode: "insensitive" } },
        ],
      },
    });
  }

  if (params.productId) filters.push({ productId: params.productId });
  if (params.type) filters.push({ type: params.type });

  if (params.from) {
    filters.push({
      createdAt: { gte: new Date(`${params.from}T00:00:00.000Z`) },
    });
  }

  if (params.to) {
    const end = new Date(`${params.to}T00:00:00.000Z`);
    end.setUTCDate(end.getUTCDate() + 1);
    filters.push({ createdAt: { lt: end } });
  }

  return filters.length > 0 ? { AND: filters } : {};
}

function buildOrderBy(
  params: MovementListParams,
): Prisma.StockTransactionOrderByWithRelationInput[] {
  const direction = params.direction;

  const primary: Prisma.StockTransactionOrderByWithRelationInput =
    params.sort === "product"
      ? { product: { name: direction } }
      : { [SORT_COLUMNS[params.sort]]: direction };

  // Stable tiebreak so pagination is deterministic.
  return [primary, { id: "desc" }];
}

/**
 * The signed change a movement represents.
 *
 * STOCK_IN adds; STOCK_OUT subtracts. ADJUSTMENT and REVERSAL carry the
 * direction in the ledger row itself — read from `newStock - previousStock`.
 */
function signedChange(
  type: StockTransactionType,
  quantity: number,
  previousStock: number,
  newStock: number,
): number {
  switch (type) {
    case "STOCK_IN":
      return quantity;
    case "STOCK_OUT":
      return -quantity;
    default:
      // ADJUSTMENT and REVERSAL: the ledger is the truth.
      return newStock - previousStock;
  }
}

/** Resolves a reference to a clickable href. */
function referenceHref(
  type: StockReferenceType,
  id: string | null,
): string | null {
  if (!id) return null;

  switch (type) {
    case "ORDER":
      return `/orders/${id}`;
    case "PURCHASE":
      return `/purchases/${id}`;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Querying
// ---------------------------------------------------------------------------

export async function listMovements(
  params: MovementListParams,
): Promise<Result<MovementListPage>> {
  try {
    const where = buildWhere(params);

    const [total, rows] = await Promise.all([
      prisma.stockTransaction.count({ where }),
      prisma.stockTransaction.findMany({
        where,
        orderBy: buildOrderBy(params),
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
        select: {
          id: true,
          createdAt: true,
          type: true,
          quantity: true,
          previousStock: true,
          newStock: true,
          referenceType: true,
          referenceId: true,
          note: true,
          productId: true,
          product: { select: { name: true, sku: true } },
          createdByUser: { select: { name: true } },
        },
      }),
    ]);

    return {
      ok: true,
      data: {
        items: rows.map((row) => ({
          id: row.id,
          createdAt: row.createdAt,
          type: row.type,
          change: signedChange(
            row.type,
            row.quantity,
            row.previousStock,
            row.newStock,
          ),
          previousStock: row.previousStock,
          newStock: row.newStock,
          productId: row.productId,
          productName: row.product.name,
          productSku: row.product.sku,
          referenceType: row.referenceType,
          referenceId: row.referenceId,
          referenceHref: referenceHref(row.referenceType, row.referenceId),
          referenceLabel: referenceLabel(row.referenceType),
          note: row.note,
          createdByName: row.createdByUser?.name ?? null,
        })),
        total,
        page: params.page,
        pageSize: params.pageSize,
        pageCount: Math.max(1, Math.ceil(total / params.pageSize)),
      },
    };
  } catch (error) {
    return { ok: false, error: toSafeError(error, "listMovements") };
  }
}

function referenceLabel(type: StockReferenceType): string | null {
  switch (type) {
    case "ORDER":
      return "Order";
    case "PURCHASE":
      return "Purchase";
    case "STOCK_TRANSACTION":
      return "Transaction";
    case "MANUAL":
      return "Manual";
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

interface StatsRow {
  total: number;
  stock_in: number;
  stock_out: number;
  adjustments: number;
  net_change: number;
}

export async function loadMovementStats(): Promise<Result<MovementStats>> {
  try {
    const rows = await prisma.$queryRaw<StatsRow[]>`
      SELECT
        COUNT(*)::int                                            AS total,
        COUNT(*) FILTER (WHERE type = 'STOCK_IN')::int           AS stock_in,
        COUNT(*) FILTER (WHERE type = 'STOCK_OUT')::int          AS stock_out,
        COUNT(*) FILTER (
          WHERE type IN ('ADJUSTMENT', 'REVERSAL')
        )::int                                                   AS adjustments,
        COALESCE(SUM(new_stock - previous_stock), 0)::int        AS net_change
      FROM stock_transactions
    `;

    const totals = rows[0] ?? {
      total: 0,
      stock_in: 0,
      stock_out: 0,
      adjustments: 0,
      net_change: 0,
    };

    return {
      ok: true,
      data: {
        total: totals.total,
        stockIn: totals.stock_in,
        stockOut: totals.stock_out,
        adjustments: totals.adjustments,
        netChange: totals.net_change,
      },
    };
  } catch (error) {
    return { ok: false, error: toSafeError(error, "loadMovementStats") };
  }
}

// ---------------------------------------------------------------------------
// Filter options
// ---------------------------------------------------------------------------

/**
 * Products that have at least one stock transaction.
 *
 * For the filter dropdown — so it does not show products that have never
 * moved, which would never produce results.
 */
export async function loadMovementProducts(): Promise<
  { id: string; name: string; sku: string }[]
> {
  try {
    const rows = await prisma.$queryRaw<
      { id: string; name: string; sku: string }[]
    >`
      SELECT DISTINCT p.id, p.name, p.sku
      FROM products p
      INNER JOIN stock_transactions st ON st.product_id = p.id
      ORDER BY p.name
    `;

    return rows;
  } catch (error) {
    toSafeError(error, "loadMovementProducts");
    return [];
  }
}
