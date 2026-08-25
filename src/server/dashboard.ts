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
  /** Stock at cost. A string, because the SQL sum is a numeric and rounding it
   *  through a float would lose cents on a large catalogue. */
  stockValue: string;
  lowStockCount: number;
  outOfStockCount: number;
  openOrderCount: number;
  pendingPurchaseCount: number;
  recentMovements: RecentMovement[];
}

export interface RecentMovement {
  id: string;
  type: string;
  quantity: number;
  quantityAfter: number;
  createdAt: Date;
  productName: string;
  productSku: string;
}

interface ProductAggregate {
  product_count: number;
  total_units: number;
  stock_value: string;
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
         * One pass over products for all five figures. `quantity <= reorder_level`
         * compares two columns, which the query builder cannot express, and
         * splitting this into separate counts would mean four table scans
         * instead of one.
         */
        prisma.$queryRaw<ProductAggregate[]>`
          SELECT
            COUNT(*)::int                                                        AS product_count,
            COALESCE(SUM(quantity), 0)::int                                      AS total_units,
            COALESCE(SUM(quantity * unit_cost), 0)::text                         AS stock_value,
            COUNT(*) FILTER (WHERE quantity <= 0)::int                           AS out_of_stock,
            COUNT(*) FILTER (WHERE quantity > 0 AND quantity <= reorder_level)::int AS low_stock
          FROM products
          WHERE is_active = true
        `,
        prisma.order.count({ where: { status: { in: ["DRAFT", "CONFIRMED"] } } }),
        prisma.purchase.count({ where: { status: { in: ["DRAFT", "ORDERED"] } } }),
        prisma.stockMovement.findMany({
          take: 5,
          orderBy: { createdAt: "desc" },
          select: {
            id: true,
            type: true,
            quantity: true,
            quantityAfter: true,
            createdAt: true,
            product: { select: { name: true, sku: true } },
          },
        }),
      ]);

    const totals = aggregate[0] ?? {
      product_count: 0,
      total_units: 0,
      stock_value: "0",
      out_of_stock: 0,
      low_stock: 0,
    };

    return {
      ok: true,
      data: {
        productCount: totals.product_count,
        totalUnits: totals.total_units,
        stockValue: totals.stock_value,
        lowStockCount: totals.low_stock,
        outOfStockCount: totals.out_of_stock,
        openOrderCount,
        pendingPurchaseCount,
        recentMovements: movements.map((movement) => ({
          id: movement.id,
          type: movement.type,
          quantity: movement.quantity,
          quantityAfter: movement.quantityAfter,
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
