import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ArrowLeft,
  ArrowLeftRight,
  Layers,
  ShoppingCart,
  Truck,
  Warehouse,
} from "lucide-react";

import { CertificatePanel } from "@/app/(app)/products/[id]/certificate-panel";
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
  type ProductDetail,
} from "@/server/products";
import { loadSupplierOptions } from "@/server/suppliers";
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
    ? await Promise.all([
        loadCategories(),
        // The product's own supplier is kept in the list even if archived, so
        // editing an existing product does not silently blank its sourcing.
        loadSupplierOptions(product.supplierId),
      ])
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
                  standardCost: product.standardCost,
                  sellingPrice: product.sellingPrice,
                  stockQuantity: product.stockQuantity,
                  minimumStock: product.minimumStock,
                  status: product.status,
                  supplierId: product.supplierId,
                  supplierName: product.supplierName,
                  deletable: product.deletable,
                }}
              />
            ) : null
          }
        />
      </div>

      <StockSummary product={product} />

      {/*
        Dates are handed over as `YYYY-MM-DD` strings rather than Date objects.
        The panel feeds them straight back into `<input type="date">`, which
        accepts exactly that format and nothing else, and the conversion belongs
        on the server where the value is already known to be a UTC calendar day.
      */}
      <CertificatePanel
        productId={product.id}
        status={product.certificateStatus}
        canManage={canManage}
        certificate={
          product.certificate
            ? {
                id: product.certificate.id,
                certificateType: product.certificate.certificateType,
                certificateNumber: product.certificate.certificateNumber,
                issueDate: isoDay(product.certificate.issueDate),
                expiryDate: product.certificate.expiryDate
                  ? isoDay(product.certificate.expiryDate)
                  : null,
                fileName: product.certificate.fileName,
                fileSize: product.certificate.fileSize,
                fileUrl: product.certificate.fileUrl,
                uploadedByName: product.certificate.uploadedByName,
                createdAt: product.certificate.createdAt.toISOString(),
              }
            : null
        }
        history={product.certificateHistory.map((entry) => ({
          id: entry.id,
          certificateType: entry.certificateType,
          certificateNumber: entry.certificateNumber,
          issueDate: isoDay(entry.issueDate),
          expiryDate: entry.expiryDate ? isoDay(entry.expiryDate) : null,
          fileName: entry.fileName,
          fileUrl: entry.fileUrl,
          supersededAt: (entry.supersededAt ?? entry.updatedAt).toISOString(),
          uploadedByName: entry.uploadedByName,
        }))}
      />

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
            <DetailRow label="Standard cost (reference)">
              {product.standardCost === null ? (
                <span className="text-sm text-muted-foreground">Not set</span>
              ) : (
                <span className="tabular text-sm font-medium text-muted-foreground">
                  {formatCurrency(product.standardCost)}
                </span>
              )}
            </DetailRow>
            <DetailRow label="Average cost on hand">
              <AverageCost
                value={product.stockValue}
                costedUnits={product.costedUnits}
                uncostedUnits={product.uncostedUnits}
              />
            </DetailRow>
            <DetailRow label="Selling price">
              <span className="tabular text-sm font-medium">
                {formatCurrency(product.sellingPrice)}
              </span>
            </DetailRow>
            <DetailRow label="Margin">
              <Margin
                stockValue={product.stockValue}
                costedUnits={product.costedUnits}
                uncostedUnits={product.uncostedUnits}
                price={product.sellingPrice}
              />
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
            <CardTitle>Stock on hand by batch</CardTitle>
            <CardDescription>
              What each batch of this stock cost, oldest first — the order a
              sale will consume them in.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {product.lots.length === 0 ? (
              <EmptyState
                icon={Layers}
                title="No stock on hand"
                description="Batches appear here once a purchase is received or opening stock is recorded."
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Received</TableHead>
                    <TableHead>Source</TableHead>
                    <TableHead className="text-right">Unit cost</TableHead>
                    <TableHead className="text-right">Remaining</TableHead>
                    <TableHead className="text-right">Value</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {product.lots.map((lot) => (
                    <TableRow key={lot.id}>
                      <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                        {formatDate(lot.receivedAt)}
                      </TableCell>
                      <TableCell>
                        {lot.purchaseNumber ? (
                          <Link
                            href={`/purchases/${lot.sourceId}`}
                            className="font-mono text-sm underline-offset-4 hover:underline"
                          >
                            {lot.purchaseNumber}
                          </Link>
                        ) : (
                          <Badge variant="outline">
                            {lot.costSource === "OPENING"
                              ? "Opening stock"
                              : lot.costSource === "ADJUSTMENT"
                                ? "Adjustment"
                                : "Pre-costing stock"}
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="tabular text-right text-sm">
                        {lot.unitCost === null ? (
                          <span className="text-muted-foreground">Unknown</span>
                        ) : (
                          formatCurrency(lot.unitCost)
                        )}
                      </TableCell>
                      <TableCell className="tabular text-right text-sm">
                        {formatNumber(lot.quantityRemaining)}
                        <span className="ml-1 text-xs text-muted-foreground">
                          / {formatNumber(lot.quantityReceived)}
                        </span>
                      </TableCell>
                      <TableCell className="tabular text-right text-sm">
                        {lot.unitCost === null ? (
                          <span className="text-muted-foreground">—</span>
                        ) : (
                          formatCurrency(
                            Number(lot.unitCost) * lot.quantityRemaining,
                          )
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            {product.uncostedUnits > 0 ? (
              <p className="border-t px-6 py-3 text-xs text-muted-foreground">
                {formatNumber(product.uncostedUnits)}{" "}
                {product.uncostedUnits === 1 ? "unit has" : "units have"} no
                recorded acquisition cost, so {product.uncostedUnits === 1 ? "it is" : "they are"}{" "}
                excluded from the value above. Selling{" "}
                {product.uncostedUnits === 1 ? "it" : "them"} is allowed; the
                margin on those units simply cannot be calculated.
              </p>
            ) : null}
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
                {formatCurrency(product.stockValue)}
              </p>
              {product.uncostedUnits > 0 ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  {formatNumber(product.costedUnits)} of{" "}
                  {formatNumber(product.stockQuantity)} units costed
                </p>
              ) : null}
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
/**
 * The weighted average of what the stock actually on the shelf cost.
 *
 * A summary of the lots, not a stored figure and not an input to any COGS
 * calculation — a sale is costed against the batches it consumes, not against
 * this. It is here because "what is my stock worth per unit right now" is a
 * fair question, and answering it from the lots is the only way to answer it
 * truthfully once the same part has been bought at several prices.
 *
 * Covers the costed units only, and says so whenever some units are not.
 */
function AverageCost({
  value,
  costedUnits,
  uncostedUnits,
}: {
  value: string;
  costedUnits: number;
  uncostedUnits: number;
}) {
  if (costedUnits === 0) {
    return (
      <span className="text-sm text-muted-foreground">
        {uncostedUnits > 0 ? "Cost unknown" : "No stock on hand"}
      </span>
    );
  }

  const average = Number(value) / costedUnits;

  return (
    <span className="tabular text-sm font-medium">
      {formatCurrency(average)}
      {uncostedUnits > 0 ? (
        <span className="ml-1.5 text-xs text-muted-foreground">
          (over {formatNumber(costedUnits)} costed{" "}
          {costedUnits === 1 ? "unit" : "units"})
        </span>
      ) : null}
    </span>
  );
}

/**
 * Margin against what the stock on hand actually cost.
 *
 * This used to be `sellingPrice - costPrice`, a catalogue figure that described
 * no real transaction: the cost half was whatever someone last typed into the
 * product form, unrelated to what any unit in the warehouse was bought for.
 * It is now the selling price against the average cost of the units actually
 * held, and it declines to produce a number at all when none of them have a
 * known cost — an unqualified margin over unpriced stock is exactly the kind of
 * confident wrong answer this redesign set out to remove.
 */
function Margin({
  stockValue,
  costedUnits,
  uncostedUnits,
  price,
}: {
  stockValue: string;
  costedUnits: number;
  uncostedUnits: number;
  price: string;
}) {
  if (costedUnits === 0) {
    return (
      <span className="text-sm text-muted-foreground">
        {uncostedUnits > 0
          ? "Cannot be calculated — acquisition cost unknown"
          : "No stock on hand"}
      </span>
    );
  }

  const averageCost = Number(stockValue) / costedUnits;
  const priceValue = Number(price);
  const difference = priceValue - averageCost;
  const percentage = priceValue === 0 ? 0 : (difference / priceValue) * 100;

  return (
    <span className="flex flex-col items-end gap-0.5">
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
      {uncostedUnits > 0 ? (
        <span className="text-xs text-muted-foreground">
          Based on {formatNumber(costedUnits)} costed{" "}
          {costedUnits === 1 ? "unit" : "units"}
        </span>
      ) : null}
    </span>
  );
}

/**
 * A `DATE` column as the `YYYY-MM-DD` string a date input expects.
 *
 * Sliced from the UTC ISO string rather than formatted locally: the column
 * holds a calendar day with no time and no zone, and running it through a local
 * formatter would move it a day for anyone west of Greenwich.
 */
function isoDay(value: Date): string {
  return value.toISOString().slice(0, 10);
}
