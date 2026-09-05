import Link from "next/link";
import {
  ArrowDown,
  ArrowUp,
  ChevronsUpDown,
  Package,
  SearchX,
} from "lucide-react";

import { ProductRowActions } from "@/app/(app)/products/product-row-actions";
import type { SupplierOption } from "@/app/(app)/products/product-form-dialog";
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
  hasActiveFilters,
  productsHref,
  sortHref,
  type ProductListParams,
  type ProductSortKey,
} from "@/lib/product-query";
import { listProducts } from "@/server/products";
import { cn } from "@/lib/utils";

/**
 * The products table.
 *
 * An async server component, which is what lets the page above it render its
 * header and filters immediately and stream this in — the Suspense boundary
 * around it shows a skeleton for exactly as long as the query takes. It also
 * means the whole catalogue never crosses the network: the filtering, sorting
 * and paging happen in Postgres, and one page of rows comes back as HTML.
 */

async function ProductsTable({
  params,
  categories,
  suppliers,
  canManage,
}: {
  params: ProductListParams;
  categories: string[];
  suppliers: SupplierOption[];
  canManage: boolean;
}) {
  const result = await listProducts(params);

  if (!result.ok) {
    return (
      <ErrorState
        title="Products could not be loaded"
        message={result.error.message}
      />
    );
  }

  const { items, total, page, pageCount, pageSize } = result.data;

  if (items.length === 0) {
    return hasActiveFilters(params) ? (
      <EmptyState
        icon={SearchX}
        title="No products match those filters"
        description="Nothing in the catalogue matches the current search and filters. Widen them, or clear them to see everything."
      />
    ) : (
      <EmptyState
        icon={Package}
        title="No products yet"
        description={
          canManage
            ? "Add your first product to start tracking stock. Its opening quantity is recorded as a stock movement, so the ledger explains it from the very first unit."
            : "The catalogue is empty. An administrator can add the first product."
        }
      />
    );
  }

  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <SortableHead params={params} column="name">
              Product
            </SortableHead>
            <SortableHead params={params} column="sku">
              SKU
            </SortableHead>
            <SortableHead params={params} column="category" className="hidden md:table-cell">
              Category
            </SortableHead>
            <SortableHead params={params} column="supplier" className="hidden xl:table-cell">
              Supplier
            </SortableHead>
            <SortableHead
              params={params}
              column="standardCost"
              className="hidden text-right sm:table-cell"
              align="right"
            >
              Std cost
            </SortableHead>
            <SortableHead params={params} column="sellingPrice" className="text-right" align="right">
              Reference
            </SortableHead>
            <SortableHead params={params} column="stockQuantity" className="text-right" align="right">
              Stock
            </SortableHead>
            <TableHead className="w-12">
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>

        <TableBody>
          {items.map((product) => (
            <TableRow key={product.id}>
              <TableCell className="max-w-[16rem]">
                <Link
                  href={`/products/${product.id}`}
                  className="block truncate font-medium hover:text-primary hover:underline"
                >
                  {product.name}
                </Link>
                {product.status !== "ACTIVE" ? (
                  <Badge variant="muted" className="mt-1">
                    {product.status === "DISCONTINUED"
                      ? "Discontinued"
                      : "Inactive"}
                  </Badge>
                ) : null}
              </TableCell>

              <TableCell className="font-mono text-xs text-muted-foreground">
                {product.sku}
              </TableCell>

              <TableCell className="hidden md:table-cell">
                <Badge variant="outline">{product.category}</Badge>
              </TableCell>

              <TableCell className="hidden max-w-[12rem] truncate xl:table-cell">
                {product.supplierName ?? (
                  <span className="text-muted-foreground">—</span>
                )}
              </TableCell>

              <TableCell className="tabular hidden text-right text-muted-foreground sm:table-cell">
                {product.standardCost === null ? (
                  <span className="text-muted-foreground">—</span>
                ) : (
                  formatCurrency(product.standardCost)
                )}
              </TableCell>

              <TableCell className="tabular text-right font-medium">
                {product.sellingPrice === null ? (
                  <span className="text-muted-foreground">—</span>
                ) : (
                  formatCurrency(product.sellingPrice)
                )}
              </TableCell>

              <TableCell className="tabular text-right font-medium">
                {formatNumber(product.stockQuantity)}
              </TableCell>

              <TableCell className="text-right">
                <ProductRowActions
                  canManage={canManage}
                  categories={categories}
                  suppliers={suppliers}
                  product={{
                    id: product.id,
                    name: product.name,
                    sku: product.sku,
                    description: product.description,
                    category: product.category,
                    standardCost: product.standardCost,
                    sellingPrice: product.sellingPrice,
                    stockQuantity: product.stockQuantity,
                    status: product.status,
                    supplierId: product.supplierId,
                    supplierName: product.supplierName,
                  }}
                />
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
        hrefFor={(next) => productsHref({ ...params, page: next })}
      />
    </>
  );
}

/**
 * A column heading that sorts.
 *
 * A link, not a button: the sort lives in the URL, so the ordering survives a
 * refresh, can be shared, and works without JavaScript. The icon distinguishes
 * the active column from the ones that merely could be sorted — an arrow for
 * the current direction, a dimmed pair of chevrons for everything else.
 */
function SortableHead({
  params,
  column,
  children,
  className,
  align = "left",
}: {
  params: ProductListParams;
  column: ProductSortKey;
  children: React.ReactNode;
  className?: string;
  align?: "left" | "right";
}) {
  const active = params.sort === column;
  const Icon = !active ? ChevronsUpDown : params.direction === "asc" ? ArrowUp : ArrowDown;

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
        href={sortHref(params, column)}
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

export { ProductsTable };
