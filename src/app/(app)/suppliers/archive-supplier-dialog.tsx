"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Archive, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { setSupplierStatusAction } from "@/app/(app)/suppliers/actions";
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
 * Confirmation for archiving a supplier.
 *
 * Only for archiving. Bringing one back is reversible and unsurprising, so the
 * menu does that directly; taking somebody out of circulation changes what
 * everyone else sees when they raise a purchase or add a product, which is
 * worth a sentence first.
 *
 * The sentence that matters is the one about history. Archiving is routinely
 * mistaken for a soft delete, and here it is further from one than usual: the
 * stock this supplier delivered is costed against their purchases, and that
 * chain has to keep resolving. Nothing about a lot, a quantity or an
 * acquisition cost changes.
 */

function ArchiveSupplierDialog({
  open,
  onOpenChange,
  supplier,
  onArchived,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  supplier: { id: string; name: string; purchaseCount: number; productCount: number };
  onArchived?: () => void;
}) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);

  async function handleArchive() {
    setSubmitting(true);
    const result = await setSupplierStatusAction(supplier.id, "INACTIVE");
    setSubmitting(false);

    if (!result.ok) {
      toast.error(result.message);
      return;
    }

    onOpenChange(false);
    toast.success(result.message);
    router.refresh();
    onArchived?.();
  }

  const { purchaseCount: purchases, productCount: products } = supplier;

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
            <Archive className="size-4 text-muted-foreground" aria-hidden />
            Archive supplier
          </DialogTitle>
          <DialogDescription>
            <span className="font-medium text-foreground">{supplier.name}</span>{" "}
            will no longer be offered when raising a purchase or assigning a
            supplier to a product.
          </DialogDescription>
        </DialogHeader>

        <p className="rounded-lg border border-border bg-muted/40 p-3 text-xs leading-relaxed text-muted-foreground">
          {purchases > 0
            ? `Their ${purchases} existing purchase${purchases === 1 ? "" : "s"} ${purchases === 1 ? "is" : "are"} untouched — still theirs, still shown against their name, and the stock they delivered keeps its acquisition cost. A pending delivery can still be received. `
            : "Nothing is deleted. "}
          {products > 0
            ? `${products} product${products === 1 ? "" : "s"} sourced from them keep${products === 1 ? "s" : ""} that link and stay${products === 1 ? "s" : ""} editable. `
            : ""}
          Archiving can be undone at any time.
        </p>

        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline" disabled={submitting}>
              Cancel
            </Button>
          </DialogClose>
          <Button type="button" onClick={handleArchive} disabled={submitting}>
            {submitting ? <Loader2 className="animate-spin" /> : null}
            {submitting ? "Archiving…" : "Archive supplier"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export { ArchiveSupplierDialog };
