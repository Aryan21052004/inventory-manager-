import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { CircleDashed, Clock, Plus, ShoppingCart, Wallet } from "lucide-react";

import { OrderFilters } from "@/app/(app)/orders/order-filters";
import { OrdersTable } from "@/app/(app)/orders/orders-table";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { StatCard } from "@/components/ui/stat-card";
import { TableSkeleton } from "@/components/ui/skeleton";
import { formatCurrency, formatNumber } from "@/lib/format";
import {
  parseOrderListParams,
  toOrderSearchParams,
  type RawSearchParams,
} from "@/lib/order-query";
import { loadCustomers, loadOrderStats } from "@/server/orders";

export const metadata: Metadata = { title: "Orders" };

// Live data — must not be captured at build time.
export const dynamic = "force-dynamic";

/**
 * The order book.
 *
 * Reads its state from the query string, like the products list, so a filtered
 * view is bookmarkable and the browser is handed one page of rows rather than
 * the whole book plus the code to sift it. Every figure comes from the
 * database; nothing here is hardcoded.
 *
 * There is no role gate on this page. Raising and progressing orders is
 * ordinary work that both roles do, and the server checks authentication on
 * every action regardless.
 */
export default async function OrdersPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const params = parseOrderListParams(await searchParams);

  const [stats, customers] = await Promise.all([
    loadOrderStats(),
    loadCustomers(),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Orders"
        description="Customer orders and the stock they commit. Confirming an order deducts its quantities."
        actions={
          <Button asChild>
            <Link href="/orders/new">
              <Plus />
              New order
            </Link>
          </Button>
        }
      />

      {stats.ok ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard
            label="Orders"
            value={formatNumber(stats.data.total)}
            hint="All time"
            icon={ShoppingCart}
          />
          <StatCard
            label="Drafts"
            value={formatNumber(stats.data.draft)}
            hint="Not yet committed"
            icon={CircleDashed}
          />
          <StatCard
            label="Pending"
            value={formatNumber(stats.data.pending)}
            hint="Waiting to be confirmed"
            icon={Clock}
            tone={stats.data.pending > 0 ? "warning" : "default"}
          />
          <StatCard
            label="Confirmed value"
            value={formatCurrency(stats.data.openValue)}
            hint={`${formatNumber(stats.data.confirmed)} awaiting completion`}
            icon={Wallet}
            tone="success"
          />
        </div>
      ) : null}

      <Card>
        <CardContent className="p-0">
          <OrderFilters params={params} customers={customers} />

          {/*
            Keyed on the query string so a filter change remounts the boundary
            and the skeleton appears again — otherwise React keeps the resolved
            children on screen and changing a filter looks like nothing happened.
          */}
          <Suspense
            key={toOrderSearchParams(params).toString()}
            fallback={<TableSkeleton rows={6} columns={7} />}
          >
            <OrdersTable params={params} />
          </Suspense>
        </CardContent>
      </Card>
    </div>
  );
}
