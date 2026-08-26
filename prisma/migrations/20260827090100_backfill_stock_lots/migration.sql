-- Variable-cost inventory, part 2 of 3: backfilling lots for existing stock.
--
-- Data only. No table is created, altered or dropped here, so reverting this
-- step is `DELETE FROM stock_lots` and nothing else.
--
-- ---------------------------------------------------------------------------
-- What this does, and what it deliberately does not
-- ---------------------------------------------------------------------------
--
-- Every product holding stock gets lots that sum to exactly its current
-- quantity, so the invariant the whole valuation layer rests on —
-- SUM(stock_lots.quantity_remaining) = products.stock_quantity — is true from
-- the first moment lots exist. The terminal guard at the bottom aborts the
-- migration rather than leave that untrue.
--
-- Cost is reconstructed only where the existing data proves it: a received
-- purchase line records what was actually paid, and the stock ledger records
-- that those goods were booked in. Where that chain does not reach, the stock
-- becomes an UNKNOWN lot with a NULL cost and stays that way. Nothing here
-- reads products.cost_price, and nothing averages, estimates or interpolates —
-- a fabricated cost is indistinguishable from a real one once written, and the
-- point of this entire change set is that the difference stays visible.
--
-- The attribution is newest-first, which is not arbitrary: FIFO consumes the
-- oldest units, so what is still on the shelf is by definition what arrived
-- most recently. Cancelled purchases are excluded because their stock was
-- already reversed back out of inventory.
--
-- What is NOT done: historical orders are not costed. Replaying the ledger
-- through FIFO would produce a COGS figure for every past sale, but FIFO was
-- not the costing policy when those sales happened — there was no policy — so
-- those numbers would be assumed rather than proven. Past order_items keep
-- cost_total NULL and costed_quantity 0, which reports honestly as "margin
-- unknown for orders placed before costing existed". Accurate COGS begins now
-- and runs forward.
--
-- Backfilled lots carry stock_transaction_id NULL where no ledger row explains
-- them. The alternative was to invent STOCK_IN rows for movements that never
-- happened, which would have corrupted the one table this application treats
-- as the truth. Null is the honest marker, and it is a state no application
-- code is allowed to write.

-- ---------------------------------------------------------------------------
-- 1. Costed lots, reconstructed from received purchases, newest first.
--
-- The running total is what slices the attribution: for each purchase line,
-- everything newer than it has already claimed `running_total - quantity`
-- units, so this line may claim at most what is left of the balance under
-- that. Lines entirely beyond the balance are filtered out, and the last line
-- to fall inside it is partially claimed.
-- ---------------------------------------------------------------------------

INSERT INTO "stock_lots" (
  "id", "product_id", "unit_cost", "cost_source",
  "quantity_received", "quantity_remaining",
  "source_type", "source_id", "received_at",
  "stock_transaction_id", "created_by", "created_at"
)
SELECT
  gen_random_uuid()::text,
  c."product_id",
  c."unit_cost",
  'PURCHASE'::"LotCostSource",
  c."take",
  c."take",
  'PURCHASE'::"StockReferenceType",
  c."purchase_id",
  c."received_at",
  c."stock_transaction_id",
  NULL,
  CURRENT_TIMESTAMP
FROM (
  SELECT
    b."product_id",
    b."unit_cost",
    b."purchase_id",
    b."received_at",
    b."stock_transaction_id",
    LEAST(
      b."quantity",
      b."stock_quantity" - (b."running_total" - b."quantity")
    ) AS "take"
  FROM (
    SELECT
      pi."product_id",
      pi."quantity",
      pi."unit_cost",
      p."id" AS "purchase_id",
      p."received_at",
      pr."stock_quantity",
      (
        -- The STOCK_IN this delivery wrote for this product. Exactly one
        -- exists for a received purchase line; LIMIT 1 is belt and braces so
        -- a surprise cannot violate the unique index and abort the migration.
        SELECT st."id"
        FROM "stock_transactions" st
        WHERE st."reference_type" = 'PURCHASE'
          AND st."reference_id" = p."id"
          AND st."product_id" = pi."product_id"
          AND st."type" = 'STOCK_IN'
        ORDER BY st."created_at" ASC, st."id" ASC
        LIMIT 1
      ) AS "stock_transaction_id",
      SUM(pi."quantity") OVER (
        PARTITION BY pi."product_id"
        ORDER BY p."received_at" DESC, p."id" DESC
        ROWS UNBOUNDED PRECEDING
      ) AS "running_total"
    FROM "purchase_items" pi
    JOIN "purchases" p
      ON p."id" = pi."purchase_id"
     AND p."status" = 'RECEIVED'
     AND p."received_at" IS NOT NULL
    JOIN "products" pr
      ON pr."id" = pi."product_id"
    WHERE pr."stock_quantity" > 0
  ) b
  WHERE b."running_total" - b."quantity" < b."stock_quantity"
) c
WHERE c."take" > 0;

-- ---------------------------------------------------------------------------
-- 2. Whatever the purchase history could not account for.
--
-- Stock adjusted in by hand, opening balances entered when the product was
-- created, seeded rows, anything received before the ledger could explain it.
-- One UNKNOWN lot per product, dated to the product's creation so FIFO
-- consumes it first — it genuinely is the oldest stock, and draining it early
-- means the uncosted share of reporting shrinks on its own over time.
-- ---------------------------------------------------------------------------

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
-- 3. The guard.
--
-- Migrations run in a transaction, so raising here aborts the whole backfill
-- rather than leaving a half-costed database behind. A mismatch means the
-- attribution logic above disagrees with the ledger, and that is a condition
-- to stop and investigate, not to paper over.
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
      'Stock lot backfill failed: % product(s) have lots that do not sum to their stock quantity.',
      mismatched;
  END IF;
END $$;
