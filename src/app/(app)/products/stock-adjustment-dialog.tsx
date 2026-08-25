"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Loader2, Minus, Plus } from "lucide-react";
import { toast } from "sonner";

import { adjustStockAction } from "@/app/(app)/products/actions";
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
import { formatNumber } from "@/lib/format";
import {
  adjustmentDelta,
  stockAdjustmentSchema,
  toAdjustmentFieldErrors,
  type AdjustmentDirection,
  type AdjustmentFieldErrors,
} from "@/lib/validation/adjustment";
import { cn } from "@/lib/utils";

/**
 * A manual stock correction — the only way a quantity changes by hand.
 *
 * The dialog asks for a count and a direction rather than a signed number,
 * because that is how the operation is actually described out loud: "twelve
 * fewer than the system thinks", not "minus twelve". The sign is derived once,
 * on the way to the ledger.
 *
 * The preview underneath is not decoration. An adjustment is the one movement
 * with no document behind it, and seeing "200 → 180" before committing is what
 * catches a decrease that should have been an increase — the mistake this form
 * is most likely to produce.
 *
 * Everything shown here is a courtesy. The dialog is only rendered for an
 * admin, the arithmetic is checked as you type, and neither fact protects
 * anything: the server re-checks the role against our database, locks the row,
 * and refuses a result below zero. This is the convenient path to those rules,
 * not the enforcement of them.
 */

function StockAdjustmentDialog({
  open,
  onOpenChange,
  product,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  product: { id: string; name: string; sku: string; stockQuantity: number };
}) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<AdjustmentFieldErrors>({});
  const [direction, setDirection] = useState<AdjustmentDirection>("INCREASE");
  const [quantity, setQuantity] = useState("");

  const fieldId = useId();
  const id = (name: string) => `${fieldId}-${name}`;

  const parsedQuantity = Number(quantity);
  const previewValid =
    quantity.trim() !== "" &&
    Number.isInteger(parsedQuantity) &&
    parsedQuantity > 0;

  const projected = previewValid
    ? product.stockQuantity + adjustmentDelta({ quantity: parsedQuantity, direction })
    : null;

  const wouldGoNegative = projected !== null && projected < 0;

  function reset() {
    setErrors({});
    setDirection("INCREASE");
    setQuantity("");
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const formData = new FormData(event.currentTarget);
    const parsed = stockAdjustmentSchema.safeParse(
      Object.fromEntries(formData),
    );

    if (!parsed.success) {
      setErrors(toAdjustmentFieldErrors(parsed.error));
      toast.error("Check the highlighted fields");
      return;
    }

    setErrors({});
    setSubmitting(true);

    const result = await adjustStockAction(formData);

    setSubmitting(false);

    if (!result.ok) {
      if (result.fieldErrors) setErrors(result.fieldErrors);
      toast.error(result.message);
      return;
    }

    onOpenChange(false);
    reset();
    toast.success("Stock adjusted", { description: result.message });
    router.refresh();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (submitting) return;
        onOpenChange(next);
        if (!next) reset();
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Adjust stock</DialogTitle>
          <DialogDescription>
            Correct the recorded quantity for {product.name}. The change is
            written to the stock ledger against your account.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
          {/* The product is fixed by whichever row opened this dialog. It still
              travels as a form field because the server takes an id, and the
              server checks it exists — but there is no product picker here, so
              there is nothing for a mistake to land on. */}
          <input type="hidden" name="productId" value={product.id} />

          <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-muted/40 px-4 py-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{product.name}</p>
              <p className="truncate font-mono text-xs text-muted-foreground">
                {product.sku}
              </p>
            </div>
            <div className="text-right">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">
                On hand
              </p>
              <p className="tabular text-lg font-semibold">
                {formatNumber(product.stockQuantity)}
              </p>
            </div>
          </div>

          <Field
            label="Direction"
            htmlFor={id("direction")}
            error={errors.direction}
          >
            {/* A two-state control rather than a dropdown: there are exactly two
                answers and the choice changes the sign of everything below it,
                so it should be visible without opening anything. */}
            <div
              id={id("direction")}
              role="radiogroup"
              aria-label="Adjustment direction"
              className="grid grid-cols-2 gap-2"
            >
              <DirectionOption
                value="INCREASE"
                current={direction}
                onSelect={setDirection}
                icon={Plus}
                label="Increase"
                tone="success"
              />
              <DirectionOption
                value="DECREASE"
                current={direction}
                onSelect={setDirection}
                icon={Minus}
                label="Decrease"
                tone="destructive"
              />
            </div>
            <input type="hidden" name="direction" value={direction} />
          </Field>

          <Field
            label="Quantity"
            htmlFor={id("quantity")}
            hint="How many units to add or remove — a positive whole number."
            error={errors.quantity}
          >
            <Input
              id={id("quantity")}
              name="quantity"
              type="number"
              min="1"
              step="1"
              value={quantity}
              onChange={(event) => setQuantity(event.target.value)}
              placeholder="0"
              autoComplete="off"
              aria-invalid={Boolean(errors.quantity)}
              className="tabular"
            />
          </Field>

          {projected !== null ? (
            <div
              className={cn(
                "flex items-center justify-center gap-3 rounded-lg border px-4 py-3 font-mono text-sm",
                wouldGoNegative
                  ? "border-destructive/30 bg-destructive/10"
                  : "border-border bg-muted/40",
              )}
            >
              <span className="tabular text-muted-foreground">
                {formatNumber(product.stockQuantity)}
              </span>
              <ArrowRight className="size-4 text-muted-foreground" aria-hidden />
              <span
                className={cn(
                  "tabular text-base font-semibold",
                  wouldGoNegative
                    ? "text-destructive"
                    : direction === "INCREASE"
                      ? "text-success"
                      : "text-foreground",
                )}
              >
                {formatNumber(projected)}
              </span>
            </div>
          ) : null}

          {wouldGoNegative ? (
            <p className="text-xs font-medium text-destructive">
              That would take stock below zero. Reduce the quantity — inventory
              cannot go negative, and the server will refuse this.
            </p>
          ) : null}

          <Field
            label="Reason"
            htmlFor={id("reason")}
            hint="Required. This is the only explanation the ledger will ever have."
            error={errors.reason}
          >
            <Textarea
              id={id("reason")}
              name="reason"
              rows={2}
              placeholder="Stock count correction — two units found damaged."
              aria-invalid={Boolean(errors.reason)}
            />
          </Field>

          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={submitting}>
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={submitting || wouldGoNegative}>
              {submitting ? <Loader2 className="animate-spin" /> : null}
              {submitting ? "Adjusting…" : "Record adjustment"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DirectionOption({
  value,
  current,
  onSelect,
  icon: Icon,
  label,
  tone,
}: {
  value: AdjustmentDirection;
  current: AdjustmentDirection;
  onSelect: (value: AdjustmentDirection) => void;
  icon: typeof Plus;
  label: string;
  tone: "success" | "destructive";
}) {
  const selected = current === value;

  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={() => onSelect(value)}
      className={cn(
        "flex items-center justify-center gap-2 rounded-md border px-3 py-2 text-sm font-medium transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        selected
          ? tone === "success"
            ? "border-success/40 bg-success/12 text-success"
            : "border-destructive/40 bg-destructive/10 text-destructive"
          : "border-border bg-card text-muted-foreground hover:bg-accent hover:text-accent-foreground",
      )}
    >
      <Icon className="size-4" aria-hidden />
      {label}
    </button>
  );
}

export { StockAdjustmentDialog };
