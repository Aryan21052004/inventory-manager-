import "server-only";

import { AppError, NotFoundError } from "@/lib/errors";
import { canFulfilOutstanding, orderStatusLabel } from "@/lib/order-status";
import { prisma } from "@/lib/prisma";
import {
  ACCEPTED_IMAGE_LABELS,
  MAX_IMAGE_BYTES,
  MAX_IMAGES_PER_UPLOAD,
  MAX_IMAGE_LABEL,
  sanitiseImageName,
  type AcceptedImageType,
} from "@/lib/validation/order-item-image";
import { requireUser } from "@/server/auth";

/**
 * Photographs attached to an order line.
 *
 * A packing shot, a picture of damage, the state of the goods as they went out.
 * The bytes live in Postgres; there is no storage driver, no URL and no file on
 * disk, so a line and its photographs are one thing to back up and one thing to
 * delete.
 *
 * **Nothing here touches inventory.** No stock movement, no lot, no
 * consumption, no cost, no quantity on any document. Adding or removing a
 * photograph changes exactly one table, and the tests assert the rest of the
 * order is byte-identical afterwards.
 *
 * **Only on a committed order.** Every write goes through `assertManageable`,
 * which requires CONFIRMED or COMPLETED via `canFulfilOutstanding` — the same
 * predicate `fulfilOrder` enforces, called rather than restated.
 *
 * The reason is structural rather than a policy preference. `updateOrder`
 * replaces an editable order's lines wholesale — `deleteMany` then `create` —
 * so a line on a DRAFT or PENDING order has no stable identity across an edit,
 * and `order_item_images` cascades from the line. An image attached to a draft
 * would be destroyed the next time anybody changed a quantity, with no error
 * and no trace. Keeping "manageable" and `isEditable` disjoint makes that
 * unrepresentable instead of merely unlikely, and is why `updateOrder` needed
 * no change at all.
 *
 * **Any signed-in user.** STAFF and ADMIN both upload, view and remove.
 * Photographing what went out is ordinary warehouse work backed by a document,
 * which is the policy orders already use — ADMIN is reserved in this codebase
 * for corrections with no document behind them, and nothing here is one.
 */

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** One image, without its bytes. Everything a screen needs. */
export interface OrderItemImageView {
  id: string;
  orderItemId: string;
  fileName: string;
  contentType: string;
  fileSize: number;
  createdAt: Date;
  /** The authenticated route that serves the bytes. Never a storage path. */
  url: string;
}

export interface OrderItemImageFile {
  body: Buffer;
  contentType: string;
  fileName: string;
}

/**
 * The route that serves one image.
 *
 * Nested under the line on purpose: the id alone is not the address, so a
 * request has to name a line *and* an image that genuinely belongs to it. That
 * is what makes cross-line and cross-order access a 404 rather than something
 * the handler has to remember to check.
 */
export function orderItemImageUrl(
  orderItemId: string,
  imageId: string,
): string {
  return `/api/order-items/${orderItemId}/images/${imageId}`;
}

// ---------------------------------------------------------------------------
// What a file actually is
// ---------------------------------------------------------------------------

interface Signature {
  contentType: AcceptedImageType;
  /** Bytes every file of this format carries, and where they sit. */
  magic: readonly (readonly [offset: number, bytes: readonly number[]])[];
}

/**
 * The four accepted formats, by their leading bytes.
 *
 * The browser tells us a filename and a `Content-Type`, and neither is
 * evidence: renaming `payload.html` to `photo.png` takes a second, and the
 * `Content-Type` on a multipart part is whatever the sender wrote. If the
 * server believed either it would store a file it had not identified and then
 * serve it back with a type it had been told rather than one it had checked —
 * which is how an upload feature becomes a way to host an attack on your own
 * origin.
 *
 * WebP needs two windows rather than one: `RIFF` at the start, then `WEBP` at
 * byte 8, with the container length in between. Checking only the `RIFF` prefix
 * would accept any RIFF file — a WAV, an AVI — as an image.
 */
const SIGNATURES: readonly Signature[] = [
  // JPEG: SOI followed by a marker. The fourth byte varies by encoder.
  { contentType: "image/jpeg", magic: [[0, [0xff, 0xd8, 0xff]]] },
  // PNG: the eight-byte signature, including the CRLF/EOF trap bytes that exist
  // to detect a file mangled by a text-mode transfer.
  {
    contentType: "image/png",
    magic: [[0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]]],
  },
  // WebP: "RIFF" .... "WEBP".
  {
    contentType: "image/webp",
    magic: [
      [0, [0x52, 0x49, 0x46, 0x46]],
      [8, [0x57, 0x45, 0x42, 0x50]],
    ],
  },
  // GIF: "GIF87a" and "GIF89a" — the version digit is the only difference.
  { contentType: "image/gif", magic: [[0, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]]] },
  { contentType: "image/gif", magic: [[0, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]]] },
];

