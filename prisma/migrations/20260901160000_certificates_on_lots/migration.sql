-- Move airworthiness paperwork from the product to the batch it arrived on.
--
-- A certificate covers the units that were received, not the catalogue entry
-- they were booked against. Two deliveries of the same part number under two
-- different 8130-3 forms were previously indistinguishable: one current
-- certificate per product, and a product whose paperwork read as valid could
-- still have differently certified units sitting on the shelf. That is the
-- limitation this migration removes.
--
--   Supplier -> Purchase -> StockLot -> Certificate
--
-- Nothing about inventory changes. No stock quantity, ledger row, lot,
-- consumption or cost value is read or written below. Certificates never
-- affected FIFO allocation, valuation or stock movement, and still do not.

-- 1. The composite-foreign-key target.
--
-- `id` is already the primary key, so this unique constraint is redundant on
-- its own. It exists only so `(stock_lot_id, product_id)` on certificates has
-- a pair to reference, which is what lets the database refuse a certificate
-- naming one product while its lot names another.
CREATE UNIQUE INDEX "stock_lots_id_product_id_key" ON "stock_lots"("id", "product_id");

-- 2. The lot relationship. Nullable — see step 4.
ALTER TABLE "certificates" ADD COLUMN "stock_lot_id" TEXT;

CREATE INDEX "certificates_stock_lot_id_superseded_at_idx"
  ON "certificates"("stock_lot_id", "superseded_at");

-- 3. The lot link and the product-agreement check, as one composite key.
--
-- A single foreign key does both jobs: it points a certificate at its batch,
-- and because it carries `product_id` it makes disagreement between the
-- certificate's product and the lot's product unrepresentable.
--
-- MATCH SIMPLE is the default and is what makes this work: a row with a NULL
-- `stock_lot_id` is exempt, so the legacy rows in step 4 pass while every
-- lot-linked row is checked. MATCH FULL would reject all of them.
--
-- `product_id` therefore participates in two foreign keys — this one and the
-- existing CASCADE to `products`. That is intentional and legal.
--
-- ON DELETE RESTRICT, deliberately. A lot is only ever deleted for a product
-- that has never traded, and `deleteProduct` removes the certificates and
-- their stored files before it reaches the lots. Cascading here would let a
-- lot delete quietly destroy paperwork history.
ALTER TABLE "certificates" ADD CONSTRAINT "certificates_stock_lot_id_product_id_fkey"
  FOREIGN KEY ("stock_lot_id", "product_id")
  REFERENCES "stock_lots" ("id", "product_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- 4. Retire any product-level certificate that is still current.
--
-- Certificates are no longer permitted to claim coverage of a whole product,
-- so a row that is current and has no lot has to become history. It is retired
-- rather than deleted: the document existed and was filed, and that is the
-- record this table keeps.
--
-- Legacy rows that are *already* superseded are left exactly as they are, with
-- a null lot. They are deliberately NOT backfilled onto a lot — which units a
-- historical document covered cannot be established from the data, and
-- guessing would fabricate coverage. A product whose only lot looks obvious is
-- still a guess.
--
-- On the development database this affects zero rows. Other environments are
-- not assumed to match.
UPDATE "certificates"
   SET "superseded_at" = NOW()
 WHERE "stock_lot_id" IS NULL
   AND "superseded_at" IS NULL;

-- 5. Uniqueness moves from the product to the lot.
--
-- The old index enforced one current certificate per product. The new one
-- enforces one per lot, which is what lets two lots of the same part hold
-- different paperwork in different states at the same time. Rows with a null
-- lot are all superseded after step 4, so they cannot collide.
DROP INDEX "certificates_one_current_per_product";

CREATE UNIQUE INDEX "certificates_one_current_per_lot"
  ON "certificates" ("stock_lot_id")
  WHERE "superseded_at" IS NULL;

-- 6. A current certificate must name a lot.
--
-- Step 4 cleared the existing violations; this stops new ones. Together they
-- make "product-level certificates are history, never coverage" something the
-- database enforces rather than something the application has to remember.
--
-- Prisma's schema language cannot express a CHECK, so like the other
-- hand-written constraints in this project it lives here and is invisible to
-- `prisma migrate diff`.
ALTER TABLE "certificates"
  ADD CONSTRAINT "certificates_lot_required_unless_historical"
  CHECK ("stock_lot_id" IS NOT NULL OR "superseded_at" IS NOT NULL);
