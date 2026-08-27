"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { deleteSupplierAction } from "@/app/(app)/suppliers/actions";
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
 * Confirmation for deleting a supplier.
 *
 * Two conditions have to hold, and they are refused for different reasons —
 * which is why the copy names whichever one applies rather than giving a single
 * generic warning.
 *
 * A supplier with **purchases** cannot go because those documents have to keep
 * saying who supplied the goods, and the stock they delivered is costed against
 * them. A supplier with **products** cannot go because deleting them would
 * succeed at the database level and quietly clear the sourcing on every
 * catalogue row they supply — the destructive case that looks harmless.
 *
 * The server refuses either regardless of what this dialog offers. The copy
 * exists so the refusal is not a surprise, and where the list already knows the
 * counts, the button is disabled rather than left to fail.
 */

function DeleteSupplierDialog({
  open,
  onOpenChange,
  supplier,
  onDeleted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  supplier: {
    id: string;
    name: string;
    purchaseCount: number;
    productCount: number;
  };
  /** Called after a successful delete — the detail page uses it to navigate
   *  away from a record that no longer exists. */
  onDeleted?: () => void;
}) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);

  const { purchaseCount: purchases, productCount: products } = supplier;
  const blocked = purchases > 0 || products > 0;

  async function handleDelete() {
    setSubmitting(true);
    const result = await deleteSupplierAction(supplier.id);
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

  function reason(): string {
    if (purchases > 0) {
      return `This supplier has ${purchases} purchase${purchases === 1 ? "" : "s"} on record, so they cannot be deleted — those documents have to keep saying who the goods came from, and the stock they delivered is costed against them. Archive them instead: that takes them out of the supplier pickers and leaves the history intact.`;
    }

    if (products > 0) {
      return `${products} product${products === 1 ? " is" : "s are"} sourced from this supplier, so they cannot be deleted — doing so would quietly clear the supplier from ${products === 1 ? "that catalogue item" : "those catalogue items"} with nothing to explain it. Reassign ${products === 1 ? "it" : "them"} first, or archive this supplier instead.`;
    }

    return "Only a supplier with no purchases and no products can be deleted — one added by mistake, before anything referenced them. Anything else should be archived.";
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
            Delete supplier
          </DialogTitle>
          <DialogDescription>
            <span className="font-medium text-foreground">{supplier.name}</span>{" "}
            will be removed. This cannot be undone.
          </DialogDescription>
        </DialogHeader>

        <p className="rounded-lg border border-border bg-muted/40 p-3 text-xs leading-relaxed text-muted-foreground">
          {reason()}
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
            disabled={submitting || blocked}
          >
            {submitting ? <Loader2 className="animate-spin" /> : null}
            {submitting ? "Deleting…" : "Delete supplier"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export { DeleteSupplierDialog };
