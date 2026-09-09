"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ImagePlus, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";

import {
  removeOrderItemImageAction,
  uploadOrderItemImagesAction,
} from "@/app/(app)/orders/actions";
import { Button } from "@/components/ui/button";
import {
  batchTooLargeMessage,
  IMAGE_ACCEPT_ATTRIBUTE,
  MAX_IMAGES_PER_UPLOAD,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_LABEL,
  MAX_UPLOAD_BATCH_LABEL,
  ACCEPTED_IMAGE_LABELS,
  formatImageSize,
} from "@/lib/validation/order-item-image";

/**
 * The photographs on one order line.
 *
 * Deliberately per line rather than per order: the control sits in the line's
 * own row, so which picture belongs to which part is a fact about where it is
 * on the page rather than something a caption has to explain.
 *
 * The thumbnails are the real images, served by the authenticated route — there
 * is no separate thumbnail pipeline and no image processing, because a handful
 * of photographs on one page does not need one and adding one would be a second
 * system to keep in step. The browser scales them; `loading="lazy"` keeps a line
 * with several from fetching all of them before anybody scrolls to it.
 *
 * Presented as a field of the line — a heading, the current value, and the
 * control that changes it, indented behind a rule inside the product cell. An
 * empty line says "No images" rather than rendering nothing, because blank
 * space is indistinguishable from a feature that was never built, which is
 * exactly how this one read.
 *
 * `canManage` decides whether the add and remove controls appear, and hiding is
 * all it does: both actions re-check the session *and* the order's status on the
 * server, so a request that skips this component is refused by the same rule.
 */

export interface OrderItemImage {
  id: string;
  fileName: string;
  contentType: string;
  fileSize: number;
  url: string;
}

