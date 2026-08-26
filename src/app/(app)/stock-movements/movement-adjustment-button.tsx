"use client";

import { useState } from "react";
import { SlidersHorizontal } from "lucide-react";

import { StockAdjustmentDialog } from "@/app/(app)/products/stock-adjustment-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/**
 * The bridge between the stock movements page and the existing adjustment
 * dialog.
 *
 * The dialog on the product page receives its product as a prop — there is
 * only one. Here the user needs to pick a product first. This component opens
 * a picker, and once a product is selected, delegates to the same
 * `StockAdjustmentDialog` that the product page uses.
 *
 * Two-step deliberately: the adjustment dialog needs to know the current stock
 * to show the preview, and the product list passed here already carries it.
 */

interface ProductOption {
  id: string;
  name: string;
  sku: string;
  stockQuantity: number;
}

function MovementAdjustmentButton({
  products,
}: {
  products: ProductOption[];
}) {
  const [picking, setPicking] = useState(false);
  const [selected, setSelected] = useState<ProductOption | null>(null);

  function handleProductSelect(productId: string) {
    const product = products.find((p) => p.id === productId);
    if (!product) return;

    setPicking(false);
    setSelected(product);
  }

  return (
    <>
      <Button variant="outline" onClick={() => setPicking(true)}>
        <SlidersHorizontal />
        Manual adjustment
      </Button>

      {/* Step 1: pick a product. */}
      <Dialog open={picking} onOpenChange={setPicking}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Adjust stock</DialogTitle>
            <DialogDescription>
              Choose a product to record a manual stock correction against.
            </DialogDescription>
          </DialogHeader>

          <Select onValueChange={handleProductSelect}>
            <SelectTrigger aria-label="Product">
              <SelectValue placeholder="Select a product…" />
            </SelectTrigger>
            <SelectContent>
              {products.map((product) => (
                <SelectItem key={product.id} value={product.id}>
                  <span className="flex items-center gap-2">
                    <span className="truncate">{product.name}</span>
                    <span className="font-mono text-xs text-muted-foreground">
                      {product.sku}
                    </span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </DialogContent>
      </Dialog>

      {/* Step 2: the existing adjustment dialog. */}
      {selected ? (
        <StockAdjustmentDialog
          open={true}
          onOpenChange={(open) => {
            if (!open) setSelected(null);
          }}
          product={selected}
        />
      ) : null}
    </>
  );
}

export { MovementAdjustmentButton };
