import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  History,
  Mail,
  MapPin,
  Pencil,
  Phone,
  TrendingDown,
  TrendingUp,
  User,
  Warehouse,
} from "lucide-react";

import { PurchaseActions } from "@/app/(app)/purchases/[id]/purchase-actions";
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
import { PageHeader } from "@/components/ui/page-header";
import { PurchaseStatusBadge } from "@/components/ui/purchase-status-badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatCurrency, formatDate, formatDateTime, formatNumber } from "@/lib/format";
import { isEditable } from "@/lib/purchase-status";
import { getPurchaseDetail, type PurchaseDetail } from "@/server/purchases";
import { listSupplyLinksForPurchase } from "@/server/supply-links";
import { cn } from "@/lib/utils";

/**
 * A single purchase, and what it did to inventory.
 *
 * The Inventory Impact panel is built from the stock ledger — the STOCK_IN rows
 * the receipt wrote and the REVERSAL rows a cancellation wrote — rather than
 * from the purchase's status. The ledger is the record of what actually moved.
 *
 * Certificates are shown per line and read straight from each product. A
 * purchase references its products' paperwork; receiving a delivery never
 * creates or changes a certificate.
 */

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const result = await getPurchaseDetail((await params).id);

  return {
    title: result.ok && result.data ? result.data.purchaseNumber : "Purchase",
  };
}