export function OrderItemImages({
  orderItemId,
  productName,
  images,
  canManage,
  awaitingConfirmation = false,
}: {
  orderItemId: string;
  productName: string;
  images: OrderItemImage[];
  /**
   * True only while the order is confirmed or completed. Editable orders have
   * their lines replaced wholesale by `updateOrder`, so an image attached to
   * one could not survive; the server refuses those, and this hides the control
   * rather than offering a button that would fail.
   */
  canManage: boolean;
  /**
   * True on DRAFT and PENDING — the states where images are not refused
   * forever, only not yet. Presentation only: it decides whether an empty line
   * says so or stays silent, and never whether anything may be written.
   */
  awaitingConfirmation?: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  /*
   * A cancelled order with no photographs is the only line that shows nothing:
   * there is neither anything to look at nor anything that could be added
   * later. Every other state says which of the two it is.
   */
  if (!canManage && images.length === 0 && !awaitingConfirmation) return null;

  /* The field's own heading, shown wherever there is a field rather than a note. */
  const labelled = canManage || images.length > 0;

  async function upload(files: FileList | null) {
    if (!files || files.length === 0) return;

    /*
     * A courtesy check before the round-trip, on exactly the two things a
     * browser can tell us cheaply. The server re-checks both and, unlike this,
     * reads the leading bytes — a renamed file passes here and is refused
     * there, which is the point.
     */
    if (files.length > MAX_IMAGES_PER_UPLOAD) {
      toast.error(
        `Up to ${MAX_IMAGES_PER_UPLOAD} images at once. Add the rest in a second batch.`,
      );
      return;
    }

    const tooBig = [...files].find((file) => file.size > MAX_IMAGE_BYTES);
    if (tooBig) {
      toast.error(`"${tooBig.name}" is larger than ${MAX_IMAGE_LABEL}.`);
      return;
    }

    /*
     * The batch as a whole. Every file can be within the per-file limit and the
     * batch still be too big to send — three ordinary phone photographs will do
     * it — and without this the request leaves, exceeds the Server Action body
     * limit, and fails at the framework boundary where none of the messages
     * above can reach the user.
     *
     * The message comes from the same shared function the server uses, so the
     * refusal reads identically whichever side produces it.
     */
    const batchTooLarge = batchTooLargeMessage([...files].map((file) => file.size));
    if (batchTooLarge) {
      toast.error(batchTooLarge);
      return;
    }

    const payload = new FormData();
    for (const file of files) payload.append("images", file);

    setBusy(true);
    const result = await uploadOrderItemImagesAction(orderItemId, payload);
    setBusy(false);

    // Cleared either way, so choosing the same file again still fires a change.
    if (inputRef.current) inputRef.current.value = "";

    if (!result.ok) {
      toast.error(result.message);
      return;
    }

    toast.success(result.message);
    router.refresh();
  }

  async function remove(imageId: string) {
    setBusy(true);
    const result = await removeOrderItemImageAction(orderItemId, imageId);
    setBusy(false);

    if (!result.ok) {
      toast.error(result.message);
      return;
    }

    toast.success(result.message);
    router.refresh();
  }

  return (
    /*
      Indented behind a hairline rule so the block reads as a field of this
      line rather than as something belonging to the order. The order has its
      own cards; anything sitting inside the product cell has to say by its
      position that it does not.
    */
    <div className="mt-2 flex flex-col gap-1.5 border-l border-border pl-2.5">
      {labelled ? (
        <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Images
        </span>
      ) : null}

      {images.length > 0 ? (
        <ul className="flex flex-wrap gap-2">
          {images.map((image) => (
            <li key={image.id} className="group relative">
              {/*
                A plain anchor rather than next/image: these bytes come from an
                authenticated route that sets `no-store`, so there is nothing
                for an optimiser to cache and nothing it could fetch on the
                server's behalf.
              */}
              <a
                href={image.url}
                target="_blank"
                rel="noreferrer"
                className="block overflow-hidden rounded-md border border-border"
                title={`${image.fileName} · ${formatImageSize(image.fileSize)}`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={image.url}
                  alt={`${productName} — ${image.fileName}`}
                  loading="lazy"
                  className="size-20 bg-muted object-cover transition-opacity group-hover:opacity-90"
                />
              </a>

              <p className="mt-0.5 max-w-20 truncate text-[11px] text-muted-foreground">
                {image.fileName}
              </p>

              {canManage ? (
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={busy}
                  aria-label={`Remove ${image.fileName}`}
                  className="absolute right-1 top-1 size-6 p-0 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
                  onClick={() => void remove(image.id)}
                >
                  <Trash2 className="size-3" />
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {canManage ? (
        <div>
          <input
            ref={inputRef}
            type="file"
            multiple
            accept={IMAGE_ACCEPT_ATTRIBUTE}
            className="sr-only"
            id={`images-${orderItemId}`}
            disabled={busy}
            onChange={(event) => void upload(event.target.files)}
          />
          {/*
            The empty state sits on the button's own row rather than above it:
            "No images" is the line's current value and the button is what
            changes it, which is one fact, not two.
          */}
          <div className="flex flex-wrap items-center gap-2">
            {images.length === 0 ? (
              <span className="text-xs text-muted-foreground">No images</span>
            ) : null}
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => inputRef.current?.click()}
            >
              {busy ? <Loader2 className="animate-spin" /> : <ImagePlus />}
              {images.length === 0 ? "Add images" : "Add more"}
            </Button>
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {ACCEPTED_IMAGE_LABELS} · up to {MAX_IMAGE_LABEL} each ·{" "}
            {MAX_UPLOAD_BATCH_LABEL} per batch
          </p>
        </div>
      ) : awaitingConfirmation && images.length === 0 ? (
        /*
          One muted line, and deliberately no control: a draft cannot carry
          photographs, and offering a disabled button would only invite the
          question this sentence answers.
        */
        <span className="text-xs text-muted-foreground">
          Images can be added once the order is confirmed
        </span>
      ) : null}
    </div>
  );
}
