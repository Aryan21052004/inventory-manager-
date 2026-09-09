-- The application currency, as one global setting.
--
-- One enum, one table, one row. Nothing else in the schema is touched: no
-- existing column is altered, no existing row is read, rewritten or deleted,
-- and not one of the twelve `Decimal(12, 2)` money columns is involved.
--
-- ---------------------------------------------------------------------------
-- What this migration means, and what it must never mean
-- ---------------------------------------------------------------------------
--
-- The currency is a *label on the numbers already stored*, not a rate applied
-- to them. Setting the installation to INR does not multiply anything; it says
-- that the values in `order_items.unit_price`, `stock_lots.unit_cost` and every
-- other money column are to be read as rupees. Switching afterwards to EUR
-- changes only how they are read.
--
-- There are no exchange rates in this system and none may be introduced. A
-- converted amount is indistinguishable from a transacted one once it has been
-- written down, and inventing money is precisely the failure the costing layer
-- was built to prevent — the same reason `products.standard_cost` was removed
-- rather than left to be averaged.
--
-- The accepted consequence, decided deliberately rather than overlooked:
-- history is re-labelled. A purchase entered while the setting said USD renders
-- with a rupee sign after a switch to INR. Nothing about the purchase changed;
-- what changed is the currency the installation reports in. The admin screen
-- states this before it saves.
--
-- ---------------------------------------------------------------------------
-- Why an enum
-- ---------------------------------------------------------------------------
--
-- ISO 4217 codes, not symbols. `₹` is a rendering of INR rather than the
-- currency itself, and `$` belongs to several currencies at once, so a symbol
-- cannot be a key. The enum also makes an unsupported value a write error here
-- rather than a formatting surprise three screens away.
--
-- All three carry a two-decimal minor unit, and that is load-bearing. Every
-- amount in this application is computed in integer minor units and stored as
-- `Decimal(12, 2)`. A currency with a different exponent — JPY has 0, KWD has 3
-- — would silently mis-scale every stored amount, so adding one is not a matter
-- of extending this list.
CREATE TYPE "Currency" AS ENUM ('USD', 'INR', 'EUR');

-- ---------------------------------------------------------------------------
-- Why a single-row table rather than a key/value store
-- ---------------------------------------------------------------------------
--
-- "The application currency" has to have exactly one answer. A settings table
-- that could hold two rows would give two, and whichever a query read first
-- would win — a bug that appears only under a race and reads as a formatting
-- glitch when it does.
--
-- The single row is therefore a database guarantee, not a convention: the id
-- defaults to `singleton` and the check constraint below refuses every other
-- value, so a second row cannot be inserted by a future writer, an importer or
-- a hand-run statement.
--
-- A typed column rather than a generic `key TEXT, value TEXT` pair, for the
-- same reason the rest of this schema is typed: `value` would accept 'INRR',
-- and the enum will not.
CREATE TABLE "app_settings" (
    "id"         TEXT NOT NULL DEFAULT 'singleton',

    -- The default is INR, matching the application default in
    -- src/lib/currency.ts. The two are asserted equal by a test, so they cannot
    -- drift apart.
    "currency"   "Currency" NOT NULL DEFAULT 'INR',

    "updated_at" TIMESTAMP(3) NOT NULL,

    -- Nullable and SetNull: the setting outlives the account that last changed
    -- it, and losing the attribution is better than losing the row.
    "updated_by" TEXT,

    CONSTRAINT "app_settings_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "app_settings" ADD CONSTRAINT "app_settings_updated_by_fkey"
    FOREIGN KEY ("updated_by") REFERENCES "users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- One row, forever. See the note above.
ALTER TABLE "app_settings"
  ADD CONSTRAINT "app_settings_singleton" CHECK ("id" = 'singleton');

-- ---------------------------------------------------------------------------
-- The row itself
-- ---------------------------------------------------------------------------
--
-- Seeded here so a migrated database is immediately in a defined state rather
-- than relying on the first admin to visit Settings.
--
-- `ON CONFLICT DO NOTHING` makes this re-runnable and, more importantly, makes
-- it decline to overwrite a choice somebody has already made. The application
-- reads this row through `getCurrency()`, which falls back to INR when it is
-- absent — a fresh database before this insert, or a test that has just
-- truncated everything — so a missing row degrades to the default rather than
-- taking a page down.
INSERT INTO "app_settings" ("id", "currency", "updated_at")
VALUES ('singleton', 'INR', CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;
