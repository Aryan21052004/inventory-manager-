import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ArrowLeft,
  ArrowLeftRight,
  ShoppingCart,
  Truck,
  Warehouse,
} from "lucide-react";

import { ProductDetailActions } from "@/app/(app)/products/[id]/product-detail-actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { PageHeader } from "@/components/ui/page-header";
import { StockStatusBadge } from "@/components/ui/stock-status-badge";
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
  formatDate,
  formatDateTime,
  formatDelta,
  formatNumber,
} from "@/lib/format";
import { getCurrentUser } from "@/server/auth";
import {
  getProductDetail,
  loadCategories,
  loadSuppliers,
  type ProductDetail,
} from "@/server/products";
import { cn } from "@/lib/utils";

/**
 * A single product, and everything that has happened to it.
 *
 * The three history panels are the point of the page. A quantity on its own is
 * a claim; the movement ledger underneath is the evidence for it, and the
 * orders and purchases are what the movements refer back to. Read together they
 * answer the only question anyone actually brings to a stock screen: why does
 * it say that?
 */

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const result = await getProductDetail((await params).id);

  return {
    title: result.ok && result.data ? result.data.name : "Product",
  };
}

export default async function ProductDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const [result, user] = await Promise.all([
    getProductDetail(id),
    getCurrentUser(),
  ]);

  if (!result.ok) {
    return (
      <Card>
        <CardContent className="p-0">
          <ErrorState
            title="This product could not be loaded"
            message={result.error.message}
          />
        </CardContent>
      </Card>
    );
  }

  if (!result.data) notFound();

  const product = result.data;
  const canManage = user?.role === "ADMIN";

  // Only fetched when they can be used — the dialogs these feed are not
  // rendered for a STAFF user.
  const [categories, suppliers] = canManage
    ? await Promise.all([loadCategories(), loadSuppliers()])
    : [[], []];

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Button variant="ghost" size="sm" asChild className="-ml-3 mb-2">
          <Link href="/products">
            <ArrowLeft />
            All products
          </Link>
        </Button>

        <PageHeader
          title={product.name}
          description={product.description ?? "No description recorded."}
          actions={
            canManage ? (
              <ProductDetailActions
                categories={categories}
                suppliers={suppliers}
                product={{
                  id: product.id,
                  name: product.name,
                  sku: product.sku,
                  description: product.description,
                  category: product.category,
                  costPrice: product.costPrice,
                  sellingPrice: product.sellingPrice,
                  stockQuantity: product.stockQuantity,
                  minimumStock: product.minimumStock,
                  status: product.status,
                  supplierId: product.supplierId,
                  deletable: product.deletable,
                }}
              />
            ) : null
          }
        />
      </div>

      <StockSummary product={product} />

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <CardHeader>
            <CardTitle>Product information</CardTitle>
            <CardDescription>Catalogue details for this item.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <DetailRow label="SKU">
              <span className="font-mono text-sm">{product.sku}</span>
            </DetailRow>
            <DetailRow label="Category">
              <Badge variant="outline">{product.category}</Badge>
            </DetailRow>
            <DetailRow label="Supplier">
              {product.supplierName ? (
                <span className="inline-flex items-center gap-1.5 text-sm">
                  <Truck className="size-3.5 text-muted-foreground" aria-hidden />
                  {product.supplierName}
                </span>
              ) : (
                <span className="text-sm text-muted-foreground">Unassigned</span>
              )}
            </DetailRow>
            <DetailRow label="Cost price">
              <span className="tabular text-sm font-medium">
                {formatCurrency(product.costPrice)}
              </span>
            </DetailRow>
            <DetailRow label="Selling price">
              <span className="tabular text-sm font-medium">
                {formatCurrency(product.sellingPrice)}
              </span>
            </DetailRow>
            <DetailRow label="Margin">
              <Margin cost={product.costPrice} price={product.sellingPrice} />
            </DetailRow>
            <DetailRow label="Status">
              <Badge
                variant={product.status === "ACTIVE" ? "success" : "muted"}
              >
                {product.status === "ACTIVE"
                  ? "Active"
                  : product.status === "INACTIVE"
                    ? "Inactive"
                    : "Discontinued"}
              </Badge>
            </DetailRow>
            <DetailRow label="Added">
              <span className="text-sm text-muted-foreground">
                {formatDate(product.createdAt)}
              </span>
            </DetailRow>
            <DetailRow label="Last updated">
              <span className="text-sm text-muted-foreground">
                {formatDateTime(product.updatedAt)}
              </span>
            </DetailRow>
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Stock movement history</CardTitle>
            <CardDescription>
              Every change to this product&apos;s quantity, most recent first.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {product.movements.length === 0 ? (
              <EmptyState
                icon={ArrowLeftRight}
                title="No movements recorded"
                description="Nothing has moved this product's stock yet. Adjustments, confirmed orders and received purchases all write a row here."
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>When</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead className="text-right">Change</TableHead>
                    <TableHead className="text-right">Balance</TableHead>
                    <TableHead className="hidden sm:table-cell">By</TableHead>
                    <TableHead className="hidden lg:table-cell">Reason</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {product.movements.map((movement) => (
                    <TableRow key={movement.id}>
                      <TableCell className="text-muted-foreground">
                        {formatDateTime(movement.createdAt)}
                      </TableCell>
                      <TableCell>
                        <Badge variant="muted">{movement.type}</Badge>
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
                      <TableCell className="hidden sm:table-cell">
                        {movement.createdByName ?? (
                          <span className="text-muted-foreground">System</span>
                        )}
                      </TableCell>
                      <TableCell className="hidden max-w-[18rem] truncate whitespace-normal text-xs text-muted-foreground lg:table-cell">
                        {movement.note ?? "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Recent orders</CardTitle>
            <CardDescription>Where this product has been sold.</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {product.recentOrders.length === 0 ? (
              <EmptyState
                icon={ShoppingCart}
                title="Not on any orders"
                description="This product has not been sold yet. Order lines referencing it will appear here."
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Order</TableHead>
                    <TableHead>Customer</TableHead>
                    <TableHead className="text-right">Qty</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {product.recentOrders.map((line) => (
                    <TableRow key={line.id}>
                      <TableCell className="font-mono text-xs">
                        {line.orderNumber}
                      </TableCell>
                      <TableCell className="max-w-[10rem] truncate">
                        {line.customerName}
                      </TableCell>
                      <TableCell className="tabular text-right">
                        {formatNumber(line.quantity)}
                      </TableCell>
                      <TableCell className="tabular text-right font-medium">
                        {formatCurrency(line.total)}
                      </TableCell>
                      <TableCell>
                        <Badge variant="muted">{line.status}</Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Recent purchases</CardTitle>
            <CardDescription>Where this product has been bought.</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {product.recentPurchases.length === 0 ? (
              <EmptyState
                icon={Warehouse}
                title="Not on any purchases"
                description="This product has not been restocked through a purchase yet. Purchase lines referencing it will appear here."
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Purchase</TableHead>
                    <TableHead>Supplier</TableHead>
                    <TableHead className="text-right">Qty</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                    <TableHead>Date</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {product.recentPurchases.map((line) => (
                    <TableRow key={line.id}>
                      <TableCell className="font-mono text-xs">
                        {line.purchaseNumber}
                      </TableCell>
                      <TableCell className="max-w-[10rem] truncate">
                        {line.supplierName}
                      </TableCell>
                      <TableCell className="tabular text-right">
                        {formatNumber(line.quantity)}
                      </TableCell>
                      <TableCell className="tabular text-right font-medium">
                        {formatCurrency(line.total)}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {formatDate(line.purchaseDate)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

/**
 * The four numbers someone came to this page for, above everything else.
 *
 * The bar underneath plots stock against the minimum, because "40 units" and
 * "a minimum of 35" are two figures a reader has to hold in their head at once
 * to know whether anything is wrong. The bar does that comparison for them.
 */
function StockSummary({ product }: { product: ProductDetail }) {
  // Scaled against twice the minimum, so the reorder line lands in the middle
  // and there is room above it to show healthy stock rather than pinning every
  // in-stock product to a full bar.
  const ceiling = Math.max(product.minimumStock * 2, product.stockQuantity, 1);
  const fill = Math.min(100, (product.stockQuantity / ceiling) * 100);
  const threshold = Math.min(100, (product.minimumStock / ceiling) * 100);

  const barTone =
    product.stockStatus === "OUT_OF_STOCK"
      ? "bg-destructive"
      : product.stockStatus === "LOW_STOCK"
        ? "bg-warning"
        : "bg-success";

  return (
    <Card>
      <CardContent className="flex flex-col gap-5">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex flex-wrap items-end gap-8">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                On hand
              </p>
              <p className="tabular mt-1 text-3xl font-semibold tracking-tight">
                {formatNumber(product.stockQuantity)}
              </p>
            </div>
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Minimum
              </p>
              <p className="tabular mt-1 text-3xl font-semibold tracking-tight text-muted-foreground">
                {formatNumber(product.minimumStock)}
              </p>
            </div>
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Value at cost
              </p>
              <p className="tabular mt-1 text-3xl font-semibold tracking-tight">
                {formatCurrency(
                  product.stockQuantity * Number(product.costPrice),
                )}
              </p>
            </div>
          </div>

          <StockStatusBadge status={product.stockStatus} />
        </div>

        <div>
          <div
            className="relative h-2 w-full overflow-hidden rounded-full bg-muted"
            role="img"
            aria-label={`${formatNumber(product.stockQuantity)} units on hand against a minimum of ${formatNumber(product.minimumStock)}`}
          >
            <div
              className={cn("h-full rounded-full transition-all", barTone)}
              style={{ width: `${fill}%` }}
            />
            {product.minimumStock > 0 ? (
              <span
                className="absolute top-0 h-full w-px bg-foreground/50"
                style={{ left: `${threshold}%` }}
                aria-hidden
              />
            ) : null}
          </div>
          {product.minimumStock > 0 ? (
            <p className="mt-2 text-xs text-muted-foreground">
              The marker is the reorder point — at or below it, the product
              counts as low stock.
            </p>
          ) : (
            <p className="mt-2 text-xs text-muted-foreground">
              No minimum is set, so this product is only ever flagged when it
              runs out entirely.
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function DetailRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-border pb-3 last:border-0 last:pb-0">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-right">{children}</span>
    </div>
  );
}

/**
 * Margin as both cash and a percentage. A negative one is worth pointing at:
 * it means the product is priced below what it costs.
 */
function Margin({ cost, price }: { cost: string; price: string }) {
  const costValue = Number(cost);
  const priceValue = Number(price);
  const difference = priceValue - costValue;
  const percentage = priceValue === 0 ? 0 : (difference / priceValue) * 100;

  return (
    <span
      className={cn(
        "tabular text-sm font-medium",
        difference < 0 ? "text-destructive" : "text-foreground",
      )}
    >
      {formatCurrency(difference)}
      <span className="ml-1.5 text-xs text-muted-foreground">
        ({percentage.toFixed(1)}%)
      </span>
    </span>
  );
}
