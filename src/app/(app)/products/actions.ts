"use server";

import { revalidatePath } from "next/cache";

import { toSafeError } from "@/lib/errors";
import type { AdjustmentFieldErrors } from "@/lib/validation/adjustment";
import type { CertificateFieldErrors } from "@/lib/validation/certificate";
import type { ProductFieldErrors } from "@/lib/validation/product";
import {
  attachCertificate,
  removeCertificate,
  updateCertificateMetadata,
} from "@/server/certificates";
import {
  adjustStock,
  createProduct,
  deleteProduct,
  updateProduct,
} from "@/server/products";

/**
 * The products module's server actions.
 *
 * These are the endpoints the browser can reach, and they are deliberately
 * thin: parse nothing, decide nothing, authorise nothing. Every one of those
 * happens in src/server/products.ts, which they call — so the rules hold no
 * matter how the operation is invoked, and the tests can exercise them without
 * a request to fake.
 *
 * What lives here is the part that only makes sense inside Next: turning a
 * `FormData` into an object, invalidating the cached pages a write affects, and
 * converting a thrown error into something a form can render.
 *
 * A note on trust. An action is a public HTTP endpoint with a generated name.
 * Anything in the `FormData` is whatever the client chose to send, including
 * fields the form does not have — which is why nothing here forwards the raw
 * object anywhere except a schema that names the fields it accepts, and why
 * `createdBy` is never among them. Attribution comes from the Clerk session,
 * server-side, in `recordStockMovement`.
 */

export type ProductActionResult =
  | { ok: true; message: string; productId?: string }
  | {
      ok: false;
      message: string;
      /**
       * Product fields, plus the certificate fields the create form also
       * carries — creating a product can fail on either half.
       */
      fieldErrors?: ProductFieldErrors & CertificateFieldErrors;
    };

export type AdjustmentActionResult =
  | { ok: true; message: string; newStock: number }
  | { ok: false; message: string; fieldErrors?: AdjustmentFieldErrors };

export type CertificateActionResult =
  | { ok: true; message: string }
  | { ok: false; message: string; fieldErrors?: CertificateFieldErrors };

/**
 * Turns a thrown error into a form-shaped failure.
 *
 * `AppError.details.field` is how the write layer says which input a message
 * belongs under — a duplicate SKU should appear beneath the SKU box, not only
 * in a toast. Anything else has already been through `toSafeError`, so the
 * message is one we wrote rather than a leaked database error.
 */
function toFailure<T extends string>(
  error: unknown,
  context: string,
): { ok: false; message: string; fieldErrors?: Partial<Record<T, string>> } {
  const safe = toSafeError(error, context);
  const field = safe.details?.["field"];

  return {
    ok: false,
    message: safe.message,
    fieldErrors:
      typeof field === "string"
        ? ({ [field]: safe.message } as Partial<Record<T, string>>)
        : undefined,
  };
}

/** Pages whose content a product write can change. */
function revalidateProduct(id?: string): void {
  revalidatePath("/products");
  revalidatePath("/dashboard");
  if (id) revalidatePath(`/products/${id}`);
}

export async function createProductAction(
  formData: FormData,
): Promise<ProductActionResult> {
  try {
    const fields = Object.fromEntries(formData);
    const file = formData.get("file");

    /*
     * A certificate is optional at creation. Its presence is decided by whether
     * a file was actually chosen — an empty file input still submits a zero-byte
     * `File`, which is not a document — rather than by whether the metadata
     * fields happen to be filled in, so a half-typed certificate nobody attached
     * a scan to does not block creating the product.
     */
    const hasCertificate = file instanceof File && file.size > 0;

    const product = await createProduct(
      fields,
      hasCertificate ? { metadata: fields, file } : null,
    );

    revalidateProduct(product.id);

    return {
      ok: true,
      productId: product.id,
      message: `"${product.name}" added to the catalogue.`,
    };
  } catch (error) {
    // The failure may name a product field or a certificate field — the create
    // path validates both — so the union covers both.
    return toFailure<keyof ProductFieldErrors | keyof CertificateFieldErrors>(
      error,
      "createProductAction",
    );
  }
}

