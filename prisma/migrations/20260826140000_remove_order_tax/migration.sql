-- ---------------------------------------------------------------------------
-- Orders: remove tax.
--
-- This system does not calculate tax. The grand total is the discounted
-- subtotal and nothing else:
--
--   total = subtotal - discount
--
-- The column is dropped rather than left defaulting to zero. A zero column is
-- not neutral — it is a field the UI will eventually render, a value a report
-- will eventually sum, and an invitation to reintroduce a calculation that was
-- deliberately removed. Nothing can read a column that is not there.
--
-- Existing rows are restated, not merely stripped of a column. Their totals
-- were computed as `subtotal - discount + tax`, so dropping the column alone
-- would leave every order carrying a total its own columns no longer explain —
-- and the rebuilt check constraint refuses exactly that. Recomputing is the
-- honest reading of the change: with tax gone from the system, the grand total
-- *is* the discounted subtotal, including for orders already written.
--
-- Every statement is written to be safe to re-run. The first attempt at this
-- migration failed halfway — Postgres rejected the new constraint because the
-- rows had not been restated yet — and Prisma applies a migration file
-- statement by statement rather than in one transaction, so the earlier
-- statements had already committed. `IF EXISTS` and a `WHERE` clause that is
-- already satisfied make re-running a no-op instead of a second failure.
-- ---------------------------------------------------------------------------

-- The constraints reference the column, so they go first.
ALTER TABLE "orders"
  DROP CONSTRAINT IF EXISTS "orders_total_balances",
  DROP CONSTRAINT IF EXISTS "orders_amounts_non_negative";

-- Restate the totals. Deliberately expressed without naming `tax`, so this
-- works whether or not the column is still present.
UPDATE "orders"
  SET "total" = "subtotal" - "discount"
  WHERE "total" <> "subtotal" - "discount";

ALTER TABLE "orders" DROP COLUMN IF EXISTS "tax";

-- Rebuilt without tax, so the database keeps arbitrating the arithmetic rather
-- than trusting whatever writes an order.
ALTER TABLE "orders"
  ADD CONSTRAINT "orders_amounts_non_negative"
    CHECK ("subtotal" >= 0 AND "discount" >= 0 AND "total" >= 0),
  ADD CONSTRAINT "orders_total_balances"
    CHECK ("total" = "subtotal" - "discount");
