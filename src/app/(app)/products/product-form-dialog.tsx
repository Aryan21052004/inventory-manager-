"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Lock } from "lucide-react";
import { toast } from "sonner";

import {
  createProductAction,
  updateProductAction,
} from "@/app/(app)/products/actions";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatNumber } from "@/lib/format";
import {
  createProductSchema,
  updateProductSchema,
  toFieldErrors,
  NO_SUPPLIER,
  type ProductFieldErrors,
} from "@/lib/validation/product";

/**
 * The create and edit form, as one component.
 *
 * The two differ in exactly one field — an opening stock box that only a new
 * product has — so keeping them apart would mean maintaining two copies of nine
 * inputs to avoid one conditional.
 *
 * That missing field is the point of this form, not an omission. Editing a
 * product cannot change its stock: a quantity that moves without a ledger row
 * explaining it is precisely the state the application exists to prevent, and a
 * number in an edit form is the easiest possible way to create one. The edit
 * dialog shows the current balance as a read-only figure and points at the
 * stock adjustment, which is audited.
 *
 * Validation runs twice, and deliberately. Here, so a mistake is caught before
 * a round-trip, and again on the server, because this copy is a convenience and
 * anything reaching the server has to be checked where the client cannot edit
 * the rules.
 */

export interface ProductFormValues {
  id: string;
  name: string;
  sku: string;
  description: string | null;
  category: string;
  costPrice: string;
  sellingPrice: string;
  stockQuantity: number;
  minimumStock: number;
  status: string;
  supplierId: string | null;
}

export interface SupplierOption {
  id: string;
  name: string;
}

