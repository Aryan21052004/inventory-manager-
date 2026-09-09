-- Photographs attached to an individual order line.
--
-- A packing shot, a picture of damage, the state of the goods as they went out.
-- A line may have any number, including none, and every existing line has none
-- — this migration adds one table and reads or rewrites nothing.
--
-- ---------------------------------------------------------------------------
-- Why the line rather than the order
-- ---------------------------------------------------------------------------
--
-- A photograph is nearly always of a *part*. An order carrying five lines would
-- otherwise leave somebody guessing which one a picture referred to, so the row
-- points at `order_items`, which is the smallest thing the photograph is
-- actually about.
--
-- ---------------------------------------------------------------------------
-- Why CASCADE is safe here, and the rule that makes it so
-- ---------------------------------------------------------------------------
--
-- `updateOrder` replaces an editable order's lines wholesale — a `deleteMany`
-- followed by a `create` — so a line on a DRAFT or PENDING order has no stable
-- identity across an edit. An image attached to one would be destroyed by the
-- cascade the next time anybody changed a quantity, silently.
--
-- The application therefore accepts images only while the order is CONFIRMED or
-- COMPLETED: `canFulfilOutstanding`, which is exactly the complement of
-- `isEditable`. Linkable and editable are disjoint, so no image can ever exist
-- on a line that `updateOrder` is able to replace, and the cascade only ever
-- fires for a line being removed for real. That rule lives in
-- src/server/order-item-images.ts and is enforced on every write.
--
-- The alternative — RESTRICT — would have made the FK abort `updateOrder` the
-- moment any line carried an image, breaking existing order editing. Neither
-- that nor changing `updateOrder` was acceptable, and neither was needed.
--
-- ---------------------------------------------------------------------------
-- What this is deliberately NOT
-- ---------------------------------------------------------------------------
--
-- Not the certificate system. A certificate is a controlled airworthiness
-- document with issue and expiry dates that is superseded rather than deleted
-- and drives a compliance register. An order-line photograph has none of that,
-- and merging them would give an informal snapshot a compliance meaning.
--
-- Not columns on `order_items`. One row per image is what makes adding one
-- incapable of rewriting another, and removing one incapable of touching its
-- siblings — a structural guarantee rather than a matter of care.
--
-- Not a URL, and not a file on disk. The bytes live in this table, so a line
-- and its photographs are one thing to back up, restore and delete.
--
-- No backfill. No existing row is read, rewritten or deleted.

CREATE TABLE "order_item_images" (
    "id"            TEXT NOT NULL,
    "order_item_id" TEXT NOT NULL,
    -- The image itself. The only copy: nothing mirrors these bytes onto the
    -- line, and no URL is stored as a rival source of truth.
    "data"          BYTEA NOT NULL,
    "file_name"     TEXT NOT NULL,
    -- Determined by reading the file's leading bytes on upload, never taken
    -- from the browser's claim, and pinned below to the four formats accepted.
    "content_type"  TEXT NOT NULL,
    "file_size"     INTEGER NOT NULL,
    "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_item_images_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "order_item_images" ADD CONSTRAINT "order_item_images_order_item_id_fkey"
    FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- The line's gallery, oldest first — the only way these rows are ever read.
CREATE INDEX "order_item_images_order_item_id_created_at_idx"
    ON "order_item_images"("order_item_id", "created_at");

-- ---------------------------------------------------------------------------
-- What the database refuses
-- ---------------------------------------------------------------------------
--
-- The upload path checks all of this first, and checks more besides — it reads
-- the leading bytes rather than trusting a declared type. These constraints are
-- the floor underneath that: they hold whatever writes the row, including a
-- future importer or a hand-run statement.
--
-- The ceiling is 5 MB, written in bytes because a CHECK cannot import a
-- constant. `MAX_IMAGE_BYTES` in src/lib/validation/order-item-image.ts is the
-- same number and is the one the application reads; a test asserts the two
-- agree, so they cannot quietly drift apart.
ALTER TABLE "order_item_images"
  ADD CONSTRAINT "order_item_images_file_size_positive"
    CHECK ("file_size" > 0),

  ADD CONSTRAINT "order_item_images_file_size_within_limit"
    CHECK ("file_size" <= 5242880),

  ADD CONSTRAINT "order_item_images_file_name_not_blank"
    CHECK (length(btrim("file_name")) > 0),

  -- Four formats, and no others. An unsupported type cannot reach the column
  -- even if some future caller skips the sniffing, which matters because this
  -- value is echoed straight back as the `Content-Type` of a download.
  ADD CONSTRAINT "order_item_images_content_type_supported"
    CHECK ("content_type" IN ('image/jpeg', 'image/png', 'image/webp', 'image/gif'));
