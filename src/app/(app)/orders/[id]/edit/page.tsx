import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Lock } from "lucide-react";

import { OrderBuilder } from "@/app/(app)/orders/order-builder";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { OrderStatusBadge } from "@/components/ui/order-status-badge";
import { PageHeader } from "@/components/ui/page-header";
import { isEditable, orderStatusLabel } from "@/lib/order-status";
import {
  getOrderDetail,
  loadCustomers,
  loadOrderProducts,
  searchOrderProducts,
} from "@/server/orders";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const result = await getOrderDetail((await params).id);

  return {
    title:
      result.ok && result.data ? `Edit ${result.data.orderNumber}` : "Edit order",
  };
}

/**
 * Editing an order's lines and customer.
 *
 * A page rather than a dialog, and the same builder the create page uses —
 * editing an order means the same work as raising one, and two copies of a
 * product search, a line table and a totals panel would drift.
 *
 * Two things this page does *not* do, both deliberately:
 *
 *   It does not touch inventory, and could not: `updateOrder` writes lines and
 *   money and has no path to the stock engine. Quantities move only on
 *   confirmation.
 *
 *   It does not decide who may edit. The status check below is so a person
 *   sees a sentence instead of a form that will refuse them — `updateOrder`
 *   re-checks it inside the transaction, with the order row locked, which is
 *   what actually stops a confirmed order being rewritten.
 */
export default async function EditOrderPage({
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

  if (!isEditable(order.status)) {
    return <NotEditable orderId={order.id} status={order.status} />;
  }

  /*
   * The products already on the order are loaded by id and *without* a status
   * filter, so a line whose product was retired since still appears. Dropping
   * it here would make it vanish from the form and silently disappear from the
   * order on save; the builder shows it, flags it, and blocks the save until
   * someone decides what to do with it.
   */
  const [customers, searchResults, lineProducts] = await Promise.all([
    /*
     * The order's own customer is requested by id as well as the active ones,
     * so an order raised before they were archived still shows who it is for.
     * Without that they would drop out of the picker and the form would look
     * like it had no customer selected.
     */
    loadCustomers(order.customerId),
    searchOrderProducts("", 20),
    loadOrderProducts(order.lines.map((line) => line.productId)),
  ]);

  const byId = new Map(lineProducts.map((product) => [product.id, product]));

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Button variant="ghost" size="sm" asChild className="-ml-3 mb-2">
          <Link href={`/orders/${order.id}`}>
            <ArrowLeft />
            Back to {order.orderNumber}
          </Link>
        </Button>

        <PageHeader
          title={`Edit ${order.orderNumber}`}
          description="Change the customer or the lines. Totals are recalculated from current prices when you save, and inventory is untouched until the order is confirmed."
          actions={<OrderStatusBadge status={order.status} />}
        />
      </div>

      <OrderBuilder
        customers={customers}
        initialProducts={searchResults}
        order={{
          id: order.id,
          orderNumber: order.orderNumber,
          customerId: order.customerId,
          /*
           * Each line keeps the price it was quoted at, read from the order and
           * not from the catalogue.
           *
           * This is the visible half of the re-pricing fix. It used to seed the
           * builder from the product's *current* price, because the server
           * recalculated from that on save — so opening a draft after a price
           * change silently showed, and then saved, a different quote than the
           * one that had been agreed. The price now round-trips: what was
           * quoted is what is shown, and what is shown is what is saved.
           */
          /*
           * The order's own currency, not the installation default. An order
           * agreed in euros keeps showing euros however the setting has moved
           * since — the default proposes one for a new document and has no say
           * over one already agreed.
           */
          currency: order.currency,
          lines: order.lines.flatMap((line) => {
            const product = byId.get(line.productId);
            return product
              ? [
                  {
                    product,
                    quantity: line.quantity,
                    unitPrice: line.unitPrice,
                    /*
                     * A saved price is the order's own figure, whatever
                     * originally suggested it, so a currency change must keep
                     * it for the operator to check rather than discard it.
                     */
                    priceSource: "manual" as const,
                  },
                ]
              : [];
          }),
        }}
      />
    </div>
  );
}

/**
 * Shown when someone reaches this URL for an order that has moved on — a stale
 * link, a back button, or a second tab. It explains rather than redirects, so
 * the reason is visible.
 */
function NotEditable({
  orderId,
  status,
}: {
  orderId: string;
  status: Parameters<typeof orderStatusLabel>[0];
}) {
  return (
    <Card>
      <CardContent className="p-0">
        <EmptyState
          icon={Lock}
          title={`This order is ${orderStatusLabel(status).toLowerCase()} and cannot be edited`}
          description={
            status === "CANCELLED"
              ? "A cancelled order is a record of something that did not happen. Raise a new order instead."
              : "Its stock has already been committed, so its lines are fixed — changing them would leave the document and the deduction behind it disagreeing."
          }
          action={
            <Button asChild>
              <Link href={`/orders/${orderId}`}>Back to the order</Link>
            </Button>
          }
        />
      </CardContent>
    </Card>
  );
}
