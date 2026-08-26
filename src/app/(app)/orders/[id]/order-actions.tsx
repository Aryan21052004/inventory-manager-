"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Loader2,
  PackageCheck,
  Undo2,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";

import {
  cancelOrderAction,
  completeOrderAction,
  confirmOrderAction,
  setOrderStatusAction,
} from "@/app/(app)/orders/actions";
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
import { canTransition, type OrderStatus } from "@/lib/order-status";
import { formatNumber } from "@/lib/format";

/**
 * The actions available on an order, and the confirmations in front of the two
 * that move inventory.
 *
 * Which buttons appear comes from the same transition table the server enforces
 * (`canTransition`), so the UI cannot offer something the server will refuse —
 * and the server refuses it anyway if anything gets past.
 *
 * Confirm and Cancel each ask first, and each says *what will happen to stock*
 * in units rather than in the abstract. "This will deduct 150 units" is a
 * sentence someone can check against the shelf; "are you sure?" is not.
 */

export interface OrderActionLine {
  productName: string;
  quantity: number;
  currentStock: number;
}

function OrderActions({
  orderId,
  status,
  lines,
}: {
  orderId: string;
  status: OrderStatus;
  lines: OrderActionLine[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
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
          onClick={() => run(() => setOrderStatusAction(orderId, "PENDING"))}
        >
          <Clock />
          Mark pending
        </Button>
      ) : null}

      {canTransition(status, "DRAFT") ? (
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => run(() => setOrderStatusAction(orderId, "DRAFT"))}
        >
          <Undo2 />
          Back to draft
        </Button>
      ) : null}

      {canTransition(status, "COMPLETED") ? (
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => run(() => completeOrderAction(orderId))}
        >
          <PackageCheck />
          Complete
        </Button>
      ) : null}

      {canTransition(status, "CANCELLED") ? (
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => setCancelling(true)}
        >
          <XCircle className="text-destructive" />
          Cancel order
        </Button>
      ) : null}

      {canTransition(status, "CONFIRMED") ? (
        <Button disabled={busy} onClick={() => setConfirming(true)}>
          <CheckCircle2 />
          Confirm order
        </Button>
      ) : null}

      {/* --- Confirmation: deducting stock --- */}
      <Dialog
        open={confirming}
        onOpenChange={(next) => {
          if (busy) return;
          setConfirming(next);
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CheckCircle2 className="size-4 text-primary" aria-hidden />
              Confirm this order
            </DialogTitle>
            <DialogDescription>
              Confirming will deduct{" "}
              <span className="font-medium text-foreground">
                {formatNumber(totalUnits)} units
              </span>{" "}
              from inventory and write a stock movement for every line, recorded
              against your account. Continue?
            </DialogDescription>
          </DialogHeader>

          <ul className="flex max-h-56 flex-col gap-2 overflow-y-auto rounded-lg border border-border bg-muted/40 p-3">
            {lines.map((line) => {
              const short = line.quantity > line.currentStock;

              return (
                <li
                  key={line.productName}
                  className="flex items-center justify-between gap-3 text-sm"
                >
                  <span className="min-w-0 flex-1 truncate">
                    {line.productName}
                  </span>
                  <span className="tabular shrink-0 font-mono text-xs">
                    {formatNumber(line.currentStock)} →{" "}
                    <span
                      className={
                        short ? "font-semibold text-destructive" : "font-semibold"
                      }
                    >
                      {formatNumber(line.currentStock - line.quantity)}
                    </span>
                  </span>
                </li>
              );
            })}
          </ul>

          {lines.some((line) => line.quantity > line.currentStock) ? (
            <p className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs leading-relaxed text-destructive">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
              At least one line asks for more than is on hand. The server will
              refuse the whole order — nothing is deducted unless every line can
              be.
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
              disabled={busy}
              onClick={() =>
                run(() => confirmOrderAction(orderId), () => setConfirming(false))
              }
            >
              {busy ? <Loader2 className="animate-spin" /> : null}
              {busy ? "Confirming…" : "Confirm and deduct stock"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* --- Confirmation: restoring stock --- */}
      <CancelOrderDialog
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
            () => cancelOrderAction(orderId, reason),
            () => setCancelling(false),
          )
        }
      />
    </>
  );
}

function CancelOrderDialog({
  open,
  onOpenChange,
  status,
  totalUnits,
  busy,
  onCancel,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  status: OrderStatus;
  totalUnits: number;
  busy: boolean;
  onCancel: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");

  // Only a confirmed order is holding stock. Cancelling a draft changes
  // nothing, and saying otherwise would be a lie the user would notice.
  const restores = status === "CONFIRMED";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="size-4 text-destructive" aria-hidden />
            Cancel this order
          </DialogTitle>
          <DialogDescription>
            {restores ? (
              <>
                Cancelling will restore the{" "}
                <span className="font-medium text-foreground">
                  {formatNumber(totalUnits)} units
                </span>{" "}
                this order deducted, writing a reversal for every line.
                Continue?
              </>
            ) : (
              "This order has not deducted any stock, so cancelling it changes inventory not at all. It cannot be reopened afterwards."
            )}
          </DialogDescription>
        </DialogHeader>

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
            placeholder="Customer withdrew the request."
          />
        </Field>

        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline" disabled={busy}>
              Keep order
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
              : restores
                ? "Cancel and restore stock"
                : "Cancel order"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export { OrderActions };
