"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Loader2, PackageCheck, Trash2, XCircle } from "lucide-react";
import { toast } from "sonner";

import {
  rejectLotAction,
  releaseLotAction,
  writeOffLotAction,
} from "@/app/(app)/lots/actions";
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
import type { LotStatus } from "@/generated/prisma/enums";
import { formatCurrency, formatNumber } from "@/lib/format";
import {
  QUARANTINED_LOT_STATUS,
  REJECTED_LOT_STATUS,
  SALEABLE_LOT_STATUS,
  type LotInspectionOutcome,
} from "@/lib/lot-status";

/**
 * What an admin can do to one returned batch.
 *
 * Only the action that is actually legal for the batch is offered: a
 * quarantined batch can be released or rejected, a rejected one can be written
 * off, and everything else shows nothing at all. That is a courtesy rather than
 * a control — the server re-checks the role, the provenance, the status and the
 * quantity on every call — but offering a button the server would refuse is a
 * good way to make a correct system feel broken.
 *
 * Every action asks first, and each dialog says what will actually happen in
 * units and money rather than in the abstract. "This destroys 4 units worth
 * ₹400" is a sentence somebody can check against the shelf before clicking;
 * "are you sure?" is not.
 */

export interface LotActionTarget {
  lotId: string;
  productName: string;
  /**
   * The enum rather than a bare string, so a caller cannot pass a status that
   * does not exist. A typo here would compile and then silently offer no
   * actions at all, which reads as a broken screen rather than a type error.
   */
  status: LotStatus;
  quantityRemaining: number;
  unitCost: string | null;
  isReturn: boolean;
}

function LotActions({ lot }: { lot: LotActionTarget }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [inspecting, setInspecting] = useState<LotInspectionOutcome | null>(null);
  const [writingOff, setWritingOff] = useState(false);

  // Inspection applies only to batches a customer sent back.
  if (!lot.isReturn) return null;

  async function run(
    action: () => Promise<{ ok: boolean; message: string }>,
    close: () => void,
  ) {
    setBusy(true);
    const result = await action();
    setBusy(false);

    if (!result.ok) {
      toast.error(result.message);
      return;
    }

    close();
    toast.success(result.message);
    router.refresh();
  }

  return (
    <>
      {lot.status === QUARANTINED_LOT_STATUS ? (
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => setInspecting(SALEABLE_LOT_STATUS)}
          >
            <PackageCheck />
            Release
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => setInspecting(REJECTED_LOT_STATUS)}
          >
            <XCircle />
            Reject
          </Button>
        </div>
      ) : null}

      {lot.status === REJECTED_LOT_STATUS && lot.quantityRemaining > 0 ? (
        <div className="flex justify-end">
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => setWritingOff(true)}
          >
            <Trash2 />
            Write off
          </Button>
        </div>
      ) : null}

      <InspectionDialog
        outcome={inspecting}
        lot={lot}
        busy={busy}
        onOpenChange={(open) => {
          if (busy) return;
          if (!open) setInspecting(null);
        }}
        onConfirm={(reason) => {
          const outcome = inspecting;
          if (!outcome) return;

          void run(
            () =>
              outcome === REJECTED_LOT_STATUS
                ? rejectLotAction(lot.lotId, reason)
                : releaseLotAction(lot.lotId, reason),
            () => setInspecting(null),
          );
        }}
      />

      <WriteOffDialog
        open={writingOff}
        lot={lot}
        busy={busy}
        onOpenChange={(open) => {
          if (busy) return;
          setWritingOff(open);
        }}
        onConfirm={(quantity, reason) =>
          void run(
            () => writeOffLotAction(lot.lotId, quantity, reason),
            () => setWritingOff(false),
          )
        }
      />
    </>
  );
}

/**
 * Releasing or condemning a quarantined batch.
 *
 * One dialog for both, because they ask for the same thing — a finding — and
 * differ only in what that finding concludes. The release copy says plainly
 * that paperwork is unaffected: an admin releasing a batch is saying it passed
 * a physical inspection, not that a certificate exists, and conflating the two
 * is the specific mistake this whole model is built to avoid.
 */
