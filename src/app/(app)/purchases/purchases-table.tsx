import Link from "next/link";
import {
  ArrowDown,
  ArrowUp,
  ChevronsUpDown,
  SearchX,
  Warehouse,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { RecordMoney } from "@/components/ui/money";
import { ErrorState } from "@/components/ui/error-state";
import { Pagination } from "@/components/ui/pagination";
import { PurchaseStatusBadge } from "@/components/ui/purchase-status-badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDate, formatNumber } from "@/lib/format";
import {
  hasActivePurchaseFilters,
  purchasesHref,
  purchaseSortHref,
  type PurchaseListParams,
  type PurchaseSortKey,
} from "@/lib/purchase-query";
import { listPurchases } from "@/server/purchases";
import { cn } from "@/lib/utils";

/**
 * The purchases table.
 *
 * An async server component behind a Suspense boundary: the page renders its
 * header and filters immediately and streams this in, and the whole purchase
 * book never crosses the network — filtering, sorting and paging happen in
 * Postgres.
 */

async function PurchasesTable({ params }: { params: PurchaseListParams }) {
  /*
   * `getCurrency` is memoised for the render, so asking for it here rather
   * than taking it as a prop costs no extra query — the page above has already
   * resolved it.
   */
  const result = await listPurchases(params);

  if (!result.ok) {
    return (
      <ErrorState
        title="Purchases could not be loaded"
        message={result.error.message}
      />
    );
  }

  const { items, total, page, pageCount, pageSize } = result.data;

  if (items.length === 0) {
    return hasActivePurchaseFilters(params) ? (
      <EmptyState
        icon={SearchX}
        title="No purchases match those filters"
        description="Nothing matches the current search, status, supplier or date range. Widen them, or clear them to see everything."
      />
    ) : (
      <EmptyState
        icon={Warehouse}
        title="No purchases yet"
        description="Raise the first purchase to start bringing stock in. Receiving a purchase adds its quantities and writes a movement for each line."
        action={
          <Button asChild>
            <Link href="/purchases/new">New purchase</Link>
          </Button>
        }
      />
    );
  }

  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <SortableHead params={params} column="purchaseNumber">
              Purchase
            </SortableHead>
            <SortableHead params={params} column="supplier">
              Supplier
            </SortableHead>
            <SortableHead params={params} column="purchaseDate">
              Date
            </SortableHead>
            <TableHead className="text-right">Items</TableHead>
            <SortableHead
              params={params}
              column="total"
              align="right"
              className="text-right"
            >
              Total
            </SortableHead>
            <SortableHead params={params} column="status">
              Status
            </SortableHead>
            <TableHead className="hidden lg:table-cell">Created by</TableHead>
          </TableRow>
        </TableHeader>

        <TableBody>
          {items.map((purchase) => (
            <TableRow key={purchase.id}>
              <TableCell>
                <Link
                  href={`/purchases/${purchase.id}`}
                  className="font-mono text-xs font-medium hover:text-primary hover:underline"
                >
                  {purchase.purchaseNumber}
                </Link>
              </TableCell>

              <TableCell className="max-w-[14rem] truncate">
                {purchase.supplierName}
              </TableCell>

              <TableCell className="text-muted-foreground">
                {formatDate(purchase.purchaseDate)}
              </TableCell>

              <TableCell className="tabular text-right text-muted-foreground">
                {formatNumber(purchase.itemCount)}
                <span className="ml-1 text-xs">
                  ({formatNumber(purchase.unitCount)} units)
                </span>
              </TableCell>

              <TableCell className="tabular text-right font-medium">
                <RecordMoney amount={purchase.total} currency={purchase.currency} />
              </TableCell>

              <TableCell>
                <PurchaseStatusBadge status={purchase.status} />
              </TableCell>

              <TableCell className="hidden max-w-[10rem] truncate lg:table-cell">
                {purchase.createdByName ?? (
                  <span className="text-muted-foreground">System</span>
                )}
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
        hrefFor={(next) => purchasesHref({ ...params, page: next })}
      />
    </>
  );
}

/** A column heading that sorts. A link, so the ordering lives in the URL. */
function SortableHead({
  params,
  column,
  children,
  className,
  align = "left",
}: {
  params: PurchaseListParams;
  column: PurchaseSortKey;
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
        href={purchaseSortHref(params, column)}
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

export { PurchasesTable };
