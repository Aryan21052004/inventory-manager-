import type { Metadata } from "next";
import { Package } from "lucide-react";

import { NewProductDialog } from "@/app/(app)/products/new-product-dialog";
import { ModulePlaceholder } from "@/components/module-placeholder";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export const metadata: Metadata = { title: "Products" };

export default function ProductsPage() {
  return (
    <ModulePlaceholder
      title="Products"
      description="Your catalogue, with cost, price, and stock on hand for every item."
      icon={Package}
      actions={<NewProductDialog />}
      planned={[
        "Create, edit, archive and restore catalogue items",
        "Search, category filters, and sortable columns",
        "Derived stock status: in stock, low, out of stock",
        "Per-product movement history and stock valuation",
        "Category and supplier assignment",
        "Bulk import from CSV",
      ]}
    >
      <Card>
        <CardContent className="p-0">
          {/* The header row shows the eventual shape of the table; rows arrive
              with the products module. */}
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>SKU</TableHead>
                <TableHead>Product</TableHead>
                <TableHead>Category</TableHead>
                <TableHead className="text-right">On hand</TableHead>
                <TableHead className="text-right">Unit cost</TableHead>
                <TableHead className="text-right">Unit price</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody />
          </Table>

          <EmptyState
            icon={Package}
            title="No products yet"
            description="Add your first product to start tracking stock. The form is live — saving arrives with the products module."
          />
        </CardContent>
      </Card>
    </ModulePlaceholder>
  );
}
