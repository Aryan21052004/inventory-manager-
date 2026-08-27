import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { CircleDashed, Plus, Truck, Warehouse, Wallet } from "lucide-react";

import { PurchaseFilters } from "@/app/(app)/purchases/purchase-filters";
import { PurchasesTable } from "@/app/(app)/purchases/purchases-table";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { StatCard } from "@/components/ui/stat-card";
import { TableSkeleton } from "@/components/ui/skeleton";
import { formatCurrency, formatNumber } from "@/lib/format";
import {
  parsePurchaseListParams,
  toPurchaseSearchParams,
  type RawSearchParams,
} from "@/lib/purchase-query";
import { loadPurchaseStats } from "@/server/purchases";
import { loadSupplierFilterOptions } from "@/server/suppliers";

export const metadata: Metadata = { title: "Purchases" };

// Live data — must not be captured at build time.
export const dynamic = "force-dynamic";

/**
 * The purchase book.
 *
 * Reads its state from the query string, like the products and orders lists, so
 * a filtered view is bookmarkable and the browser is handed one page of rows.
 * Every figure comes from the database; nothing here is hardcoded.
 *
 * No role gate: raising and receiving purchases is ordinary work both roles do,
 * and the server checks authentication on every action regardless.
 */
export default async function PurchasesPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const params = parsePurchaseListParams(await searchParams);

  const [stats, suppliers] = await Promise.all([
    loadPurchaseStats(),
    loadSupplierFilterOptions(),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Purchases"
        description="Restocking and incoming goods. Receiving a purchase adds its quantities to inventory."
        actions={
          <Button asChild>
            <Link href="/purchases/new">
              <Plus />
              New purchase
            </Link>
          </Button>
        }
      />

      {stats.ok ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard
            label="Purchases"
            value={formatNumber(stats.data.total)}
            hint="All time"
            icon={Warehouse}
          />
          <StatCard
            label="Drafts"
            value={formatNumber(stats.data.draft)}
            hint="Not yet placed"
            icon={CircleDashed}
          />
          <StatCard
            label="On order"
            value={formatCurrency(stats.data.pendingValue)}
            hint={`${formatNumber(stats.data.pending)} awaiting delivery`}
            icon={Truck}
            tone={stats.data.pending > 0 ? "warning" : "default"}
          />
          <StatCard
            label="Received value"
            value={formatCurrency(stats.data.receivedValue)}
            hint="Goods booked into stock"
            icon={Wallet}
            tone="success"
          />
        </div>
      ) : null}

      <Card>
        <CardContent className="p-0">
          <PurchaseFilters params={params} suppliers={suppliers} />

          {/*
            Keyed on the query string so a filter change remounts the boundary
            and the skeleton appears again — otherwise React keeps the resolved
            children on screen and changing a filter looks like nothing happened.
          */}
          <Suspense
            key={toPurchaseSearchParams(params).toString()}
            fallback={<TableSkeleton rows={6} columns={7} />}
          >
            <PurchasesTable params={params} />
          </Suspense>
        </CardContent>
      </Card>
    </div>
  );
}
