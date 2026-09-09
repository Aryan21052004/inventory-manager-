"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, TriangleAlert } from "lucide-react";
import { toast } from "sonner";

import { updateCurrencyAction } from "@/app/(app)/settings/actions";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  CURRENCIES,
  CURRENCY_LABELS,
  currencyLabel,
  formatMoney,
  type Currency,
} from "@/lib/currency";

/**
 * The currency selector, and the sentence that has to be read before it saves.
 *
 * The confirmation is not ceremony. A currency change is the one setting in
 * this application that alters what every existing number on every screen
 * *means*, and it does so without altering a single stored value — which is
 * exactly the combination somebody will misread. The obvious wrong assumption
 * is that the app converts; it does not, and the dialog says so in those words
 * before anything is written.
 *
 * The preview is there for the same reason. "₹1,80,104.96" makes the lakh
 * grouping visible in a way "Indian Rupee" does not, and it is cheaper to show
 * the format than to describe it.
 */

function CurrencyForm({ currency }: { currency: Currency }) {
  const router = useRouter();

  /** What the selector shows. Not saved until the dialog is confirmed. */
  const [selected, setSelected] = useState<Currency>(currency);
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const changed = selected !== currency;

  async function handleConfirm() {
    setSubmitting(true);

    const formData = new FormData();
    formData.set("currency", selected);
    const result = await updateCurrencyAction(formData);

    setSubmitting(false);

    if (!result.ok) {
      toast.error(result.message);
      // Put the control back to what is actually stored, so a refused change
      // does not leave the screen claiming a currency the server rejected.
      setSelected(currency);
      setConfirming(false);
      return;
    }

    setConfirming(false);
    toast.success(result.message);
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2 sm:max-w-xs">
        <label
          htmlFor="app-currency"
          className="text-sm font-medium"
        >
          Application currency
        </label>

        <Select
          value={selected}
          onValueChange={(value) => setSelected(value as Currency)}
        >
          <SelectTrigger id="app-currency" aria-label="Application currency">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CURRENCIES.map((code) => (
              <SelectItem key={code} value={code}>
                {CURRENCY_LABELS[code]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <p className="text-xs text-muted-foreground">
          Amounts will display as{" "}
          <span className="tabular font-medium text-foreground">
            {formatMoney("180104.96", selected)}
          </span>
          .
        </p>
      </div>

      {changed ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" onClick={() => setConfirming(true)}>
            Change currency
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => setSelected(currency)}
          >
            Cancel
          </Button>
        </div>
      ) : null}

      <Dialog
        open={confirming}
        onOpenChange={(next) => {
          if (submitting) return;
          setConfirming(next);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <TriangleAlert className="size-4 text-warning" aria-hidden />
              Change the application currency?
            </DialogTitle>
            <DialogDescription>
              From{" "}
              <span className="font-medium text-foreground">
                {currencyLabel(currency)}
              </span>{" "}
              to{" "}
              <span className="font-medium text-foreground">
                {currencyLabel(selected)}
              </span>
              .
            </DialogDescription>
          </DialogHeader>

          {/*
            The warning, in the exact terms the business agreed. Both halves
            matter: what changes (the display) and what does not (the numbers).
          */}
          <p className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-xs leading-relaxed text-foreground">
            Changing the currency changes how existing monetary amounts are
            displayed. Existing amounts are not converted.
          </p>

          <p className="rounded-lg border border-border bg-muted/40 p-3 text-xs leading-relaxed text-muted-foreground">
            Every price, cost and total already recorded keeps its exact value —
            a line at 1,250.00 stays 1,250.00 and is simply read as{" "}
            {selected} from now on. There are no exchange rates in this system,
            so nothing is recalculated. Amounts entered after this change are{" "}
            {selected}.
          </p>

          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={submitting}>
                Cancel
              </Button>
            </DialogClose>
            <Button type="button" onClick={handleConfirm} disabled={submitting}>
              {submitting ? <Loader2 className="animate-spin" /> : null}
              {submitting ? "Saving…" : `Set currency to ${selected}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export { CurrencyForm };
