"use client";

import { useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Upload } from "lucide-react";
import { toast } from "sonner";

import {
  saveCertificateAction,
  updateCertificateAction,
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
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
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

/**
 * Upload, replace, or correct a certificate.
 *
 * One dialog in three modes, because the fields are identical and only the file
 * input differs:
 *
 *   add      — metadata plus a file
 *   replace  — the same, with copy that says the current one will be retired
 *   edit     — metadata only, no file input at all
 *
 * That last mode is separate on purpose. Fixing a typo in a certificate number
 * is a correction to the record of one document; uploading a different file is
 * a different document. Sharing one dialog but not one submission path keeps
 * both honest — an edit cannot silently become a replacement.
 *
 * The file check here is the cheap half: is there a file, is it a plausible
 * size, does it end in something we accept. The server reads the file's leading
 * bytes and decides what it actually is, because a `.pdf` on the end of a name
 * is not evidence of anything.
 */

export interface CertificateFormValues {
  id: string;
  certificateType: string;
  certificateNumber: string;
  issueDate: string;
  expiryDate: string;
}

export type CertificateFormMode = "add" | "replace" | "edit";

const COPY: Record<
  CertificateFormMode,
  { title: string; description: string; submit: string }
> = {
  add: {
    title: "Add certificate",
    description:
      "Record the certificate covering this batch and upload a scan of the document.",
    submit: "Upload certificate",
  },
  replace: {
    title: "Replace certificate",
    description:
      "Upload the new document. The current certificate is retired, not deleted — it stays in this product's history along with its file.",
    submit: "Replace certificate",
  },
  edit: {
    title: "Edit certificate details",
    description:
      "Correct the recorded details. The uploaded file is not changed — to attach a different document, use Replace.",
    submit: "Save changes",
  },
};

function CertificateFormDialog({
  open,
  onOpenChange,
  mode,
  stockLotId,
  certificate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: CertificateFormMode;
  stockLotId: string;
  /** Present for edit; absent for add. Ignored for replace. */
  certificate?: CertificateFormValues;
}) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<CertificateFieldErrors>({});
  const [chosenFile, setChosenFile] = useState<File | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  const fieldId = useId();
  const id = (name: string) => `${fieldId}-${name}`;
  const typeListId = `${fieldId}-types`;

  const editing = mode === "edit";
  const copy = COPY[mode];

  // Prefill only when correcting an existing record. A replacement is a new
  // document and starts blank, so last year's number is not carried forward by
  // accident.
  const defaults = editing ? certificate : undefined;

  function reset() {
    setErrors({});
    setChosenFile(null);
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const formData = new FormData(event.currentTarget);
    const parsed = certificateMetadataSchema.safeParse(
      Object.fromEntries(formData),
    );

    const fieldErrors: CertificateFieldErrors = parsed.success
      ? {}
      : toCertificateFieldErrors(parsed.error);

    if (!editing) {
      const fileProblem = checkFileClientSide(chosenFile);
      if (fileProblem) fieldErrors.file = fileProblem;
    }

    if (Object.keys(fieldErrors).length > 0) {
      setErrors(fieldErrors);
      toast.error("Check the highlighted fields");
      return;
    }

    setErrors({});
    setSubmitting(true);

    const result =
      editing && certificate
        ? await updateCertificateAction(certificate.id, formData)
        : await saveCertificateAction(stockLotId, formData);

    setSubmitting(false);

    if (!result.ok) {
      if (result.fieldErrors) setErrors(result.fieldErrors);
      toast.error(result.message);
      return;
    }

    onOpenChange(false);
    reset();
    formRef.current?.reset();
    toast.success(result.message);
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
      <DialogContent className="max-h-[90vh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{copy.description}</DialogDescription>
        </DialogHeader>

        <form
          ref={formRef}
          onSubmit={handleSubmit}
          className="flex flex-col gap-4"
          noValidate
        >
          <Field
            label="Certificate type"
            htmlFor={id("certificateType")}
            hint="Pick a common one or type another — the list is not exhaustive."
            error={errors.certificateType}
          >
            <Input
              id={id("certificateType")}
              name="certificateType"
              list={typeListId}
              defaultValue={defaults?.certificateType ?? ""}
              placeholder="FAA 8130-3"
              autoComplete="off"
              aria-invalid={Boolean(errors.certificateType)}
            />
            {/* A datalist rather than a select: a part sourced under Transport
                Canada or CAAC, or carrying a manufacturer's own form, has to be
                recordable without waiting for a migration. */}
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
              defaultValue={defaults?.certificateNumber ?? ""}
              placeholder="8130-123456"
              autoComplete="off"
              aria-invalid={Boolean(errors.certificateNumber)}
              className="font-mono"
            />
          </Field>

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
                defaultValue={defaults?.issueDate ?? ""}
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
                defaultValue={defaults?.expiryDate ?? ""}
                aria-invalid={Boolean(errors.expiryDate)}
              />
            </Field>
          </div>

          {editing ? null : (
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
                onChange={(event) =>
                  setChosenFile(event.target.files?.[0] ?? null)
                }
                aria-invalid={Boolean(errors.file)}
                className="h-auto py-2 file:mr-3 file:rounded file:px-2 file:py-1 file:text-xs"
              />
              {chosenFile ? (
                <p className="text-xs text-muted-foreground">
                  {chosenFile.name} · {formatFileSize(chosenFile.size)}
                </p>
              ) : null}
            </Field>
          )}

          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={submitting}>
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={submitting}>
              {submitting ? (
                <Loader2 className="animate-spin" />
              ) : editing ? null : (
                <Upload />
              )}
              {submitting ? "Saving…" : copy.submit}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export { CertificateFormDialog };
