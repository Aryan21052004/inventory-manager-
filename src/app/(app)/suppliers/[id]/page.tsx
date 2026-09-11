import type { ReactNode } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  Archive,
  ArrowLeft,
  Boxes,
  CalendarClock,
  Hash,
  Mail,
  MapPin,
  Phone,
  Truck,
  Wallet,
  Warehouse,
} from "lucide-react";

import { SupplierDetailActions } from "@/app/(app)/suppliers/[id]/supplier-detail-actions";
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
import { MoneyLines, RecordMoney } from "@/components/ui/money";
import { ErrorState } from "@/components/ui/error-state";
import { PageHeader } from "@/components/ui/page-header";
import { PurchaseStatusBadge } from "@/components/ui/purchase-status-badge";
import { StatCard } from "@/components/ui/stat-card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  formatDate,
  formatDateTime,
  formatNumber,
} from "@/lib/format";
import { getCurrentUser } from "@/server/auth";
import { getSupplierDetail, type SupplierDetail } from "@/server/suppliers";

/**
 * A single supplier, and everything traceable back to them.
 *
 * Four panels, and the last is the one this page exists for. A contact card is
 * an address book entry; the purchase history makes it a supplier record; and
 * the stock panel closes the loop the costing layer opened — it reads the lots
 * still on the shelf back through the purchases that delivered them, so the
 * question "what are we holding from this supplier, and what did it cost"
 * finally has an answer.
 *
 * That panel is a *read* of the existing lots, not a second inventory
 * calculation. Nothing here writes anything.
 */

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const result = await getSupplierDetail((await params).id);

  return {
    title: result.ok && result.data ? result.data.name : "Supplier",
  };
}

