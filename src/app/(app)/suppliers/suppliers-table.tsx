import Link from "next/link";
import {
  ArrowDown,
  ArrowUp,
  ChevronsUpDown,
  SearchX,
  Truck,
} from "lucide-react";

import { SupplierRowActions } from "@/app/(app)/suppliers/supplier-row-actions";
import { Badge } from "@/components/ui/badge";
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
import { formatCurrency, formatNumber } from "@/lib/format";
import {
  suppliersHref,
  supplierSortHref,
  hasActiveSupplierFilters,
  type SupplierListParams,
  type SupplierSortKey,
} from "@/lib/supplier-query";
import { cn } from "@/lib/utils";
import { listSuppliers } from "@/server/suppliers";

/**
 * The suppliers table.
 *
 * An async server component, which is what lets the page above it render its
 * header and filters immediately and stream this in — the Suspense boundary
 * around it shows a skeleton for exactly as long as the query takes. The
 * searching, sorting and paging happen in Postgres, and one page of rows comes
 * back as HTML.
 *
 * Total purchased is RECEIVED purchases only, computed for the rows on this
 * page — see `listSuppliers`. It is not a sortable column, because sorting by
 * it would mean aggregating every purchase in the system on every load.
 */

async function SuppliersTable({
  params,
  canManage,
}: {
  params: SupplierListParams;
  canManage: boolean;
}) {
  const result = await listSuppliers(params);

  if (!result.ok) {
    return (
      <ErrorState
        title="Suppliers could not be loaded"
        message={result.error.message}
      />
    );
  }

  const { items, total, page, pageCount, pageSize } = result.data;

  if (items.length === 0) {
    return hasActiveSupplierFilters(params) ? (
      <EmptyState
        icon={SearchX}
        title="No suppliers match those filters"
        description="Nothing in the directory matches the current search and filters. Widen them, or clear them to see everyone."
      />
    ) : (
      <EmptyState
        icon={Truck}
        title="No suppliers yet"
        description="Add the first supplier to start raising purchases — a purchase has to say who the goods came from, so this is where restocking begins."
      />
    );
  }

  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <SortableHead params={params} column="name">
              Supplier
            </SortableHead>
            <TableHead className="hidden lg:table-cell">Contact</TableHead>
            <SortableHead
              params={params}
              column="email"
              className="hidden md:table-cell"
            >
              Email
            </SortableHead>
            <SortableHead
              params={params}
              column="accountNumber"
              className="hidden xl:table-cell"
            >
              Account
            </SortableHead>
            <SortableHead
              params={params}
              column="leadTime"
              className="hidden text-right xl:table-cell"
              align="right"
            >
              Lead time
            </SortableHead>
            <TableHead className="text-right">Products</TableHead>
            <SortableHead
              params={params}
              column="purchases"
              className="text-right"
              align="right"
            >
              Purchases
            </SortableHead>
            <TableHead className="text-right">Total purchased</TableHead>
            <TableHead className="w-12">
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>

        <TableBody>
          {items.map((supplier) => (
            <TableRow key={supplier.id}>
              <TableCell className="max-w-[16rem]">
                <Link
                  href={`/suppliers/${supplier.id}`}
                  className="block truncate font-medium hover:text-primary hover:underline"
                >
                  {supplier.name}
                </Link>
                {supplier.status === "INACTIVE" ? (
                  <Badge variant="muted" className="mt-1">
                    Archived
                  </Badge>
                ) : null}
              </TableCell>

              <TableCell className="hidden max-w-[12rem] truncate text-muted-foreground lg:table-cell">
                {supplier.contactPerson ?? "—"}
              </TableCell>

              <TableCell className="hidden max-w-[16rem] truncate md:table-cell">
                {supplier.email ? (
                  <a
                    href={`mailto:${supplier.email}`}
                    className="text-muted-foreground hover:text-primary hover:underline"
                  >
                    {supplier.email}
                  </a>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </TableCell>

              <TableCell className="hidden font-mono text-xs text-muted-foreground xl:table-cell">
                {supplier.accountNumber ?? "—"}
              </TableCell>

              <TableCell className="tabular hidden text-right text-muted-foreground xl:table-cell">
                {supplier.typicalLeadTimeDays === null
                  ? "—"
                  : `${formatNumber(supplier.typicalLeadTimeDays)}d`}
              </TableCell>

              <TableCell className="tabular text-right font-medium">
                {formatNumber(supplier.productCount)}
              </TableCell>

              <TableCell className="tabular text-right font-medium">
                {formatNumber(supplier.purchaseCount)}
              </TableCell>

              <TableCell className="tabular text-right font-medium">
                {formatCurrency(supplier.totalPurchased)}
              </TableCell>

              <TableCell className="text-right">
                <SupplierRowActions canManage={canManage} supplier={supplier} />
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
        hrefFor={(next) => suppliersHref({ ...params, page: next })}
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
  params: SupplierListParams;
  column: SupplierSortKey;
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
        href={supplierSortHref(params, column)}
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

export { SuppliersTable };
