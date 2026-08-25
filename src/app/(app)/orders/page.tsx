import type { Metadata } from "next";
import { Plus, ShoppingCart } from "lucide-react";

import { ModulePlaceholder } from "@/components/module-placeholder";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export const metadata: Metadata = { title: "Orders" };

export default function OrdersPage() {
  return (
    <ModulePlaceholder
      title="Orders"
      description="Customer orders, from draft through confirmation to fulfilment."
      icon={ShoppingCart}
      actions={
        <Button disabled>
          <Plus />
          New order
        </Button>
      }
      planned={[
        "Build an order from catalogue items with live line totals",
        "Confirming an order deducts stock automatically",
        "Refuse confirmation when stock is insufficient",
        "Cancelling a confirmed order returns stock to the shelf",
        "Order status pipeline: draft, confirmed, fulfilled, cancelled",
        "Customer order history and reorder",
      ]}
    >
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Order</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>Date</TableHead>
                <TableHead className="text-right">Items</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody />
          </Table>

          <EmptyState
            icon={ShoppingCart}
            title="No orders yet"
            description="Once the orders module is built, confirming an order here will deduct the ordered quantity from stock automatically."
          />
        </CardContent>
      </Card>
    </ModulePlaceholder>
  );
}
