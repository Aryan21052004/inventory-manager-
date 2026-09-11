import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ArrowLeft,
  ArrowRight,
  History,
  Mail,
  MapPin,
  Pencil,
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
import { RecordMoney } from "@/components/ui/money";
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
import type { Currency } from "@/lib/currency";
import { formatCurrency, formatDateTime, formatNumber } from "@/lib/format";
import {
  canFulfilOutstanding,
  isEditable,
  type OrderStatus,
} from "@/lib/order-status";
import { coverageNote, marginOf, totalCoverage } from "@/lib/cost-coverage";
import { OrderItemImages } from "@/app/(app)/orders/[id]/order-item-images";
import { SupplyLinkManager } from "@/app/(app)/supply-links/supply-link-manager";
import {
  getOrderDetail,
  type OrderDetail,
  type OrderDetailLine,
} from "@/server/orders";
import { listOrderItemImages } from "@/server/order-item-images";
import { getCurrency } from "@/server/settings";
import {
  listLinkablePurchaseLines,
  listSupplyLinksForOrder,
} from "@/server/supply-links";
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
  const [result, currency] = await Promise.all([
    getOrderDetail(id),
    getCurrency(),
  ]);

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

  /*
   * What is expected to cover each still-outstanding line, and what else could.
   *
   * Read here rather than inside `getOrderDetail` because a supply link is not
   * part of the order: it is a note about somebody else's document, and folding
   * it into the order loader would make every reader of that shape carry a
   * field about a purchase. Only lines that still owe something can be covered,
   * so the options are fetched for those alone.
   */
  const supplyLinks = await listSupplyLinksForOrder(order.id);

  /*
   * The photographs on each line, read here rather than inside `getOrderDetail`
   * so that loader's shape stays about the sale. The bytes are deliberately not
   * fetched — each row carries the authenticated URL a browser uses to ask for
   * one image at a time.
   */
  const imagesByLine = await listOrderItemImages(order.id);

  /*
   * Photographs may only be managed while the order is confirmed or completed,
   * because `updateOrder` replaces an editable order's lines wholesale and the
   * images cascade with them. The same predicate the server enforces, so the
   * screen cannot offer something the action would refuse.
   */
  const canManageImages = canFulfilOutstanding(order.status);

  /*
   * DRAFT and PENDING cannot carry images, for the reason above. Rendering
   * nothing at all on those orders left the feature looking absent rather than
   * not yet available, so the line says which it is. Presentation only — the
   * server still refuses the write either way.
   */
  const imagesAwaitConfirmation = isEditable(order.status);

  const linkableByLine = new Map<
    string,
    Awaited<ReturnType<typeof listLinkablePurchaseLines>>
  >(
    await Promise.all(
      order.lines
        .filter(
          (line) =>
            line.quantity > line.fulfilledQuantity &&
            canFulfilOutstanding(order.status),
        )
        .map(
          async (line) =>
            [line.id, await listLinkablePurchaseLines(line.id)] as const,
        ),
    ),
  );

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
            <>
              {/*
                Only offered while the order has committed nothing. The edit
                page and `updateOrder` both re-check this — hiding the button is
                a courtesy, not the control.
              */}
              {isEditable(order.status) ? (
                <Button variant="outline" asChild>
                  <Link href={`/orders/${order.id}/edit`}>
                    <Pencil />
                    Edit order
                  </Link>
                </Button>
              ) : null}

              <OrderActions
                orderId={order.id}
                status={order.status}
                lines={order.lines.map((line) => ({
                  orderItemId: line.id,
                  productName: line.productName,
                  quantity: line.quantity,
                  fulfilledQuantity: line.fulfilledQuantity,
                  returnedQuantity: line.returnedQuantity,
                  returnableQuantity: line.returnableQuantity,
                  currentStock: line.currentStock,
                }))}
              />
            </>
          }
        />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <OrderStatusBadge status={order.status} />
        <Timeline order={order} />
      </div>

      <InventoryImpact order={order} />

      <div className="grid gap-6 lg:grid-cols-3">
        {/*
          `min-w-0` is load-bearing. A grid item defaults to `min-width: auto`,
          so it refuses to shrink below its content — which means the products
          table's `overflow-x-auto` wrapper is never actually constrained and
          the whole page scrolls sideways on a narrow screen instead of the
          table scrolling inside its card. Latent until the Fulfilled column
          made the table one column wider than a phone could hold.
        */}
        <Card className="min-w-0 lg:col-span-2">
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
                  <TableHead className="text-right">Ordered</TableHead>
                  <TableHead className="text-right">Fulfilled</TableHead>
                  <TableHead className="text-right">Unit price</TableHead>
                  <TableHead className="hidden text-right md:table-cell">
                    Cost
                  </TableHead>
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

                      {/*
                        This line's photographs, under the part they are of.
                        Renders nothing only on a cancelled order with none —
                        the one case where there is neither anything to show
                        nor anything that could later be added.
                      */}
                      <OrderItemImages
                        orderItemId={line.id}
                        productName={line.productName}
                        images={imagesByLine.get(line.id) ?? []}
                        canManage={canManageImages}
                        awaitingConfirmation={imagesAwaitConfirmation}
                      />
                    </TableCell>

                    <TableCell className="hidden md:table-cell">
                      {/*
                        The batches this line actually drew from, read through
                        StockLotConsumption. Referenced, not copied: if a lot's
                        paperwork is replaced tomorrow this page shows the new
                        document, because the order never owned a copy.

                        An order can draw across several batches in different
                        states. All of them are listed — picking one would be
                        presenting a guess as the answer.
                      */}
                      {line.lotCertificates.length === 0 ? (
                        <span className="text-xs text-muted-foreground">
                          Not yet drawn from stock
                        </span>
                      ) : (
                        <div className="flex flex-col gap-2">
                          {line.lotCertificates.map((lot) => (
                            <div key={lot.lotId} className="flex flex-col gap-1">
                              <CertificateStatusBadge
                                status={lot.certificateStatus}
                              />
                              <span className="text-xs text-muted-foreground">
                                {formatNumber(lot.quantity)}{" "}
                                {lot.quantity === 1 ? "unit" : "units"}
                                {lot.purchaseNumber
                                  ? ` · ${lot.purchaseNumber}`
                                  : ""}
                              </span>
                              {lot.certificateType ? (
                                <span className="text-xs text-muted-foreground">
                                  {lot.certificateType}
                                  {lot.certificateNumber
                                    ? ` · ${lot.certificateNumber}`
                                    : ""}
                                </span>
                              ) : null}
                            </div>
                          ))}
                        </div>
                      )}
                    </TableCell>

                    <TableCell className="tabular text-right font-medium">
                      {formatNumber(line.quantity)}
                    </TableCell>
                    {/*
                      What has physically left, and what is still owed. Two
                      facts about the same line rather than a status: an order
                      confirmed against a shelf that could not fill it ships
                      what exists and carries the difference until stock
                      arrives.

                      The shortfall is only called *outstanding* once the order
                      has committed. On a draft nothing has been promised yet,
                      and on a cancelled order nothing is owed any more — in
                      both the subtraction still yields the full quantity, and
                      printing that as an obligation would invent one.
                      `canFulfilOutstanding` is exactly that question, and is
                      the same predicate the server enforces.
                    */}
                    <TableCell className="tabular text-right">
                      {formatNumber(line.fulfilledQuantity)}
                      {line.fulfilledQuantity < line.quantity &&
                      canFulfilOutstanding(order.status) ? (
                        <>
                          <span className="block text-xs text-muted-foreground">
                            {formatNumber(
                              line.quantity - line.fulfilledQuantity,
                            )}{" "}
                            outstanding
                          </span>
                          {/*
                            Which delivery is expected to clear it. Advisory
                            only: nothing here ships anything, and the Fulfil
                            action stays the sole route from outstanding to
                            shipped.
                          */}
                          <SupplyLinkManager
                            orderItemId={line.id}
                            productName={line.productName}
                            outstandingQuantity={
                              line.quantity - line.fulfilledQuantity
                            }
                            links={supplyLinks.get(line.id) ?? []}
                            options={linkableByLine.get(line.id) ?? []}
                          />
                        </>
                      ) : null}
                    </TableCell>
                    <TableCell className="tabular text-right">
                      <RecordMoney amount={line.unitPrice} currency={order.currency} />
                    </TableCell>
                    <TableCell className="tabular hidden text-right text-sm md:table-cell">
                      <LineCost line={line} currency={currency} />
                    </TableCell>
                    <TableCell className="tabular text-right font-medium">
                      <RecordMoney amount={line.total} currency={order.currency} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            <dl className="flex flex-col gap-2 border-t border-border p-6 text-sm">
              <div className="flex items-center justify-between">
                <dt className="text-muted-foreground">Subtotal</dt>
                <dd className="tabular font-medium">
                  <RecordMoney amount={order.subtotal} currency={order.currency} />
                </dd>
              </div>
              {/*
                No tax row and no discount row. The grand total is the subtotal,
                and the database's check constraint refuses anything else.
              */}
              <div className="flex items-center justify-between border-t border-border pt-3">
                <dt className="font-semibold">Grand total</dt>
                <dd className="tabular text-lg font-semibold">
                  <RecordMoney amount={order.total} currency={order.currency} />
                </dd>
              </div>
              <OrderMargin
                lines={order.lines}
                status={order.status}
                currency={currency}
              />
            </dl>
          </CardContent>
        </Card>

        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Customer</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <Link
                href={`/customers/${order.customerId}`}
                className="text-sm font-medium hover:text-primary hover:underline"
              >
                {order.customerName}
              </Link>

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
                          <RecordMoney
                            amount={entry.total}
                            currency={entry.currency}
                          />
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