export default async function PurchaseDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const result = await getPurchaseDetail(id);

  if (!result.ok) {
    return (
      <Card>
        <CardContent className="p-0">
          <ErrorState
            title="This purchase could not be loaded"
            message={result.error.message}
          />
        </CardContent>
      </Card>
    );
  }

  if (!result.data) notFound();

  const purchase = result.data;

  /*
   * Which order lines are waiting on each line of this delivery.
   *
   * Read-only here, and deliberately. A link is bounded by an order line's
   * outstanding quantity, so it is created and edited where that quantity
   * lives — the order page. This side answers the other half of the question,
   * "what is this delivery for", which is what somebody looking at an incoming
   * purchase actually wants to know.
   */
  const supplyLinks = await listSupplyLinksForPurchase(purchase.id);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Button variant="ghost" size="sm" asChild className="-ml-3 mb-2">
          <Link href="/purchases">
            <ArrowLeft />
            All purchases
          </Link>
        </Button>

        <PageHeader
          title={purchase.purchaseNumber}
          description={`Placed ${formatDate(purchase.purchaseDate)}${purchase.createdByName ? ` by ${purchase.createdByName}` : ""} with ${purchase.supplier.name}.`}
          actions={
            <>
              {isEditable(purchase.status) ? (
                <Button variant="outline" asChild>
                  <Link href={`/purchases/${purchase.id}/edit`}>
                    <Pencil />
                    Edit
                  </Link>
                </Button>
              ) : null}

              <PurchaseActions
                purchaseId={purchase.id}
                status={purchase.status}
                hasRetiredProducts={purchase.hasRetiredProducts}
                lines={purchase.lines.map((line) => ({
                  productName: line.productName,
                  quantity: line.quantity,
                  currentStock: line.currentStock,
                  productRetired: line.productRetired,
                }))}
              />
            </>
          }
        />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <PurchaseStatusBadge status={purchase.status} />
        <Timeline purchase={purchase} />
      </div>

      {purchase.hasRetiredProducts && purchase.status !== "CANCELLED" ? (
        <p className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm leading-relaxed text-destructive">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>
            A product on this purchase has been retired since it was raised. The
            line is still shown below — history stays readable — but the delivery
            cannot be booked in until the product is made active again or the
            line is removed.
          </span>
        </p>
      ) : null}

      <InventoryImpact purchase={purchase} />

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Products</CardTitle>
            <CardDescription>
              Unit costs are what the supplier invoiced on this delivery, which
              need not match the catalogue cost price.
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
                  <TableHead className="text-right">Unit cost</TableHead>
                  <TableHead className="text-right">Line total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {purchase.lines.map((line) => (
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
                      {line.productRetired ? (
                        <Badge variant="destructive" className="mt-1">
                          Retired
                        </Badge>
                      ) : null}
                    </TableCell>

                    <TableCell className="hidden md:table-cell">
                      {/*
                        Referenced, not copied. This reads the product's current
                        certificate — receiving a delivery never touches it.
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
                      {/*
                        Who is waiting for these units. An expectation only —
                        receiving this delivery fulfils none of these orders,
                        because which of several waiting customers gets a short
                        delivery is a commercial decision somebody makes on the
                        order itself.
                      */}
                      {(supplyLinks.get(line.id) ?? []).map((link) => (
                        <Link
                          key={link.id}
                          href={`/orders/${link.orderId}`}
                          className="mt-1 block text-xs font-normal text-muted-foreground hover:text-primary hover:underline"
                        >
                          <span className="font-mono">{link.orderNumber}</span>{" "}
                          ×{formatNumber(link.quantity)} · {link.customerName}
                        </Link>
                      ))}
                    </TableCell>
                    <TableCell className="tabular text-right">
                      {formatCurrency(line.unitCost)}
                    </TableCell>
                    <TableCell className="tabular text-right font-medium">
                      {formatCurrency(line.total)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            <dl className="flex flex-col gap-2 border-t border-border p-6 text-sm">
              {/*
                No tax row and no discount row. The total is the sum of the line
                totals — nothing else goes into it.
              */}
              <div className="flex items-center justify-between">
                <dt className="font-semibold">Grand total</dt>
                <dd className="tabular text-lg font-semibold">
                  {formatCurrency(purchase.total)}
                </dd>
              </div>
            </dl>
          </CardContent>
        </Card>

        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Supplier</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <p className="text-sm font-medium">{purchase.supplier.name}</p>

              {purchase.supplier.contactPerson ? (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <User className="size-3.5 shrink-0" aria-hidden />
                  {purchase.supplier.contactPerson}
                </p>
              ) : null}

              {purchase.supplier.email ? (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Mail className="size-3.5 shrink-0" aria-hidden />
                  <span className="truncate">{purchase.supplier.email}</span>
                </p>
              ) : null}

              {purchase.supplier.phone ? (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Phone className="size-3.5 shrink-0" aria-hidden />
                  {purchase.supplier.phone}
                </p>
              ) : null}

              {purchase.supplier.address ? (
                <p className="flex items-start gap-2 text-sm text-muted-foreground">
                  <MapPin className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                  <span>{purchase.supplier.address}</span>
                </p>
              ) : null}

              <dl className="mt-1 grid grid-cols-2 gap-3 border-t border-border pt-3">
                <div>
                  <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                    Purchases
                  </dt>
                  <dd className="tabular mt-0.5 text-lg font-semibold">
                    {formatNumber(purchase.supplier.purchaseCount)}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                    Total spent
                  </dt>
                  <dd className="tabular mt-0.5 text-lg font-semibold">
                    {formatCurrency(purchase.supplier.totalPurchased)}
                  </dd>
                  <dd className="mt-0.5 text-xs text-muted-foreground">
                    across {formatNumber(purchase.supplier.receivedCount)}{" "}
                    received
                  </dd>
                </div>
              </dl>

              <Button variant="outline" size="sm" asChild className="mt-1">
                <Link href={`/purchases?supplier=${purchase.supplier.id}`}>
                  All purchases from this supplier
                </Link>
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-sm">
                <History className="size-4 text-muted-foreground" aria-hidden />
                Purchase history
              </CardTitle>
              <CardDescription>
                Their most recent purchases, newest first.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              {purchase.supplier.recentPurchases.length === 0 ? (
                <EmptyState
                  icon={Warehouse}
                  title="No purchase history"
                  description="This is the only purchase recorded for this supplier."
                />
              ) : (
                <ul className="divide-y divide-border">
                  {purchase.supplier.recentPurchases.map((entry) => (
                    <li key={entry.id}>
                      <Link
                        href={`/purchases/${entry.id}`}
                        className={cn(
                          "flex items-center gap-3 px-6 py-3 transition-colors hover:bg-accent",
                          entry.id === purchase.id && "bg-muted/50",
                        )}
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block font-mono text-xs font-medium">
                            {entry.purchaseNumber}
                          </span>
                          <span className="block text-xs text-muted-foreground">
                            {formatDate(entry.purchaseDate)}
                          </span>
                        </span>
                        <PurchaseStatusBadge status={entry.status} />
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
 * What this purchase did to stock, read from the ledger.
 *
 * Shows the addition, and — once cancelled — the reversal underneath it, each
 * with the balances either side.
 */
function InventoryImpact({ purchase }: { purchase: PurchaseDetail }) {
  if (purchase.impact.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Inventory impact</CardTitle>
          <CardDescription>
            This purchase has not moved any stock. Quantities are added when it
            is received, and taken back if it is cancelled.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const reversed = purchase.impact.some((line) => line.reversed > 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {reversed ? "Inventory reversed" : "Inventory impact"}
        </CardTitle>
        <CardDescription>
          Read from the stock ledger — the movements this purchase actually
          wrote, not what its status implies.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {purchase.impact.map((line) => (
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

            {line.added > 0 ? (
              <ImpactRow
                tone="up"
                label={`${formatNumber(line.added)} units added`}
                from={line.addedFrom}
                to={line.addedTo}
              />
            ) : null}

            {line.reversed > 0 ? (
              <ImpactRow
                tone="down"
                label={`${formatNumber(line.reversed)} units removed`}
                from={line.reversedFrom}
                to={line.reversedTo}
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
  const Icon = tone === "up" ? TrendingUp : TrendingDown;

  return (
    <div className="flex flex-col gap-1.5">
      <p
        className={cn(
          "flex items-center gap-1.5 text-xs font-medium",
          tone === "up" ? "text-success" : "text-destructive",
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

/** The dates a purchase picked up on its way through, shown as they exist. */
function Timeline({ purchase }: { purchase: PurchaseDetail }) {
  const stamps: [string, Date | null][] = [
    ["Raised", purchase.createdAt],
    ["Received", purchase.receivedAt],
    ["Cancelled", purchase.cancelledAt],
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
