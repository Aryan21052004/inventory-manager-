"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { deleteCustomerAction } from "@/app/(app)/customers/actions";
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
 * Confirmation for deleting a customer.
 *
 * Delete is destructive and not recoverable, so it asks first, names who will
 * go, and says what to do instead when they have ordered. The server refuses a
 * customer with orders regardless of what this dialog offers; the copy exists
 * so the refusal is not a surprise — and where the list already knows the order
 * count, the button is disabled rather than left to fail.
 */

function DeleteCustomerDialog({
  open,
  onOpenChange,
  customer,
  onDeleted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  customer: { id: string; name: string; orderCount: number };
  /** Called after a successful delete — the detail page uses it to navigate
   *  away from a record that no longer exists. */
  onDeleted?: () => void;
}) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);

  const hasOrders = customer.orderCount > 0;

  async function handleDelete() {
    setSubmitting(true);
    const result = await deleteCustomerAction(customer.id);
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
            Delete customer
          </DialogTitle>
          <DialogDescription>
            <span className="font-medium text-foreground">{customer.name}</span>{" "}
            will be removed. This cannot be undone.
          </DialogDescription>
        </DialogHeader>

        <p className="rounded-lg border border-border bg-muted/40 p-3 text-xs leading-relaxed text-muted-foreground">
          {hasOrders
            ? `This customer has ${customer.orderCount} order${customer.orderCount === 1 ? "" : "s"} on record, so they cannot be deleted — those orders have to keep saying who they were for. Archive them instead: that takes them out of the customer picker and leaves the history intact.`
            : "Only customers who have never ordered can be deleted. If any order exists for them, the delete will be refused and you can archive them instead."}
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
            disabled={submitting || hasOrders}
          >
            {submitting ? <Loader2 className="animate-spin" /> : null}
            {submitting ? "Deleting…" : "Delete customer"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export { DeleteCustomerDialog };
