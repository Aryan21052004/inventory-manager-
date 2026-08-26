"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Archive, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { setCustomerStatusAction } from "@/app/(app)/customers/actions";
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
 * Confirmation for archiving a customer.
 *
 * Only for archiving. Bringing one back is reversible and unsurprising, so the
 * menu does that directly; taking someone out of circulation changes what
 * everyone else sees when they raise an order, which is worth a sentence first.
 *
 * The sentence that matters is the one about history: archiving is routinely
 * mistaken for a soft delete, and it is not. Their orders keep pointing at
 * them, keep displaying them, and keep counting towards what they have spent.
 */

function ArchiveCustomerDialog({
  open,
  onOpenChange,
  customer,
  onArchived,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  customer: { id: string; name: string; orderCount: number };
  onArchived?: () => void;
}) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);

  async function handleArchive() {
    setSubmitting(true);
    const result = await setCustomerStatusAction(customer.id, "INACTIVE");
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
            Archive customer
          </DialogTitle>
          <DialogDescription>
            <span className="font-medium text-foreground">{customer.name}</span>{" "}
            will no longer appear when raising a new order.
          </DialogDescription>
        </DialogHeader>

        <p className="rounded-lg border border-border bg-muted/40 p-3 text-xs leading-relaxed text-muted-foreground">
          {customer.orderCount > 0
            ? `Their ${customer.orderCount} existing order${customer.orderCount === 1 ? "" : "s"} ${customer.orderCount === 1 ? "is" : "are"} untouched — still theirs, still shown against their name, still counted in what they have spent. Archiving can be undone at any time.`
            : "Nothing is deleted, and archiving can be undone at any time."}
        </p>

        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline" disabled={submitting}>
              Cancel
            </Button>
          </DialogClose>
          <Button type="button" onClick={handleArchive} disabled={submitting}>
            {submitting ? <Loader2 className="animate-spin" /> : null}
            {submitting ? "Archiving…" : "Archive customer"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export { ArchiveCustomerDialog };