/**
 * The cost of one line, with its coverage when the two differ.
 *
 * Three states kept apart on purpose. An unconfirmed order has no cost of sale
 * at all — the stock has not left, so there is nothing to cost. A line drawn
 * entirely from stock nobody priced shows "Unknown" rather than a dash that
 * could be read as free. And a line straddling both shows what it can vouch
 * for, with the shortfall named underneath.
 */
function LineCost({
  line,
  currency,
}: {
  line: OrderDetailLine;
  currency: Currency;
}) {
  if (line.costTotal === null) {
    return <span className="text-muted-foreground">—</span>;
  }

  /*
   * Coverage is measured against what shipped, not against what was ordered.
   * An outstanding unit has no acquisition cost because nothing has been
   * acquired for it yet; calling it uncosted here would put a procurement
   * backlog in a column about money.
   */
  const partial = line.costedQuantity < line.fulfilledQuantity;

  return (
    <span className="inline-flex flex-col items-end">
      <span>{formatCurrency(line.costTotal, currency)}</span>
      {partial ? (
        <span className="text-xs text-muted-foreground">
          {formatNumber(line.costedQuantity)} of{" "}
          {formatNumber(line.fulfilledQuantity)} fulfilled costed
        </span>
      ) : null}
    </span>
  );
}

