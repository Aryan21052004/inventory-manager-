-- ---------------------------------------------------------------------------
-- Orders: the lifecycle the module actually needs.
--
-- Two changes to the status enum:
--
--   PENDING is added between DRAFT and CONFIRMED. A draft is still being
--   edited; a pending order is finished but waiting on something — approval,
--   payment, a slot. Neither moves stock, but conflating them would mean an
--   order that is ready to go looks identical to one half typed.
--
--   FULFILLED becomes COMPLETED. Same meaning, and the name the rest of the
--   application now uses.
--
-- Done by building a new type and swapping, rather than with ALTER TYPE ... ADD
-- VALUE. `ADD VALUE` cannot be used in the same transaction that then writes
-- the new value, and the ordering of enum labels matters for `ORDER BY status`
-- — a swap puts PENDING where it belongs instead of appending it after
-- CANCELLED. This is the same pattern the inventory-domain-model migration used
-- for UserRole.
-- ---------------------------------------------------------------------------

BEGIN;

CREATE TYPE "OrderStatus_new" AS ENUM ('DRAFT', 'PENDING', 'CONFIRMED', 'COMPLETED', 'CANCELLED');

ALTER TABLE "orders" ALTER COLUMN "status" DROP DEFAULT;

-- FULFILLED is the only label whose name changes; everything else maps across
-- by its own name.
ALTER TABLE "orders"
  ALTER COLUMN "status" TYPE "OrderStatus_new"
  USING (
    CASE "status"::text
      WHEN 'FULFILLED' THEN 'COMPLETED'
      ELSE "status"::text
    END
  )::"OrderStatus_new";

ALTER TYPE "OrderStatus" RENAME TO "OrderStatus_old";
ALTER TYPE "OrderStatus_new" RENAME TO "OrderStatus";
DROP TYPE "public"."OrderStatus_old";

ALTER TABLE "orders" ALTER COLUMN "status" SET DEFAULT 'DRAFT';

COMMIT;

-- ---------------------------------------------------------------------------
-- Authorship and lifecycle timestamps.
--
-- `created_by` is what the orders list shows in its "Created By" column, and it
-- is set from the Clerk session on the server — never from the request. SET
-- NULL rather than CASCADE: removing a user must not remove their orders.
--
-- The timestamps record when the order reached each state. `confirmed_at` is
-- the moment stock was deducted. None of them decide anything: the stock ledger
-- is what says whether inventory moved, and these are for display and for
-- reading an order's history back.
-- ---------------------------------------------------------------------------

ALTER TABLE "orders"
  ADD COLUMN "created_by" TEXT,
  ADD COLUMN "confirmed_at" TIMESTAMP(3),
  ADD COLUMN "completed_at" TIMESTAMP(3),
  ADD COLUMN "cancelled_at" TIMESTAMP(3);

ALTER TABLE "orders" ADD CONSTRAINT "orders_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "orders_created_by_idx" ON "orders"("created_by");

-- Backfill: rows that are already past DRAFT were confirmed at some point, and
-- the created timestamp is the closest honest approximation available. Without
-- this the detail page would show "confirmed: never" for every seeded order.
UPDATE "orders" SET "confirmed_at" = "created_at"
  WHERE "status" IN ('CONFIRMED', 'COMPLETED');

UPDATE "orders" SET "completed_at" = "created_at" WHERE "status" = 'COMPLETED';
UPDATE "orders" SET "cancelled_at" = "created_at" WHERE "status" = 'CANCELLED';
