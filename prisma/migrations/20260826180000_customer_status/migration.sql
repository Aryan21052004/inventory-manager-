-- ---------------------------------------------------------------------------
-- Customers: a way to take one out of circulation.
--
-- `orders.customer_id` is Restrict, so a customer who has ever ordered can
-- never be deleted — the schema has said "deactivate them instead" since the
-- first migration without providing anything to deactivate them with. This is
-- that column.
--
-- Two states, not three. A catalogue item distinguishes a temporary pause from
-- a permanent retirement because the two lead to different decisions; a
-- customer does not. They are either someone new orders may be raised for or
-- someone kept for their history.
--
-- Every existing row is ACTIVE, which the default supplies — there is no such
-- thing as an already-archived customer before the concept existed.
-- ---------------------------------------------------------------------------

CREATE TYPE "CustomerStatus" AS ENUM ('ACTIVE', 'INACTIVE');

ALTER TABLE "customers"
  ADD COLUMN "status" "CustomerStatus" NOT NULL DEFAULT 'ACTIVE';

-- The list filters on it, so it carries an index like every other filtered
-- column in this schema.
CREATE INDEX "customers_status_idx" ON "customers"("status");
