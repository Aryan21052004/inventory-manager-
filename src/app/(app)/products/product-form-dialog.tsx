"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, FileCheck2, Loader2, Lock } from "lucide-react";
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
  certificateMetadataSchema,
  checkFileClientSide,
  COMMON_CERTIFICATE_TYPES,
  FILE_ACCEPT_ATTRIBUTE,
  formatFileSize,
  MAX_FILE_LABEL,
  toCertificateFieldErrors,
  type CertificateFieldErrors,
} from "@/lib/validation/certificate";
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
  /** Planning reference only, and null when nobody has set one. */
  standardCost: string | null;
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
  const [errors, setErrors] = useState<
    ProductFieldErrors & CertificateFieldErrors
  >({});
  const [certificateFile, setCertificateFile] = useState<File | null>(null);

  // Ids are generated rather than hardcoded: two of these dialogs can be
  // mounted at once — one per table row — and duplicate ids would point every
  // label at the first copy's input.
  const fieldId = useId();
  const id = (name: string) => `${fieldId}-${name}`;

  const editing = product !== undefined;
  const categoryListId = `${fieldId}-categories`;
  const certificateTypeListId = `${fieldId}-certificate-types`;

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const formData = new FormData(event.currentTarget);
    const schema = editing ? updateProductSchema : createProductSchema;
    const parsed = schema.safeParse(Object.fromEntries(formData));

    let fieldErrors: ProductFieldErrors & CertificateFieldErrors = parsed.success
      ? {}
      : toFieldErrors(parsed.error);

    /*
     * The certificate is only validated when one was actually attached. Its
     * fields are required *given a file* and irrelevant without one, so
     * checking them unconditionally would block creating the many products
     * whose paperwork has not arrived yet.
     */
    if (!editing && certificateFile) {
      const certificate = certificateMetadataSchema.safeParse(
        Object.fromEntries(formData),
      );

      if (!certificate.success) {
        fieldErrors = {
          ...fieldErrors,
          ...toCertificateFieldErrors(certificate.error),
        };
      }

      const fileProblem = checkFileClientSide(certificateFile);
      if (fileProblem) fieldErrors = { ...fieldErrors, file: fileProblem };
    }

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
    setCertificateFile(null);
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
          setCertificateFile(null);
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

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Standard cost (reference)"
              htmlFor={id("standardCost")}
              hint="A planning figure — prefills purchase lines. Not used to value stock. Leave blank if unknown."
              error={errors.standardCost}
            >
              <Input
                id={id("standardCost")}
                name="standardCost"
                type="number"
                step="0.01"
                min="0"
                placeholder="Optional"
                defaultValue={product?.standardCost ?? ""}
                aria-invalid={Boolean(errors.standardCost)}
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

            {/*
              Only when creating, and deliberately separate from the standard
              cost above. This is what the opening units actually cost; that is
              what we expect to pay next time. Left blank the opening stock is
              recorded as uncosted, which is the honest state for inventory
              whose paperwork nobody can find — the alternative, quietly reusing
              the planning figure, would turn an estimate into a recorded
              acquisition cost that no later reader could tell apart from a real
              one.
            */}
            {editing ? null : (
              <Field
                label="Opening stock unit cost"
                htmlFor={id("openingStockUnitCost")}
                hint="What the initial stock actually cost per unit. Leave blank if unknown — it will be recorded as uncosted rather than guessed."
                error={errors.openingStockUnitCost}
              >
                <Input
                  id={id("openingStockUnitCost")}
                  name="openingStockUnitCost"
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="Optional"
                  defaultValue=""
                  aria-invalid={Boolean(errors.openingStockUnitCost)}
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

          {editing ? null : (
            <CertificateSection
              id={id}
              typeListId={certificateTypeListId}
              errors={errors}
              file={certificateFile}
              onFileChange={setCertificateFile}
            />
          )}

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

/**
 * The optional certificate, folded away until it is wanted.
 *
 * Collapsed by default, and that is a statement about the domain rather than
 * about screen space: a part frequently arrives before its paperwork does, and
 * a form that presents nine required-looking certificate fields would suggest
 * otherwise. Opening the section is a deliberate act; leaving it shut creates
 * the product with no certificate and a status of MISSING, which is a perfectly
 * ordinary state.
 *
 * A native `<details>` rather than a controlled disclosure — no state, no
 * animation to get wrong, and it works before hydration.
 */
function CertificateSection({
  id,
  typeListId,
  errors,
  file,
  onFileChange,
}: {
  id: (name: string) => string;
  typeListId: string;
  errors: CertificateFieldErrors;
  file: File | null;
  onFileChange: (file: File | null) => void;
}) {
  const hasErrors = Boolean(
    errors.file ||
      errors.certificateType ||
      errors.certificateNumber ||
      errors.issueDate ||
      errors.expiryDate,
  );

  return (
    <details
      // Forced open when something inside is wrong, so a validation message
      // cannot end up hidden behind a collapsed summary.
      open={hasErrors || file !== null}
      className="group rounded-lg border border-border bg-muted/30 [&[open]]:bg-transparent"
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 p-3 text-sm font-medium">
        <FileCheck2 className="size-4 text-muted-foreground" aria-hidden />
        Certificate
        <span className="font-normal text-muted-foreground">— optional</span>
        <ChevronDown
          className="ml-auto size-4 text-muted-foreground transition-transform group-open:rotate-180"
          aria-hidden
        />
      </summary>

      <div className="flex flex-col gap-4 border-t border-border p-3 pt-4">
        <p className="text-xs leading-relaxed text-muted-foreground">
          Attach the airworthiness or conformity document now if you have it. A
          product can be created without one and the certificate added later
          from its detail page.
        </p>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Certificate type"
            htmlFor={id("certificateType")}
            error={errors.certificateType}
          >
            <Input
              id={id("certificateType")}
              name="certificateType"
              list={typeListId}
              placeholder="FAA 8130-3"
              autoComplete="off"
              aria-invalid={Boolean(errors.certificateType)}
            />
            <datalist id={typeListId}>
              {COMMON_CERTIFICATE_TYPES.map((type) => (
                <option key={type} value={type} />
              ))}
            </datalist>
          </Field>

          <Field
            label="Certificate number"
            htmlFor={id("certificateNumber")}
            error={errors.certificateNumber}
          >
            <Input
              id={id("certificateNumber")}
              name="certificateNumber"
              placeholder="8130-123456"
              autoComplete="off"
              aria-invalid={Boolean(errors.certificateNumber)}
              className="font-mono"
            />
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Issue date"
            htmlFor={id("issueDate")}
            error={errors.issueDate}
          >
            <Input
              id={id("issueDate")}
              name="issueDate"
              type="date"
              aria-invalid={Boolean(errors.issueDate)}
            />
          </Field>

          <Field
            label="Expiry date"
            htmlFor={id("expiryDate")}
            hint="Leave blank if it does not expire."
            error={errors.expiryDate}
          >
            <Input
              id={id("expiryDate")}
              name="expiryDate"
              type="date"
              aria-invalid={Boolean(errors.expiryDate)}
            />
          </Field>
        </div>

        <Field
          label="Certificate file"
          htmlFor={id("file")}
          hint={`PDF, JPG or PNG, up to ${MAX_FILE_LABEL}.`}
          error={errors.file}
        >
          <Input
            id={id("file")}
            name="file"
            type="file"
            accept={FILE_ACCEPT_ATTRIBUTE}
            onChange={(event) => onFileChange(event.target.files?.[0] ?? null)}
            aria-invalid={Boolean(errors.file)}
            className="h-auto py-2 file:mr-3 file:rounded file:px-2 file:py-1 file:text-xs"
          />
          {file ? (
            <p className="text-xs text-muted-foreground">
              {file.name} · {formatFileSize(file.size)}
            </p>
          ) : null}
        </Field>
      </div>
    </details>
  );
}

export { ProductFormDialog };
