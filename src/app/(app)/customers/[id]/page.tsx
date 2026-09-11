import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  Archive,
  ArrowLeft,
  CalendarClock,
  Mail,
  MapPin,
  Phone,
  ReceiptText,
  ShoppingCart,
  Wallet,
} from "lucide-react";

import { CustomerDetailActions } from "@/app/(app)/customers/[id]/customer-detail-actions";
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
import { OrderStatusBadge } from "@/components/ui/order-status-badge";
import { PageHeader } from "@/components/ui/page-header";
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
import { getCustomerDetail, type CustomerDetail } from "@/server/customers";

/**
 * A single customer, and everything they have bought.
 *
 * The order history is the point of the page. A contact card on its own is an
 * address book entry; the history underneath is what makes it a customer
 * record, and it is the reason archiving has to be non-destructive — the orders
 * below keep pointing here whatever the status says.
 */

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const result = await getCustomerDetail((await params).id);

  return {
    title: result.ok && result.data ? result.data.name : "Customer",
  };
}

export default async function CustomerDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const [result, user] = await Promise.all([
    getCustomerDetail(id),
    getCurrentUser(),
  ]);

  if (!result.ok) {
    return (
      <Card>
        <CardContent className="p-0">
          <ErrorState
            title="This customer could not be loaded"
            message={result.error.message}
          />
        </CardContent>
      </Card>
    );
  }

  if (!result.data) notFound();

  const customer = result.data;
  const canManage = user?.role === "ADMIN";
  const archived = customer.status === "INACTIVE";

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Button variant="ghost" size="sm" asChild className="-ml-3 mb-2">
          <Link href="/customers">
            <ArrowLeft />
            All customers
          </Link>
        </Button>

        <PageHeader
          title={customer.name}
          description={`Added ${formatDate(customer.createdAt)}${
            customer.lastOrderAt
              ? ` · last ordered ${formatDate(customer.lastOrderAt)}`
              : " · no orders yet"
          }.`}
          actions={
            <CustomerDetailActions canManage={canManage} customer={customer} />
          }
        />
      </div>

      {/*
        Said plainly rather than left to a small pill. Archiving is routinely
        mistaken for deletion, and the person reading this page needs to know
        both halves: they are out of the picker, and nothing else changed.
      */}
      {archived ? (
        <div className="flex items-start gap-3 rounded-xl border border-border bg-muted/40 p-4">
          <Archive className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
          <div className="text-sm">
            <p className="font-medium">This customer is archived</p>
            <p className="mt-0.5 text-muted-foreground">
              They will not appear when raising a new order. Their existing
              orders are untouched and still counted below.
            </p>
          </div>
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Orders"
          value={formatNumber(customer.orderCount)}
          hint={openHint(customer)}
          icon={ShoppingCart}
        />
        <StatCard
          label="Lifetime value"
          value={<MoneyLines total={customer.lifetimeValueByCurrency} stackedClassName="text-lg" />}
          hint="Confirmed and completed"
          icon={Wallet}
          tone="success"
        />
        <StatCard
          label="Open value"
          value={<MoneyLines total={customer.openValueByCurrency} stackedClassName="text-lg" />}
          hint="Drafts and pending orders"
          icon={ReceiptText}
        />
        <StatCard
          label="Last order"
          value={
            customer.lastOrderAt ? formatDate(customer.lastOrderAt) : "Never"
          }
          hint={
            customer.lastOrderAt
              ? formatDateTime(customer.lastOrderAt)
              : "Nothing raised for them yet"
          }
          icon={CalendarClock}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <CardHeader>
            <CardTitle>Contact details</CardTitle>
            <CardDescription>How to reach them.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <ContactRow icon={Mail} label="Email">
              {customer.email ? (
                <a
                  href={`mailto:${customer.email}`}
                  className="hover:text-primary hover:underline"
                >
                  {customer.email}
                </a>
              ) : (
                <span className="text-muted-foreground">Not given</span>
              )}
            </ContactRow>

            <ContactRow icon={Phone} label="Phone">
              {customer.phone ?? (
                <span className="text-muted-foreground">Not given</span>
              )}
            </ContactRow>

            <ContactRow icon={MapPin} label="Address">
              {customer.address ? (
                <span className="whitespace-pre-line">{customer.address}</span>
              ) : (
                <span className="text-muted-foreground">Not given</span>
              )}
            </ContactRow>

            <div className="flex items-center justify-between border-t border-border pt-4 text-sm">
              <span className="text-muted-foreground">Status</span>
              <Badge variant={archived ? "muted" : "success"}>
                {archived ? "Archived" : "Active"}
              </Badge>
            </div>
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Order history</CardTitle>
            <CardDescription>
              {customer.hasMoreOrders
                ? `Their ${formatNumber(customer.orders.length)} most recent orders, of ${formatNumber(customer.orderCount)}.`
                : "Every order raised for them, most recent first."}
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {customer.orders.length === 0 ? (
              <EmptyState
                icon={ShoppingCart}
                title="No orders yet"
                description="Nothing has been raised for this customer. Their record is here and ready when it is."
                action={
                  archived ? undefined : (
                    <Button asChild>
                      <Link href={`/orders/new?customer=${customer.id}`}>
                        New order
                      </Link>
                    </Button>
                  )
                }
              />
            ) : (
              <>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Order</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="hidden text-right sm:table-cell">
                        Items
                      </TableHead>
                      <TableHead className="text-right">Total</TableHead>
                      <TableHead className="hidden md:table-cell">
                        Raised
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {customer.orders.map((order) => (
                      <TableRow key={order.id}>
                        <TableCell>
                          <Link
                            href={`/orders/${order.id}`}
                            className="font-mono text-xs font-medium hover:text-primary hover:underline"
                          >
                            {order.orderNumber}
                          </Link>
                        </TableCell>
                        <TableCell>
                          <OrderStatusBadge status={order.status} />
                        </TableCell>
                        <TableCell className="tabular hidden text-right text-muted-foreground sm:table-cell">
                          {formatNumber(order.itemCount)}
                        </TableCell>
                        <TableCell className="tabular text-right font-medium">
                          <RecordMoney amount={order.total} currency={order.currency} />
                        </TableCell>
                        <TableCell className="hidden text-muted-foreground md:table-cell">
                          {formatDateTime(order.createdAt)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>

                <div className="border-t border-border p-4">
                  <Button variant="outline" size="sm" asChild>
                    <Link href={`/orders?customer=${customer.id}`}>
                      All orders from this customer
                    </Link>
                  </Button>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

/**
 * The hint under the order count: how many are still open, which is the number
 * somebody looking at a customer actually wants — the total is history, the
 * open ones are work.
 */
function openHint(customer: CustomerDetail): string {
  const open = customer.statusCounts.DRAFT + customer.statusCounts.PENDING;

  if (customer.orderCount === 0) return "None raised yet";
  if (open === 0) return "None open";

  return `${formatNumber(open)} still open`;
}

function ContactRow({
  icon: Icon,
  label,
  children,
}: {
  icon: typeof Mail;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-3 text-sm">
      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">
          {label}
        </p>
        <div className="mt-0.5 break-words">{children}</div>
      </div>
    </div>
  );
}
