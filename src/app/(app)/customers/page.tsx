import { Suspense } from "react";
import type { Metadata } from "next";
import { Archive, ReceiptText, Users, Wallet } from "lucide-react";

import { CustomerFilters } from "@/app/(app)/customers/customer-filters";
import { CustomersTable } from "@/app/(app)/customers/customers-table";
import { NewCustomerButton } from "@/app/(app)/customers/new-customer-button";
import { Card, CardContent } from "@/components/ui/card";
import { MoneyLines } from "@/components/ui/money";
import { PageHeader } from "@/components/ui/page-header";
import { TableSkeleton } from "@/components/ui/skeleton";
import { StatCard } from "@/components/ui/stat-card";
import {
  parseCustomerListParams,
  toCustomerSearchParams,
  type RawSearchParams,
} from "@/lib/customer-query";
import { formatNumber } from "@/lib/format";
import { getCurrentUser } from "@/server/auth";
import { loadCustomerStats } from "@/server/customers";

export const metadata: Metadata = { title: "Customers" };

/**
 * The customer directory.
 *
 * A server component reading its state out of the query string, like the other
 * lists: the search, the filter and the page are in the URL, the query runs in
 * Postgres, and the browser receives one page of rows. Every figure here is
 * read from the database.
 *
 * Adding and editing a customer is open to any signed-in user — an order needs
 * one, both roles raise orders, and a STAFF user who could sell to somebody but
 * not write down who they are would be stuck at the first step. `canManage`
 * gates archiving and deleting, and it hides those controls rather than
 * protecting them: each action re-checks the role on the server.
 */

// The list reflects live order counts and totals, so this page must not be
// captured at build time.
export const dynamic = "force-dynamic";

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const params = parseCustomerListParams(await searchParams);

  const [user, stats] = await Promise.all([
    getCurrentUser(),
    loadCustomerStats(),
  ]);

  const canManage = user?.role === "ADMIN";

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Customers"
        description="The people and businesses you sell to, and what they have ordered."
        actions={<NewCustomerButton />}
      />

      {stats.ok ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard
            label="Customers"
            value={formatNumber(stats.data.total)}
            hint={`${formatNumber(stats.data.active)} active`}
            icon={Users}
          />
          <StatCard
            label="Have ordered"
            value={formatNumber(stats.data.withOrders)}
            hint="The rest are contacts, not buyers yet"
            icon={ReceiptText}
          />
          <StatCard
            label="Archived"
            value={formatNumber(stats.data.archived)}
            hint="Not offered on new orders"
            icon={Archive}
            tone="default"
          />
          <StatCard
            label="Lifetime value"
            value={<MoneyLines total={stats.data.lifetimeValueByCurrency} stackedClassName="text-lg" />}
            hint="Confirmed and completed orders"
            icon={Wallet}
            tone="success"
          />
        </div>
      ) : null}

      <Card>
        <CardContent className="p-0">
          <CustomerFilters params={params} />

          {/*
            Keyed on the query string so a filter change remounts the boundary
            and the skeleton appears again. Without the key React would keep the
            resolved children on screen while the new query ran, and changing a
            filter would look like nothing had happened.
          */}
          <Suspense
            key={toCustomerSearchParams(params).toString()}
            fallback={
              <TableSkeleton
                rows={params.pageSize > 10 ? 10 : 6}
                columns={6}
              />
            }
          >
            <CustomersTable params={params} canManage={canManage} />
          </Suspense>
        </CardContent>
      </Card>
    </div>
  );
}
