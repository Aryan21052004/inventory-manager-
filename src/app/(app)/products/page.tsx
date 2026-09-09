import { Suspense } from "react";
import type { Metadata } from "next";
import { Boxes, Wallet } from "lucide-react";

import { NewProductButton } from "@/app/(app)/products/new-product-button";
import { ProductFilters } from "@/app/(app)/products/product-filters";
import { ProductsTable } from "@/app/(app)/products/products-table";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { StatCard } from "@/components/ui/stat-card";
import { TableSkeleton } from "@/components/ui/skeleton";
import { formatCurrency, formatNumber } from "@/lib/format";
import {
  parseProductListParams,
  toSearchParams,
  type RawSearchParams,
} from "@/lib/product-query";
import { getCurrentUser } from "@/server/auth";
import { loadCategories, loadProductStats } from "@/server/products";
import { loadSupplierOptions } from "@/server/suppliers";
import { getCurrency } from "@/server/settings";

export const metadata: Metadata = { title: "Products" };

/**
 * The catalogue.
 *
 * A server component reading its state out of the query string. That is what
 * keeps the whole thing honest: the filters, the sort and the page are in the
 * URL, the query runs in Postgres, and the browser receives one page of rows —
 * not the catalogue plus the code to sift it. Every figure on this page is
 * read from the database; nothing is hardcoded.
 *
 * The role decides what the page offers, and only that. `canManage` hides the
 * admin controls from a STAFF user; it does not protect them. Each action
 * behind those controls re-checks the role on the server against our own
 * database, because hiding a button stops nobody who can call the action
 * directly.
 */

// The list reflects live stock, so this page must not be captured at build time.
export const dynamic = "force-dynamic";

export default async function ProductsPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const params = parseProductListParams(await searchParams);

  const [user, stats, categories, suppliers, currency] = await Promise.all([
    getCurrentUser(),
    loadProductStats(),
    loadCategories(),
    loadSupplierOptions(),
    getCurrency(),
  ]);

  const canManage = user?.role === "ADMIN";

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Products"
        description="Your catalogue, with cost, price, and stock on hand for every item."
        actions={
          canManage ? (
            <NewProductButton categories={categories} suppliers={suppliers} />
          ) : null
        }
      />

      {stats.ok ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <StatCard
            label="Products"
            value={formatNumber(stats.data.total)}
            hint="Items in the catalogue"
            icon={Boxes}
          />
          <StatCard
            label="Stock value"
            value={formatCurrency(stats.data.stockValue, currency)}
            hint={
              stats.data.uncostedUnits > 0
                ? `Excludes ${formatNumber(stats.data.uncostedUnits)} ${stats.data.uncostedUnits === 1 ? "unit" : "units"} of unknown cost`
                : "Valued at actual acquisition cost"
            }
            icon={Wallet}
            tone="success"
          />
        </div>
      ) : null}

      <Card>
        <CardContent className="p-0">
          <ProductFilters params={params} categories={categories} />

          {/*
            Keyed on the query string so a filter change remounts the boundary
            and the skeleton appears again. Without the key React would keep the
            resolved children on screen while the new query ran, and changing a
            filter would look like nothing had happened.
          */}
          <Suspense
            key={toSearchParams(params).toString()}
            fallback={<TableSkeleton rows={params.pageSize > 10 ? 10 : 6} columns={6} />}
          >
            <ProductsTable
              params={params}
              categories={categories}
              suppliers={suppliers}
              canManage={canManage}
            />
          </Suspense>
        </CardContent>
      </Card>
    </div>
  );
}
