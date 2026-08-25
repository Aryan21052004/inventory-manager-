"use client";

import { useState } from "react";
import { Loader2, Plus } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Field } from "@/components/ui/label";
import { Input, Textarea } from "@/components/ui/input";
import {
  productSchema,
  toFieldErrors,
  type ProductFieldErrors,
} from "@/lib/validation/product";

/**
 * The create-product form.
 *
 * The form, its validation, and the loading/error/success states are real — the
 * only thing missing is the server action behind it, which arrives with the
 * products module. It is wired to say so on submit rather than pretending to
 * save, so nobody mistakes a placeholder for a working feature.
 */

function NewProductDialog() {
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<ProductFieldErrors>({});

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);

    const parsed = productSchema.safeParse(Object.fromEntries(formData));

    if (!parsed.success) {
      setErrors(toFieldErrors(parsed.error));
      toast.error("Check the highlighted fields");
      return;
    }

    setErrors({});
    setSubmitting(true);

    // Stands in for the server action, so the pending state is exercised.
    await new Promise((resolve) => setTimeout(resolve, 600));

    setSubmitting(false);
    setOpen(false);
    toast.success(`"${parsed.data.name}" validated`, {
      description:
        "The form works end to end, but saving arrives with the products module.",
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setErrors({});
      }}
    >
      <DialogTrigger asChild>
        <Button>
          <Plus />
          New product
        </Button>
      </DialogTrigger>

      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>New product</DialogTitle>
          <DialogDescription>
            Add an item to the catalogue and set its opening stock level.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="SKU" htmlFor="sku" error={errors.sku}>
              <Input
                id="sku"
                name="sku"
                placeholder="WID-001"
                aria-invalid={Boolean(errors.sku)}
                className="font-mono"
              />
            </Field>

            <Field label="Name" htmlFor="name" error={errors.name}>
              <Input
                id="name"
                name="name"
                placeholder="Widget, large"
                aria-invalid={Boolean(errors.name)}
              />
            </Field>
          </div>

          <Field
            label="Category"
            htmlFor="category"
            hint="A plain label, e.g. Peripherals. Used to group and filter the catalogue."
            error={errors.category}
          >
            <Input
              id="category"
              name="category"
              placeholder="Peripherals"
              aria-invalid={Boolean(errors.category)}
            />
          </Field>

          <Field
            label="Description"
            htmlFor="description"
            hint="Optional."
            error={errors.description}
          >
            <Textarea
              id="description"
              name="description"
              rows={2}
              placeholder="What this product is, for anyone picking it off the shelf."
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Cost price" htmlFor="costPrice" error={errors.costPrice}>
              <Input
                id="costPrice"
                name="costPrice"
                type="number"
                step="0.01"
                min="0"
                defaultValue="0.00"
                aria-invalid={Boolean(errors.costPrice)}
                className="tabular"
              />
            </Field>

            <Field
              label="Selling price"
              htmlFor="sellingPrice"
              error={errors.sellingPrice}
            >
              <Input
                id="sellingPrice"
                name="sellingPrice"
                type="number"
                step="0.01"
                min="0"
                defaultValue="0.00"
                aria-invalid={Boolean(errors.sellingPrice)}
                className="tabular"
              />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Opening stock"
              htmlFor="stockQuantity"
              hint="Recorded as the first stock movement."
              error={errors.stockQuantity}
            >
              <Input
                id="stockQuantity"
                name="stockQuantity"
                type="number"
                min="0"
                defaultValue="0"
                aria-invalid={Boolean(errors.stockQuantity)}
                className="tabular"
              />
            </Field>

            <Field
              label="Minimum stock"
              htmlFor="minimumStock"
              hint="Flags the product as low stock at or below this."
              error={errors.minimumStock}
            >
              <Input
                id="minimumStock"
                name="minimumStock"
                type="number"
                min="0"
                defaultValue="0"
                aria-invalid={Boolean(errors.minimumStock)}
                className="tabular"
              />
            </Field>
          </div>

          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={submitting}>
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={submitting}>
              {submitting ? <Loader2 className="animate-spin" /> : null}
              {submitting ? "Saving…" : "Create product"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export { NewProductDialog };
