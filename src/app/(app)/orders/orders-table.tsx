import Link from "next/link";
import {
  ArrowDown,
  ArrowUp,
  ChevronsUpDown,
  SearchX,
  ShoppingCart,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { RecordMoney } from "@/components/ui/money";
import { ErrorState } from "@/components/ui/error-state";
import { OrderStatusBadge } from "@/components/ui/order-status-badge";
import { Pagination } from "@/components/ui/pagination";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDateTime, formatNumber } from "@/lib/format";
import {
  hasActiveOrderFilters,
  ordersHref,
  orderSortHref,
  type OrderListParams,
  type OrderSortKey,
} from "@/lib/order-query";
import { canFulfilOutstanding } from "@/lib/order-status";
import { listOrders } from "@/server/orders";
import { cn } from "@/lib/utils";

/**
 * The orders table.
 *
 * An async server component behind a Suspense boundary, like the products
 * table: the page renders its header and filters immediately and streams this
 * in, and the whole order book never crosses the network — the filtering,
 * sorting and paging happen in Postgres.
 */

async function OrdersTable({ params }: { params: OrderListParams }) {
  /*
   * `getCurrency` is memoised for the render, so asking for it here rather
   * than taking it as a prop costs no extra query — the page above has already
   * resolved it.
   */
  const result = await listOrders(params);

  if (!result.ok) {
    return (
      <ErrorState
        title="Orders could not be loaded"
        message={result.error.message}
      />
    );
  }

  const { items, total, page, pageCount, pageSize } = result.data;

  if (items.length === 0) {
    return hasActiveOrderFilters(params) ? (
      <EmptyState
        icon={SearchX}
        title="No orders match those filters"
        description="Nothing matches the current search, status, customer or date range. Widen them, or clear them to see everything."
      />
    ) : (
      <EmptyState
        icon={ShoppingCart}
        title="No orders yet"
        description="Raise the first order to start selling from stock. Confirming an order deducts its quantities and writes a movement for each line."
        action={
          <Button asChild>
            <Link href="/orders/new">New order</Link>
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
            <SortableHead params={params} column="orderNumber">
              Order
            </SortableHead>
            <SortableHead params={params} column="customer">
              Customer
            </SortableHead>
            <SortableHead params={params} column="createdAt">
              Date
            </SortableHead>
            <TableHead className="text-right">Items</TableHead>
            <SortableHead params={params} column="total" align="right" className="text-right">
              Total
            </SortableHead>
            <SortableHead params={params} column="status">
              Status
            </SortableHead>
            <TableHead className="hidden lg:table-cell">Created by</TableHead>
          </TableRow>
        </TableHeader>

        <TableBody>
          {items.map((order) => (
            <TableRow key={order.id}>
              <TableCell>
                <Link
                  href={`/orders/${order.id}`}
                  className="font-mono text-xs font-medium hover:text-primary hover:underline"
                >
                  {order.orderNumber}
                </Link>
              </TableCell>

              <TableCell className="max-w-[14rem] truncate">
                <Link
                  href={`/customers/${order.customerId}`}
                  className="hover:text-primary hover:underline"
                >
                  {order.customerName}
                </Link>
              </TableCell>

              <TableCell className="text-muted-foreground">
                {formatDateTime(order.createdAt)}
              </TableCell>

              <TableCell className="tabular text-right text-muted-foreground">
                {/* Lines and units are different questions — "3 products" and
                    "230 units" both matter when reading an order book. */}
                {formatNumber(order.itemCount)}
                <span className="ml-1 text-xs">
                  ({formatNumber(order.unitCount)} units)
                </span>
              </TableCell>

              <TableCell className="tabular text-right font-medium">
                <RecordMoney amount={order.total} currency={order.currency} />
              </TableCell>

              <TableCell>
                <div className="flex flex-col items-start gap-1">
                  <OrderStatusBadge status={order.status} />
                  {/*
                    Outstanding units sit beside the status rather than in it.
                    The order genuinely is confirmed or completed — the sale
                    happened — and what is still owed is a fact about its lines,
                    so it reads as a second line of detail instead of a sixth
                    status. Not sortable: it is a sum over order_items, and
                    ordering by it would mean aggregating the whole order book
                    on every load.

                    Only shown once the order has committed. A draft owes
                    nothing — it has not been confirmed — and a cancelled order
                    owes nothing either, so on both the subtraction produces a
                    number that is arithmetically correct and means nothing.
                    `canFulfilOutstanding` is exactly that question, and is the
                    same predicate the server enforces.
                  */}
                  {order.outstandingUnits > 0 &&
                  canFulfilOutstanding(order.status) ? (
                    <span className="text-xs text-muted-foreground">
                      {formatNumber(order.outstandingUnits)} outstanding
                    </span>
                  ) : null}
                </div>
              </TableCell>

              <TableCell className="hidden max-w-[10rem] truncate lg:table-cell">
                {order.createdByName ?? (
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
        hrefFor={(next) => ordersHref({ ...params, page: next })}
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
  params: OrderListParams;
  column: OrderSortKey;
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
        active ? (params.direction === "asc" ? "ascending" : "descending") : "none"
      }
    >
      <Link
        href={orderSortHref(params, column)}
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

export { OrdersTable };
