import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import {
  ArrowLeftRight,
  Boxes,
  CheckCircle2,
  FileWarning,
  Layers,
  PackageX,
  Scale,
  ShoppingCart,
  Truck,
  Wallet,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { OrderStatusBadge } from "@/components/ui/order-status-badge";
import { PageHeader } from "@/components/ui/page-header";
import { PurchaseStatusBadge } from "@/components/ui/purchase-status-badge";
import { StatCard } from "@/components/ui/stat-card";
import { StatCardSkeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { Currency } from "@/lib/currency";
import {
  formatCurrency,
  formatDate,
  formatDateTime,
  formatDelta,
  formatNumber,
} from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  loadAttention,
  loadCosting,
  loadInventory,
  loadProcurement,
  loadRecentMovements,
  loadSales,
  type CertificateAttentionLot,
} from "@/server/dashboard";
import { getCurrency } from "@/server/settings";

export const metadata: Metadata = { title: "Dashboard" };

/**
 * The operational dashboard.
 *
 * Ordered to answer one question — *what needs my attention right now?* — so
 * the section that can prompt action comes first and the sections that describe
 * the state of the business follow it.
 *
 * Every section loads independently behind its own Suspense boundary. A slow
 * aggregate delays its own card and nothing else, which matters more here than
 * anywhere: this is the page people leave open.
 *
 * Two rules run through the whole page. Operational figures — units, counts,
 * things needing action — are separated from financial ones, because "446 units
 * on hand" and "₹18,104 of stock" answer different questions and get read by
 * different people. And no money figure appears without saying what it covers:
 * a margin over a business whose costs are half unknown is not a margin, and
 * the costing section refuses to show one rather than flattering it.
 */

// Every figure is live, so this page must not be captured at build time.
export const dynamic = "force-dynamic";

export default function DashboardPage() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Dashboard"
        description="Stock health, open commitments, and what the business has actually done."
      />

      <Section
        emphasis
        title="Needs attention"
        description="Everything here is something somebody has to act on."
      >
        <Suspense fallback={<TileSkeletons count={4} />}>
          <AttentionSection />
        </Suspense>
      </Section>

      <Section
        title="Inventory"
        description="What is on the shelf, and what it cost to put there."
      >
        <Suspense fallback={<TileSkeletons count={4} />}>
          <InventorySection />
        </Suspense>
      </Section>

      {/*
        Costing sits directly under Inventory rather than after Procurement.
        "What is on the shelf" and "how much of what sold can be costed" are two
        halves of one question, and they used to be separated by both trading
        sections — around fifteen hundred pixels apart.
      */}
      <Section
        title="Costing & coverage"
        description="How much of what has been sold can actually be costed."
      >
        <Suspense fallback={<TileSkeletons count={4} />}>
          <CostingSection />
        </Suspense>
      </Section>

      <Section
        title="Sales"
        description="Revenue counts confirmed and completed orders. Drafts and cancellations are not revenue."
      >
        <Suspense fallback={<TileSkeletons count={4} />}>
          <SalesSection />
        </Suspense>
      </Section>

      <Section
        title="Procurement"
        description="Spend counts received purchases only. Drafts and cancellations are not spend."
      >
        <Suspense fallback={<TileSkeletons count={4} />}>
          <ProcurementSection />
        </Suspense>
      </Section>

      <Section title="Recent activity">
        <Suspense fallback={<TableFallback />}>
          <ActivitySection />
        </Suspense>
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Needs attention
// ---------------------------------------------------------------------------

async function AttentionSection() {
  const result = await loadAttention();

  if (!result.ok) return <SectionError message={result.error.message} />;

  const data = result.data;
  const { certificates } = data;
  const paperwork =
    certificates.expiredCount +
    certificates.expiringSoonCount +
    certificates.missingCount;

  const nothingToDo =
    paperwork === 0 &&
    data.actionableOrderCount === 0 &&
    data.outstandingPurchaseCount === 0;

  if (nothingToDo) {
    return (
      <Card>
        <CardContent className="p-0">
          <EmptyState
            icon={CheckCircle2}
            title="Nothing needs attention"
            description="No certificate problems, and no orders or deliveries outstanding."
          />
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <LinkedStat
          href="/orders"
          label="Orders to action"
          value={formatNumber(data.actionableOrderCount)}
          hint="Pending or confirmed — drafts excluded"
          icon={ShoppingCart}
        />
        <LinkedStat
          href="/purchases"
          label="Deliveries outstanding"
          value={formatNumber(data.outstandingPurchaseCount)}
          hint="Raised but not yet received"
          icon={Truck}
        />
      </div>

      {paperwork > 0 ? (
        /*
          The one table on this page whose rows are tasks rather than history.
          A tinted border is the whole distinction — it already carries a
          warning-toned icon, and anything more would be decoration on a list
          that is meant to be worked through and emptied.
        */
        <Card className="border-warning/35">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FileWarning className="size-4 text-warning" aria-hidden />
              Certificates needing attention
            </CardTitle>
            <CardDescription>
              {[
                certificates.expiredCount > 0
                  ? `${formatNumber(certificates.expiredCount)} expired`
                  : null,
                certificates.expiringSoonCount > 0
                  ? `${formatNumber(certificates.expiringSoonCount)} expiring within 30 days`
                  : null,
                certificates.missingCount > 0
                  ? `${formatNumber(certificates.missingCount)} with no certificate`
                  : null,
              ]
                .filter(Boolean)
                .join(" · ")}
              . Active products only.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Batch</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="hidden text-right sm:table-cell">
                    Expires
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {certificates.lots.map((lot) => (
                  <TableRow key={lot.lotId}>
                    <TableCell className="max-w-[18rem]">
                      <Link
                        href={`/products/${lot.productId}`}
                        className="block truncate font-medium hover:text-primary hover:underline"
                      >
                        {lot.name}
                      </Link>
                      <span className="font-mono text-xs text-muted-foreground">
                        {lot.sku} · {formatNumber(lot.quantityRemaining)}{" "}
                        {lot.quantityRemaining === 1 ? "unit" : "units"}
                      </span>
                    </TableCell>
                    <TableCell>
                      <CertificateBadge lot={lot} />
                    </TableCell>
                    <TableCell className="hidden text-right text-sm text-muted-foreground sm:table-cell">
                      {lot.expiryDate ? formatDate(lot.expiryDate) : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {certificates.hasMore ? (
              <p className="border-t px-6 py-3 text-xs text-muted-foreground">
                Showing the {certificates.lots.length} most urgent. Open a
                product to file or replace a batch&apos;s paperwork.
              </p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function CertificateBadge({ lot }: { lot: CertificateAttentionLot }) {
  if (lot.status === "MISSING") {
    return <Badge variant="muted">No certificate</Badge>;
  }

  if (lot.status === "EXPIRED") {
    const days = Math.abs(lot.daysRemaining ?? 0);
    return (
      <Badge variant="destructive">
        Expired {days === 0 ? "today" : `${formatNumber(days)}d ago`}
      </Badge>
    );
  }

  return (
    <Badge variant="warning">
      {lot.daysRemaining === 0
        ? "Expires today"
        : `${formatNumber(lot.daysRemaining ?? 0)}d left`}
    </Badge>
  );
}

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

async function InventorySection() {
  const [result, currency] = await Promise.all([
    loadInventory(),
    getCurrency(),
  ]);

  if (!result.ok) return <SectionError message={result.error.message} />;

  const data = result.data;
  const { retired } = data;

  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          compact
          label="Products"
          value={formatNumber(data.productCount)}
          hint={
            retired.productCount > 0
              ? `${formatNumber(retired.productCount)} no longer sellable`
              : "All sellable"
          }
          icon={Boxes}
        />
        <StatCard
          compact
          label="Units on hand"
          value={formatNumber(data.totalUnits)}
          hint="Across every product holding stock"
          icon={Layers}
        />
        <StatCard
          compact
          label="Value at cost"
          value={formatCurrency(data.stockValue, currency)}
          hint={
            data.uncostedUnits > 0
              ? `Covers ${formatNumber(data.costedUnits)} of ${formatNumber(data.totalUnits)} units`
              : "Every unit costed"
          }
          icon={Wallet}
          tone="success"
        />
        <StatCard
          compact
          label="Tied up in retired stock"
          value={formatCurrency(retired.value, currency)}
          hint={
            retired.units > 0
              ? `${formatNumber(retired.units)} units in inactive or discontinued products`
              : "Nothing held in retired products"
          }
          icon={PackageX}
          tone={retired.units > 0 ? "warning" : "default"}
        />
      </div>

      {data.uncostedUnits > 0 ? (
        <p className="rounded-lg border border-border bg-muted/40 p-3 text-xs leading-relaxed text-muted-foreground">
          {formatNumber(data.uncostedUnits)}{" "}
          {data.uncostedUnits === 1 ? "unit has" : "units have"} no recorded
          acquisition cost — stock that predates cost tracking, or that was
          counted in by hand. {data.uncostedUnits === 1 ? "It is" : "They are"}{" "}
          excluded from the value above rather than counted as free.
        </p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sales
// ---------------------------------------------------------------------------

async function SalesSection() {
  const [result, currency] = await Promise.all([
    loadSales(),
    getCurrency(),
  ]);

  if (!result.ok) return <SectionError message={result.error.message} />;

  const data = result.data;

  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          compact
          label="Realised revenue"
          value={formatCurrency(data.realisedRevenue, currency)}
          hint="Confirmed and completed orders"
          icon={Wallet}
          tone="success"
        />
        <StatCard
          compact
          label="Open order value"
          value={formatCurrency(data.openOrderValue, currency)}
          hint="Confirmed, not yet shipped"
          icon={ShoppingCart}
        />
        <StatCard
          compact
          label="Orders in flight"
          value={formatNumber(data.pendingCount + data.confirmedCount)}
          hint={`${formatNumber(data.pendingCount)} pending · ${formatNumber(data.confirmedCount)} confirmed`}
          icon={Layers}
        />
        <StatCard
          compact
          label="Completed"
          value={formatNumber(data.completedCount)}
          hint={`${formatNumber(data.draftCount)} draft · ${formatNumber(data.cancelledCount)} cancelled`}
          icon={CheckCircle2}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Recent orders</CardTitle>
          <CardAction>
            <Button variant="outline" size="sm" asChild>
              <Link href="/orders">View all</Link>
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent className="p-0">
          {data.recentOrders.length === 0 ? (
            <EmptyState
              icon={ShoppingCart}
              title="No orders yet"
              description="Orders raised for a customer appear here."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Order</TableHead>
                  <TableHead className="hidden sm:table-cell">
                    Customer
                  </TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead className="hidden text-right md:table-cell">
                    Raised
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.recentOrders.map((order) => (
                  <TableRow key={order.id}>
                    <TableCell>
                      <Link
                        href={`/orders/${order.id}`}
                        className="font-mono text-sm font-medium hover:text-primary hover:underline"
                      >
                        {order.orderNumber}
                      </Link>
                    </TableCell>
                    <TableCell className="hidden max-w-[14rem] truncate text-muted-foreground sm:table-cell">
                      {order.customerName}
                    </TableCell>
                    <TableCell>
                      <OrderStatusBadge status={order.status as never} />
                    </TableCell>
                    <TableCell className="tabular text-right font-medium">
                      {formatCurrency(order.total, currency)}
                    </TableCell>
                    <TableCell className="hidden text-right text-sm text-muted-foreground md:table-cell">
                      {formatDate(order.createdAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Procurement
// ---------------------------------------------------------------------------

async function ProcurementSection() {
  const [result, currency] = await Promise.all([
    loadProcurement(),
    getCurrency(),
  ]);

  if (!result.ok) return <SectionError message={result.error.message} />;

  const data = result.data;

  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          compact
          label="Received spend"
          value={formatCurrency(data.receivedSpend, currency)}
          hint="Goods actually delivered"
          icon={Wallet}
        />
        <StatCard
          compact
          label="Committed"
          value={formatCurrency(data.committedSpend, currency)}
          hint="Placed with a supplier, in transit"
          icon={Truck}
        />
        <StatCard
          compact
          label="Deliveries in flight"
          value={formatNumber(data.pendingCount)}
          hint={`${formatNumber(data.draftCount)} still being written`}
          icon={Layers}
        />
        <StatCard
          compact
          label="Received"
          value={formatNumber(data.receivedCount)}
          hint={`${formatNumber(data.cancelledCount)} cancelled`}
          icon={CheckCircle2}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Recent purchases</CardTitle>
          <CardAction>
            <Button variant="outline" size="sm" asChild>
              <Link href="/purchases">View all</Link>
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent className="p-0">
          {data.recentPurchases.length === 0 ? (
            <EmptyState
              icon={Truck}
              title="No purchases yet"
              description="Purchases raised with a supplier appear here."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Purchase</TableHead>
                  <TableHead className="hidden sm:table-cell">
                    Supplier
                  </TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead className="hidden text-right md:table-cell">
                    Placed
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.recentPurchases.map((purchase) => (
                  <TableRow key={purchase.id}>
                    <TableCell>
                      <Link
                        href={`/purchases/${purchase.id}`}
                        className="font-mono text-sm font-medium hover:text-primary hover:underline"
                      >
                        {purchase.purchaseNumber}
                      </Link>
                    </TableCell>
                    <TableCell className="hidden max-w-[14rem] truncate text-muted-foreground sm:table-cell">
                      {purchase.supplierName}
                    </TableCell>
                    <TableCell>
                      <PurchaseStatusBadge status={purchase.status as never} />
                    </TableCell>
                    <TableCell className="tabular text-right font-medium">
                      {formatCurrency(purchase.total, currency)}
                    </TableCell>
                    <TableCell className="hidden text-right text-sm text-muted-foreground md:table-cell">
                      {formatDate(purchase.purchaseDate)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Costing and coverage
// ---------------------------------------------------------------------------

async function CostingSection() {
  const [result, currency] = await Promise.all([
    loadCosting(),
    getCurrency(),
  ]);

  if (!result.ok) return <SectionError message={result.error.message} />;

  const data = result.data;

  /*
   * Coverage is read against *fulfilled* units, never units sold.
   *
   * A unit that has been sold but not shipped has no acquisition cost because
   * nothing has been acquired against it yet. Putting it in this denominator
   * would make a procurement backlog look like a costing failure, and the two
   * have nothing to do with each other — outstanding quantity is reported on
   * its own line below instead.
   */
  const coverage =
    data.fulfilledUnits === 0
      ? 0
      : (data.costedUnits / data.fulfilledUnits) * 100;
  const complete =
    data.fulfilledUnits > 0 && data.costedUnits === data.fulfilledUnits;

  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          compact
          label="Cost coverage"
          value={data.fulfilledUnits === 0 ? "—" : `${coverage.toFixed(1)}%`}
          hint={
            data.fulfilledUnits === 0
              ? data.unitsSold === 0
                ? "Nothing sold yet"
                : "Nothing fulfilled yet"
              : `${formatNumber(data.costedUnits)} of ${formatNumber(data.fulfilledUnits)} units fulfilled`
          }
          icon={Scale}
          tone={complete ? "success" : coverage === 0 ? "warning" : "default"}
        />
        {/*
          Shown as its own figure rather than left implicit, so the margin below
          reads as one tile minus the next. It is deliberately not called
          revenue: see the basis note under the meter.
        */}
        <StatCard
          compact
          label="Revenue from costed units"
          value={
            data.costedRevenue === null
              ? "—"
              : formatCurrency(data.costedRevenue, currency)
          }
          hint={
            data.costedRevenue === null
              ? "No sold units have a recorded cost"
              : `What ${formatNumber(data.costedUnits)} costed units sold for`
          }
          icon={ShoppingCart}
        />
        <StatCard
          compact
          label="Known cost of sales"
          value={data.knownCogs === null ? "—" : formatCurrency(data.knownCogs, currency)}
          hint={
            data.knownCogs === null
              ? "No sold units have a recorded cost"
              : `Over ${formatNumber(data.costedUnits)} costed units`
          }
          icon={Wallet}
        />
        <MarginTile data={data} currency={currency} />
      </div>

      {/*
        The coverage meter. A ratio the reader actually needs, drawn from a
        plain div rather than a charting dependency — the number is the point
        and the bar only makes it scannable.
      */}
      {data.fulfilledUnits > 0 || data.outstandingUnits > 0 ? (
        <div className="flex flex-col gap-2">
          <div
            className="relative h-2 w-full overflow-hidden rounded-full bg-muted"
            role="img"
            aria-label={`${formatNumber(data.costedUnits)} of ${formatNumber(data.fulfilledUnits)} fulfilled units have a recorded acquisition cost`}
          >
            <div
              className={cn(
                "absolute inset-y-0 left-0 rounded-full",
                complete ? "bg-success" : "bg-warning",
              )}
              style={{ width: `${Math.max(coverage, coverage > 0 ? 2 : 0)}%` }}
            />
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {data.fulfilledUnits === 0
              ? `None of the ${formatNumber(data.unitsSold)} units sold has been fulfilled from stock, so there is no cost of sale to report yet.`
              : complete
                ? `Every one of the ${formatNumber(data.fulfilledUnits)} units fulfilled has a recorded acquisition cost, so the margin above covers everything that has shipped.`
                : data.costedUnits === 0
                  ? `None of the ${formatNumber(data.fulfilledUnits)} units fulfilled has a recorded acquisition cost, so no margin can be calculated. Those units sold for ${formatCurrency(data.allRevenue, currency)}; what they cost is unknown. Coverage grows as stock received since cost tracking began is sold.`
                  : `Margin is calculated over ${formatNumber(data.costedUnits)} of ${formatNumber(data.fulfilledUnits)} units fulfilled. The remaining ${formatNumber(data.fulfilledUnits - data.costedUnits)} have no recorded acquisition cost and are excluded from both the cost and the revenue it is measured against.`}
          </p>

          {/*
            Outstanding quantity, kept well away from the coverage sentence
            above. These units are sold and not shipped; they are not uncosted,
            they are unacquired, and folding them into a coverage percentage
            would describe a procurement queue as a bookkeeping gap.
          */}
          {data.outstandingUnits > 0 ? (
            <p className="text-xs leading-relaxed text-muted-foreground">
              A further {formatNumber(data.outstandingUnits)}{" "}
              {data.outstandingUnits === 1 ? "unit is" : "units are"} sold but
              not yet fulfilled, so {data.outstandingUnits === 1 ? "it has" : "they have"}{" "}
              no cost of sale at all. {data.outstandingUnits === 1 ? "It joins" : "They join"}{" "}
              the figures above once the stock arrives and the order is
              fulfilled.
            </p>
          ) : null}
          {/*
            A paragraph reconciling two revenue bases used to sit here, because
            this section measured at list price while Sales reported revenue net
            of an order-level discount, and the two did not match. The discount
            feature is gone (§20), so there is one basis and nothing left to
            reconcile. Removed rather than reworded: an explanation of a
            difference that cannot occur is worse than no explanation at all.
          */}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The margin figure, or an explicit refusal to produce one.
 *
 * There is deliberately no path here that renders a number when nothing is
 * costed. `revenue - knownCost` on a business with no recorded costs reports
 * the entire revenue as profit — the single most damaging thing this page could
 * say, and the more damaging for looking entirely plausible.
 */
function MarginTile({
  data,
  currency,
}: {
  data: {
    margin: string | null;
    marginPercent: number | null;
    costedUnits: number;
    fulfilledUnits: number;
    unitsSold: number;
  };
  currency: Currency;
}) {
  if (data.margin === null) {
    /*
     * Three reasons for having no margin, and they are not interchangeable.
     * Nothing sold; sold but nothing shipped, so no cost exists yet; or
     * shipped from stock whose price was never recorded, which will never
     * resolve on its own. Saying the wrong one sends someone looking in the
     * wrong place.
     */
    return (
      <StatCard
        compact
        label="Realised margin"
        value="Not available"
        hint={
          data.unitsSold === 0
            ? "Nothing sold yet"
            : data.fulfilledUnits === 0
              ? "Nothing fulfilled yet, so there is no cost of sale"
              : "No fulfilled units have a recorded acquisition cost"
        }
        icon={Scale}
        tone="warning"
      />
    );
  }

  const complete = data.costedUnits === data.fulfilledUnits;

  return (
    <StatCard
      compact
      label="Realised margin"
      value={formatCurrency(data.margin, currency)}
      hint={
        complete
          ? `${(data.marginPercent ?? 0).toFixed(1)}% across every unit fulfilled`
          : `${(data.marginPercent ?? 0).toFixed(1)}% over ${formatNumber(data.costedUnits)} of ${formatNumber(data.fulfilledUnits)} units fulfilled`
      }
      icon={Scale}
      tone={Number(data.margin) < 0 ? "destructive" : "success"}
    />
  );
}

// ---------------------------------------------------------------------------
// Recent activity
// ---------------------------------------------------------------------------

async function ActivitySection() {
  const result = await loadRecentMovements();

  if (!result.ok) return <SectionError message={result.error.message} />;

  const movements = result.data;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Recent stock movements</CardTitle>
        <CardDescription>
          Every change to stock on hand, and what caused it.
        </CardDescription>
        <CardAction>
          <Button variant="outline" size="sm" asChild>
            <Link href="/stock-movements">View all</Link>
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="p-0">
        {movements.length === 0 ? (
          <EmptyState
            icon={ArrowLeftRight}
            title="No stock movements yet"
            description="Confirming an order or receiving a purchase writes a movement here automatically."
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Product</TableHead>
                <TableHead>Type</TableHead>
                <TableHead className="text-right">Change</TableHead>
                <TableHead className="text-right">Balance</TableHead>
                <TableHead className="hidden text-right md:table-cell">
                  When
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {movements.map((movement) => (
                <TableRow key={movement.id}>
                  <TableCell>
                    <span className="font-medium">{movement.productName}</span>
                    <span className="ml-2 font-mono text-xs text-muted-foreground">
                      {movement.productSku}
                    </span>
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
                  <TableCell className="hidden text-right text-muted-foreground md:table-cell">
                    {formatDateTime(movement.createdAt)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

function Section({
  title,
  description,
  emphasis = false,
  children,
}: {
  title: string;
  description?: string;
  /**
   * Marks the one section that can prompt action.
   *
   * Hierarchy here is a size ladder rather than an ornament: the page title is
   * 20px, this is 18px, and every reporting section below it is 16px. Before,
   * all six headings were the same size and position in the scroll was the only
   * thing saying which one mattered — on a page several screens tall, that is
   * not a signal.
   */
  emphasis?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2
          className={cn(
            "font-semibold tracking-tight",
            emphasis ? "text-lg" : "text-base",
          )}
        >
          {title}
        </h2>
        {description ? (
          <p className="text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {children}
    </section>
  );
}

/**
 * A stat tile that is also a link, for the figures that lead somewhere.
 *
 * Two of the eighteen tiles on this page are links, and they used to be
 * indistinguishable from the sixteen that are not. The tinted border says so
 * before the pointer arrives, which is what a keyboard user and anyone
 * scanning the page actually needs; the hover only confirms it. Border and
 * background rather than a shadow or a bright fill — this is a counter that
 * happens to lead somewhere, not a call to action.
 */
function LinkedStat({
  href,
  ...props
}: {
  href: string;
  label: string;
  value: string;
  hint: string;
  icon: React.ComponentProps<typeof StatCard>["icon"];
  tone?: React.ComponentProps<typeof StatCard>["tone"];
}) {
  return (
    <Link
      href={href}
      className="group rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {/*
        The transition names box-shadow explicitly. `transition-colors` alone
        looked right but silently replaced the tile's own `transition-shadow` —
        tailwind-merge treats every `transition-*` as one group — so these two
        tiles snapped their hover shadow while the other sixteen eased it.
      */}
      <StatCard
        {...props}
        compact
        className="h-full border-primary/30 transition-[box-shadow,border-color,background-color] group-hover:border-primary/60 group-hover:bg-accent/30"
      />
    </Link>
  );
}

function TileSkeletons({ count }: { count: number }) {
  return (
    <div
      className={cn(
        "grid gap-3 sm:grid-cols-2",
        count === 3 ? "lg:grid-cols-3" : "lg:grid-cols-4",
      )}
    >
      {Array.from({ length: count }, (_, index) => (
        <StatCardSkeleton key={index} compact />
      ))}
    </div>
  );
}

function TableFallback() {
  return (
    <Card>
      <CardContent className="p-6">
        <div className="h-40 animate-pulse rounded-lg bg-muted" />
      </CardContent>
    </Card>
  );
}

/**
 * One section failing does not take the page down.
 *
 * Each section reads independently, so a failure is scoped to the card that
 * could not load — the rest of the dashboard still renders. That matters most
 * when the database is briefly unreachable: the operator sees which figures
 * are missing rather than an empty page.
 */
function SectionError({ message }: { message: string }) {
  return (
    <Card>
      <CardContent className="p-0">
        <ErrorState title="This section could not be loaded" message={message} />
      </CardContent>
    </Card>
  );
}
