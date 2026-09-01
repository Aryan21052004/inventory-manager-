import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ArrowLeft,
  ArrowLeftRight,
  ArrowDown,
  ArrowUp,
  ChevronsUpDown,
  Download,
  SearchX,
} from "lucide-react";

import { ReportFilters } from "@/app/(app)/reports/report-filters";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { PageHeader } from "@/components/ui/page-header";
import { Pagination } from "@/components/ui/pagination";
import { StatCard } from "@/components/ui/stat-card";
import { TableSkeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { RawSearchParams } from "@/lib/date-range";
import { formatCurrency, formatNumber } from "@/lib/format";
import {
  describeRange,
  isReportKey,
  reportCsvHref,
  reportHref,
  reportParamsFor,
  reportRowLabel,
  reportSortHref,
  REPORT_CONFIG,
  REPORT_DESCRIPTIONS,
  REPORT_TITLES,
  toReportSearchParams,
  type ReportKey,
  type ReportParams,
} from "@/lib/report-query";
import { cn } from "@/lib/utils";
import { loadCategories } from "@/server/products";
import {
  loadMovementSummaryReport,
  loadPurchaseSpendReport,
  loadSalesReport,
  loadValuationReport,
} from "@/server/reports";

/**
 * One report, whichever it is.
 *
 * They share a shape — filters, summary tiles, a sortable paged table, a CSV
 * button — so they share a page rather than four near-identical copies.
 * What differs is the columns and the sentence explaining what the figures
 * mean, and that sentence is not decoration: a report gets exported and
 * forwarded, and the basis has to travel with it.
 *
 * The table streams behind Suspense so the filter bar paints immediately.
 */

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ report: string }>;
}): Promise<Metadata> {
  const { report } = await params;
  return {
    title: isReportKey(report) ? REPORT_TITLES[report] : "Report",
  };
}

export default async function ReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ report: string }>;
  searchParams: Promise<RawSearchParams>;
}) {
  const { report } = await params;
  if (!isReportKey(report)) notFound();

  const config = REPORT_CONFIG[report];
  const reportParams = reportParamsFor(report, await searchParams);
  const defaults = {
    grouping: config.defaultGrouping,
    sort: config.defaultSort,
  };

  const categories = await loadCategories();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Button variant="ghost" size="sm" asChild className="-ml-3 mb-2">
          <Link href="/reports">
            <ArrowLeft />
            All reports
          </Link>
        </Button>

        <PageHeader
          title={REPORT_TITLES[report]}
          description={REPORT_DESCRIPTIONS[report]}
          actions={
            <Button variant="outline" asChild>
              {/* A plain link, not a fetch: the browser downloads it, and the
                  route checks the session before a row is read. */}
              <a href={reportCsvHref(report, reportParams, defaults)} download>
                <Download />
                Export CSV
              </a>
            </Button>
          }
        />
      </div>

      <Card>
        <CardContent className="p-0">
          <ReportFilters
            report={report}
            params={reportParams}
            defaults={defaults}
            groupings={config.groupings}
            categories={categories}
            /* Only the movement summary filters by ledger type. */
            movementTypes={report === "movements"}
          />

          <Suspense
            key={toReportSearchParams(reportParams, defaults).toString()}
            fallback={<TableSkeleton rows={8} columns={6} />}
          >
            {report === "valuation" ? (
              <ValuationBody params={reportParams} defaults={defaults} />
            ) : report === "sales" ? (
              <SalesBody params={reportParams} defaults={defaults} />
            ) : report === "purchases" ? (
              <PurchaseBody params={reportParams} defaults={defaults} />
            ) : (
              <MovementBody params={reportParams} defaults={defaults} />
            )}
          </Suspense>
        </CardContent>
      </Card>
    </div>
  );
}

type Defaults = { grouping: string; sort: string };

// ---------------------------------------------------------------------------
// R1 · Stock valuation
// ---------------------------------------------------------------------------

