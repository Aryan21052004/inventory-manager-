import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ArrowLeft,
  ArrowRight,
  History,
  Mail,
  MapPin,
  Phone,
  ShoppingCart,
  TrendingDown,
  TrendingUp,
} from "lucide-react";

import { OrderActions } from "@/app/(app)/orders/[id]/order-actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { CertificateStatusBadge } from "@/components/ui/certificate-status-badge";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { OrderStatusBadge } from "@/components/ui/order-status-badge";
import { PageHeader } from "@/components/ui/page-header";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatCurrency, formatDateTime, formatNumber } from "@/lib/format";
import { getOrderDetail, type OrderDetail } from "@/server/orders";
import { cn } from "@/lib/utils";

/**
 * A single order, and what it did to inventory.
 *
 * The Inventory Impact panel is the part worth reading carefully. It is built
 * from the stock ledger — the STOCK_OUT rows the confirmation wrote and the
 * REVERSAL rows a cancellation wrote — rather than from the order's status. The
 * ledger is the record of what actually moved; the status is a label on the
 * document, and if the two ever disagreed the ledger would be the one telling
 * the truth.
 *
 * Certificates are shown per line and are read straight from each product. The
 * order references its products' paperwork; it never copies it.
 */

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const result = await getOrderDetail((await params).id);

  return {
    title: result.ok && result.data ? result.data.orderNumber : "Order",
  };
}

