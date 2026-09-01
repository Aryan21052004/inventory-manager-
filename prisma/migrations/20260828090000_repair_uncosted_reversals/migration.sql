-- Repairs stock that a cancellation put back with no lot to put it into.
--
-- ---------------------------------------------------------------------------
-- The defect
-- ---------------------------------------------------------------------------
--
-- The backfill in 20260827090100 deliberately did not cost historical orders:
-- FIFO was not the costing policy when they happened, so assigning them a COGS
-- would have been assumed rather than proven. That was right, but it left a
-- consequence unhandled — those orders can still be cancelled.
--
-- Cancelling one writes a REVERSAL and raises `products.stock_quantity`
-- correctly, but `returnToLots` had nothing to work with: an order confirmed
-- before cost tracking existed has no `stock_lot_consumptions` rows, so there
-- was no lot to return the units to. It returned zero, silently. The stock
-- existed in the ledger and in no lot, and
-- SUM(stock_lots.quantity_remaining) = products.stock_quantity — the invariant
-- the whole valuation layer rests on — stopped being true.
--
-- The application fix is in `returnToLots`, which now creates an UNKNOWN lot
-- for whatever the consumption rows cannot account for. This migration repairs
-- the rows already stranded by the defect.
--
-- ---------------------------------------------------------------------------
-- The repair
-- ---------------------------------------------------------------------------
--
-- One UNKNOWN lot per affected product, for exactly the difference. The cost is
-- NULL and stays NULL: these units are genuinely of unknown acquisition cost,
-- and inventing one — from `standard_cost`, from an average, from anything —
-- is the fabrication this whole design exists to prevent.
--
-- `received_at` is the product's creation date so FIFO consumes them early.
-- They are the oldest stock on the shelf by construction, and uncosted stock
-- draining first is what shrinks the uncosted share of reporting over time.
--
-- `stock_transaction_id` is NULL, which already means "created by a migration
-- rather than by a movement" — the same marker the backfill uses. No ledger
-- row is invented here; the REVERSAL that put this stock back already exists
-- and already explains it.

INSERT INTO "stock_lots" (
  "id", "product_id", "unit_cost", "cost_source",
  "quantity_received", "quantity_remaining",
  "source_type", "source_id", "received_at",
  "stock_transaction_id", "created_by", "created_at"
)
SELECT
  gen_random_uuid()::text,
  pr."id",
  NULL,
  'UNKNOWN'::"LotCostSource",
  pr."stock_quantity" - COALESCE(l."covered", 0),
  pr."stock_quantity" - COALESCE(l."covered", 0),
  'MANUAL'::"StockReferenceType",
  NULL,
  pr."created_at",
  NULL,
  NULL,
  CURRENT_TIMESTAMP
FROM "products" pr
LEFT JOIN (
  SELECT "product_id", SUM("quantity_remaining")::int AS "covered"
  FROM "stock_lots"
  GROUP BY "product_id"
) l ON l."product_id" = pr."id"
WHERE pr."stock_quantity" - COALESCE(l."covered", 0) > 0;

-- ---------------------------------------------------------------------------
-- The guard.
--
-- Same terminal check the backfill uses. If anything still fails to reconcile
-- the migration aborts rather than leaving a half-repaired database, because a
-- valuation that is quietly wrong is worse than one that refuses to load.
--
-- Note this only repairs shortfalls. A product whose lots hold *more* than its
-- stock quantity would be a different defect with a different cause, and this
-- deliberately does not paper over it — the guard will catch it and stop.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  mismatched integer;
BEGIN
  SELECT COUNT(*) INTO mismatched
  FROM "products" pr
  LEFT JOIN (
    SELECT "product_id", SUM("quantity_remaining")::int AS "remaining"
    FROM "stock_lots"
    GROUP BY "product_id"
  ) l ON l."product_id" = pr."id"
  WHERE pr."stock_quantity" <> COALESCE(l."remaining", 0);

  IF mismatched > 0 THEN
    RAISE EXCEPTION
      'Stock lot repair failed: % product(s) still do not reconcile.',
      mismatched;
  END IF;
END $$;
