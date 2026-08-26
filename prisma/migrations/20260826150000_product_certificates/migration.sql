-- ---------------------------------------------------------------------------
-- Certificates: airworthiness and conformity paperwork for a part.
--
-- Shaped as a record of documents over time rather than a set of columns on
-- `products`. A product has at most one *current* certificate and any number of
-- retired ones; `superseded_at` separates them. Replacing a certificate retires
-- the old row and inserts a new one, so the history survives and the file each
-- version pointed at is still addressable.
-- ---------------------------------------------------------------------------

CREATE TABLE "certificates" (
    "id" TEXT NOT NULL,
    "certificate_type" TEXT NOT NULL,
    "certificate_number" TEXT NOT NULL,
    "issue_date" DATE NOT NULL,
    "expiry_date" DATE,
    "file_name" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "file_size" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "superseded_at" TIMESTAMP(3),
    "product_id" TEXT NOT NULL,
    "uploaded_by" TEXT,

    CONSTRAINT "certificates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "certificates_product_id_superseded_at_idx" ON "certificates"("product_id", "superseded_at");
CREATE INDEX "certificates_expiry_date_idx" ON "certificates"("expiry_date");
CREATE INDEX "certificates_certificate_type_idx" ON "certificates"("certificate_type");
CREATE INDEX "certificates_uploaded_by_idx" ON "certificates"("uploaded_by");

-- AddForeignKey
ALTER TABLE "certificates" ADD CONSTRAINT "certificates_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "certificates" ADD CONSTRAINT "certificates_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Integrity constraints
--
-- Hand-written, like the others: Prisma's schema language has no syntax for
-- CHECK constraints or for partial unique indexes, and both of the rules below
-- are ones the application must not be the only thing enforcing.
-- ---------------------------------------------------------------------------

-- At most one current certificate per product.
--
-- This is the important one. Replacing a certificate is read-then-write —
-- retire the current row, insert a new one — and two uploads racing each other
-- would both find the same current row, both retire it, and both insert. The
-- product would end up with two certificates claiming to be current and no way
-- to say which is authoritative. A partial unique index makes the second one
-- fail instead, which the application turns into a retry-able conflict.
CREATE UNIQUE INDEX "certificates_one_current_per_product"
  ON "certificates" ("product_id")
  WHERE "superseded_at" IS NULL;

-- A document cannot expire before it was issued, and a file has a size.
ALTER TABLE "certificates"
  ADD CONSTRAINT "certificates_expiry_after_issue"
    CHECK ("expiry_date" IS NULL OR "expiry_date" >= "issue_date"),
  ADD CONSTRAINT "certificates_file_size_positive" CHECK ("file_size" > 0),
  ADD CONSTRAINT "certificates_number_not_blank"
    CHECK (length(btrim("certificate_number")) > 0),
  ADD CONSTRAINT "certificates_type_not_blank"
    CHECK (length(btrim("certificate_type")) > 0);
