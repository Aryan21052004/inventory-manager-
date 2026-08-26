"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  Loader2,
  PackageCheck,
  Truck,
  Undo2,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";

import {
  cancelPurchaseAction,
  receivePurchaseAction,
  setPurchaseStatusAction,
} from "@/app/(app)/purchases/actions";
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
import { Textarea } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { formatNumber } from "@/lib/format";
import { canTransition, type PurchaseStatus } from "@/lib/purchase-status";

/**
 * The actions available on a purchase, and the confirmations in front of the
 * two that move inventory.
 *
 * Which buttons appear comes from the same transition table the server enforces
 * (`canTransition`), so the UI cannot offer something the server will refuse —
 * and the server refuses it anyway if anything gets past.
 *
 * Receive and Cancel each ask first, and each says what will happen to stock in
 * units rather than in the abstract. "This will add 100 units" is a sentence
 * someone can check against the pallet in front of them.
 */

export interface PurchaseActionLine {
  productName: string;
  quantity: number;
  currentStock: number;
  productRetired: boolean;
}

function PurchaseActions({
  purchaseId,
  status,
  lines,
  hasRetiredProducts,
}: {
  purchaseId: string;
  status: PurchaseStatus;
  lines: PurchaseActionLine[];
  hasRetiredProducts: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [receiving, setReceiving] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  async function run(
    action: () => Promise<{ ok: boolean; message: string }>,
    close?: () => void,
  ) {
    setBusy(true);
    const result = await action();
    setBusy(false);

    if (!result.ok) {
      toast.error(result.message);
      return;
    }

    close?.();
    toast.success(result.message);
    router.refresh();
  }

  const totalUnits = lines.reduce((sum, line) => sum + line.quantity, 0);

  return (
    <>
      {canTransition(status, "PENDING") ? (
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => run(() => setPurchaseStatusAction(purchaseId, "PENDING"))}
        >
          <Truck />
          Mark pending
        </Button>
      ) : null}

      {canTransition(status, "DRAFT") ? (
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => run(() => setPurchaseStatusAction(purchaseId, "DRAFT"))}
        >
          <Undo2 />
          Back to draft
        </Button>
      ) : null}

      {canTransition(status, "CANCELLED") ? (
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => setCancelling(true)}
        >
          <XCircle className="text-destructive" />
          Cancel purchase
        </Button>
      ) : null}

      {canTransition(status, "RECEIVED") ? (
        <Button disabled={busy} onClick={() => setReceiving(true)}>
          <PackageCheck />
          Receive purchase
        </Button>
      ) : null}

      {/* --- Confirmation: adding stock --- */}
      <Dialog
        open={receiving}
        onOpenChange={(next) => {
          if (busy) return;
          setReceiving(next);
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <PackageCheck className="size-4 text-primary" aria-hidden />
              Receive this purchase
            </DialogTitle>
            <DialogDescription>
              Receiving will add{" "}
              <span className="font-medium text-foreground">
                {formatNumber(totalUnits)} units
              </span>{" "}
              to inventory and write a stock movement for every line, recorded
              against your account. Continue?
            </DialogDescription>
          </DialogHeader>

          <ul className="flex max-h-56 flex-col gap-2 overflow-y-auto rounded-lg border border-border bg-muted/40 p-3">
            {lines.map((line) => (
              <li
                key={line.productName}
                className="flex items-center justify-between gap-3 text-sm"
              >
                <span className="min-w-0 flex-1 truncate">
                  {line.productName}
                </span>
                <span className="tabular shrink-0 font-mono text-xs">
                  {formatNumber(line.currentStock)} →{" "}
                  <span className="font-semibold text-success">
                    {formatNumber(line.currentStock + line.quantity)}
                  </span>
                </span>
              </li>
            ))}
          </ul>

          {hasRetiredProducts ? (
            <p className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs leading-relaxed text-destructive">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
              At least one product on this purchase has been retired. The server
              will refuse the whole delivery — nothing is added unless every line
              can be. Make the product active again, or remove the line.
            </p>
          ) : null}

          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={busy}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="button"
              disabled={busy || hasRetiredProducts}
              onClick={() =>
                run(
                  () => receivePurchaseAction(purchaseId),
                  () => setReceiving(false),
                )
              }
            >
              {busy ? <Loader2 className="animate-spin" /> : null}
              {busy ? "Receiving…" : "Receive and add stock"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* --- Confirmation: taking stock back --- */}
      <CancelPurchaseDialog
        open={cancelling}
        onOpenChange={(next) => {
          if (busy) return;
          setCancelling(next);
        }}
        status={status}
        totalUnits={totalUnits}
        busy={busy}
        onCancel={(reason) =>
          run(
            () => cancelPurchaseAction(purchaseId, reason),
            () => setCancelling(false),
          )
        }
      />
    </>
  );
}

function CancelPurchaseDialog({
  open,
  onOpenChange,
  status,
  totalUnits,
  busy,
  onCancel,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  status: PurchaseStatus;
  totalUnits: number;
  busy: boolean;
  onCancel: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");

  // Only a received purchase has put anything on the shelf. Cancelling a draft
  // changes nothing, and saying otherwise would be a lie the user would notice.
  const reverses = status === "RECEIVED";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="size-4 text-destructive" aria-hidden />
            Cancel this purchase
          </DialogTitle>
          <DialogDescription>
            {reverses ? (
              <>
                Cancelling will remove the{" "}
                <span className="font-medium text-foreground">
                  {formatNumber(totalUnits)} units
                </span>{" "}
                this purchase added, writing a reversal for every line.
                Continue?
              </>
            ) : (
              "This purchase has not added any stock, so cancelling it changes inventory not at all. It cannot be reopened afterwards."
            )}
          </DialogDescription>
        </DialogHeader>

        {reverses ? (
          <p className="rounded-lg border border-border bg-muted/40 p-3 text-xs leading-relaxed text-muted-foreground">
            If any of these units have already been sold, taking them back would
            drive stock below zero — the server will refuse the whole
            cancellation rather than reverse it halfway.
          </p>
        ) : null}

        <Field
          label="Reason"
          htmlFor="cancel-reason"
          hint="Optional, and recorded on the reversal in the stock ledger."
        >
          <Textarea
            id="cancel-reason"
            rows={2}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Delivery returned to supplier — wrong parts."
          />
        </Field>

        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline" disabled={busy}>
              Keep purchase
            </Button>
          </DialogClose>
          <Button
            type="button"
            variant="destructive"
            disabled={busy}
            onClick={() => onCancel(reason)}
          >
            {busy ? <Loader2 className="animate-spin" /> : null}
            {busy
              ? "Cancelling…"
              : reverses
                ? "Cancel and remove stock"
                : "Cancel purchase"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export { PurchaseActions };
