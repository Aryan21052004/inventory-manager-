import type { Metadata } from "next";
import { ArrowLeftRight, SlidersHorizontal } from "lucide-react";

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

export const metadata: Metadata = { title: "Stock Movements" };

export default function StockMovementsPage() {
  return (
    <ModulePlaceholder
      title="Stock Movements"
      description="The ledger behind every quantity — what changed, by how much, and why."
      icon={ArrowLeftRight}
      actions={
        <Button variant="outline" disabled>
          <SlidersHorizontal />
          Manual adjustment
        </Button>
      }
      planned={[
        "Append-only ledger of every stock change",
        "Filter by product, movement type, and date range",
        "Manual adjustments with a required reason",
        "Trace each movement back to its order or purchase",
        "Running balance per product",
        "Export to CSV for stocktake reconciliation",
      ]}
    >
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Product</TableHead>
                <TableHead>Type</TableHead>
                <TableHead className="text-right">Change</TableHead>
                <TableHead className="text-right">Balance after</TableHead>
                <TableHead>Reference</TableHead>
                <TableHead>By</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody />
          </Table>

          <EmptyState
            icon={ArrowLeftRight}
            title="No movements recorded"
            description="Movements are written automatically whenever stock changes, so this fills in as soon as orders and purchases start flowing."
          />
        </CardContent>
      </Card>
    </ModulePlaceholder>
  );
}
