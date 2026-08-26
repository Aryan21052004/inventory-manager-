"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import {
  createCustomerAction,
  updateCustomerAction,
} from "@/app/(app)/customers/actions";
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
  createCustomerSchema,
  toCustomerFieldErrors,
  updateCustomerSchema,
  type CustomerFieldErrors,
} from "@/lib/validation/customer";

/**
 * The create and edit form, as one component.
 *
 * The two are the same four fields, so keeping them apart would mean
 * maintaining two copies of one form to avoid a single conditional in the
 * heading.
 *
 * What is deliberately not here is the status. Archiving a customer is not an
 * edit — it takes a record out of circulation for everyone, it is restricted to
 * ADMIN, and it lives behind its own control. Leaving it out means this form
 * cannot carry it and the update action would ignore it anyway.
 *
 * Validation runs twice, and deliberately. Here, so a mistake is caught before
 * a round-trip, and again on the server, because this copy is a convenience and
 * anything reaching the server has to be checked where the client cannot edit
 * the rules.
 */

export interface CustomerFormValues {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  address: string | null;
}

function CustomerFormDialog({
  open,
  onOpenChange,
  customer,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Absent for a new customer; present to edit an existing one. */
  customer?: CustomerFormValues;
  onSaved?: (customerId: string) => void;
}) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<CustomerFieldErrors>({});

  // Generated rather than hardcoded: two of these dialogs can be mounted at
  // once — one per table row — and duplicate ids would point every label at the
  // first copy's input.
  const fieldId = useId();
  const id = (name: string) => `${fieldId}-${name}`;

  const editing = customer !== undefined;

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const formData = new FormData(event.currentTarget);
    const schema = editing ? updateCustomerSchema : createCustomerSchema;
    const parsed = schema.safeParse(Object.fromEntries(formData));

    if (!parsed.success) {
      setErrors(toCustomerFieldErrors(parsed.error));
      toast.error("Check the highlighted fields");
      return;
    }

    setErrors({});
    setSubmitting(true);

    const result = editing
      ? await updateCustomerAction(customer.id, formData)
      : await createCustomerAction(formData);

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
    if (result.customerId) onSaved?.(result.customerId);
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
          <DialogTitle>{editing ? "Edit customer" : "New customer"}</DialogTitle>
          <DialogDescription>
            {editing
              ? "Update their contact details. Their orders are unaffected."
              : "Add someone to sell to. Only a name is required — the rest can follow."}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
          <Field label="Name" htmlFor={id("name")} error={errors.name}>
            <Input
              id={id("name")}
              name="name"
              defaultValue={customer?.name ?? ""}
              placeholder="Brightline Aviation Ltd"
              autoComplete="off"
              aria-invalid={Boolean(errors.name)}
            />
          </Field>

          <Field
            label="Email"
            htmlFor={id("email")}
            hint="Optional, but unique across customers when given."
            error={errors.email}
          >
            <Input
              id={id("email")}
              name="email"
              type="email"
              defaultValue={customer?.email ?? ""}
              placeholder="parts@brightline.example"
              autoComplete="off"
              aria-invalid={Boolean(errors.email)}
            />
          </Field>

          <Field label="Phone" htmlFor={id("phone")} error={errors.phone}>
            <Input
              id={id("phone")}
              name="phone"
              type="tel"
              defaultValue={customer?.phone ?? ""}
              placeholder="+1 555 0100"
              autoComplete="off"
              aria-invalid={Boolean(errors.phone)}
            />
          </Field>

          <Field label="Address" htmlFor={id("address")} error={errors.address}>
            <Textarea
              id={id("address")}
              name="address"
              defaultValue={customer?.address ?? ""}
              placeholder="Hangar 4, Fieldgate Airpark"
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
                  : "Add customer"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export { CustomerFormDialog };
