"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Info,
  Loader2,
  PackageCheck,
  PackageOpen,
  Truck,
  Undo2,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";

import {
  cancelOrderAction,
  completeOrderAction,
  confirmOrderAction,
  fulfilOrderAction,
  recordReturnAction,
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
import { Input, Textarea } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import {
  canFulfilOutstanding,
  canTransition,
  type OrderStatus,
} from "@/lib/order-status";
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
  /** The order line itself, which is what a fulfilment addresses. */
  orderItemId: string;
  productName: string;
  quantity: number;
  /** How many of `quantity` have physically shipped. */
  fulfilledQuantity: number;
  /** How many shipped units the customer has already sent back. */
  returnedQuantity: number;
  /** What may still come back: `fulfilledQuantity - returnedQuantity`. */
  returnableQuantity: number;
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
  const [fulfilling, setFulfilling] = useState(false);
  const [returning, setReturning] = useState(false);

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

  /*
   * What this order has actually shipped, and what it still owes. Read from
   * the lines rather than inferred from the status: a confirmed order may be
   * holding everything, some of it, or nothing at all.
   */
  const fulfilledUnits = lines.reduce(
    (sum, line) => sum + line.fulfilledQuantity,
    0,
  );
  const outstandingLines = lines.filter(
    (line) => line.fulfilledQuantity < line.quantity,
  );
  const outstandingUnits = outstandingLines.reduce(
    (sum, line) => sum + (line.quantity - line.fulfilledQuantity),
    0,
  );

  /*
   * Eligibility comes from `canFulfilOutstanding`, the same predicate
   * `fulfilOrder` enforces — so the button cannot offer something the server
   * will refuse. Completion is commercial and fulfilment is physical, which is
   * why a COMPLETED order still qualifies; that reasoning lives in
   * order-status.ts rather than being restated here.
   */
  const canFulfil = canFulfilOutstanding(status) && outstandingUnits > 0;

  /*
   * Only units that actually shipped can come back, and only ones that have
   * not already been sent back. When nothing is returnable the action is not
   * offered at all rather than offered and refused — the server enforces the
   * same bound, so the button cannot promise something it will decline.
   */
  const returnableLines = lines.filter((line) => line.returnableQuantity > 0);
  const returnableUnits = returnableLines.reduce(
    (sum, line) => sum + line.returnableQuantity,
    0,
  );
  const canReturn = returnableUnits > 0;

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

      {canFulfil ? (
        <Button disabled={busy} onClick={() => setFulfilling(true)}>
          <Truck />
          Fulfil {formatNumber(outstandingUnits)}{" "}
          {outstandingUnits === 1 ? "unit" : "units"}
        </Button>
      ) : null}

      {canReturn ? (
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => setReturning(true)}
        >
          <PackageOpen />
          Record return
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
              Confirming will deduct up to{" "}
              <span className="font-medium text-foreground">
                {formatNumber(totalUnits)} units
              </span>{" "}
              from inventory and write a stock movement for every line that has
              stock, recorded against your account. Continue?
            </DialogDescription>
          </DialogHeader>

          <ul className="flex max-h-56 flex-col gap-2 overflow-y-auto rounded-lg border border-border bg-muted/40 p-3">
            {lines.map((line) => {
              /*
               * What this line will actually take, which is what the shelf can
               * give — never a negative balance. The old preview subtracted the
               * whole quantity and showed a negative number for a short line,
               * which is not a state this system can reach.
               */
              const take = Math.min(line.quantity, Math.max(0, line.currentStock));
              const outstanding = line.quantity - take;

              return (
                <li
                  key={line.orderItemId}
                  className="flex items-center justify-between gap-3 text-sm"
                >
                  <span className="min-w-0 flex-1 truncate">
                    {line.productName}
                  </span>
                  <span className="tabular shrink-0 font-mono text-xs">
                    {formatNumber(line.currentStock)} →{" "}
                    <span className="font-semibold">
                      {formatNumber(line.currentStock - take)}
                    </span>
                    {outstanding > 0 ? (
                      <span className="ml-2 font-sans text-muted-foreground">
                        {formatNumber(outstanding)} outstanding
                      </span>
                    ) : null}
                  </span>
                </li>
              );
            })}
          </ul>

          {lines.some((line) => line.quantity > line.currentStock) ? (
            <p className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 p-3 text-xs leading-relaxed text-muted-foreground">
              <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
              At least one line asks for more than is on hand. The order will be
              confirmed, whatever is in stock will be deducted, and the shortfall
              stays outstanding until you fulfil it from a later delivery.
              Inventory is never taken below zero.
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
              {busy ? "Confirming…" : "Confirm order"}
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
        fulfilledUnits={fulfilledUnits}
        busy={busy}
        onCancel={(reason) =>
          run(
            () => cancelOrderAction(orderId, reason),
            () => setCancelling(false),
          )
        }
      />

      {/* --- Fulfilment: shipping what the order still owes --- */}
      <FulfilOrderDialog
        open={fulfilling}
        onOpenChange={(next) => {
          if (busy) return;
          setFulfilling(next);
        }}
        lines={outstandingLines}
        busy={busy}
        onFulfil={(payload) =>
          run(
            () => fulfilOrderAction(orderId, payload),
            () => setFulfilling(false),
          )
        }
      />

      {/* --- Returns: goods the customer has sent back --- */}
      <RecordReturnDialog
        open={returning}
        onOpenChange={(next) => {
          if (busy) return;
          setReturning(next);
        }}
        lines={returnableLines}
        busy={busy}
        onReturn={(reason, payload) =>
          run(
            () => recordReturnAction(orderId, reason, payload),
            () => setReturning(false),
          )
        }
      />
    </>
  );
}

/**
 * Choosing what to ship against an order that is still owed units.
 *
 * Each line is prefilled with `min(outstanding, on hand)` - the common case is
 * "yes, send all of that", and it should be one click. The numbers stay
 * editable because a partial shipment is a real thing and the operator, not
 * this dialog, knows whether the whole lot is going in the box today.
 *
 * Nothing here decides quantities on its own. When a short delivery has to be
 * split between several waiting orders, that is a commercial decision about
 * which customer waits, and burying it in a default would hide it.
 */
function FulfilOrderDialog({
  open,
  onOpenChange,
  lines,
  busy,
  onFulfil,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  lines: OrderActionLine[];
  busy: boolean;
  onFulfil: (lines: { orderItemId: string; quantity: number }[]) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/*
        The form is mounted only while the dialog is open, so its prefilled
        quantities come from a `useState` initialiser rather than an effect that
        writes state on open. That matters beyond tidiness: stock moves while
        this page is up, and remounting means the defaults are read at the
        moment the operator opens the dialog rather than whenever the page last
        rendered.
      */}
      {open ? (
        <FulfilOrderForm lines={lines} busy={busy} onFulfil={onFulfil} />
      ) : null}
    </Dialog>
  );
}

function FulfilOrderForm({
  lines,
  busy,
  onFulfil,
}: {
  lines: OrderActionLine[];
  busy: boolean;
  onFulfil: (lines: { orderItemId: string; quantity: number }[]) => void;
}) {
  const [quantities, setQuantities] = useState<Record<string, number>>(() =>
    Object.fromEntries(
      lines.map(
        (line) =>
          [
            line.orderItemId,
            Math.min(
              line.quantity - line.fulfilledQuantity,
              Math.max(0, line.currentStock),
            ),
          ] as const,
      ),
    ),
  );

  const payload = lines
    .map((line) => ({
      orderItemId: line.orderItemId,
      quantity: quantities[line.orderItemId] ?? 0,
    }))
    .filter((line) => line.quantity > 0);

  const totalToShip = payload.reduce((sum, line) => sum + line.quantity, 0);

  // Anything asked for beyond what is on the shelf. The server refuses such a
  // request outright rather than shipping fewer, so the dialog says so first.
  const overStock = lines.filter(
    (line) =>
      (quantities[line.orderItemId] ?? 0) > Math.max(0, line.currentStock),
  );

  return (
    <DialogContent className="max-w-lg">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <Truck className="size-4 text-primary" aria-hidden />
          Fulfil outstanding units
        </DialogTitle>
        <DialogDescription>
          This ships units the order already owes. It deducts stock and writes
          a movement against your account, and it does not change the
          order status.
        </DialogDescription>
      </DialogHeader>

      <ul className="flex max-h-64 flex-col gap-3 overflow-y-auto rounded-lg border border-border bg-muted/40 p-3">
        {lines.map((line) => {
          const outstanding = line.quantity - line.fulfilledQuantity;
          const canShip = Math.min(outstanding, Math.max(0, line.currentStock));

          return (
            <li key={line.orderItemId} className="flex flex-col gap-1">
              <div className="flex items-center justify-between gap-3">
                <span className="min-w-0 flex-1 truncate text-sm">
                  {line.productName}
                </span>
                <Input
                  type="number"
                  min="0"
                  step="1"
                  className="w-24 text-right"
                  aria-label={`Units of ${line.productName} to fulfil`}
                  value={quantities[line.orderItemId] ?? 0}
                  disabled={busy}
                  onChange={(event) => {
                    const next = Number(event.target.value);
                    setQuantities((current) => ({
                      ...current,
                      [line.orderItemId]:
                        Number.isFinite(next) && next > 0
                          ? Math.min(Math.floor(next), outstanding)
                          : 0,
                    }));
                  }}
                />
              </div>
              <span className="text-xs text-muted-foreground">
                {formatNumber(outstanding)} outstanding &middot;{" "}
                {formatNumber(line.currentStock)} on hand
                {canShip < outstanding
                  ? ` — only ${formatNumber(canShip)} can ship now`
                  : ""}
              </span>
            </li>
          );
        })}
      </ul>

      {overStock.length > 0 ? (
        <p className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs leading-relaxed text-destructive">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
          At least one line asks for more than is on hand. Fulfilment is
          refused rather than reduced - lower the quantity to what is actually
          going out.
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
          disabled={busy || totalToShip === 0 || overStock.length > 0}
          onClick={() => onFulfil(payload)}
        >
          {busy ? <Loader2 className="animate-spin" /> : null}
          {busy
            ? "Fulfilling..."
            : `Fulfil ${formatNumber(totalToShip)} ${totalToShip === 1 ? "unit" : "units"}`}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function CancelOrderDialog({
  open,
  onOpenChange,
  fulfilledUnits,
  busy,
  onCancel,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  fulfilledUnits: number;
  busy: boolean;
  onCancel: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");

  /*
   * What comes back is what actually went out, which is no longer something
   * the status can answer. A confirmed order may have shipped everything, some
   * of it, or nothing at all, and promising to restore units that never left
   * would be a lie the user would notice the moment they looked at the shelf.
   */
  const restores = fulfilledUnits > 0;

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
                  {formatNumber(fulfilledUnits)}{" "}
                  {fulfilledUnits === 1 ? "unit" : "units"}
                </span>{" "}
                this order actually shipped, writing a reversal for every line
                that moved. Any outstanding units are simply no longer owed.
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

/**
 * Recording goods a customer has sent back.
 *
 * The four numbers are all shown deliberately. "Returned 2 of 5 shipped" is a
 * sentence somebody can check against the boxes on the dock; a bare input with
 * a maximum is not, and the difference matters because a return is irreversible
 * from this screen — the units come back quarantined and only an inspection
 * releases them.
 *
 * Nothing is prefilled. Unlike a fulfilment, where "send everything owed" is
 * the overwhelmingly common case, a return is whatever physically turned up,
 * and a default would be this dialog guessing at a delivery it cannot see.
 *
 * The reason is required and is not a formality: it is the only durable record
 * of why a shipped sale was partly undone, and unlike a quantity it cannot be
 * reconstructed from anything else afterwards.
 */
function RecordReturnDialog({
  open,
  onOpenChange,
  lines,
  busy,
  onReturn,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  lines: OrderActionLine[];
  busy: boolean;
  onReturn: (
    reason: string,
    lines: { orderItemId: string; quantity: number }[],
  ) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <RecordReturnForm lines={lines} busy={busy} onReturn={onReturn} />
      </DialogContent>
    </Dialog>
  );
}

function RecordReturnForm({
  lines,
  busy,
  onReturn,
}: {
  lines: OrderActionLine[];
  busy: boolean;
  onReturn: (
    reason: string,
    lines: { orderItemId: string; quantity: number }[],
  ) => void;
}) {
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [reason, setReason] = useState("");

  const payload = lines
    .map((line) => ({
      orderItemId: line.orderItemId,
      quantity: quantities[line.orderItemId] ?? 0,
    }))
    .filter((line) => line.quantity > 0);

  const units = payload.reduce((sum, line) => sum + line.quantity, 0);

  // Mirrors the server's per-line bound, so the dialog cannot offer a quantity
  // the server will refuse.
  const overReturned = lines.filter(
    (line) => (quantities[line.orderItemId] ?? 0) > line.returnableQuantity,
  );

  const reasonTooShort = reason.trim().length < 3;
  const blocked = busy || units === 0 || overReturned.length > 0 || reasonTooShort;

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <PackageOpen className="size-4 text-primary" aria-hidden />
          Record a return
        </DialogTitle>
        <DialogDescription>
          Returned units come back as their own batches, at the cost they
          shipped at, and stay quarantined until somebody inspects them. They do
          not become saleable stock on arrival.
        </DialogDescription>
      </DialogHeader>

      <div className="flex flex-col gap-4">
        <ul className="flex flex-col gap-3">
          {lines.map((line) => (
            <li key={line.orderItemId} className="flex flex-col gap-1">
              <div className="flex items-center justify-between gap-3">
                <span className="min-w-0 flex-1 truncate text-sm">
                  {line.productName}
                </span>
                <Input
                  type="number"
                  min={0}
                  max={line.returnableQuantity}
                  step={1}
                  value={quantities[line.orderItemId] ?? 0}
                  disabled={busy}
                  onChange={(event) =>
                    setQuantities((current) => ({
                      ...current,
                      [line.orderItemId]: Math.max(
                        0,
                        Math.floor(Number(event.target.value) || 0),
                      ),
                    }))
                  }
                  className="tabular w-24 shrink-0"
                  aria-label={`Units of ${line.productName} returned`}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                {formatNumber(line.quantity)} ordered ·{" "}
                {formatNumber(line.fulfilledQuantity)} shipped ·{" "}
                {formatNumber(line.returnedQuantity)} already returned ·{" "}
                <span className="font-medium text-foreground">
                  {formatNumber(line.returnableQuantity)} still returnable
                </span>
              </p>
            </li>
          ))}
        </ul>

        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="return-reason"
            className="text-sm font-medium leading-none"
          >
            Why did they come back?
          </label>
          <Textarea
            id="return-reason"
            rows={2}
            value={reason}
            disabled={busy}
            placeholder="Customer over-ordered — units unused and still boxed."
            onChange={(event) => setReason(event.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            Required. This is the only record of why the sale was partly undone.
          </p>
        </div>

        {overReturned.length > 0 ? (
          <p className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-xs leading-relaxed text-destructive">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>
              More units than were shipped, or than remain returnable. The
              server refuses such a request outright.
            </span>
          </p>
        ) : null}
      </div>

      <DialogFooter>
        <DialogClose asChild>
          <Button variant="outline" disabled={busy}>
            Cancel
          </Button>
        </DialogClose>
        <Button
          disabled={blocked}
          onClick={() => onReturn(reason.trim(), payload)}
        >
          {busy ? <Loader2 className="animate-spin" /> : <PackageOpen />}
          Record return of {formatNumber(units)}{" "}
          {units === 1 ? "unit" : "units"}
        </Button>
      </DialogFooter>
    </>
  );
}
