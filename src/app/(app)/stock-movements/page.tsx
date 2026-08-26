import { Suspense } from "react";
import type { Metadata } from "next";
import {
  ArrowDownToLine,
  ArrowLeftRight,
  ArrowUpFromLine,
  SlidersHorizontal,
} from "lucide-react";

import { MovementAdjustmentButton } from "@/app/(app)/stock-movements/movement-adjustment-button";
import { MovementFilters } from "@/app/(app)/stock-movements/movement-filters";
import { MovementsTable } from "@/app/(app)/stock-movements/movements-table";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { StatCard } from "@/components/ui/stat-card";
import { TableSkeleton } from "@/components/ui/skeleton";
import { formatNumber } from "@/lib/format";
import {
  parseMovementListParams,
  toMovementSearchParams,
  type RawSearchParams,
} from "@/lib/stock-movement-query";
import { getCurrentUser } from "@/server/auth";
import {
  loadMovementProducts,
  loadMovementStats,
} from "@/server/stock-movements";

export const metadata: Metadata = { title: "Stock Movements" };

/**
 * The stock ledger.
 *
 * Every change to a product's quantity — confirming an order, receiving a
 * purchase, a manual adjustment — writes a row to this table. The page is a
 * read model over `StockTransaction`, not a write path: the movements are
 * created by the stock engine, and this page shows what it has recorded.
 *
 * The manual adjustment button is the one exception: it opens the same dialog
 * the product page uses, which calls through the same `adjustStockAction` →
 * `recordStockMovement` path, which writes the ledger. After the write the
 * page refreshes and the new row is there.
 */

// Live data — must not be captured at build time.
export const dynamic = "force-dynamic";

export default async function StockMovementsPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const params = parseMovementListParams(await searchParams);

  const [user, stats, products] = await Promise.all([
    getCurrentUser(),
    loadMovementStats(),
    loadMovementProducts(),
  ]);

  const canManage = user?.role === "ADMIN";

  // For the adjustment button, we need products with their stock quantities.
  // Only fetched when the user can use them.
  let adjustableProducts: {
    id: string;
    name: string;
    sku: string;
    stockQuantity: number;
  }[] = [];

  if (canManage) {
    const { prisma } = await import("@/lib/prisma");
    adjustableProducts = await prisma.product.findMany({
      where: { status: "ACTIVE" },
      orderBy: { name: "asc" },
      select: { id: true, name: true, sku: true, stockQuantity: true },
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Stock Movements"
        description="The ledger behind every quantity — what changed, by how much, and why."
        actions={
          canManage ? (
            <MovementAdjustmentButton products={adjustableProducts} />
          ) : null
        }
      />

      {stats.ok ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard
            label="Total movements"
            value={formatNumber(stats.data.total)}
            hint="All recorded stock changes"
            icon={ArrowLeftRight}
          />
          <StatCard
            label="Stock in"
            value={formatNumber(stats.data.stockIn)}
            hint="Purchases and additions"
            icon={ArrowDownToLine}
            tone="success"
          />
          <StatCard
            label="Stock out"
            value={formatNumber(stats.data.stockOut)}
            hint="Orders and deductions"
            icon={ArrowUpFromLine}
          />
          <StatCard
            label="Adjustments"
            value={formatNumber(stats.data.adjustments)}
            hint="Manual corrections and reversals"
            icon={SlidersHorizontal}
            tone={stats.data.adjustments > 0 ? "warning" : "default"}
          />
        </div>
      ) : null}

      <Card>
        <CardContent className="p-0">
          <MovementFilters params={params} products={products} />

          {/*
            Keyed on the query string so a filter change remounts the boundary
            and the skeleton appears again — otherwise React keeps the resolved
            children on screen and changing a filter looks like nothing happened.
          */}
          <Suspense
            key={toMovementSearchParams(params).toString()}
            fallback={<TableSkeleton rows={params.pageSize > 25 ? 15 : 10} columns={8} />}
          >
            <MovementsTable params={params} />
          </Suspense>
        </CardContent>
      </Card>
    </div>
  );
}
