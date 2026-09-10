-- Per-record currency: Phase 0 of three (expand).
--
-- Replaces one installation-wide currency that every stored amount was read
-- in with a currency recorded on each record that holds money.
--
-- ---------------------------------------------------------------------------
-- What was wrong
-- ---------------------------------------------------------------------------
--
-- `app_settings.currency` was documented as a label rather than a rate: it said
-- how every `Decimal(12, 2)` in the database should be read, and changing it
-- re-labelled all of them at once. An amount of 16,960 entered against a USD
-- purchase rendered as 16,960 rupees the moment the setting moved to INR. No
-- number changed, which was the design; but the *meaning* of every historical
-- number did, which made history unreliable.
--
-- The fix is not conversion. There are no exchange rates in this system and
-- none may be added — a converted amount is indistinguishable from a real one
-- once it is written down. The fix is that each record remembers what it was
-- denominated in, so nothing has to be inferred from a setting later.
--
-- ---------------------------------------------------------------------------
-- Expand, backfill, contract — and why this migration only expands
-- ---------------------------------------------------------------------------
--
-- Every column added here is NULLABLE, and deliberately so. Existing rows have
-- no recoverable currency: `app_settings` keeps a single `updated_at` and no
-- history, so once the setting has been changed there is no record of what any
-- earlier row was entered under. Assigning them the current setting would be
-- the same falsification this migration exists to end, performed once and
-- permanently.
--
-- So legacy rows keep a NULL currency and the application shows them as
-- unlabelled rather than guessing. A later migration backfills from reviewed
-- evidence and then contracts:
--
--   Phase 1  application writes a currency on every new record
--   Phase 2  backfill, per installation, from evidence rather than a default
--   Phase 3  SET NOT NULL on orders.currency and purchases.currency, and add
--            the paired-null CHECK constraints
--
-- ---------------------------------------------------------------------------
-- Why there are no check constraints here
-- ---------------------------------------------------------------------------
--
-- The paired-null rules — `selling_price IS NULL` exactly when
-- `price_currency IS NULL`, and the same for the two cost columns and the
-- order line — belong to Phase 3, not here.
--
-- They were briefly written into this migration as NOT VALID, on the reasoning
-- that NOT VALID still enforces on new inserts and so would protect new rows
-- while legacy ones waited. That is true, and it is exactly why it was wrong
-- at this point in the sequence: enforcing on inserts breaks every caller that
-- does not yet supply a currency, which is all of them until Phase 1 lands.
-- The whole purpose of an expand migration is that existing code keeps running
-- untouched, so the constraints go in with the contract, once the writers
-- populate the columns and the backfill has settled the old rows.
--
-- No row is read, rewritten or deleted by this migration. No monetary value
-- changes, and no existing query breaks: every column added is nullable, and
-- the only rename is behind `getCurrency()` in src/server/settings.ts.

-- ---------------------------------------------------------------------------
-- The setting stops being "the currency" and becomes "the default for new
-- entries". Renamed rather than reused so the old reading cannot survive by
-- accident in a query somebody copied forward.
-- ---------------------------------------------------------------------------
ALTER TABLE "app_settings" RENAME COLUMN "currency" TO "default_currency";

-- ---------------------------------------------------------------------------
-- Reference value. A current catalogue price, not a record of a transaction,
-- so unlike the columns below this one is editable afterwards.
-- ---------------------------------------------------------------------------
ALTER TABLE "products" ADD COLUMN "price_currency" "Currency";


-- ---------------------------------------------------------------------------
-- Transaction currencies. One per document, authoritative for its lines:
-- `order_items` and `purchase_items` get no currency column, because one order
-- is one contract at one price list and a per-line currency would make the
-- document's own subtotal and total unrepresentable as single figures.
--
-- Editable while the document is editable, frozen once it commits — CONFIRMED
-- for an order, RECEIVED for a purchase, since receipt is what writes the
-- currency into the stock lots.
-- ---------------------------------------------------------------------------
ALTER TABLE "orders" ADD COLUMN "currency" "Currency";
ALTER TABLE "purchases" ADD COLUMN "currency" "Currency";

-- ---------------------------------------------------------------------------
-- Acquisition cost currency, on the lot itself rather than found by joining
-- back to a purchase. Three of the five ways a lot is created have no purchase
-- behind them — opening stock, a manual adjustment, and a sales return — and
-- FIFO has to read the currency without walking a chain that may not exist.
--
-- Never invented for a null cost: unknown stays unknown, in both directions.
-- ---------------------------------------------------------------------------
ALTER TABLE "stock_lots" ADD COLUMN "cost_currency" "Currency";


-- ---------------------------------------------------------------------------
-- Frozen at the draw, copied from the lot, for the same reason `unit_cost`
-- already is: historical COGS stays a fact about this row rather than a lookup
-- a later migration could quietly restate.
--
-- These rows are where a line's true cost of sale survives when its currencies
-- diverge and the order line can no longer state a single total.
-- ---------------------------------------------------------------------------
ALTER TABLE "stock_lot_consumptions" ADD COLUMN "cost_currency" "Currency";


-- ---------------------------------------------------------------------------
-- The cost side of an order line, which is NOT the order's currency: stock
-- bought in USD can be sold in INR, and collapsing the two is the error this
-- whole change exists to stop.
--
-- Null — together with `cost_total`, and with `costed_quantity` at zero — when
-- one line drew from costed lots in more than one currency. FIFO may
-- legitimately do that, and the sum of a USD layer and a EUR layer is not a
-- number in any currency. The line degrades to uncosted so those units fall
-- out of both the cost and the revenue that margin is measured over, and no
-- figure can be inflated by them. The per-layer truth stays in
-- `stock_lot_consumptions`.
-- ---------------------------------------------------------------------------
ALTER TABLE "order_items" ADD COLUMN "cost_currency" "Currency";

