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
import { CostBasisOption } from "@/components/ui/cost-basis-option";
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
import { basisForQuantity } from "@/lib/validation/cost-basis";
import {
  createProductSchema,
  updateProductSchema,
  toFieldErrors,
  NO_SUPPLIER,
  type OpeningStockCostBasis,
  type ProductFieldErrors,
} from "@/lib/validation/product";

/**
 * The create and edit form, as one component.
 *
 * The two differ only in the opening stock block, which a new product has and
 * an existing one cannot, so keeping them apart would mean maintaining two
 * copies of eight shared inputs to avoid one conditional.
 *
 * That missing block is the point of this form, not an omission. Editing a
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
  sellingPrice: string | null;
  stockQuantity: number;
  status: string;
  supplierId: string | null;
  /**
   * Carried alongside the id so the select can still name a supplier who has
   * since been archived. The options list holds active suppliers only; without
   * the name, an archived one would render as a blank row.
   */
  supplierName?: string | null;
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

  /*
   * The opening quantity is controlled, which the other inputs are not.
   *
   * It has to be: whether the cost question appears at all depends on it. A
   * product created holding nothing has no batch, so asking what that batch
   * cost would be a question with no subject — and asking it anyway is how a
   * form trains people to dismiss it.
   */
  const [openingQuantity, setOpeningQuantity] = useState("0");
  const [openingCostBasis, setOpeningCostBasis] =
    useState<OpeningStockCostBasis | null>(null);

  const opensWithStock = Number(openingQuantity) > 0;

  /**
   * Typing the quantity down to zero withdraws the cost question entirely.
   *
   * The block unmounts either way, so the reason textarea and the hidden basis
   * input leave the form and nothing stale is submitted. What used to survive
   * was the *selection*: come back to a positive quantity and UNKNOWN would
   * still be highlighted, next to an empty reason box the operator had already
   * filled in once. That reads as an answer that is still on record when it is
   * not, which is the one impression this control must never give.
   *
   * Cleared here rather than in an effect, because it is a consequence of the
   * edit rather than of the render.
   */
  function changeOpeningQuantity(next: string) {
    setOpeningQuantity(next);
    setOpeningCostBasis((current) => basisForQuantity(Number(next), current));
  }

  // Ids are generated rather than hardcoded: two of these dialogs can be
  // mounted at once — one per table row — and duplicate ids would point every
  // label at the first copy's input.
  const fieldId = useId();
  const id = (name: string) => `${fieldId}-${name}`;

  const editing = product !== undefined;
  const categoryListId = `${fieldId}-categories`;

  /*
   * Active suppliers, plus this product's own if it has since been archived.
   *
   * The options list deliberately excludes archived suppliers — they must not
   * be available for a *new* assignment. But a product already sourced from one
   * has to keep showing it, or opening the edit dialog would silently drop the
   * supplier and saving would clear a field nobody meant to touch. Archiving
   * stops new business; it does not make existing records unsaveable.
   *
   * Flagged in the list rather than shown plainly, so nobody picks it back up
   * without noticing what it is.
   */
  const supplierChoices: (SupplierOption & { archived?: boolean })[] =
    product?.supplierId && !suppliers.some((s) => s.id === product.supplierId)
      ? [
          ...suppliers,
          {
            id: product.supplierId,
            name: product.supplierName ?? "Archived supplier",
            archived: true,
          },
        ]
      : suppliers;

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const formData = new FormData(event.currentTarget);
    const schema = editing ? updateProductSchema : createProductSchema;
    const parsed = schema.safeParse(Object.fromEntries(formData));

    const fieldErrors: ProductFieldErrors = parsed.success
      ? {}
      : toFieldErrors(parsed.error);

    if (Object.keys(fieldErrors).length > 0) {
      setErrors(fieldErrors);
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
        if (!next) {
          setErrors({});
          // Reopening must not inherit the last attempt's cost answer — an
          // unnoticed carry-over is a declared cost basis nobody declared.
          setOpeningQuantity("0");
          setOpeningCostBasis(null);
        }
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

          {/*
            There is no cost field here, and that is deliberate. The catalogue
            carries a reference *price* and no cost at all: the same part is
            bought at several prices, so a single cost on this row could only be
            stale, absent, or wrong while reading exactly like a real one. What
            a batch cost is recorded per receipt, below for opening stock and on
            the purchase line for everything after.
          */}
          <Field
            label="Reference price"
            htmlFor={id("sellingPrice")}
            hint="Optional. Prefills a new order line — the price actually quoted is set on the order."
            error={errors.sellingPrice}
          >
            <Input
              id={id("sellingPrice")}
              name="sellingPrice"
              type="number"
              step="0.01"
              min="0"
              defaultValue={product?.sellingPrice ?? ""}
              aria-invalid={Boolean(errors.sellingPrice)}
              className="tabular"
            />
          </Field>

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
                value={openingQuantity}
                onChange={(event) => changeOpeningQuantity(event.target.value)}
                aria-invalid={Boolean(errors.stockQuantity)}
                className="tabular"
              />
            </Field>
          )}

          {/*
            Only when creating, and only once there are units to cost.

            This block used to be a single optional "opening stock unit cost"
            box, and leaving it blank silently produced an UNKNOWN lot. That is
            where this system's uncosted opening units came from — not from
            anyone deciding the cost was unrecoverable, but from a form that
            never asked. Now the question is asked, with no default, and both
            answers are real: a cost, or a reason there isn't one.
          */}
          {!editing && opensWithStock ? (
            <>
              <Field
                label="Acquisition cost"
                htmlFor={id("openingStockCostBasis")}
                hint="These units become the product's first batch. What that batch cost is frozen here and used for every sale that later draws on it."
                error={errors.openingStockCostBasis}
              >
                <div
                  id={id("openingStockCostBasis")}
                  role="radiogroup"
                  aria-label="Opening stock cost basis"
                  className="grid gap-2 sm:grid-cols-2"
                >
                  <CostBasisOption
                    value="KNOWN"
                    current={openingCostBasis}
                    onSelect={setOpeningCostBasis}
                    label="I know what these cost"
                    detail="Enter the price per unit"
                  />
                  <CostBasisOption
                    value="UNKNOWN"
                    current={openingCostBasis}
                    onSelect={setOpeningCostBasis}
                    label="Cost is unknown"
                    detail="Records as uncosted, permanently"
                  />
                </div>
                {openingCostBasis ? (
                  <input
                    type="hidden"
                    name="openingStockCostBasis"
                    value={openingCostBasis}
                  />
                ) : null}
              </Field>

              {openingCostBasis === "KNOWN" ? (
                <Field
                  label="Opening stock unit cost"
                  htmlFor={id("openingStockUnitCost")}
                  hint="What one unit actually cost to acquire — not what it sells for."
                  error={errors.openingStockUnitCost}
                >
                  <Input
                    id={id("openingStockUnitCost")}
                    name="openingStockUnitCost"
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="0.00"
                    autoComplete="off"
                    aria-invalid={Boolean(errors.openingStockUnitCost)}
                    className="tabular"
                  />
                </Field>
              ) : null}

              {openingCostBasis === "UNKNOWN" ? (
                <Field
                  label="Why is the cost unknown?"
                  htmlFor={id("openingStockUnknownReason")}
                  hint="Required. These units will report as uncosted for as long as they last, and this is the only thing that will ever explain why."
                  error={errors.openingStockUnknownReason}
                >
                  <Textarea
                    id={id("openingStockUnknownReason")}
                    name="openingStockUnknownReason"
                    rows={2}
                    placeholder="Stock predates this system — the original purchase paperwork cannot be found."
                    aria-invalid={Boolean(errors.openingStockUnknownReason)}
                  />
                </Field>
              ) : null}
            </>
          ) : null}

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
                  {supplierChoices.map((supplier) => (
                    <SelectItem key={supplier.id} value={supplier.id}>
                      {supplier.name}
                      {supplier.archived ? " (archived)" : ""}
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

/*
 * There is deliberately no certificate section on this form.
 *
 * A certificate covers the batch that arrived, and at creation there is no
 * batch — opening stock produces one, but a product created with zero stock
 * produces none, and a field that works only sometimes is worse than a field
 * that is not there. Paperwork is filed against a lot from the product detail
 * page once stock exists.
 */

export { ProductFormDialog };