function matchesAt(
  body: Buffer,
  offset: number,
  bytes: readonly number[],
): boolean {
  if (body.byteLength < offset + bytes.length) return false;

  for (let index = 0; index < bytes.length; index += 1) {
    if (body[offset + index] !== bytes[index]) return false;
  }

  return true;
}

/**
 * Identifies a buffer, or returns null if it is not one of the four formats.
 *
 * Null rather than a thrown error: "this is not an image" is something a person
 * did, not something that went wrong, and the caller turns it into a message
 * under the file input.
 *
 * Note what this is not — a guarantee the file is *safe*, or even that it
 * decodes. It is a guarantee the file is what it claims to be, which is what
 * lets the download route send a truthful `Content-Type` alongside `nosniff`.
 */
export function sniffImageType(body: Buffer): AcceptedImageType | null {
  for (const signature of SIGNATURES) {
    if (signature.magic.every(([offset, bytes]) => matchesAt(body, offset, bytes))) {
      return signature.contentType;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

/**
 * Loads a line and refuses one whose order may not carry images.
 *
 * Both halves matter. The line has to exist, and its order has to be committed
 * — and this runs on every write, so a request that skips the UI is refused by
 * the same rule the screen honours.
 */
async function assertManageable(orderItemId: string): Promise<{
  id: string;
  orderId: string;
  productName: string;
}> {
  if (!orderItemId.trim()) {
    throw new AppError("BAD_REQUEST", "An order line is required.");
  }

  const line = await prisma.orderItem.findUnique({
    where: { id: orderItemId },
    select: {
      id: true,
      orderId: true,
      product: { select: { name: true } },
      order: { select: { status: true, orderNumber: true } },
    },
  });

  if (!line) throw new NotFoundError("Order line");

  /*
   * `canFulfilOutstanding` rather than a second list of statuses — the same
   * predicate `fulfilOrder` enforces and the order page reads. A draft or
   * pending order is refused because `updateOrder` would replace its lines and
   * the cascade would take the images with them; a cancelled order is refused
   * because it is finished.
   */
  if (!canFulfilOutstanding(line.order.status)) {
    throw new AppError(
      "CONFLICT",
      `Order ${line.order.orderNumber} is ${orderStatusLabel(line.order.status).toLowerCase()}, so photographs cannot be attached to its lines. Images can be added once an order is confirmed, and stay with it after completion.`,
    );
  }

  return {
    id: line.id,
    orderId: line.orderId,
    productName: line.product.name,
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Every image on one order's lines, keyed by line id.
 *
 * **The bytes are not selected.** A page rendering five lines with three
 * photographs each would otherwise pull fifteen buffers of up to 5 MB through
 * the server for a list that shows none of them. The `url` on each row is how a
 * browser asks for one, one at a time.
 */
export async function listOrderItemImages(
  orderId: string,
): Promise<Map<string, OrderItemImageView[]>> {
  const rows = await prisma.orderItemImage.findMany({
    where: { orderItem: { orderId } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      orderItemId: true,
      fileName: true,
      contentType: true,
      fileSize: true,
      createdAt: true,
    },
  });

  const byLine = new Map<string, OrderItemImageView[]>();

  for (const row of rows) {
    const list = byLine.get(row.orderItemId) ?? [];
    list.push({ ...row, url: orderItemImageUrl(row.orderItemId, row.id) });
    byLine.set(row.orderItemId, list);
  }

  return byLine;
}

/**
 * One image's bytes, for the download route.
 *
 * Addressed by **both** ids, and that is the access control rather than a
 * courtesy: `findFirst` with both in the `where` cannot return an image that
 * belongs to a different line, so guessing an id from another order yields the
 * same "not found" as an id that never existed. Nothing leaks either way.
 *
 * Authentication only — any signed-in user may look at what shipped. There is
 * no status rule here on purpose: an order cancelled after a photograph was
 * taken should still show it, because the photograph records something that
 * happened. Only *changing* the set is restricted.
 */
export async function getOrderItemImageFile(
  orderItemId: string,
  imageId: string,
): Promise<OrderItemImageFile> {
  await requireUser();

  if (!orderItemId.trim() || !imageId.trim()) {
    throw new NotFoundError("Image");
  }

  const image = await prisma.orderItemImage.findFirst({
    where: { id: imageId, orderItemId },
    select: { data: true, contentType: true, fileName: true },
  });

  if (!image) throw new NotFoundError("Image");

  return {
    body: Buffer.from(image.data),
    contentType: image.contentType,
    fileName: image.fileName,
  };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export interface UploadedImage {
  id: string;
  fileName: string;
  fileSize: number;
  contentType: string;
}

/**
 * Attaches one or more photographs to a line.
 *
 * **Adding never overwrites.** Each file becomes its own row; nothing reads or
 * replaces what is already there. That is a property of the table rather than
 * of this function — one image per row is exactly why the model is a table and
 * not a column.
 *
 * **All or nothing.** Every file is validated before any is written, and the
 * writes share one transaction, so a batch containing one bad file stores none
 * of it. A partial upload would leave somebody to work out which of five
 * photographs actually landed.
 */
export async function attachOrderItemImages(
  orderItemId: string,
  files: readonly unknown[],
): Promise<{ orderId: string; productName: string; images: UploadedImage[] }> {
  await requireUser();
  const line = await assertManageable(orderItemId);

  if (files.length === 0) {
    throw new AppError("BAD_REQUEST", "Choose at least one image.");
  }

  if (files.length > MAX_IMAGES_PER_UPLOAD) {
    throw new AppError(
      "BAD_REQUEST",
      `Up to ${MAX_IMAGES_PER_UPLOAD} images can be uploaded at once. Add the rest in a second batch.`,
    );
  }

  /*
   * Read and check everything first. The alternative — validating as we write —
   * would leave the earlier files of a rejected batch already stored.
   */
  const prepared: {
    /*
     * A plain `Uint8Array` rather than Node's `Buffer`. Both describe the same
     * bytes, but a `Buffer`'s backing store is typed `ArrayBufferLike`, which
     * the generated `Bytes` input refuses — it wants an `ArrayBuffer`. The
     * sniffing above works on the `Buffer`; only the value handed to Prisma is
     * converted.
     */
    data: Uint8Array<ArrayBuffer>;
    fileName: string;
    contentType: AcceptedImageType;
    fileSize: number;
  }[] = [];

  for (const file of files) {
    if (!(file instanceof File) || file.size === 0) {
      throw new AppError("BAD_REQUEST", "That file could not be read.");
    }

    // Checked before the bytes are pulled into memory, so a huge file is
    // refused rather than buffered.
    if (file.size > MAX_IMAGE_BYTES) {
      throw new AppError(
        "BAD_REQUEST",
        `"${sanitiseImageName(file.name)}" is larger than ${MAX_IMAGE_LABEL}. Photograph at a lower resolution, or upload it on its own.`,
      );
    }

    const data = Buffer.from(await file.arrayBuffer());

    // Re-checked against the bytes actually read. The declared size and the
    // real one are not required to agree.
    if (data.byteLength === 0 || data.byteLength > MAX_IMAGE_BYTES) {
      throw new AppError(
        "BAD_REQUEST",
        `"${sanitiseImageName(file.name)}" is larger than ${MAX_IMAGE_LABEL} or could not be read.`,
      );
    }

    const contentType = sniffImageType(data);

    if (!contentType) {
      throw new AppError(
        "BAD_REQUEST",
        `"${sanitiseImageName(file.name)}" is not a ${ACCEPTED_IMAGE_LABELS} image. Renaming a file does not change what it is — upload the actual picture.`,
      );
    }

    prepared.push({
      // `from` rather than `new`: it copies into a freshly allocated
      // `ArrayBuffer`, which is the exact type the generated input wants. A
      // `Buffer` view carries `ArrayBufferLike` and is rejected.
      data: Uint8Array.from(data),
      fileName: sanitiseImageName(file.name),
      contentType,
      fileSize: data.byteLength,
    });
  }

  const images = await prisma.$transaction(
    prepared.map((image) =>
      prisma.orderItemImage.create({
        data: { orderItemId: line.id, ...image },
        select: {
          id: true,
          fileName: true,
          fileSize: true,
          contentType: true,
        },
      }),
    ),
  );

  return { orderId: line.orderId, productName: line.productName, images };
}

/**
 * Removes one photograph, and only that one.
 *
 * Addressed by both ids for the same reason the download route is: a `deleteMany`
 * scoped to the pair cannot reach an image on another line, so a guessed id
 * removes nothing rather than somebody else's picture. The count it returns is
 * how "did that exist?" is answered without a second read.
 *
 * Nothing else changes — no quantity, no status, no stock, no cost. The line is
 * not written to at all.
 */
export async function removeOrderItemImage(
  orderItemId: string,
  imageId: string,
): Promise<{ orderId: string; productName: string }> {
  await requireUser();
  const line = await assertManageable(orderItemId);

  if (!imageId.trim()) throw new NotFoundError("Image");

  const { count } = await prisma.orderItemImage.deleteMany({
    where: { id: imageId, orderItemId: line.id },
  });

  if (count === 0) throw new NotFoundError("Image");

  return { orderId: line.orderId, productName: line.productName };
}