/**
 * Gross margin on the order, over the units whose cost is known.
 *
 * Renders nothing at all before confirmation: an order that has not moved stock
 * has no cost of sale, and a margin row reading "100%" against a null cost
 * would be worse than absent.
 *
 * The arithmetic deliberately apportions revenue to the costed units rather
 * than setting the whole order's revenue against a partial cost. That second
 * form is the tempting one — total minus known cost — and it silently reports
 * uncosted stock as pure profit. Where coverage is incomplete the shortfall is
 * spelled out underneath in units, so the figure is never mistaken for the
 * whole picture.
 */
function OrderMargin({
  lines,
  status,
  currency,
}: {
  lines: OrderDetailLine[];
  status: OrderStatus;
  currency: Currency;
}) {
  const results = lines.map((line) =>
    marginOf({
      quantity: line.quantity,
      fulfilledQuantity: line.fulfilledQuantity,
      unitPrice: Number(line.unitPrice),
      costTotal: line.costTotal === null ? null : Number(line.costTotal),
      costedQuantity: line.costedQuantity,
    }),
  );

  const coverage = totalCoverage(results);
  if (coverage.costedQuantity === 0 && coverage.quantity === 0) return null;

  const cost = results.reduce((sum, result) => sum + result.cost, 0);
  const revenue = results.reduce((sum, result) => sum + result.revenue, 0);
  const margin = revenue - cost;

  /*
   * Nothing costed, and there are now three reasons for that. They are not
   * interchangeable, and saying the wrong one sends the reader somewhere
   * useless.
   *
   * An order that has not been confirmed has no cost of sale yet — it will get
   * one when it is. An order that *has* been confirmed but shipped nothing,
   * because the shelf was empty, has no cost of sale either, and for a
   * completely different reason: nothing has been acquired against it, so
   * there is nothing to price. And an order that shipped units drawn entirely
   * from batches nobody priced will never get one at all.
   *
   * The middle case is the one this page used to get wrong. It reported "the
   * stock this order consumed has no recorded acquisition cost" for an order
   * that had consumed no stock whatsoever, which reads as a costing failure
   * when it is a procurement queue.
   *
   * None of the three is a margin of zero, which is the one answer this must
   * never give.
   */
  if (coverage.costedQuantity === 0) {
    const moved = status === "CONFIRMED" || status === "COMPLETED";
    const outstanding = coverage.quantity - coverage.fulfilledQuantity;

    return (
      <div className="flex items-center justify-between gap-6 border-t border-border pt-3 text-xs text-muted-foreground">
        <dt>Gross margin</dt>
        <dd className="text-right">
          {lines.length === 0
            ? "—"
            : !moved
              ? "Not available until the order is confirmed"
              : coverage.fulfilledQuantity === 0
                ? `Not available — nothing has been fulfilled from stock yet, so this order has no cost of sale. ${formatNumber(outstanding)} ${outstanding === 1 ? "unit is" : "units are"} outstanding.`
                : "Not available — the stock this order consumed has no recorded acquisition cost"}
        </dd>
      </div>
    );
  }

  const note = coverageNote(coverage);

  return (
    <div className="flex flex-col gap-1 border-t border-border pt-3">
      <div className="flex items-center justify-between">
        <dt className="text-muted-foreground">Cost of goods sold</dt>
        <dd className="tabular font-medium">{formatCurrency(cost, currency)}</dd>
      </div>
      <div className="flex items-center justify-between">
        <dt className="text-muted-foreground">Gross margin</dt>
        <dd
          className={cn(
            "tabular font-medium",
            margin < 0 ? "text-destructive" : "text-success",
          )}
        >
          {formatCurrency(margin, currency)}
          {revenue > 0 ? (
            <span className="ml-1.5 text-xs text-muted-foreground">
              ({((margin / revenue) * 100).toFixed(1)}%)
            </span>
          ) : null}
        </dd>
      </div>
      {note ? (
        <p className="pt-1 text-xs text-muted-foreground">{note}</p>
      ) : null}
    </div>
  );
}