export async function updateProductAction(
  id: string,
  formData: FormData,
): Promise<ProductActionResult> {
  try {
    const product = await updateProduct(id, Object.fromEntries(formData));
    revalidateProduct(product.id);

    return {
      ok: true,
      productId: product.id,
      message: `"${product.name}" updated.`,
    };
  } catch (error) {
    return toFailure<keyof ProductFieldErrors>(error, "updateProductAction");
  }
}

export async function deleteProductAction(
  id: string,
): Promise<ProductActionResult> {
  try {
    const { name } = await deleteProduct(id);
    revalidateProduct(id);

    return { ok: true, message: `"${name}" deleted.` };
  } catch (error) {
    return toFailure<keyof ProductFieldErrors>(error, "deleteProductAction");
  }
}

export async function adjustStockAction(
  formData: FormData,
): Promise<AdjustmentActionResult> {
  try {
    const outcome = await adjustStock(Object.fromEntries(formData));
    revalidateProduct(outcome.productId);
    revalidatePath("/stock-movements");

    return {
      ok: true,
      newStock: outcome.newStock,
      message: `${outcome.productName}: ${outcome.previousStock} → ${outcome.newStock} units.`,
    };
  } catch (error) {
    return toFailure<keyof AdjustmentFieldErrors>(error, "adjustStockAction");
  }
}

// ---------------------------------------------------------------------------
// Certificates
// ---------------------------------------------------------------------------

/**
 * Attaches or replaces a product's certificate.
 *
 * The `File` travels inside the FormData rather than as a separate argument:
 * server actions serialise `File` natively, so the upload needs no route
 * handler of its own and no second endpoint to secure. Note the body size limit
 * raised in next.config.ts — the default is 1 MB, which a scanned certificate
 * clears easily.
 *
 * As everywhere else here, this wrapper decides nothing. `attachCertificate`
 * checks the role, validates the metadata, reads the file's leading bytes to
 * find out what it actually is, and writes the file before the row so a failure
 * leaves an orphan file rather than a row pointing at nothing.
 */
export async function saveCertificateAction(
  productId: string,
  formData: FormData,
): Promise<CertificateActionResult> {
  try {
    const certificate = await attachCertificate({
      productId,
      metadata: Object.fromEntries(formData),
      file: formData.get("file"),
    });

    revalidateProduct(productId);

    return {
      ok: true,
      message: `Certificate ${certificate.certificateNumber} saved.`,
    };
  } catch (error) {
    return toFailure<keyof CertificateFieldErrors>(
      error,
      "saveCertificateAction",
    );
  }
}

/** Corrects the details on the current certificate. The file is untouched. */
export async function updateCertificateAction(
  certificateId: string,
  productId: string,
  formData: FormData,
): Promise<CertificateActionResult> {
  try {
    const certificate = await updateCertificateMetadata(
      certificateId,
      Object.fromEntries(formData),
    );

    revalidateProduct(productId);

    return {
      ok: true,
      message: `Certificate ${certificate.certificateNumber} updated.`,
    };
  } catch (error) {
    return toFailure<keyof CertificateFieldErrors>(
      error,
      "updateCertificateAction",
    );
  }
}

/**
 * Withdraws the current certificate.
 *
 * A retirement rather than a deletion — the row and its file are kept as
 * history and the product simply reads as having none. See `removeCertificate`.
 */
export async function removeCertificateAction(
  certificateId: string,
): Promise<CertificateActionResult> {
  try {
    const { productId, certificateNumber } =
      await removeCertificate(certificateId);

    revalidateProduct(productId);

    return {
      ok: true,
      message: `Certificate ${certificateNumber} withdrawn. Its record is kept in the product's history.`,
    };
  } catch (error) {
    return toFailure<keyof CertificateFieldErrors>(
      error,
      "removeCertificateAction",
    );
  }
}
