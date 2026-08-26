-- ---------------------------------------------------------------------------
-- Purchases: the lifecycle the module actually needs.
--
-- ORDERED becomes PENDING, matching the orders module and the language the
-- rest of the application now uses: a pending document is one that is finished
-- and waiting on something outside this system.
--
-- Done by building a new type and swapping, for the same reasons as the order
-- migration: `ALTER TYPE ... ADD VALUE` cannot be used in the transaction that
-- then writes the new value, and the label order matters for `ORDER BY status`.
-- ---------------------------------------------------------------------------

BEGIN;

CREATE TYPE "PurchaseStatus_new" AS ENUM ('DRAFT', 'PENDING', 'RECEIVED', 'CANCELLED');

ALTER TABLE "purchases" ALTER COLUMN "status" DROP DEFAULT;

ALTER TABLE "purchases"
  ALTER COLUMN "status" TYPE "PurchaseStatus_new"
  USING (
    CASE "status"::text
      WHEN 'ORDERED' THEN 'PENDING'
      ELSE "status"::text
    END
  )::"PurchaseStatus_new";

ALTER TYPE "PurchaseStatus" RENAME TO "PurchaseStatus_old";
ALTER TYPE "PurchaseStatus_new" RENAME TO "PurchaseStatus";
DROP TYPE "public"."PurchaseStatus_old";

ALTER TABLE "purchases" ALTER COLUMN "status" SET DEFAULT 'DRAFT';

COMMIT;

-- ---------------------------------------------------------------------------
-- Authorship and lifecycle timestamps.
--
-- `created_by` is what the purchases list shows in its "Created By" column, set
-- from the Clerk session on the server and never from the request. SET NULL
-- rather than CASCADE: removing a user must not remove their purchases.
--
-- `received_at` is the moment stock was added. None of these decide anything —
-- the stock ledger is what says whether inventory moved.
-- ---------------------------------------------------------------------------

ALTER TABLE "purchases"
  ADD COLUMN "created_by" TEXT,
  ADD COLUMN "received_at" TIMESTAMP(3),
  ADD COLUMN "cancelled_at" TIMESTAMP(3);

ALTER TABLE "purchases" ADD CONSTRAINT "purchases_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "purchases_created_by_idx" ON "purchases"("created_by");

-- Backfill: rows already RECEIVED had their goods arrive at some point, and the
-- purchase date is the closest honest approximation available.
UPDATE "purchases" SET "received_at" = "purchase_date" WHERE "status" = 'RECEIVED';
UPDATE "purchases" SET "cancelled_at" = "purchase_date" WHERE "status" = 'CANCELLED';
