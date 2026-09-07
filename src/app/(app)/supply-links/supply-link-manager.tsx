"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Link2, Loader2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import {
  createSupplyLinkAction,
  removeSupplyLinkAction,
  updateSupplyLinkAction,
} from "@/app/(app)/supply-links/actions";
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
import { Input } from "@/components/ui/input";
import { formatDate, formatNumber } from "@/lib/format";

/**
 * Managing which deliveries are expected to cover one outstanding order line.
 *
 * Deliberately small. This is a note about what somebody is waiting for, not a
 * planning tool: pick a delivery, say how many units of it are meant for this
 * line, and change or drop that later. It ships nothing, allocates nothing and
 * reserves nothing — the copy says so, because a screen that looks like an
 * allocation tool will be read as one.
 *
 * Every option shown is a purchase line for the same part, on a purchase that
 * has been received, with units nobody else has claimed. That list
 * is read outside a transaction and is therefore advisory in the strict sense:
 * the server re-checks all of it under the two document locks, so an option
 * that went stale between render and click is refused rather than accepted.
 */

export interface LinkedDelivery {
  id: string;
  quantity: number;
  purchaseId: string;
  purchaseNumber: string;
  purchaseStatus: string;
  supplierName: string;
  purchaseDate: Date;
}

export interface LinkableDelivery {
  purchaseItemId: string;
  purchaseNumber: string;
  purchaseStatus: string;
  supplierName: string;
  purchaseDate: Date;
  unallocatedQuantity: number;
}

