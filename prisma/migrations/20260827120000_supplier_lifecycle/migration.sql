-- Suppliers gain a lifecycle, and two fields the business actually asked for.
--
-- Purely additive. One enum, three columns, one index — nothing existing is
-- altered or dropped, and every supplier already on file becomes ACTIVE, which
-- is what they all were in practice: the application had no way to make a
-- supplier anything else, because until now it had no way to write a supplier
-- at all.
--
-- Reverting is dropping the three columns and the type. No data can be lost by
-- doing so, because nothing else references them.
--
-- Deliberately *not* here: any change to `products.supplier_id` or
-- `purchases.supplier_id`. The SetNull/Restrict asymmetry between them is
-- intentional and load-bearing — Restrict is what stops a supplier with
-- purchase history being deleted, and that guard is the last link in the
-- StockLot → Purchase → Supplier provenance chain the costing layer depends on.
-- Archiving is a column update; it touches no lot, no quantity and no cost.

-- CreateEnum
CREATE TYPE "SupplierStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- AlterTable
ALTER TABLE "suppliers"
  ADD COLUMN "account_number" TEXT,
  ADD COLUMN "typical_lead_time_days" INTEGER,
  ADD COLUMN "status" "SupplierStatus" NOT NULL DEFAULT 'ACTIVE';

-- CreateIndex
CREATE INDEX "suppliers_status_idx" ON "suppliers"("status");

-- A lead time is a number of days, and a negative one is not a slow delivery.
-- Bounded well below the integer ceiling: anything past a few years is a typo
-- on its way to becoming a reorder suggestion nobody can explain.
ALTER TABLE "suppliers"
  ADD CONSTRAINT "suppliers_typical_lead_time_days_sane"
    CHECK (
      "typical_lead_time_days" IS NULL
      OR ("typical_lead_time_days" >= 0 AND "typical_lead_time_days" <= 3650)
    );
