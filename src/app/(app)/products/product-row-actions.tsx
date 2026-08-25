"use client";

import { useState } from "react";
import Link from "next/link";
import {
  Eye,
  MoreHorizontal,
  Pencil,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";

import { DeleteProductDialog } from "@/app/(app)/products/delete-product-dialog";
import {
  ProductFormDialog,
  type ProductFormValues,
  type SupplierOption,
} from "@/app/(app)/products/product-form-dialog";
import { StockAdjustmentDialog } from "@/app/(app)/products/stock-adjustment-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * The per-row actions menu.
 *
 * The dialogs are siblings of the menu rather than children of it. A Radix
 * dropdown unmounts its content when it closes, so a dialog opened from inside
 * one would be torn down in the same moment it appeared; the menu item sets a
 * piece of state and the dialog, which lives outside, reacts to it.
 *
 * `canManage` hides what an admin-only action would be. It hides — it does not
 * protect. Every action behind these items re-checks the role on the server
 * against our own database, because a hidden button stops nobody who can open
 * devtools and call the action directly.
 */

function ProductRowActions({
  product,
  categories,
  suppliers,
  canManage,
}: {
  product: ProductFormValues & { deletable?: boolean };
  categories: string[];
  suppliers: SupplierOption[];
  canManage: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [adjusting, setAdjusting] = useState(false);
  const [deleting, setDeleting] = useState(false);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" aria-label={`Actions for ${product.name}`}>
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>

        <DropdownMenuContent align="end">
          <DropdownMenuItem asChild>
            <Link href={`/products/${product.id}`}>
              <Eye />
              View details
            </Link>
          </DropdownMenuItem>

          {canManage ? (
            <>
              <DropdownMenuItem onSelect={() => setEditing(true)}>
                <Pencil />
                Edit product
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setAdjusting(true)}>
                <SlidersHorizontal />
                Adjust stock
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onSelect={() => setDeleting(true)}
              >
                <Trash2 />
                Delete
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      {canManage ? (
        <>
          <ProductFormDialog
            open={editing}
            onOpenChange={setEditing}
            product={product}
            categories={categories}
            suppliers={suppliers}
          />
          <StockAdjustmentDialog
            open={adjusting}
            onOpenChange={setAdjusting}
            product={product}
          />
          <DeleteProductDialog
            open={deleting}
            onOpenChange={setDeleting}
            product={product}
          />
        </>
      ) : null}
    </>
  );
}

export { ProductRowActions };
