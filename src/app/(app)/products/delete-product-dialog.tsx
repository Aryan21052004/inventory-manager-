"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { deleteProductAction } from "@/app/(app)/products/actions";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * Confirmation for deleting a product.
 *
 * Delete is destructive and, unlike most things in this app, not recoverable —
 * so it asks first, names what will go, and says what will happen instead when
 * the product has history. The server refuses a product that has traded
 * regardless of what this dialog offers; the copy here exists so the refusal is
 * not a surprise.
 */

function DeleteProductDialog({
  open,
  onOpenChange,
  product,
  onDeleted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  product: { id: string; name: string; sku: string; deletable?: boolean };
  /** Called after a successful delete — the detail page uses it to navigate
   *  away from a row that no longer exists. */
  onDeleted?: () => void;
}) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);

  // Undefined means the caller has not checked, which the list has not: the
  // page would need two more counts per row to know. The server decides either
  // way, and an honest "may not be possible" beats a wrong promise.
  const traded = product.deletable === false;

  async function handleDelete() {
    setSubmitting(true);
    const result = await deleteProductAction(product.id);
    setSubmitting(false);

    if (!result.ok) {
      toast.error(result.message);
      return;
    }

    onOpenChange(false);
    toast.success(result.message);
    router.refresh();
    onDeleted?.();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (submitting) return;
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="size-4 text-destructive" aria-hidden />
            Delete product
          </DialogTitle>
          <DialogDescription>
            <span className="font-medium text-foreground">{product.name}</span>{" "}
            <span className="font-mono text-xs">({product.sku})</span> will be
            removed, along with the stock movements that describe its balance.
            This cannot be undone.
          </DialogDescription>
        </DialogHeader>

        <p className="rounded-lg border border-border bg-muted/40 p-3 text-xs leading-relaxed text-muted-foreground">
          {traded
            ? "This product appears on existing orders or purchases, so it cannot be deleted — those documents have to keep meaning what they said. Set its status to Discontinued instead."
            : "Products that appear on an order or a purchase cannot be deleted. If this one does, the delete will be refused and you can set its status to Discontinued instead."}
        </p>

        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline" disabled={submitting}>
              Cancel
            </Button>
          </DialogClose>
          <Button
            type="button"
            variant="destructive"
            onClick={handleDelete}
            disabled={submitting || traded}
          >
            {submitting ? <Loader2 className="animate-spin" /> : null}
            {submitting ? "Deleting…" : "Delete product"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export { DeleteProductDialog };
