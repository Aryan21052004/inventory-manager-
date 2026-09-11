import "server-only";

import type { Prisma } from "@/generated/prisma/client";
import type {
  StockReferenceType,
  StockTransactionType,
} from "@/generated/prisma/enums";
import type { Currency } from "@/lib/currency";
import { toSafeError, type SafeError } from "@/lib/errors";
import { sumByCurrency, type MoneyByCurrency } from "@/lib/money-by-currency";
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

  /**
   * What this movement cost, per currency the batches were bought in.
   *
   * Inflows carry the price the batch was booked in at; outflows carry what
   * they drew from the batches they consumed. **One entry per currency**,
   * because FIFO takes the oldest batches and does not reorder to chase a
   * tidier answer — so a single sale can legitimately draw from a batch bought
   * in dollars and one bought in rupees. There is no exchange rate in this
   * application, so those two are reported side by side rather than added.
   *
   * Empty means the movement touched stock whose acquisition cost was never
   * established — not zero, and not a figure inferred from the catalogue. An
   * entry with a null currency is different again: the amount is real, but
   * what it is denominated in was never recorded.
   */
  costTotalByCurrency: MoneyByCurrency;
  /**
   * How many of `change` the cost covers. A movement can be partly costed when
   * FIFO draws across both costed and uncosted batches, and the coverage has to
   * travel with the money or the number reads as complete when it is not.
   */
  costedQuantity: number;
  /** The batches this movement created or drew from. */
  lots: MovementLot[];
}

/** One batch touched by a movement. */
export interface MovementLot {
  lotId: string;
  quantity: number;
  unitCost: string | null;
  /** The purchase the batch arrived on, when there was one. */
  purchaseNumber: string | null;
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
          /*
           * The valuation side of the movement. An inflow owns exactly one lot
           * (`originatedLot`); an outflow points at every batch it drew from.
           * Both are selected here rather than fetched per row — a ledger page
           * is fifty rows, and fifty round trips to decorate them would be a
           * poor trade for a column.
           */
          originatedLot: {
            select: {
              id: true,
              unitCost: true,
              costCurrency: true,
              quantityReceived: true,
              sourceType: true,
              sourceId: true,
            },
          },
          lotConsumptions: {
            select: {
              lotId: true,
              quantity: true,
              unitCost: true,
              costCurrency: true,
              lot: { select: { sourceType: true, sourceId: true } },
            },
          },
        },
      }),
    ]);

    /*
     * Purchase numbers for every batch on the page, in one query. The lot
     * carries a purchase id; the table wants something a human recognises.
     */
    const purchaseIds = new Set<string>();

    for (const row of rows) {
      if (row.originatedLot?.sourceType === "PURCHASE" && row.originatedLot.sourceId) {
        purchaseIds.add(row.originatedLot.sourceId);
      }
      for (const consumption of row.lotConsumptions) {
        if (consumption.lot.sourceType === "PURCHASE" && consumption.lot.sourceId) {
          purchaseIds.add(consumption.lot.sourceId);
        }
      }
    }

    const purchaseNumbers = new Map<string, string>();

    if (purchaseIds.size > 0) {
      const purchases = await prisma.purchase.findMany({
        where: { id: { in: [...purchaseIds] } },
        select: { id: true, purchaseNumber: true },
      });
      for (const purchase of purchases) {
        purchaseNumbers.set(purchase.id, purchase.purchaseNumber);
      }
    }

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
          ...movementCost(row, purchaseNumbers),
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

/**
 * The cost of one movement, and what it covers.
 *
 * An inflow is costed by the batch it created; an outflow by the batches it
 * consumed, summed. Integer cents throughout, for the same reason the rest of
 * the system uses them — adding a column of floats loses money.
 *
 * A movement that drew across both costed and uncosted batches comes back
 * partly covered rather than fully costed at whatever happened to be known, so
 * the table can say "3 of 8 units costed" instead of quietly implying eight.
 */
function movementCost(
  row: {
    quantity: number;
    originatedLot: {
      id: string;
      unitCost: Prisma.Decimal | null;
      costCurrency: Currency | null;
      quantityReceived: number;
      sourceType: StockReferenceType;
      sourceId: string | null;
    } | null;
    lotConsumptions: {
      lotId: string;
      quantity: number;
      unitCost: Prisma.Decimal | null;
      costCurrency: Currency | null;
      lot: { sourceType: StockReferenceType; sourceId: string | null };
    }[];
  },
  purchaseNumbers: Map<string, string>,
): {
  costTotalByCurrency: MoneyByCurrency;
  costedQuantity: number;
  lots: MovementLot[];
} {
  const numberFor = (
    sourceType: StockReferenceType,
    sourceId: string | null,
  ) =>
    sourceType === "PURCHASE" && sourceId
      ? (purchaseNumbers.get(sourceId) ?? null)
      : null;

  if (row.originatedLot) {
    const lot = row.originatedLot;

    return {
      /*
       * One batch, so at most one currency — the one frozen onto the lot when
       * it was received, never today's installation default.
       */
      costTotalByCurrency:
        lot.unitCost === null
          ? []
          : [
              {
                currency: lot.costCurrency,
                amount: (Number(lot.unitCost) * row.quantity).toFixed(2),
              },
            ],
      costedQuantity: lot.unitCost === null ? 0 : row.quantity,
      lots: [
        {
          lotId: lot.id,
          quantity: row.quantity,
          unitCost: lot.unitCost?.toString() ?? null,
          purchaseNumber: numberFor(lot.sourceType, lot.sourceId),
        },
      ],
    };
  }

  if (row.lotConsumptions.length === 0) {
    return { costTotalByCurrency: [], costedQuantity: 0, lots: [] };
  }

  /*
   * One figure per currency, never one figure across them.
   *
   * Each layer is priced at its own frozen rate in its own frozen currency,
   * and `sumByCurrency` adds only the layers that agree. Summing the lot
   * straight into one scalar — which this did — produced a number in no
   * currency at all whenever FIFO crossed a boundary.
   */
  const layers: { currency: Currency | null; amount: string }[] = [];
  let costedQuantity = 0;

  for (const consumption of row.lotConsumptions) {
    /*
     * Unsigned, deliberately. A reversal is its own transaction carrying only
     * negative rows, so there is nothing here to net against; taking the
     * magnitude is what makes a reversal read as the value of the stock it
     * put back rather than as a negative.
     */
    const quantity = Math.abs(consumption.quantity);
    if (consumption.unitCost === null) continue;

    const cents = Math.round(Number(consumption.unitCost) * 100) * quantity;

    layers.push({
      currency: consumption.costCurrency,
      amount: (cents / 100).toFixed(2),
    });
    costedQuantity += quantity;
  }

  return {
    costTotalByCurrency: sumByCurrency(layers),
    costedQuantity,
    lots: row.lotConsumptions.map((consumption) => ({
      lotId: consumption.lotId,
      quantity: Math.abs(consumption.quantity),
      unitCost: consumption.unitCost?.toString() ?? null,
      purchaseNumber: numberFor(
        consumption.lot.sourceType,
        consumption.lot.sourceId,
      ),
    })),
  };
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
