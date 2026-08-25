"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Pencil, SlidersHorizontal, Trash2 } from "lucide-react";

import { DeleteProductDialog } from "@/app/(app)/products/delete-product-dialog";
import {
  ProductFormDialog,
  type ProductFormValues,
  type SupplierOption,
} from "@/app/(app)/products/product-form-dialog";
import { StockAdjustmentDialog } from "@/app/(app)/products/stock-adjustment-dialog";
import { Button } from "@/components/ui/button";

/**
 * The admin controls on a product's detail page.
 *
 * The same three dialogs the table row offers, laid out as buttons because
 * there is room for them here and they are the reason someone opened the page.
 *
 * Deleting is the one action that needs to do something afterwards: the page
 * the user is standing on describes a product that no longer exists, so it
 * navigates back to the list rather than leaving them looking at a ghost.
 */
function ProductDetailActions({
  product,
  categories,
  suppliers,
}: {
  product: ProductFormValues & { deletable: boolean };
  categories: string[];
  suppliers: SupplierOption[];
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [adjusting, setAdjusting] = useState(false);
  const [deleting, setDeleting] = useState(false);

  return (
    <>
      <Button variant="outline" onClick={() => setAdjusting(true)}>
        <SlidersHorizontal />
        Adjust stock
      </Button>

      <Button onClick={() => setEditing(true)}>
        <Pencil />
        Edit
      </Button>

      <Button
        variant="ghost"
        size="icon"
        aria-label="Delete product"
        onClick={() => setDeleting(true)}
      >
        <Trash2 className="text-destructive" />
      </Button>

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
        onDeleted={() => router.push("/products")}
      />
    </>
  );
}

export { ProductDetailActions };