function ProductFormDialog({
  open,
  onOpenChange,
  product,
  categories,
  suppliers,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Absent for a new product; present to edit an existing one. */
  product?: ProductFormValues;
  categories: string[];
  suppliers: SupplierOption[];
  onSaved?: (productId: string) => void;
}) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<ProductFieldErrors>({});

  // Ids are generated rather than hardcoded: two of these dialogs can be
  // mounted at once — one per table row — and duplicate ids would point every
  // label at the first copy's input.
  const fieldId = useId();
  const id = (name: string) => `${fieldId}-${name}`;

  const editing = product !== undefined;
  const categoryListId = `${fieldId}-categories`;

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const formData = new FormData(event.currentTarget);
    const schema = editing ? updateProductSchema : createProductSchema;
    const parsed = schema.safeParse(Object.fromEntries(formData));

    if (!parsed.success) {
      setErrors(toFieldErrors(parsed.error));
      toast.error("Check the highlighted fields");
      return;
    }

    setErrors({});
    setSubmitting(true);

    const result = editing
      ? await updateProductAction(product.id, formData)
      : await createProductAction(formData);

    setSubmitting(false);

    if (!result.ok) {
      // A duplicate SKU comes back attributed to its field, so it lands under
      // the input rather than only in a toast the user has to remember.
      if (result.fieldErrors) setErrors(result.fieldErrors);
      toast.error(result.message);
      return;
    }

    onOpenChange(false);
    toast.success(result.message);

    // The server has already revalidated; this is what makes the open page pick
    // the new data up without a manual reload.
    router.refresh();
    if (result.productId) onSaved?.(result.productId);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (submitting) return;
        onOpenChange(next);
        if (!next) setErrors({});
      }}
    >
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit product" : "New product"}</DialogTitle>
          <DialogDescription>
            {editing
              ? "Update the catalogue details. Stock is changed through a stock adjustment, which records who changed it and why."
              : "Add an item to the catalogue and set its opening stock level."}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Product name" htmlFor={id("name")} error={errors.name}>
              <Input
                id={id("name")}
                name="name"
                defaultValue={product?.name ?? ""}
                placeholder="Widget, large"
                autoComplete="off"
                aria-invalid={Boolean(errors.name)}
              />
            </Field>

            <Field
              label="SKU"
              htmlFor={id("sku")}
              hint="Unique across the catalogue."
              error={errors.sku}
            >
              <Input
                id={id("sku")}
                name="sku"
                defaultValue={product?.sku ?? ""}
                placeholder="WID-001"
                autoComplete="off"
                aria-invalid={Boolean(errors.sku)}
                className="font-mono"
              />
            </Field>
          </div>

          <Field
            label="Category"
            htmlFor={id("category")}
            hint="Pick an existing one or type a new label."
            error={errors.category}
          >
            <Input
              id={id("category")}
              name="category"
              list={categoryListId}
              defaultValue={product?.category ?? ""}
              placeholder="Peripherals"
              autoComplete="off"
              aria-invalid={Boolean(errors.category)}
            />
            {/* A datalist rather than a select: categories are a plain label on
                the product, so the form has to allow one that does not exist
                yet while still making the existing ones easy to reuse. */}
            <datalist id={categoryListId}>
              {categories.map((category) => (
                <option key={category} value={category} />
              ))}
            </datalist>
          </Field>

          <Field
            label="Description"
            htmlFor={id("description")}
            hint="Optional."
            error={errors.description}
          >
            <Textarea
              id={id("description")}
              name="description"
              rows={2}
              defaultValue={product?.description ?? ""}
              placeholder="What this product is, for anyone picking it off the shelf."
              aria-invalid={Boolean(errors.description)}
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Cost price"
              htmlFor={id("costPrice")}
              hint="What you pay per unit."
              error={errors.costPrice}
            >
              <Input
                id={id("costPrice")}
                name="costPrice"
                type="number"
                step="0.01"
                min="0"
                defaultValue={product?.costPrice ?? "0.00"}
                aria-invalid={Boolean(errors.costPrice)}
                className="tabular"
              />
            </Field>

            <Field
              label="Selling price"
              htmlFor={id("sellingPrice")}
              hint="What you charge per unit."
              error={errors.sellingPrice}
            >
              <Input
                id={id("sellingPrice")}
                name="sellingPrice"
                type="number"
                step="0.01"
                min="0"
                defaultValue={product?.sellingPrice ?? "0.00"}
                aria-invalid={Boolean(errors.sellingPrice)}
                className="tabular"
              />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            {editing ? (
              <ReadOnlyStock quantity={product.stockQuantity} />
            ) : (
              <Field
                label="Initial stock"
                htmlFor={id("stockQuantity")}
                hint="Recorded as the first stock movement."
                error={errors.stockQuantity}
              >
                <Input
                  id={id("stockQuantity")}
                  name="stockQuantity"
                  type="number"
                  min="0"
                  step="1"
                  defaultValue="0"
                  aria-invalid={Boolean(errors.stockQuantity)}
                  className="tabular"
                />
              </Field>
            )}

            <Field
              label="Minimum stock"
              htmlFor={id("minimumStock")}
              hint="At or below this, the product counts as low stock."
              error={errors.minimumStock}
            >
              <Input
                id={id("minimumStock")}
                name="minimumStock"
                type="number"
                min="0"
                step="1"
                defaultValue={String(product?.minimumStock ?? 0)}
                aria-invalid={Boolean(errors.minimumStock)}
                className="tabular"
              />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Supplier"
              htmlFor={id("supplierId")}
              hint="Optional — who you buy this from."
              error={errors.supplierId}
            >
              <Select
                name="supplierId"
                defaultValue={product?.supplierId ?? NO_SUPPLIER}
              >
                <SelectTrigger id={id("supplierId")}>
                  <SelectValue placeholder="Unassigned" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_SUPPLIER}>Unassigned</SelectItem>
                  {suppliers.map((supplier) => (
                    <SelectItem key={supplier.id} value={supplier.id}>
                      {supplier.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            <Field
              label="Status"
              htmlFor={id("status")}
              hint="Discontinued keeps the history but takes it out of circulation."
              error={errors.status}
            >
              <Select name="status" defaultValue={product?.status ?? "ACTIVE"}>
                <SelectTrigger id={id("status")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ACTIVE">Active</SelectItem>
                  <SelectItem value="INACTIVE">Inactive</SelectItem>
                  <SelectItem value="DISCONTINUED">Discontinued</SelectItem>
                </SelectContent>
              </Select>
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
              {submitting
                ? "Saving…"
                : editing
                  ? "Save changes"
                  : "Create product"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Current stock, shown but not editable.
 *
 * Leaving the field out entirely would read as an oversight — someone would
 * eventually "fix" it. Showing the number next to the reason it is locked makes
 * the constraint visible and points at the operation that does change stock.
 */
function ReadOnlyStock({ quantity }: { quantity: number }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="flex items-center gap-2 text-sm font-medium leading-none">
        Current stock
      </span>
      <div className="flex h-9 items-center gap-2 rounded-md border border-dashed border-border bg-muted/40 px-3 text-sm">
        <Lock className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="tabular font-medium">{formatNumber(quantity)}</span>
        <span className="text-muted-foreground">units</span>
      </div>
      <p className="text-xs text-muted-foreground">
        Changed through a stock adjustment, so the ledger records who and why.
      </p>
    </div>
  );
}

export { ProductFormDialog };
