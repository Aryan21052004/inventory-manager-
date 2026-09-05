-- ---------------------------------------------------------------------------
-- Orders: remove the discount.
--
-- This system does not apply discounts. The grand total is the sum of the line
-- totals and nothing else:
--
--   total = subtotal
--
-- The column is dropped rather than left defaulting to zero, for the same
-- reason tax was: a zero column is not neutral. It is a field the UI will
-- eventually render, a value a report will eventually sum, and an invitation to
-- reintroduce a calculation that was deliberately removed. Nothing can read a
-- column that is not there.
--
-- ---------------------------------------------------------------------------
-- READ THIS BEFORE APPLYING TO A DATABASE WITH REAL ORDERS
-- ---------------------------------------------------------------------------
--
-- Statement 2 below RESTATES HISTORICAL ORDER TOTALS. For any order that
-- carried a discount, `total` currently records what the customer was charged;
-- after this migration it records the sum of the line prices, which is a larger
-- number. Revenue over any period containing such an order therefore rises.
--
-- That is unavoidable. `total = subtotal - discount` and `total = subtotal`
-- cannot both hold for a discounted order, and the alternatives are worse:
-- rewriting `order_items.unit_price` to absorb the discount would falsify what
-- each line sold for, which the schema explicitly forbids ("an order must not
-- change retrospectively"), and rounding would not land exactly.
--
-- So run this first, against the database you are about to migrate:
--
--   SELECT order_number, status, subtotal, discount, total, confirmed_at
--   FROM orders
--   WHERE discount <> 0
--   ORDER BY confirmed_at NULLS LAST;
--
--   * No rows  -> this migration is completely lossless. Apply it.
--   * Any rows -> STOP. Export them and keep the export alongside this file,
--                 then record here which orders were restated and by how much
--                 in total. A comment in a SQL file is not a record; a file
--                 someone can open in three years is.
--
-- Restatement record (fill in before applying to a database with rows above):
--
--   Orders restated: ____
--   Total value moved: ____
--   Export committed at: ____
--
-- ---------------------------------------------------------------------------
--
-- Every statement is written to be safe to re-run. Prisma applies a migration
-- file statement by statement rather than in one transaction, so a failure
-- part-way leaves the earlier statements committed — which is exactly what
-- happened the first time the tax column was removed. `IF EXISTS` and a `WHERE`
-- clause that is already satisfied make a re-run a no-op instead of a second
-- failure.
-- ---------------------------------------------------------------------------

-- 1. The constraints reference the column, so they go first. All three:
--    `orders_discount_within_subtotal` came from the initial migration and was
--    never rebuilt by the tax removal, so it is still present and still names
--    the column.
ALTER TABLE "orders"
  DROP CONSTRAINT IF EXISTS "orders_total_balances",
  DROP CONSTRAINT IF EXISTS "orders_discount_within_subtotal",
  DROP CONSTRAINT IF EXISTS "orders_amounts_non_negative";

-- 2. Restate the totals. Deliberately expressed without naming `discount`, so
--    this works whether or not the column is still present, and so a re-run
--    after step 3 is a no-op rather than an error.
UPDATE "orders"
  SET "total" = "subtotal"
  WHERE "total" <> "subtotal";

-- 3. Drop the column.
ALTER TABLE "orders" DROP COLUMN IF EXISTS "discount";

-- 4. Rebuilt without it, so the database keeps arbitrating the arithmetic
--    rather than trusting whatever writes an order.
--
--    `total = subtotal` is a redundancy — two columns holding one number — and
--    it is kept deliberately: `total` is what every list, report, dashboard and
--    export reads, so collapsing the pair would touch far more code than it
--    would simplify. This constraint is what makes the redundancy safe.
ALTER TABLE "orders"
  ADD CONSTRAINT "orders_amounts_non_negative"
    CHECK ("subtotal" >= 0 AND "total" >= 0),
  ADD CONSTRAINT "orders_total_balances"
    CHECK ("total" = "subtotal");
