import type { Metadata } from "next";
import { Plus, Warehouse } from "lucide-react";

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

export const metadata: Metadata = { title: "Purchases" };

export default function PurchasesPage() {
  return (
    <ModulePlaceholder
      title="Purchases"
      description="Restocking orders raised with suppliers, and the goods received against them."
      icon={Warehouse}
      actions={
        <Button disabled>
          <Plus />
          New purchase
        </Button>
      }
      planned={[
        "Raise a purchase order against a supplier",
        "Receiving a purchase adds stock automatically",
        "Partial receipts against an outstanding order",
        "Update unit cost from the received price",
        "Purchase status pipeline: draft, ordered, received, cancelled",
        "Suggested reorder list from low-stock products",
      ]}
    >
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Purchase</TableHead>
                <TableHead>Supplier</TableHead>
                <TableHead>Raised</TableHead>
                <TableHead className="text-right">Items</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody />
          </Table>

          <EmptyState
            icon={Warehouse}
            title="No purchases yet"
            description="Marking a purchase as received will add the received quantity to stock automatically."
          />
        </CardContent>
      </Card>
    </ModulePlaceholder>
  );
}