export default async function OrderDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const result = await getOrderDetail(id);

  if (!result.ok) {
    return (
      <Card>
        <CardContent className="p-0">
          <ErrorState
            title="This order could not be loaded"
            message={result.error.message}
          />
        </CardContent>
      </Card>
    );
  }

  if (!result.data) notFound();

  const order = result.data;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Button variant="ghost" size="sm" asChild className="-ml-3 mb-2">
          <Link href="/orders">
            <ArrowLeft />
            All orders
          </Link>
        </Button>

        <PageHeader
          title={order.orderNumber}
          description={`Raised ${formatDateTime(order.createdAt)}${order.createdByName ? ` by ${order.createdByName}` : ""} for ${order.customerName}.`}
          actions={
            <OrderActions
              orderId={order.id}
              status={order.status}
              lines={order.lines.map((line) => ({
                productName: line.productName,
                quantity: line.quantity,
                currentStock: line.currentStock,
              }))}
            />
          }
        />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <OrderStatusBadge status={order.status} />
        <Timeline order={order} />
      </div>

      <InventoryImpact order={order} />

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Products</CardTitle>
            <CardDescription>
              Unit prices were copied from the catalogue when the order was
              raised, so they do not move when the price list does.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Product</TableHead>
                  <TableHead className="hidden md:table-cell">
                    Certificate
                  </TableHead>
                  <TableHead className="text-right">Quantity</TableHead>
                  <TableHead className="text-right">Unit price</TableHead>
                  <TableHead className="text-right">Line total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {order.lines.map((line) => (
                  <TableRow key={line.id}>
                    <TableCell className="max-w-[16rem]">
                      <Link
                        href={`/products/${line.productId}`}
                        className="block truncate font-medium hover:text-primary hover:underline"
                      >
                        {line.productName}
                      </Link>
                      <span className="font-mono text-xs text-muted-foreground">
                        {line.sku}
                      </span>
                    </TableCell>

                    <TableCell className="hidden md:table-cell">
                      {/*
                        Referenced, not copied. This reads the product's current
                        certificate — if it is replaced tomorrow, this page shows
                        the new one, because the order never owned a copy.
                      */}
                      <div className="flex flex-col gap-1">
                        <CertificateStatusBadge status={line.certificateStatus} />
                        {line.certificateType ? (
                          <span className="text-xs text-muted-foreground">
                            {line.certificateType}
                            {line.certificateNumber
                              ? ` · ${line.certificateNumber}`
                              : ""}
                          </span>
                        ) : null}
                      </div>
                    </TableCell>

                    <TableCell className="tabular text-right font-medium">
                      {formatNumber(line.quantity)}
                    </TableCell>
                    <TableCell className="tabular text-right">
                      {formatCurrency(line.unitPrice)}
                    </TableCell>
                    <TableCell className="tabular text-right font-medium">
                      {formatCurrency(line.total)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            <dl className="flex flex-col gap-2 border-t border-border p-6 text-sm">
              <div className="flex items-center justify-between">
                <dt className="text-muted-foreground">Subtotal</dt>
                <dd className="tabular font-medium">
                  {formatCurrency(order.subtotal)}
                </dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-muted-foreground">Discount</dt>
                <dd className="tabular font-medium text-destructive">
                  {Number(order.discount) > 0 ? "−" : ""}
                  {formatCurrency(order.discount)}
                </dd>
              </div>
              {/*
                No tax row. The grand total is the discounted subtotal, and the
                database's check constraint refuses anything else.
              */}
              <div className="flex items-center justify-between border-t border-border pt-3">
                <dt className="font-semibold">Grand total</dt>
                <dd className="tabular text-lg font-semibold">
                  {formatCurrency(order.total)}
                </dd>
              </div>
            </dl>
          </CardContent>
        </Card>

        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Customer</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <p className="text-sm font-medium">{order.customerName}</p>

              {order.customerEmail ? (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Mail className="size-3.5 shrink-0" aria-hidden />
                  <span className="truncate">{order.customerEmail}</span>
                </p>
              ) : null}

              {order.customerPhone ? (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Phone className="size-3.5 shrink-0" aria-hidden />
                  {order.customerPhone}
                </p>
              ) : null}

              {order.customerAddress ? (
                <p className="flex items-start gap-2 text-sm text-muted-foreground">
                  <MapPin className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                  <span>{order.customerAddress}</span>
                </p>
              ) : null}

              <Button variant="outline" size="sm" asChild className="mt-1">
                <Link href={`/orders?customer=${order.customerId}`}>
                  All orders from this customer
                </Link>
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-sm">
                <History className="size-4 text-muted-foreground" aria-hidden />
                Customer history
              </CardTitle>
              <CardDescription>
                Their other orders, most recent first.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              {order.customerHistory.length === 0 ? (
                <EmptyState
                  icon={ShoppingCart}
                  title="No other orders"
                  description="This is the only order recorded for this customer."
                />
              ) : (
                <ul className="divide-y divide-border">
                  {order.customerHistory.map((entry) => (
                    <li key={entry.id}>
                      <Link
                        href={`/orders/${entry.id}`}
                        className="flex items-center gap-3 px-6 py-3 transition-colors hover:bg-accent"
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block font-mono text-xs font-medium">
                            {entry.orderNumber}
                          </span>
                          <span className="block text-xs text-muted-foreground">
                            {formatDateTime(entry.createdAt)}
                          </span>
                        </span>
                        <OrderStatusBadge status={entry.status} />
                        <span className="tabular shrink-0 text-sm font-medium">
                          {formatCurrency(entry.total)}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

/**
 * What this order did to stock, read from the ledger.
 *
 * Shows the deduction, and — once cancelled — the restore underneath it, each
 * with the balances either side. An order that has never been confirmed has no
 * movements at all, and says so rather than showing an empty table.
 */
function InventoryImpact({ order }: { order: OrderDetail }) {
  if (order.impact.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Inventory impact</CardTitle>
          <CardDescription>
            This order has not moved any stock. Quantities are deducted when it
            is confirmed, and returned if it is cancelled.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const restored = order.impact.some((line) => line.restored > 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{restored ? "Inventory restored" : "Inventory impact"}</CardTitle>
        <CardDescription>
          Read from the stock ledger — the movements this order actually wrote,
          not what its status implies.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {order.impact.map((line) => (
          <div
            key={line.productId}
            className="flex flex-col gap-3 rounded-lg border border-border p-4"
          >
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{line.productName}</p>
              <p className="font-mono text-xs text-muted-foreground">
                {line.sku}
              </p>
            </div>

            {line.deducted > 0 ? (
              <ImpactRow
                tone="down"
                label={`${formatNumber(line.deducted)} units deducted`}
                from={line.deductedFrom}
                to={line.deductedTo}
              />
            ) : null}

            {line.restored > 0 ? (
              <ImpactRow
                tone="up"
                label={`${formatNumber(line.restored)} units restored`}
                from={line.restoredFrom}
                to={line.restoredTo}
              />
            ) : null}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function ImpactRow({
  tone,
  label,
  from,
  to,
}: {
  tone: "up" | "down";
  label: string;
  from: number | null;
  to: number | null;
}) {
  const Icon = tone === "down" ? TrendingDown : TrendingUp;

  return (
    <div className="flex flex-col gap-1.5">
      <p
        className={cn(
          "flex items-center gap-1.5 text-xs font-medium",
          tone === "down" ? "text-destructive" : "text-success",
        )}
      >
        <Icon className="size-3.5" aria-hidden />
        {label}
      </p>
      <p className="tabular flex items-center gap-2 font-mono text-sm">
        <span className="text-muted-foreground">
          {from === null ? "—" : formatNumber(from)}
        </span>
        <ArrowRight className="size-3.5 text-muted-foreground" aria-hidden />
        <span className="font-semibold">
          {to === null ? "—" : formatNumber(to)}
        </span>
      </p>
    </div>
  );
}

/** The dates an order picked up on its way through, shown as they exist. */
function Timeline({ order }: { order: OrderDetail }) {
  const stamps: [string, Date | null][] = [
    ["Raised", order.createdAt],
    ["Confirmed", order.confirmedAt],
    ["Completed", order.completedAt],
    ["Cancelled", order.cancelledAt],
  ];

  return (
    <div className="flex flex-wrap items-center gap-2">
      {stamps
        .filter((entry): entry is [string, Date] => entry[1] !== null)
        .map(([label, at]) => (
          <Badge key={label} variant="outline">
            {label} {formatDateTime(at)}
          </Badge>
        ))}
    </div>
  );
}
