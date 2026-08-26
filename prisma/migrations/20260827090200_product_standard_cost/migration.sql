-- Variable-cost inventory, part 3 of 3: demoting the catalogue cost.
--
-- products.cost_price becomes products.standard_cost, and becomes nullable.
--
-- ---------------------------------------------------------------------------
-- This migration is hand-written, and must stay that way
-- ---------------------------------------------------------------------------
--
-- `prisma migrate dev` cannot see a rename. Diffing the old schema against the
-- new one, it finds a column that vanished and a column that appeared, and
-- generates DROP COLUMN "cost_price" followed by ADD COLUMN "standard_cost" —
-- which is silent, total data loss for every cost in the catalogue. RENAME
-- COLUMN preserves the values. If this file is ever regenerated, check it.
--
-- It runs last on purpose. Part 2 populates the lots that take over valuation,
-- and the application code stops reading this column in the same change set;
-- doing the rename first would leave a window where stock is valued at zero.
--
-- ---------------------------------------------------------------------------
-- Why nullable
-- ---------------------------------------------------------------------------
--
-- The column used to be NOT NULL, which meant every product form had to
-- produce a cost whether anyone knew one or not — manufacturing exactly the
-- fake data this change set exists to eliminate. It is now a planning
-- reference: prefill for a purchase line, a column to browse the catalogue by,
-- and nothing that touches money which has to be right. Actual acquisition
-- cost lives on stock_lots, frozen per receipt.
--
-- Note for a future revert: renaming back is trivial, but restoring NOT NULL
-- will fail once any product has been saved with a null standard_cost. After
-- that point, reverting means deciding a value for those rows.

-- AlterTable
ALTER TABLE "products" RENAME COLUMN "cost_price" TO "standard_cost";

-- AlterTable
ALTER TABLE "products" ALTER COLUMN "standard_cost" DROP NOT NULL;

-- The old constraint named the old column and would refuse a null.
ALTER TABLE "products" DROP CONSTRAINT "products_cost_price_non_negative";

ALTER TABLE "products"
  ADD CONSTRAINT "products_standard_cost_non_negative"
    CHECK ("standard_cost" IS NULL OR "standard_cost" >= 0);
