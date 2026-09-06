-- Making the cost-basis rule structural for operator-created lots.
--
-- `stock_lots` already asserted two of the four pairings between `cost_source`
-- and `unit_cost`:
--
--     stock_lots_purchase_cost_known   PURCHASE => unit_cost IS NOT NULL
--     stock_lots_unknown_cost_is_null  UNKNOWN  => unit_cost IS NULL
--
-- The two inbound routes an operator drives — an opening balance typed when a
-- product is created, and an upward stock adjustment — had no such assertion.
-- The application has required an explicit KNOWN/UNKNOWN declaration on both
-- for some time, and a KNOWN declaration always carries a cost, so an OPENING
-- or ADJUSTMENT lot with a null cost is already unreachable through the forms.
-- It was still representable in the database, and that gap is what this closes.
--
-- ---------------------------------------------------------------------------
-- Why the database and not just the forms
-- ---------------------------------------------------------------------------
--
-- A validation rule protects the path it sits on. A check constraint protects
-- the table. Lots are written by the stock engine, by the seed, by test
-- fixtures and by backfill migrations, and only the first of those goes through
-- a form. The rule that matters here — if the system says the basis is known,
-- the lot must carry a cost — should not depend on which door the row came
-- through.
--
-- It also makes the model legible from the schema alone. Reading `stock_lots`,
-- the four cost sources now state their own contract:
--
--     PURCHASE   => costed   (a supplier invoice line)
--     OPENING    => costed   (an operator said what it cost)
--     ADJUSTMENT => costed   (an operator said what it cost)
--     UNKNOWN    => uncosted (nobody could say)
--
-- ---------------------------------------------------------------------------
-- This does not force anyone to invent a cost
-- ---------------------------------------------------------------------------
--
-- Worth stating plainly, because the constraints read as though it might.
-- UNKNOWN remains fully available and is unchanged: an operator who cannot
-- price a batch chooses it, gives a written reason, and the lot is stored with
-- a null cost and a `cost_source` of UNKNOWN. These constraints do not touch
-- that path. What they refuse is the *contradiction* — a lot claiming a known
-- basis while holding no cost — which is a row that could only ever have come
-- from a bug.
--
-- ---------------------------------------------------------------------------
-- Existing data
-- ---------------------------------------------------------------------------
--
-- No backfill, and no rewriting of history. The development database holds five
-- UNKNOWN lots: two from the opening-stock form before it asked the question,
-- and three created by the stock-lot backfill migration, which had no operator
-- and no paperwork to work from. All five are UNKNOWN with a null cost, which
-- both constraints permit and neither touches.
--
-- Their missing reasons stay missing. Writing one now would be fabricating an
-- audit trail, which is the same fault as inventing a cost, moved one column
-- across. They remain what they are: honestly uncosted, historical stock.
--
-- Validated immediately rather than added NOT VALID. There are no violating
-- rows to grandfather, and a constraint that is not checked against what is
-- already stored proves less than one that is.

-- AddConstraint
ALTER TABLE "stock_lots"
  ADD CONSTRAINT "stock_lots_opening_cost_known"
    CHECK ("cost_source" <> 'OPENING' OR "unit_cost" IS NOT NULL);

-- AddConstraint
ALTER TABLE "stock_lots"
  ADD CONSTRAINT "stock_lots_adjustment_cost_known"
    CHECK ("cost_source" <> 'ADJUSTMENT' OR "unit_cost" IS NOT NULL);