export function SupplyLinkManager({
  orderItemId,
  productName,
  outstandingQuantity,
  links,
  options,
}: {
  orderItemId: string;
  productName: string;
  outstandingQuantity: number;
  links: LinkedDelivery[];
  options: LinkableDelivery[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const expected = links.reduce((sum, link) => sum + link.quantity, 0);
  const uncovered = Math.max(0, outstandingQuantity - expected);

  async function run(action: () => Promise<{ ok: boolean; message: string }>) {
    setBusy(true);
    const result = await action();
    setBusy(false);

    if (!result.ok) {
      toast.error(result.message);
      return;
    }

    toast.success(result.message);
    router.refresh();
  }

  return (
    <>
      <div className="mt-1 flex flex-wrap items-center justify-end gap-1.5">
        {links.map((link) => (
          <span
            key={link.id}
            className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/50 px-1.5 py-0.5 text-xs text-muted-foreground"
          >
            <Link2 className="size-3 shrink-0" aria-hidden />
            <span className="font-mono">{link.purchaseNumber}</span>
            <span className="tabular">×{formatNumber(link.quantity)}</span>
          </span>
        ))}

        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-1.5 text-xs"
          onClick={() => setOpen(true)}
        >
          {links.length === 0 ? "Link a delivery" : "Edit"}
        </Button>
      </div>

      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (busy) return;
          setOpen(next);
        }}
      >
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Link2 className="size-4 text-primary" aria-hidden />
              Deliveries earmarked for this line
            </DialogTitle>
            <DialogDescription>
              {formatNumber(outstandingQuantity)}{" "}
              {outstandingQuantity === 1 ? "unit" : "units"} of {productName}{" "}
              still outstanding, {formatNumber(expected)} earmarked from
              received deliveries and {formatNumber(uncovered)} not yet covered.
              This is a note about which arrived batch is meant for this
              customer — it ships nothing and reserves nothing, and the order is
              fulfilled by hand when the goods are ready to go out.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4">
            {links.length > 0 ? (
              <ul className="flex flex-col gap-2">
                {links.map((link) => (
                  <LinkRow
                    key={link.id}
                    link={link}
                    busy={busy}
                    onSave={(quantity) =>
                      void run(() => updateSupplyLinkAction(link.id, quantity))
                    }
                    onRemove={() =>
                      void run(() => removeSupplyLinkAction(link.id))
                    }
                  />
                ))}
              </ul>
            ) : null}

            <AddLink
              orderItemId={orderItemId}
              options={options.filter(
                (option) =>
                  !links.some(
                    (link) => link.purchaseNumber === option.purchaseNumber,
                  ),
              )}
              busy={busy}
              uncovered={uncovered}
              onAdd={(purchaseItemId, quantity) =>
                void run(() =>
                  createSupplyLinkAction(orderItemId, purchaseItemId, quantity),
                )
              }
            />
          </div>

          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" disabled={busy}>
                Done
              </Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** One existing expectation, with its quantity editable in place. */
function LinkRow({
  link,
  busy,
  onSave,
  onRemove,
}: {
  link: LinkedDelivery;
  busy: boolean;
  onSave: (quantity: number) => void;
  onRemove: () => void;
}) {
  const [quantity, setQuantity] = useState(link.quantity);

  return (
    <li className="flex items-center gap-3 rounded-lg border border-border p-3">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{link.purchaseNumber}</p>
        <p className="truncate text-xs text-muted-foreground">
          {link.supplierName} · {link.purchaseStatus.toLowerCase()} ·{" "}
          {formatDate(link.purchaseDate)}
        </p>
      </div>

      <Input
        type="number"
        min={1}
        step={1}
        value={quantity}
        disabled={busy}
        onChange={(event) =>
          setQuantity(Math.max(1, Math.floor(Number(event.target.value) || 1)))
        }
        className="tabular w-20"
        aria-label={`Units expected from ${link.purchaseNumber}`}
      />

      <Button
        size="sm"
        variant="outline"
        disabled={busy || quantity === link.quantity}
        onClick={() => onSave(quantity)}
      >
        {busy ? <Loader2 className="animate-spin" /> : null}
        Save
      </Button>

      <Button
        size="sm"
        variant="ghost"
        disabled={busy}
        onClick={onRemove}
        aria-label={`Remove ${link.purchaseNumber}`}
      >
        <Trash2 className="size-4" />
      </Button>
    </li>
  );
}

/** Adding a new expectation from the deliveries that could still cover this. */
function AddLink({
  options,
  busy,
  uncovered,
  onAdd,
}: {
  orderItemId: string;
  options: LinkableDelivery[];
  busy: boolean;
  uncovered: number;
  onAdd: (purchaseItemId: string, quantity: number) => void;
}) {
  const [selected, setSelected] = useState("");
  const [quantity, setQuantity] = useState(1);

  if (options.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-border p-3 text-xs text-muted-foreground">
        No arrived delivery could cover this line. A purchase qualifies once it
        is for the same part, has been received, and still has units nobody else
        is expecting.
      </p>
    );
  }

  const option = options.find((o) => o.purchaseItemId === selected);
  const ceiling = Math.min(uncovered, option?.unallocatedQuantity ?? uncovered);

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/40 p-3">
      <label
        htmlFor="supply-link-purchase"
        className="text-sm font-medium leading-none"
      >
        Expect units from
      </label>

      <div className="flex items-center gap-2">
        <select
          id="supply-link-purchase"
          value={selected}
          disabled={busy}
          onChange={(event) => {
            setSelected(event.target.value);
            setQuantity(1);
          }}
          className="h-9 flex-1 rounded-md border border-input bg-transparent px-2 text-sm"
        >
          <option value="">Choose a delivery…</option>
          {options.map((candidate) => (
            <option key={candidate.purchaseItemId} value={candidate.purchaseItemId}>
              {candidate.purchaseNumber} · {candidate.supplierName} ·{" "}
              {candidate.unallocatedQuantity} free
            </option>
          ))}
        </select>

        <Input
          type="number"
          min={1}
          step={1}
          value={quantity}
          disabled={busy || !selected}
          onChange={(event) =>
            setQuantity(Math.max(1, Math.floor(Number(event.target.value) || 1)))
          }
          className="tabular w-20"
          aria-label="Units expected"
        />

        <Button
          size="sm"
          disabled={busy || !selected || quantity < 1 || quantity > ceiling}
          onClick={() => onAdd(selected, quantity)}
        >
          {busy ? <Loader2 className="animate-spin" /> : <Plus />}
          Link
        </Button>
      </div>

      {option ? (
        <p className="text-xs text-muted-foreground">
          {formatNumber(option.unallocatedQuantity)} of that delivery{" "}
          {option.unallocatedQuantity === 1 ? "is" : "are"} unclaimed, and{" "}
          {formatNumber(uncovered)} of this line{" "}
          {uncovered === 1 ? "is" : "are"} uncovered — so at most{" "}
          {formatNumber(ceiling)} can be expected here.
        </p>
      ) : null}
    </div>
  );
}