export default async function SupplierDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const [result, user] = await Promise.all([
    getSupplierDetail(id),
    getCurrentUser(),
  ]);

  if (!result.ok) {
    return (
      <Card>
        <CardContent className="p-0">
          <ErrorState
            title="This supplier could not be loaded"
            message={result.error.message}
          />
        </CardContent>
      </Card>
    );
  }

  if (!result.data) notFound();

  const supplier = result.data;
  const canManage = user?.role === "ADMIN";
  const archived = supplier.status === "INACTIVE";

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Button variant="ghost" size="sm" asChild className="-ml-3 mb-2">
          <Link href="/suppliers">
            <ArrowLeft />
            All suppliers
          </Link>
        </Button>

        <PageHeader
          title={supplier.name}
          description={
            supplier.contactPerson
              ? `${supplier.contactPerson} · added ${formatDate(supplier.createdAt)}`
              : `Added ${formatDate(supplier.createdAt)}`
          }
          actions={
            <SupplierDetailActions supplier={supplier} canManage={canManage} />
          }
        />
      </div>

      {archived ? (
        <div className="flex items-start gap-3 rounded-lg border border-border bg-muted/40 p-4">
          <Archive
            className="mt-0.5 size-4 shrink-0 text-muted-foreground"
            aria-hidden
          />
          <p className="text-sm text-muted-foreground">
            <span className="font-medium text-foreground">Archived.</span> This
            supplier is not offered when raising a new purchase or assigning a
            supplier to a product. Everything below is untouched — their
            purchases still name them, a pending delivery can still be received,
            and the stock they supplied keeps its acquisition cost.
          </p>
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Purchases"
          value={formatNumber(supplier.purchaseCount)}
          hint={`${formatNumber(supplier.receivedCount)} received`}
          icon={Truck}
        />
        <StatCard
          label="Total purchased"
          value={<MoneyLines total={supplier.totalPurchasedByCurrency} stackedClassName="text-lg" />}
          hint="Received purchases only"
          icon={Wallet}
          tone="success"
        />
        <StatCard
          label="Products supplied"
          value={formatNumber(supplier.productCount)}
          hint="Catalogue items sourced here"
          icon={Boxes}
        />
        <StatCard
          label="Stock on hand"
          value={formatNumber(supplier.stockOnHand.units)}
          hint={
            supplier.stockOnHand.units === 0
              ? "Nothing traceable to them"
              : `Across ${formatNumber(supplier.stockOnHand.productCount)} product${supplier.stockOnHand.productCount === 1 ? "" : "s"}`
          }
          icon={Warehouse}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <CardHeader>
            <CardTitle>Contact details</CardTitle>
            <CardDescription>How to reach this supplier.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <DetailRow label="Contact person" icon={undefined}>
              {supplier.contactPerson ?? (
                <span className="text-muted-foreground">Not recorded</span>
              )}
            </DetailRow>

            <DetailRow label="Email" icon={Mail}>
              {supplier.email ? (
                <a
                  href={`mailto:${supplier.email}`}
                  className="hover:text-primary hover:underline"
                >
                  {supplier.email}
                </a>
              ) : (
                <span className="text-muted-foreground">Not recorded</span>
              )}
            </DetailRow>

            <DetailRow label="Phone" icon={Phone}>
              {supplier.phone ?? (
                <span className="text-muted-foreground">Not recorded</span>
              )}
            </DetailRow>

            <DetailRow label="Account number" icon={Hash}>
              {supplier.accountNumber ? (
                <span className="font-mono text-sm">
                  {supplier.accountNumber}
                </span>
              ) : (
                <span className="text-muted-foreground">Not recorded</span>
              )}
            </DetailRow>

            <DetailRow label="Typical lead time" icon={CalendarClock}>
              {supplier.typicalLeadTimeDays === null ? (
                <span className="text-muted-foreground">Not recorded</span>
              ) : (
                <span className="tabular">
                  {formatNumber(supplier.typicalLeadTimeDays)}{" "}
                  {supplier.typicalLeadTimeDays === 1 ? "day" : "days"}
                </span>
              )}
            </DetailRow>

            <DetailRow label="Address" icon={MapPin}>
              {supplier.address ? (
                <span className="whitespace-pre-line">{supplier.address}</span>
              ) : (
                <span className="text-muted-foreground">Not recorded</span>
              )}
            </DetailRow>

            <DetailRow label="Status" icon={undefined}>
              <Badge variant={archived ? "muted" : "success"}>
                {archived ? "Archived" : "Active"}
              </Badge>
            </DetailRow>

            {supplier.firstPurchaseAt ? (
              <DetailRow label="Trading since" icon={undefined}>
                <span className="text-sm text-muted-foreground">
                  {formatDate(supplier.firstPurchaseAt)}
                  {supplier.lastPurchaseAt
                    ? ` · last ${formatDate(supplier.lastPurchaseAt)}`
                    : ""}
                </span>
              </DetailRow>
            ) : null}
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Stock on hand from this supplier</CardTitle>
            <CardDescription>
              Units still held that arrived on one of their deliveries, valued
              at what was actually paid.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {supplier.stockOnHand.units === 0 ? (
              <EmptyState
                icon={Warehouse}
                title="No stock traceable to this supplier"
                description="Either nothing they delivered is left, or their deliveries predate lot costing."
              />
            ) : (
              <div className="flex flex-col gap-4">
                <div className="grid gap-4 sm:grid-cols-3">
                  <Figure
                    label="Units on hand"
                    value={formatNumber(supplier.stockOnHand.units)}
                  />
                  <Figure
                    label="Value at cost"
                    value={<MoneyLines total={supplier.stockOnHand.valueByCurrency} stackedClassName="text-lg" />}
                  />
                  <Figure
                    label="Products"
                    value={formatNumber(supplier.stockOnHand.productCount)}
                  />
                </div>

                {/*
                  The coverage disclosure, in the same terms as everywhere else.
                  Stock whose acquisition cost was never established is excluded
                  from the value rather than valued at zero or at a guess, and
                  saying so is what stops the figure being read as the whole.
                */}
                {supplier.stockOnHand.uncostedUnits > 0 ? (
                  <p className="rounded-lg border border-border bg-muted/40 p-3 text-xs leading-relaxed text-muted-foreground">
                    Valued over{" "}
                    {formatNumber(supplier.stockOnHand.costedUnits)} of{" "}
                    {formatNumber(supplier.stockOnHand.units)} units.{" "}
                    {formatNumber(supplier.stockOnHand.uncostedUnits)}{" "}
                    {supplier.stockOnHand.uncostedUnits === 1
                      ? "unit has"
                      : "units have"}{" "}
                    no recorded acquisition cost and{" "}
                    {supplier.stockOnHand.uncostedUnits === 1 ? "is" : "are"}{" "}
                    excluded from the figure above.
                  </p>
                ) : null}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Purchase history</CardTitle>
          <CardDescription>
            {supplier.hasMorePurchases
              ? `The 25 most recent of ${formatNumber(supplier.purchaseCount)}.`
              : "Every purchase raised with this supplier."}
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {supplier.purchases.length === 0 ? (
            <EmptyState
              icon={Truck}
              title="Nothing bought yet"
              description="Purchases raised with this supplier will appear here."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Purchase</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="hidden text-right sm:table-cell">
                    Lines
                  </TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead className="hidden md:table-cell">Placed</TableHead>
                  <TableHead className="hidden lg:table-cell">
                    Received
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {supplier.purchases.map((purchase) => (
                  <TableRow key={purchase.id}>
                    <TableCell>
                      <Link
                        href={`/purchases/${purchase.id}`}
                        className="font-mono text-sm font-medium hover:text-primary hover:underline"
                      >
                        {purchase.purchaseNumber}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <PurchaseStatusBadge status={purchase.status} />
                    </TableCell>
                    <TableCell className="tabular hidden text-right text-muted-foreground sm:table-cell">
                      {formatNumber(purchase.itemCount)}
                    </TableCell>
                    <TableCell className="tabular text-right font-medium">
                      <RecordMoney amount={purchase.total} currency={purchase.currency} />
                    </TableCell>
                    <TableCell className="hidden text-sm text-muted-foreground md:table-cell">
                      {formatDate(purchase.purchaseDate)}
                    </TableCell>
                    <TableCell className="hidden text-sm text-muted-foreground lg:table-cell">
                      {purchase.receivedAt
                        ? formatDateTime(purchase.receivedAt)
                        : "—"}
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
          <CardTitle>Products supplied</CardTitle>
          <CardDescription>
            {supplier.hasMoreProducts
              ? `The first 50 of ${formatNumber(supplier.productCount)} catalogue items sourced here.`
              : "Catalogue items sourced from this supplier."}
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {supplier.products.length === 0 ? (
            <EmptyState
              icon={Boxes}
              title="No products assigned"
              description="Products can name a supplier on the product form. None currently name this one."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Product</TableHead>
                  <TableHead className="hidden sm:table-cell">
                    Category
                  </TableHead>
                  <TableHead className="text-right">On hand</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {supplier.products.map((product) => (
                  <TableRow key={product.id}>
                    <TableCell className="max-w-[18rem]">
                      <Link
                        href={`/products/${product.id}`}
                        className="block truncate font-medium hover:text-primary hover:underline"
                      >
                        {product.name}
                      </Link>
                      <span className="font-mono text-xs text-muted-foreground">
                        {product.sku}
                      </span>
                    </TableCell>
                    <TableCell className="hidden sm:table-cell">
                      <Badge variant="outline">{product.category}</Badge>
                    </TableCell>
                    <TableCell className="tabular text-right font-medium">
                      {formatNumber(product.stockQuantity)}
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

function DetailRow({
  label,
  icon: Icon,
  children,
}: {
  label: string;
  icon: React.ComponentType<{ className?: string }> | undefined;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="inline-flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {Icon ? <Icon className="size-3.5" aria-hidden /> : null}
        {label}
      </span>
      <span className="text-sm">{children}</span>
    </div>
  );
}

function Figure({
  label,
  value,
}: {
  label: string;
  /** Widened for money that spans currencies — see `MoneyLines`. */
  value: ReactNode;
}) {
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className="tabular mt-1 text-2xl font-semibold tracking-tight">
        {value}
      </p>
    </div>
  );
}

export type { SupplierDetail };
