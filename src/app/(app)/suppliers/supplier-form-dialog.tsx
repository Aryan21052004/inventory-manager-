"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import {
  createSupplierAction,
  updateSupplierAction,
} from "@/app/(app)/suppliers/actions";
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
  createSupplierSchema,
  toSupplierFieldErrors,
  updateSupplierSchema,
  type SupplierFieldErrors,
} from "@/lib/validation/supplier";

/**
 * The create and edit form, as one component.
 *
 * The two are the same fields, so keeping them apart would mean maintaining two
 * copies of one form to avoid a single conditional in the heading.
 *
 * What is deliberately not here is the status. Archiving a supplier is not an
 * edit — it takes them out of both the purchase and product pickers, it is
 * restricted to ADMIN, and it lives behind its own control. Leaving it out
 * means this form cannot carry it and the update action would ignore it anyway.
 *
 * Validation runs twice, and deliberately. Here, so a mistake is caught before
 * a round-trip, and again on the server, because this copy is a convenience and
 * anything reaching the server has to be checked where the client cannot edit
 * the rules.
 */

export interface SupplierFormValues {
  id: string;
  name: string;
  contactPerson: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  accountNumber: string | null;
  typicalLeadTimeDays: number | null;
}

function SupplierFormDialog({
  open,
  onOpenChange,
  supplier,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Absent for a new supplier; present to edit an existing one. */
  supplier?: SupplierFormValues;
  onSaved?: (supplierId: string) => void;
}) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<SupplierFieldErrors>({});

  // Generated rather than hardcoded: two of these dialogs can be mounted at
  // once — one per table row — and duplicate ids would point every label at the
  // first copy's input.
  const fieldId = useId();
  const id = (name: string) => `${fieldId}-${name}`;

  const editing = supplier !== undefined;

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const formData = new FormData(event.currentTarget);
    const schema = editing ? updateSupplierSchema : createSupplierSchema;
    const parsed = schema.safeParse(Object.fromEntries(formData));

    if (!parsed.success) {
      setErrors(toSupplierFieldErrors(parsed.error));
      toast.error("Check the highlighted fields");
      return;
    }

    setErrors({});
    setSubmitting(true);

    const result = editing
      ? await updateSupplierAction(supplier.id, formData)
      : await createSupplierAction(formData);

    setSubmitting(false);

    if (!result.ok) {
      // A duplicate email comes back attributed to its field, so it lands under
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
    if (result.supplierId) onSaved?.(result.supplierId);
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
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit supplier" : "New supplier"}</DialogTitle>
          <DialogDescription>
            {editing
              ? "Update their details. Their purchases and the stock they delivered are unaffected."
              : "Add somebody to buy from. Only a name is required — the rest can follow."}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
          <Field label="Name" htmlFor={id("name")} error={errors.name}>
            <Input
              id={id("name")}
              name="name"
              defaultValue={supplier?.name ?? ""}
              placeholder="Kestrel Aerospace Components"
              autoComplete="off"
              aria-invalid={Boolean(errors.name)}
            />
          </Field>

          <Field
            label="Contact person"
            htmlFor={id("contactPerson")}
            hint="Who to actually speak to."
            error={errors.contactPerson}
          >
            <Input
              id={id("contactPerson")}
              name="contactPerson"
              defaultValue={supplier?.contactPerson ?? ""}
              placeholder="Priya Raghunathan"
              autoComplete="off"
              aria-invalid={Boolean(errors.contactPerson)}
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Email"
              htmlFor={id("email")}
              hint="Optional, but unique across suppliers."
              error={errors.email}
            >
              <Input
                id={id("email")}
                name="email"
                type="email"
                defaultValue={supplier?.email ?? ""}
                placeholder="orders@kestrel.example"
                autoComplete="off"
                aria-invalid={Boolean(errors.email)}
              />
            </Field>

            <Field label="Phone" htmlFor={id("phone")} error={errors.phone}>
              <Input
                id={id("phone")}
                name="phone"
                type="tel"
                defaultValue={supplier?.phone ?? ""}
                placeholder="+44 20 7946 0112"
                autoComplete="off"
                aria-invalid={Boolean(errors.phone)}
              />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Account number"
              htmlFor={id("accountNumber")}
              hint="Our account with them, as it appears on their invoices."
              error={errors.accountNumber}
            >
              <Input
                id={id("accountNumber")}
                name="accountNumber"
                defaultValue={supplier?.accountNumber ?? ""}
                placeholder="Optional"
                autoComplete="off"
                aria-invalid={Boolean(errors.accountNumber)}
              />
            </Field>

            <Field
              label="Typical lead time"
              htmlFor={id("typicalLeadTimeDays")}
              hint="In days. A planning figure, not measured from history."
              error={errors.typicalLeadTimeDays}
            >
              <Input
                id={id("typicalLeadTimeDays")}
                name="typicalLeadTimeDays"
                type="number"
                min="0"
                step="1"
                defaultValue={
                  supplier?.typicalLeadTimeDays === null ||
                  supplier?.typicalLeadTimeDays === undefined
                    ? ""
                    : String(supplier.typicalLeadTimeDays)
                }
                placeholder="Optional"
                aria-invalid={Boolean(errors.typicalLeadTimeDays)}
                className="tabular"
              />
            </Field>
          </div>

          <Field label="Address" htmlFor={id("address")} error={errors.address}>
            <Textarea
              id={id("address")}
              name="address"
              defaultValue={supplier?.address ?? ""}
              placeholder="Unit 14, Brightmoor Industrial Estate, Slough"
              rows={3}
              aria-invalid={Boolean(errors.address)}
            />
          </Field>

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
                  : "Add supplier"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export { SupplierFormDialog };