function InspectionDialog({
  outcome,
  lot,
  busy,
  onOpenChange,
  onConfirm,
}: {
  outcome: LotInspectionOutcome | null;
  lot: LotActionTarget;
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  const rejecting = outcome === REJECTED_LOT_STATUS;

  return (
    <Dialog
      open={outcome !== null}
      onOpenChange={(open) => {
        if (!open) setReason("");
        onOpenChange(open);
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {rejecting ? (
              <XCircle className="size-4 text-destructive" aria-hidden />
            ) : (
              <PackageCheck className="size-4 text-primary" aria-hidden />
            )}
            {rejecting ? "Reject this batch" : "Release this batch"}
          </DialogTitle>
          <DialogDescription>
            {formatNumber(lot.quantityRemaining)}{" "}
            {lot.quantityRemaining === 1 ? "unit" : "units"} of{" "}
            {lot.productName}.{" "}
            {rejecting
              ? "The units stay on the shelf and keep their cost. Nothing is destroyed until they are written off, and a rejection cannot be undone."
              : "These units become saleable immediately. This records a physical inspection only — it does not attach or revalidate any certificate, and a batch with no paperwork will still read as missing."}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="lot-reason" className="text-sm font-medium leading-none">
            {rejecting ? "Why is it being rejected?" : "What did the inspection find?"}
          </label>
          <Textarea
            id="lot-reason"
            rows={2}
            value={reason}
            disabled={busy}
            placeholder={
              rejecting
                ? "Corrosion on the mating face — not repairable."
                : "Inspected against the original release note; no damage found."
            }
            onChange={(event) => setReason(event.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            Required. This is the only record of the decision.
          </p>
        </div>

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" disabled={busy}>
              Cancel
            </Button>
          </DialogClose>
          <Button
            variant={rejecting ? "destructive" : "default"}
            disabled={busy || reason.trim().length < 3}
            onClick={() => onConfirm(reason.trim())}
          >
            {busy ? <Loader2 className="animate-spin" /> : null}
            {rejecting ? "Reject batch" : "Release batch"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Destroying units of a condemned batch.
 *
 * The confirmation states the batch, the quantity, what will be left, and what
 * it costs — and says the operation cannot be undone, because it cannot. When
 * the batch has no known cost the dialog says exactly that rather than showing
 * a zero: a zero is a price, and nobody paid it.
 */
function WriteOffDialog({
  open,
  lot,
  busy,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  lot: LotActionTarget;
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (quantity: number, reason: string) => void;
}) {
  const [quantity, setQuantity] = useState(0);
  const [reason, setReason] = useState("");

  const overQuantity = quantity > lot.quantityRemaining;
  const remaining = Math.max(0, lot.quantityRemaining - quantity);

  const value =
    lot.unitCost === null
      ? null
      : formatCurrency((Number(lot.unitCost) * quantity).toFixed(2));

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setQuantity(0);
          setReason("");
        }
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Trash2 className="size-4 text-destructive" aria-hidden />
            Write off rejected stock
          </DialogTitle>
          <DialogDescription>
            {lot.productName} — a rejected batch holding{" "}
            {formatNumber(lot.quantityRemaining)}{" "}
            {lot.quantityRemaining === 1 ? "unit" : "units"}. Written-off units
            leave inventory permanently and are taken from this batch only.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between gap-3">
            <label htmlFor="write-off-quantity" className="text-sm font-medium">
              Units to write off
            </label>
            <Input
              id="write-off-quantity"
              type="number"
              min={0}
              max={lot.quantityRemaining}
              step={1}
              value={quantity}
              disabled={busy}
              onChange={(event) =>
                setQuantity(Math.max(0, Math.floor(Number(event.target.value) || 0)))
              }
              className="tabular w-24"
            />
          </div>

          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-lg border border-border bg-muted/40 p-3 text-sm">
            <dt className="text-muted-foreground">Left in this batch after</dt>
            <dd className="tabular text-right font-medium">
              {formatNumber(remaining)}
            </dd>
            <dt className="text-muted-foreground">Value written off</dt>
            <dd className="tabular text-right font-medium">
              {value ?? "No recorded cost"}
            </dd>
          </dl>

          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="write-off-reason"
              className="text-sm font-medium leading-none"
            >
              Why are they being destroyed?
            </label>
            <Textarea
              id="write-off-reason"
              rows={2}
              value={reason}
              disabled={busy}
              placeholder="Scrapped after inspection — certificate of destruction on file."
              onChange={(event) => setReason(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Required. This is the disposal record.
            </p>
          </div>

          <p className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-xs leading-relaxed text-destructive">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>
              This cannot be undone. The units leave stock and the value leaves
              the inventory valuation.
            </span>
          </p>
        </div>

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" disabled={busy}>
              Cancel
            </Button>
          </DialogClose>
          <Button
            variant="destructive"
            disabled={
              busy || quantity <= 0 || overQuantity || reason.trim().length < 3
            }
            onClick={() => onConfirm(quantity, reason.trim())}
          >
            {busy ? <Loader2 className="animate-spin" /> : <Trash2 />}
            Write off {formatNumber(quantity)}{" "}
            {quantity === 1 ? "unit" : "units"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export { LotActions };