async function ValuationBody({
  params,
  defaults,
}: {
  params: ReportParams;
  defaults: Defaults;
}) {
  const result = await loadValuationReport(params);

  if (!result.ok) {
    return (
      <ErrorState
        title="This report could not be loaded"
        message={result.error.message}
      />
    );
  }

  const { rows, totals, total, page, pageCount, pageSize } = result.data;

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={SearchX}
        title="No stock to value"
        description="Nothing matches the current filters, or no product is holding stock."
      />
    );
  }

  return (
    <>
      <div className="grid gap-4 border-b border-border p-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Value at cost"
          value={formatCurrency(totals.valueAtCost)}
          hint={`Covers ${formatNumber(totals.costedUnits)} of ${formatNumber(totals.units)} units`}
          icon={ChevronsUpDown}
          tone="success"
        />
        <StatCard
          label="Value at retail"
          value={formatCurrency(totals.valueAtRetail)}
          hint="Quantity × selling price — a different basis"
          icon={ChevronsUpDown}
        />
        <StatCard
          label="Uncosted units"
          value={formatNumber(totals.uncostedUnits)}
          hint={
            totals.uncostedUnits > 0
              ? "Excluded from value, never valued at zero"
              : "Every unit costed"
          }
          icon={ChevronsUpDown}
          tone={totals.uncostedUnits > 0 ? "warning" : "default"}
        />
        <StatCard
          label="Retired stock"
          value={formatCurrency(totals.retiredValueAtCost)}
          hint={`${formatNumber(totals.retiredUnits)} units in ${formatNumber(totals.retiredProducts)} inactive or discontinued products`}
          icon={ChevronsUpDown}
          tone={totals.retiredUnits > 0 ? "warning" : "default"}
        />
      </div>

      <BasisNote>
        <span className="font-medium text-foreground">Value at cost</span> is
        what was actually paid, summed over the batches still on the shelf, and
        covers only units with a recorded acquisition cost.{" "}
        <span className="font-medium text-foreground">Value at retail</span> is
        quantity times selling price — a different basis, not a second estimate
        of cost. Uncosted units are excluded from the cost figure rather than
        valued at zero or at the catalogue&apos;s standard cost.
      </BasisNote>

      <Table>
        <TableHeader>
          <TableRow>
            <SortHead report="valuation" params={params} defaults={defaults} column="sku">
              SKU
            </SortHead>
            <SortHead report="valuation" params={params} defaults={defaults} column="name">
              Product
            </SortHead>
            <SortHead
              report="valuation"
              params={params}
              defaults={defaults}
              column="category"
              className="hidden lg:table-cell"
            >
              Category
            </SortHead>
            <SortHead
              report="valuation"
              params={params}
              defaults={defaults}
              column="units"
              className="text-right"
              align="right"
            >
              Units
            </SortHead>
            <SortHead
              report="valuation"
              params={params}
              defaults={defaults}
              column="uncosted"
              className="hidden text-right sm:table-cell"
              align="right"
            >
              Uncosted
            </SortHead>
            <SortHead
              report="valuation"
              params={params}
              defaults={defaults}
              column="value"
              className="text-right"
              align="right"
            >
              At cost
            </SortHead>
            <SortHead
              report="valuation"
              params={params}
              defaults={defaults}
              column="retail"
              className="hidden text-right md:table-cell"
              align="right"
            >
              At retail
            </SortHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.productId}>
              <TableCell className="font-mono text-xs">
                <Link
                  href={`/products/${row.productId}`}
                  className="hover:text-primary hover:underline"
                >
                  {row.sku}
                </Link>
              </TableCell>
              <TableCell className="max-w-[18rem] truncate">
                {row.name}
                {row.productStatus !== "ACTIVE" ? (
                  <Badge variant="muted" className="ml-2">
                    {row.productStatus === "INACTIVE"
                      ? "Inactive"
                      : "Discontinued"}
                  </Badge>
                ) : null}
              </TableCell>
              <TableCell className="hidden lg:table-cell">
                <Badge variant="outline">{row.category}</Badge>
              </TableCell>
              <TableCell className="tabular text-right">
                {formatNumber(row.units)}
              </TableCell>
              <TableCell className="tabular hidden text-right sm:table-cell">
                {row.uncostedUnits > 0 ? (
                  <span className="text-warning">
                    {formatNumber(row.uncostedUnits)}
                  </span>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </TableCell>
              <TableCell className="tabular text-right font-medium">
                {formatCurrency(row.valueAtCost)}
              </TableCell>
              <TableCell className="tabular hidden text-right text-muted-foreground md:table-cell">
                {formatCurrency(row.valueAtRetail)}
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
        hrefFor={(next) =>
          reportHref("valuation", { ...params, page: next }, defaults)
        }
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// R2 · Sales
// ---------------------------------------------------------------------------

async function SalesBody({
  params,
  defaults,
}: {
  params: ReportParams;
  defaults: Defaults;
}) {
  const result = await loadSalesReport(params);

  if (!result.ok) {
    return (
      <ErrorState
        title="This report could not be loaded"
        message={result.error.message}
      />
    );
  }

  const { rows, totals, total, page, pageCount, pageSize } = result.data;
  const apportioned =
    params.grouping === "product" || params.grouping === "category";

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={SearchX}
        title="No sales in this period"
        description={`Nothing was confirmed between ${describeRange(params).toLowerCase()}. Widen the period, or clear the filters.`}
      />
    );
  }

  return (
    <>
      <div className="grid gap-4 border-b border-border p-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Realised revenue"
          value={formatCurrency(totals.realisedRevenue)}
          hint="After order-level discounts"
          icon={ChevronsUpDown}
          tone="success"
        />
        <StatCard
          label="Sales at list price"
          value={formatCurrency(totals.salesAtListPrice)}
          hint="Before order-level discounts"
          icon={ChevronsUpDown}
        />
        <StatCard
          label="Discounts"
          value={formatCurrency(totals.discounts)}
          hint="The gap between the two figures"
          icon={ChevronsUpDown}
        />
        <StatCard
          label="Orders"
          value={formatNumber(totals.orders)}
          hint={`${formatNumber(totals.units)} units · ${describeRange(params)}`}
          icon={ChevronsUpDown}
        />
      </div>

      <BasisNote>
        Confirmed and completed orders only, dated by{" "}
        <span className="font-medium text-foreground">
          when each was confirmed
        </span>{" "}
        — the moment stock left. Drafts and cancellations are excluded.{" "}
        {apportioned ? (
          <>
            Realised revenue is blank for this grouping: an order-level discount
            applies to a whole order, and this system does not apportion one
            across the lines rather than invent a rule for splitting it.
          </>
        ) : (
          <>
            Realised revenue is after order-level discounts; sales at list price
            is before them.
          </>
        )}
      </BasisNote>

      <Table>
        <TableHeader>
          <TableRow>
            <SortHead report="sales" params={params} defaults={defaults} column="label">
              {params.grouping === "period" ? "Month" : "Group"}
            </SortHead>
            <SortHead
              report="sales"
              params={params}
              defaults={defaults}
              column="orders"
              className="text-right"
              align="right"
            >
              Orders
            </SortHead>
            <SortHead
              report="sales"
              params={params}
              defaults={defaults}
              column="units"
              className="hidden text-right sm:table-cell"
              align="right"
            >
              Units
            </SortHead>
            <SortHead
              report="sales"
              params={params}
              defaults={defaults}
              column="value"
              className="text-right"
              align="right"
            >
              At list price
            </SortHead>
            <SortHead
              report="sales"
              params={params}
              defaults={defaults}
              column="revenue"
              className="text-right"
              align="right"
            >
              Realised revenue
            </SortHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.key}>
              <TableCell className="max-w-[20rem]">
                <span className="font-medium">{row.label}</span>
                {row.sublabel ? (
                  <span className="ml-2 font-mono text-xs text-muted-foreground">
                    {row.sublabel}
                  </span>
                ) : null}
              </TableCell>
              <TableCell className="tabular text-right">
                {formatNumber(row.orders)}
              </TableCell>
              <TableCell className="tabular hidden text-right sm:table-cell">
                {formatNumber(row.units)}
              </TableCell>
              <TableCell className="tabular text-right font-medium">
                {formatCurrency(row.salesAtListPrice)}
              </TableCell>
              <TableCell className="tabular text-right font-medium">
                {row.realisedRevenue === null ? (
                  <span
                    className="text-muted-foreground"
                    title="An order-level discount is not apportioned across lines"
                  >
                    Not apportioned
                  </span>
                ) : (
                  formatCurrency(row.realisedRevenue)
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
        hrefFor={(next) =>
          reportHref("sales", { ...params, page: next }, defaults)
        }
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// R3 · Purchase spend
// ---------------------------------------------------------------------------

async function PurchaseBody({
  params,
  defaults,
}: {
  params: ReportParams;
  defaults: Defaults;
}) {
  const result = await loadPurchaseSpendReport(params);

  if (!result.ok) {
    return (
      <ErrorState
        title="This report could not be loaded"
        message={result.error.message}
      />
    );
  }

  const { rows, totals, total, page, pageCount, pageSize } = result.data;

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={SearchX}
        title="No deliveries in this period"
        description={`Nothing was received between ${describeRange(params).toLowerCase()}. Widen the period, or clear the filters.`}
      />
    );
  }

  return (
    <>
      <div className="grid gap-4 border-b border-border p-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Received spend"
          value={formatCurrency(totals.receivedSpend)}
          hint="Goods actually delivered"
          icon={ChevronsUpDown}
          tone="success"
        />
        <StatCard
          label="Committed"
          value={formatCurrency(totals.committedSpend)}
          hint={`${formatNumber(totals.committedPurchases)} pending — not counted as spend`}
          icon={ChevronsUpDown}
        />
        <StatCard
          label="Deliveries"
          value={formatNumber(totals.purchases)}
          hint={describeRange(params)}
          icon={ChevronsUpDown}
        />
        <StatCard
          label="Units received"
          value={formatNumber(totals.units)}
          hint="Across every delivery in the period"
          icon={ChevronsUpDown}
        />
      </div>

      <BasisNote>
        Received purchases only, dated by{" "}
        <span className="font-medium text-foreground">
          when each delivery arrived
        </span>
        . Drafts and cancellations are excluded, and pending purchases are shown
        as committed rather than spent.{" "}
        <span className="font-medium text-foreground">
          Spend is not cost of sales
        </span>{" "}
        — buying and selling are different events at different times, and this
        figure must not be subtracted from revenue to produce a margin.
      </BasisNote>

      <Table>
        <TableHeader>
          <TableRow>
            <SortHead
              report="purchases"
              params={params}
              defaults={defaults}
              column="label"
            >
              {params.grouping === "period" ? "Month" : "Group"}
            </SortHead>
            <SortHead
              report="purchases"
              params={params}
              defaults={defaults}
              column="purchases"
              className="text-right"
              align="right"
            >
              Deliveries
            </SortHead>
            <SortHead
              report="purchases"
              params={params}
              defaults={defaults}
              column="units"
              className="hidden text-right sm:table-cell"
              align="right"
            >
              Units
            </SortHead>
            <SortHead
              report="purchases"
              params={params}
              defaults={defaults}
              column="value"
              className="text-right"
              align="right"
            >
              Received spend
            </SortHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.key}>
              <TableCell className="max-w-[20rem]">
                <span className="font-medium">{row.label}</span>
                {row.sublabel ? (
                  <span className="ml-2 font-mono text-xs text-muted-foreground">
                    {row.sublabel}
                  </span>
                ) : null}
              </TableCell>
              <TableCell className="tabular text-right">
                {formatNumber(row.purchases)}
              </TableCell>
              <TableCell className="tabular hidden text-right sm:table-cell">
                {formatNumber(row.units)}
              </TableCell>
              <TableCell className="tabular text-right font-medium">
                {formatCurrency(row.receivedSpend)}
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
        hrefFor={(next) =>
          reportHref("purchases", { ...params, page: next }, defaults)
        }
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// R4 · Stock movement summary
// ---------------------------------------------------------------------------

async function MovementBody({
  params,
  defaults,
}: {
  params: ReportParams;
  defaults: Defaults;
}) {
  const result = await loadMovementSummaryReport(params);

  if (!result.ok) {
    return (
      <ErrorState
        title="This report could not be loaded"
        message={result.error.message}
      />
    );
  }

  const { rows, totals, total, page, pageCount, pageSize } = result.data;

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={SearchX}
        title="No movements in this period"
        description={`Nothing moved in or out between ${describeRange(params).toLowerCase()}. Widen the period, or clear the filters.`}
      />
    );
  }

  return (
    <>
      <div className="grid gap-4 border-b border-border p-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Units in"
          value={formatNumber(totals.unitsIn)}
          hint="Everything that added stock"
          icon={ArrowDown}
          tone="success"
        />
        <StatCard
          label="Units out"
          value={formatNumber(totals.unitsOut)}
          hint="Everything that took stock away"
          icon={ArrowUp}
        />
        <StatCard
          label="Net change"
          value={formatNumber(totals.netChange)}
          hint="Units in minus units out"
          icon={ArrowLeftRight}
          tone={totals.netChange < 0 ? "warning" : "default"}
        />
        <StatCard
          label="Movements"
          value={formatNumber(totals.movements)}
          hint={`Across ${formatNumber(totals.products)} ${totals.products === 1 ? "product" : "products"}`}
          icon={ChevronsUpDown}
        />
      </div>

      <BasisNote>
        Dated by{" "}
        <span className="font-medium text-foreground">
          when each movement was recorded in the ledger
        </span>
        , which is the moment the stock actually moved.{" "}
        <span className="font-medium text-foreground">
          Direction is read from the balance a movement left behind
        </span>
        , not from its type — so a cancellation counts against the movement it
        undid, and both stay visible as separate movements. Opening stock and
        manual adjustments are included even though no document explains them.
        Stock that predates the ledger has no movement and is not reported here.
        For the individual rows — the reference document, who recorded it, the
        note and the cost — see{" "}
        <Link href="/stock-movements" className="font-medium text-foreground underline underline-offset-4">
          stock movements
        </Link>
        .
      </BasisNote>

      <Table>
        <TableHeader>
          <TableRow>
            <SortHead
              report="movements"
              params={params}
              defaults={defaults}
              column="label"
            >
              {params.grouping === "period"
                ? "Month"
                : params.grouping === "type"
                  ? "Movement type"
                  : "Group"}
            </SortHead>
            <SortHead
              report="movements"
              params={params}
              defaults={defaults}
              column="movements"
              className="text-right"
              align="right"
            >
              Movements
            </SortHead>
            <SortHead
              report="movements"
              params={params}
              defaults={defaults}
              column="products"
              className="hidden text-right lg:table-cell"
              align="right"
            >
              Products
            </SortHead>
            <SortHead
              report="movements"
              params={params}
              defaults={defaults}
              column="in"
              className="hidden text-right sm:table-cell"
              align="right"
            >
              Units in
            </SortHead>
            <SortHead
              report="movements"
              params={params}
              defaults={defaults}
              column="out"
              className="hidden text-right sm:table-cell"
              align="right"
            >
              Units out
            </SortHead>
            <SortHead
              report="movements"
              params={params}
              defaults={defaults}
              column="net"
              className="text-right"
              align="right"
            >
              Net change
            </SortHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.key}>
              <TableCell className="max-w-[20rem]">
                <span className="font-medium">
                  {reportRowLabel(params.grouping, row.label)}
                </span>
                {row.sublabel ? (
                  <span className="ml-2 font-mono text-xs text-muted-foreground">
                    {row.sublabel}
                  </span>
                ) : null}
              </TableCell>
              <TableCell className="tabular text-right">
                {formatNumber(row.movements)}
              </TableCell>
              <TableCell className="tabular hidden text-right lg:table-cell">
                {formatNumber(row.products)}
              </TableCell>
              <TableCell className="tabular hidden text-right text-success sm:table-cell">
                {row.unitsIn === 0 ? "—" : formatNumber(row.unitsIn)}
              </TableCell>
              <TableCell className="tabular hidden text-right sm:table-cell">
                {row.unitsOut === 0 ? "—" : formatNumber(row.unitsOut)}
              </TableCell>
              <TableCell
                className={cn(
                  "tabular text-right font-medium",
                  row.netChange < 0 && "text-destructive",
                )}
              >
                {row.netChange > 0 ? "+" : ""}
                {formatNumber(row.netChange)}
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
        hrefFor={(next) =>
          reportHref("movements", { ...params, page: next }, defaults)
        }
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

/**
 * The sentence that says what the numbers above it mean.
 *
 * Not optional decoration. These figures get exported and forwarded, and
 * somebody reading a spreadsheet three weeks later has only what the report
 * told them.
 */
function BasisNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="border-b border-border bg-muted/40 px-6 py-3 text-xs leading-relaxed text-muted-foreground">
      {children}
    </p>
  );
}

function SortHead({
  report,
  params,
  defaults,
  column,
  children,
  className,
  align = "left",
}: {
  report: ReportKey;
  params: ReportParams;
  defaults: Defaults;
  column: string;
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
        href={reportSortHref(report, params, defaults, column)}
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
