import "server-only";

import { prisma } from "@/lib/prisma";
import { toSafeError, type SafeError } from "@/lib/errors";

/**
 * Read model for the dashboard.
 *
 * Server-side data access lives under `src/server/` rather than inside the page
 * components, so the queries can be reused by reports and API routes later
 * without dragging JSX along with them.
 */

export interface DashboardSnapshot {
  productCount: number;
  totalUnits: number;
  /**
   * Stock at actual acquisition cost, summed over the lots still holding units.
   *
   * A string, because the SQL sum is a numeric and rounding it through a float
   * would lose cents on a large catalogue.
   *
   * Covers only units whose cost is known — see `uncostedUnits`. The two belong
   * together on screen: this figure alone would read as the value of everything
   * on the shelf, which it is not.
   */
  stockValue: string;
  /**
   * Units on hand with no established acquisition cost. Excluded from the value
   * above rather than valued at zero or at a guess.
   */
  uncostedUnits: number;
  lowStockCount: number;
  outOfStockCount: number;
  openOrderCount: number;
  pendingPurchaseCount: number;
  recentMovements: RecentMovement[];
}

export interface RecentMovement {
  id: string;
  type: string;
  /**
   * The signed effect on stock: negative for anything that took units away.
   *
   * The column stores the size of the move and leaves the direction to `type`,
   * so a raw `quantity` renders as "+120" on an outbound movement. Deriving the
   * sign from the two balances is the one form that cannot disagree with what
   * actually happened.
   */
  change: number;
  /** Stock on hand once this movement had been applied. */
  newStock: number;
  createdAt: Date;
  productName: string;
  productSku: string;
}

interface ProductAggregate {
  product_count: number;
  total_units: number;
  stock_value: string;
  uncosted_units: number;
  out_of_stock: number;
  low_stock: number;
}

export type DashboardResult =
  | { ok: true; data: DashboardSnapshot }
  | { ok: false; error: SafeError };

/**
 * Never throws. A dashboard that cannot reach the database is a state the page
 * renders, not a crash — the caller gets a result to branch on.
 */
export async function loadDashboard(): Promise<DashboardResult> {
  try {
    const [aggregate, openOrderCount, pendingPurchaseCount, movements] =
      await Promise.all([
        /*
         * One pass over products for the counts, with two uncorrelated
         * subqueries for the lot-based valuation.
         * `stock_quantity <= minimum_stock` compares two columns, which the
         * query builder cannot express, and splitting this into separate counts
         * would mean four table scans instead of one.
         */
        prisma.$queryRaw<ProductAggregate[]>`
          SELECT
            COUNT(*)::int                                            AS product_count,
            COALESCE(SUM(stock_quantity), 0)::int                    AS total_units,
            COALESCE((
              SELECT SUM(l.quantity_remaining * l.unit_cost)
              FROM stock_lots l
              JOIN products lp ON lp.id = l.product_id AND lp.status = 'ACTIVE'
              WHERE l.quantity_remaining > 0 AND l.unit_cost IS NOT NULL
            ), 0)::text                                              AS stock_value,
            COALESCE((
              SELECT SUM(l.quantity_remaining)
              FROM stock_lots l
              JOIN products lp ON lp.id = l.product_id AND lp.status = 'ACTIVE'
              WHERE l.quantity_remaining > 0 AND l.unit_cost IS NULL
            ), 0)::int                                               AS uncosted_units,
            COUNT(*) FILTER (WHERE stock_quantity <= 0)::int         AS out_of_stock,
            COUNT(*) FILTER (
              WHERE stock_quantity > 0 AND stock_quantity <= minimum_stock
            )::int                                                   AS low_stock
          FROM products
          WHERE status = 'ACTIVE'
        `,
        // Everything not yet shipped or abandoned. PENDING belongs here too:
        // it is an order that is finished and waiting, which is exactly the
        // kind of commitment this figure is counting.
        prisma.order.count({
          where: { status: { in: ["DRAFT", "PENDING", "CONFIRMED"] } },
        }),
        // Goods not yet on the shelf: still being written, or placed with the
        // supplier and in transit.
        prisma.purchase.count({
          where: { status: { in: ["DRAFT", "PENDING"] } },
        }),
        prisma.stockTransaction.findMany({
          take: 5,
          orderBy: { createdAt: "desc" },
          select: {
            id: true,
            type: true,
            previousStock: true,
            newStock: true,
            createdAt: true,
            product: { select: { name: true, sku: true } },
          },
        }),
      ]);

    const totals = aggregate[0] ?? {
      product_count: 0,
      total_units: 0,
      stock_value: "0",
      uncosted_units: 0,
      out_of_stock: 0,
      low_stock: 0,
    };

    return {
      ok: true,
      data: {
        productCount: totals.product_count,
        totalUnits: totals.total_units,
        stockValue: totals.stock_value,
        uncostedUnits: totals.uncosted_units,
        lowStockCount: totals.low_stock,
        outOfStockCount: totals.out_of_stock,
        openOrderCount,
        pendingPurchaseCount,
        recentMovements: movements.map((movement) => ({
          id: movement.id,
          type: movement.type,
          change: movement.newStock - movement.previousStock,
          newStock: movement.newStock,
          createdAt: movement.createdAt,
          productName: movement.product.name,
          productSku: movement.product.sku,
        })),
      },
    };
  } catch (error) {
    return { ok: false, error: toSafeError(error, "loadDashboard") };
  }
}
