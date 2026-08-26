import Link from "next/link";
import {
  ArrowDown,
  ArrowLeftRight,
  ArrowUp,
  ChevronsUpDown,
  SearchX,
} from "lucide-react";

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
import {
  formatCurrency,
  formatDateTime,
  formatDelta,
  formatNumber,
} from "@/lib/format";
import {
  hasActiveMovementFilters,
  MOVEMENT_TYPE_LABELS,
  movementsHref,
  movementSortHref,
  type MovementListParams,
  type MovementSortKey,
} from "@/lib/stock-movement-query";
import {
  listMovements,
  type MovementListItem,
} from "@/server/stock-movements";
import { cn } from "@/lib/utils";

/**
 * The stock ledger as a table.
 *
 * Async server component — the query runs on the server and the browser
 * receives rendered rows. Same pattern as products-table.tsx and
 * orders-table.tsx.
 */
async function MovementsTable({ params }: { params: MovementListParams }) {
  const result = await listMovements(params);

  if (!result.ok) {
    return (
      <ErrorState
        title="Stock movements could not be loaded"
        message={result.error.message}
      />
    );
  }

  const { items, total, page, pageCount, pageSize } = result.data;

  if (items.length === 0) {
    return hasActiveMovementFilters(params) ? (
      <EmptyState
        icon={SearchX}
        title="No movements match those filters"
        description="Nothing in the ledger matches the current search and filters. Widen them, or clear them to see everything."
      />
    ) : (
      <EmptyState
        icon={ArrowLeftRight}
        title="No movements recorded"
        description="Movements are written automatically whenever stock changes — confirming orders, receiving purchases, and manual adjustments all write a row here."
      />
    );
  }

  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <SortableHead params={params} sortKey="createdAt" label="When" />
            <SortableHead params={params} sortKey="product" label="Product" />
            <SortableHead params={params} sortKey="type" label="Type" />
            <SortableHead
              params={params}
              sortKey="quantity"
              label="Change"
              align="right"
            />
            <SortableHead
              params={params}
              sortKey="newStock"
              label="Balance"
              align="right"
            />
            <TableHead className="hidden text-right md:table-cell">
              Cost
            </TableHead>
            <TableHead>Reference</TableHead>
            <TableHead className="hidden lg:table-cell">By</TableHead>
            <TableHead className="hidden xl:table-cell">Reason</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((movement) => (
            <TableRow key={movement.id}>
              <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                {formatDateTime(movement.createdAt)}
              </TableCell>

              <TableCell className="max-w-[14rem]">
                <Link
                  href={`/products/${movement.productId}`}
                  className="block truncate text-sm font-medium hover:text-primary hover:underline"
                >
                  {movement.productName}
                </Link>
                <span className="font-mono text-xs text-muted-foreground">
                  {movement.productSku}
                </span>
              </TableCell>

              <TableCell>
                <Badge variant="muted">
                  {MOVEMENT_TYPE_LABELS[movement.type]}
                </Badge>
              </TableCell>

              <TableCell
                className={cn(
                  "tabular text-right font-medium",
                  movement.change < 0 ? "text-destructive" : "text-success",
                )}
              >
                {formatDelta(movement.change)}
              </TableCell>

              <TableCell className="tabular text-right">
                {formatNumber(movement.newStock)}
              </TableCell>

              <TableCell className="tabular hidden text-right text-sm md:table-cell">
                <MovementCost movement={movement} />
              </TableCell>

              <TableCell>
                {movement.referenceHref ? (
                  <Link
                    href={movement.referenceHref}
                    className="text-sm font-medium text-primary hover:underline"
                  >
                    {movement.referenceLabel}
                  </Link>
                ) : (
                  <span className="text-sm text-muted-foreground">
                    {movement.referenceLabel ?? "—"}
                  </span>
                )}
              </TableCell>

              <TableCell className="hidden lg:table-cell">
                {movement.createdByName ?? (
                  <span className="text-muted-foreground">System</span>
                )}
              </TableCell>

              <TableCell className="hidden max-w-[16rem] truncate whitespace-normal text-xs text-muted-foreground xl:table-cell">
                {movement.note ?? "—"}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      {pageCount > 1 ? (
        <Pagination
          page={page}
          pageSize={pageSize}
          pageCount={pageCount}
          total={total}
          hrefFor={(next) => movementsHref({ ...params, page: next })}
        />
      ) : null}
    </>
  );
}

/**
 * A sortable column heading.
 *
 * Accessible link with arrow icons and `aria-sort`. Matches the pattern from
 * products-table.tsx.
 */
function SortableHead({
  params,
  sortKey,
  label,
  align,
}: {
  params: MovementListParams;
  sortKey: MovementSortKey;
  label: string;
  align?: "right";
}) {
  const active = params.sort === sortKey;
  const href = movementSortHref(params, sortKey);

  const Icon = active
    ? params.direction === "asc"
      ? ArrowUp
      : ArrowDown
    : ChevronsUpDown;

  return (
    <TableHead className={align === "right" ? "text-right" : undefined}>
      <Link
        href={href}
        prefetch={false}
        className={cn(
          "inline-flex items-center gap-1 hover:text-foreground",
          active ? "text-foreground" : "text-muted-foreground",
        )}
        aria-sort={
          active
            ? params.direction === "asc"
              ? "ascending"
              : "descending"
            : "none"
        }
      >
        {label}
        <Icon className="size-3.5" aria-hidden />
      </Link>
    </TableHead>
  );
}

/**
 * What a movement cost, and how much of it that figure speaks for.
 *
 * Three distinct states, and keeping them distinct is the point. A known cost
 * renders as money. A movement across stock that was never priced renders as
 * "Unknown" — never as a dash that reads like zero, and never as a figure
 * borrowed from the catalogue. And a movement that drew from both kinds shows
 * the money it can vouch for with its coverage underneath, so nobody reads a
 * partial total as a complete one.
 */
function MovementCost({ movement }: { movement: MovementListItem }) {
  const units = Math.abs(movement.change);

  if (movement.costTotal === null) {
    return <span className="text-muted-foreground">Unknown</span>;
  }

  const partial = movement.costedQuantity < units;

  return (
    <span className="inline-flex flex-col items-end">
      <span>{formatCurrency(movement.costTotal)}</span>
      {partial ? (
        <span className="text-xs text-muted-foreground">
          {formatNumber(movement.costedQuantity)} of {formatNumber(units)} costed
        </span>
      ) : null}
    </span>
  );
}

export { MovementsTable };
