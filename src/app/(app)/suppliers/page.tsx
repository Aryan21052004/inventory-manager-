import { Suspense } from "react";
import type { Metadata } from "next";
import { Archive, Truck, Wallet, Warehouse } from "lucide-react";

import { NewSupplierButton } from "@/app/(app)/suppliers/new-supplier-button";
import { SupplierFilters } from "@/app/(app)/suppliers/supplier-filters";
import { SuppliersTable } from "@/app/(app)/suppliers/suppliers-table";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { TableSkeleton } from "@/components/ui/skeleton";
import { StatCard } from "@/components/ui/stat-card";
import { formatCurrency, formatNumber } from "@/lib/format";
import {
  parseSupplierListParams,
  toSupplierSearchParams,
  type RawSearchParams,
} from "@/lib/supplier-query";
import { getCurrentUser } from "@/server/auth";
import { loadSupplierStats } from "@/server/suppliers";

export const metadata: Metadata = { title: "Suppliers" };

/**
 * The supplier directory.
 *
 * A server component reading its state out of the query string, like the other
 * lists: the search, the filter and the page are in the URL, the query runs in
 * Postgres, and the browser receives one page of rows. Every figure here is
 * read from the database.
 *
 * Adding and editing a supplier is open to any signed-in user — a purchase
 * needs one, both roles raise purchases, and a STAFF user who could order goods
 * but not write down who they came from would be stuck at the first step.
 * `canManage` gates archiving, reactivating and deleting, and it hides those
 * controls rather than protecting them: each action re-checks the role on the
 * server.
 */

// The list reflects live purchase counts and spend, so this page must not be
// captured at build time.
export const dynamic = "force-dynamic";

export default async function SuppliersPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const params = parseSupplierListParams(await searchParams);

  const [user, stats] = await Promise.all([
    getCurrentUser(),
    loadSupplierStats(),
  ]);

  const canManage = user?.role === "ADMIN";

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Suppliers"
        description="Who you buy from, what they supply, and what you have spent with them."
        actions={<NewSupplierButton />}
      />

      {stats.ok ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard
            label="Suppliers"
            value={formatNumber(stats.data.total)}
            hint={`${formatNumber(stats.data.active)} active`}
            icon={Truck}
          />
          <StatCard
            label="Bought from"
            value={formatNumber(stats.data.withPurchases)}
            hint="The rest are contacts, not vendors yet"
            icon={Warehouse}
          />
          <StatCard
            label="Archived"
            value={formatNumber(stats.data.archived)}
            hint="Not offered on new purchases or products"
            icon={Archive}
          />
          <StatCard
            label="Total purchased"
            value={formatCurrency(stats.data.totalPurchased)}
            hint="Received purchases only"
            icon={Wallet}
            tone="success"
          />
        </div>
      ) : null}

      <Card>
        <CardContent className="p-0">
          <SupplierFilters params={params} />

          {/*
            Keyed on the query string so a filter change remounts the boundary
            and the skeleton appears again. Without the key React would keep the
            resolved children on screen while the new query ran, and changing a
            filter would look like nothing had happened.
          */}
          <Suspense
            key={toSupplierSearchParams(params).toString()}
            fallback={
              <TableSkeleton rows={params.pageSize > 10 ? 10 : 6} columns={8} />
            }
          >
            <SuppliersTable params={params} canManage={canManage} />
          </Suspense>
        </CardContent>
      </Card>
    </div>
  );
}
