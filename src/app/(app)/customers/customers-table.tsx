import Link from "next/link";
import {
  ArrowDown,
  ArrowUp,
  ChevronsUpDown,
  SearchX,
  Users,
} from "lucide-react";

import { CustomerRowActions } from "@/app/(app)/customers/customer-row-actions";
import { Badge } from "@/components/ui/badge";
import { MoneyLines } from "@/components/ui/money";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { Pagination } from "@/components/ui/pagination";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  customersHref,
  customerSortHref,
  hasActiveCustomerFilters,
  type CustomerListParams,
  type CustomerSortKey,
} from "@/lib/customer-query";
import { formatDate, formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";
import { listCustomers } from "@/server/customers";

/**
 * The customers table.
 *
 * An async server component, which is what lets the page above it render its
 * header and filters immediately and stream this in — the Suspense boundary
 * around it shows a skeleton for exactly as long as the query takes. The
 * searching, sorting and paging happen in Postgres, and one page of rows comes
 * back as HTML.
 *
 * Lifetime value is CONFIRMED and COMPLETED orders only, computed for the rows
 * on this page — see `listCustomers`. It is not a sortable column, because
 * sorting by it would mean aggregating the whole customer base on every load.
 */

async function CustomersTable({
  params,
  canManage,
}: {
  params: CustomerListParams;
  canManage: boolean;
}) {
  /*
   * `getCurrency` is memoised for the render, so asking for it here rather
   * than taking it as a prop costs no extra query — the page above has already
   * resolved it.
   */
  const result = await listCustomers(params);

  if (!result.ok) {
    return (
      <ErrorState
        title="Customers could not be loaded"
        message={result.error.message}
      />
    );
  }

  const { items, total, page, pageCount, pageSize } = result.data;

  if (items.length === 0) {
    return hasActiveCustomerFilters(params) ? (
      <EmptyState
        icon={SearchX}
        title="No customers match those filters"
        description="Nothing in the directory matches the current search and filters. Widen them, or clear them to see everyone."
      />
    ) : (
      <EmptyState
        icon={Users}
        title="No customers yet"
        description="Add the first customer to start raising orders — an order has to say who it is for, so this is where selling begins."
      />
    );
  }

  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <SortableHead params={params} column="name">
              Customer
            </SortableHead>
            <SortableHead
              params={params}
              column="email"
              className="hidden md:table-cell"
            >
              Email
            </SortableHead>
            <TableHead className="hidden lg:table-cell">Phone</TableHead>
            <SortableHead
              params={params}
              column="orders"
              className="text-right"
              align="right"
            >
              Orders
            </SortableHead>
            <TableHead className="text-right">Lifetime value</TableHead>
            <SortableHead
              params={params}
              column="createdAt"
              className="hidden xl:table-cell"
            >
              Added
            </SortableHead>
            <TableHead className="w-12">
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>

        <TableBody>
          {items.map((customer) => (
            <TableRow key={customer.id}>
              <TableCell className="max-w-[16rem]">
                <Link
                  href={`/customers/${customer.id}`}
                  className="block truncate font-medium hover:text-primary hover:underline"
                >
                  {customer.name}
                </Link>
                {customer.status === "INACTIVE" ? (
                  <Badge variant="muted" className="mt-1">
                    Archived
                  </Badge>
                ) : null}
              </TableCell>

              <TableCell className="hidden max-w-[16rem] truncate md:table-cell">
                {customer.email ? (
                  <a
                    href={`mailto:${customer.email}`}
                    className="text-muted-foreground hover:text-primary hover:underline"
                  >
                    {customer.email}
                  </a>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </TableCell>

              <TableCell className="hidden text-muted-foreground lg:table-cell">
                {customer.phone ?? "—"}
              </TableCell>

              <TableCell className="tabular text-right font-medium">
                {formatNumber(customer.orderCount)}
              </TableCell>

              <TableCell className="tabular text-right font-medium">
                <MoneyLines total={customer.lifetimeValueByCurrency} />
              </TableCell>

              <TableCell className="hidden text-muted-foreground xl:table-cell">
                {formatDate(customer.createdAt)}
              </TableCell>

              <TableCell className="text-right">
                <CustomerRowActions canManage={canManage} customer={customer} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <Pagination
        page={page}
        pageCount={pageCount}
        total={total}
        pageSize={pageSize}
        hrefFor={(next) => customersHref({ ...params, page: next })}
      />
    </>
  );
}

/**
 * A column heading that sorts.
 *
 * A link, not a button: the sort lives in the URL, so the ordering survives a
 * refresh, can be shared, and works without JavaScript. The icon distinguishes
 * the active column from the ones that merely could be sorted.
 */
function SortableHead({
  params,
  column,
  children,
  className,
  align = "left",
}: {
  params: CustomerListParams;
  column: CustomerSortKey;
  children: React.ReactNode;
  className?: string;
  align?: "left" | "right";
}) {
  const active = params.sort === column;
  const Icon = !active
    ? ChevronsUpDown
    : params.direction === "asc"
      ? ArrowUp
      : ArrowDown;

  return (
    <TableHead
      className={className}
      aria-sort={
        active
          ? params.direction === "asc"
            ? "ascending"
            : "descending"
          : "none"
      }
    >
      <Link
        href={customerSortHref(params, column)}
        prefetch={false}
        className={cn(
          "inline-flex items-center gap-1.5 rounded transition-colors hover:text-foreground",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          align === "right" && "flex-row-reverse",
          active && "text-foreground",
        )}
      >
        {children}
        <Icon
          className={cn("size-3", active ? "opacity-100" : "opacity-40")}
          aria-hidden
        />
      </Link>
    </TableHead>
  );
}

export { CustomersTable };
