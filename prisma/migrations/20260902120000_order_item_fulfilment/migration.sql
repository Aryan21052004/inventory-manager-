-- Fulfilment separated from commercial completion.
--
-- The business sells parts it does not yet hold. Until now confirmation
-- refused an order the shelf could not fill, because the only thing an order
-- line could say about a shortfall was nothing. This column is the missing
-- vocabulary: how many of a line's units have physically left, as distinct
-- from how many were sold and from how many have a known acquisition cost.
--
-- Nothing about physical inventory changes here. No stock quantity, lot,
-- consumption or ledger row is written, altered or deleted by this migration,
-- and every existing negative-stock guard survives untouched:
--
--   products_stock_quantity_non_negative
--   stock_transactions_stock_non_negative
--   stock_lots_quantity_received_positive
--   stock_lots_quantity_remaining_within_received
--
-- Outstanding quantity is not stored. It is `quantity - fulfilled_quantity`,
-- and two columns that must agree are two columns that will not.

-- ---------------------------------------------------------------------------
-- 1. The column.
--
-- Defaulted to zero so the ALTER is a metadata-only operation on existing
-- rows; step 3 then sets the historical truth from the ledger. The check
-- constraints deliberately come *after* the backfill — a realised line has
-- costed_quantity > 0 and would violate costed <= fulfilled while fulfilled
-- is still sitting at its default.
-- ---------------------------------------------------------------------------

ALTER TABLE "order_items"
  ADD COLUMN "fulfilled_quantity" INTEGER NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- 2. Pre-flight.
--
-- The backfill below reads the stock ledger rather than the order status,
-- because the ledger is what actually moved. But it can only do that safely if
-- the two agree everywhere to begin with, so this block establishes that they
-- do and aborts if they do not.
--
-- Migrations run in a transaction, so RAISE here rolls back the whole thing,
-- column included. Nothing is repaired, adjusted or nudged into agreement: an
-- environment whose history does not match is a condition to stop and
-- investigate, not to paper over with invented data.
--
-- Three properties, each one an assumption the backfill would otherwise be
-- making silently:
--
--   A  Every CONFIRMED/COMPLETED line deducted its full quantity, net of any
--      reversal. This is what `confirmOrder` has always done — all-or-nothing
--      per line — so a mismatch means either a partial deduction predating
--      this column or a ledger edited outside the application.
--
--   B  No DRAFT or PENDING order ever moved stock. Neither status touches
--      inventory, and a movement against one would mean the status machine was
--      bypassed.
--
--   C  Every CANCELLED order nets to zero. Cancellation restores exactly what
--      was taken, so anything else means a reversal went missing or ran twice.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  realised_mismatch integer;
  unrealised_moved  integer;
  cancelled_net     integer;
  sample            text;
BEGIN
  -- A. Realised lines whose net ledger movement disagrees with the line.
  SELECT COUNT(*), MIN(o."order_number" || ' / ' || oi."product_id")
    INTO realised_mismatch, sample
  FROM "orders" o
  JOIN "order_items" oi ON oi."order_id" = o."id"
  WHERE o."status" IN ('CONFIRMED', 'COMPLETED')
    AND oi."quantity" <> COALESCE((
      SELECT SUM(
               CASE WHEN st."type" = 'STOCK_OUT'
                    THEN st."quantity"
                    ELSE -st."quantity"
               END
             )::int
      FROM "stock_transactions" st
      WHERE st."reference_type" = 'ORDER'
        AND st."reference_id" = o."id"
        AND st."product_id" = oi."product_id"
    ), 0);

  IF realised_mismatch > 0 THEN
    RAISE EXCEPTION
      'Fulfilment backfill refused: % realised order line(s) do not match the stock ledger (first: %). Reconcile the ledger before applying this migration; nothing has been changed.',
      realised_mismatch, sample;
  END IF;

  -- B. Unrealised orders that nonetheless moved stock.
  SELECT COUNT(DISTINCT o."id"), MIN(o."order_number")
    INTO unrealised_moved, sample
  FROM "orders" o
  JOIN "stock_transactions" st
    ON st."reference_type" = 'ORDER' AND st."reference_id" = o."id"
  WHERE o."status" IN ('DRAFT', 'PENDING');

  IF unrealised_moved > 0 THEN
    RAISE EXCEPTION
      'Fulfilment backfill refused: % draft or pending order(s) have stock movements (first: %). Neither status may move inventory; nothing has been changed.',
      unrealised_moved, sample;
  END IF;

  -- C. Cancelled orders that did not net back to zero.
  SELECT COUNT(*), MIN("order_number") INTO cancelled_net, sample
  FROM (
    SELECT o."id", o."order_number",
           COALESCE(SUM(
             CASE WHEN st."type" = 'STOCK_OUT'
                  THEN st."quantity"
                  ELSE -st."quantity"
             END
           ), 0)::int AS "net"
    FROM "orders" o
    LEFT JOIN "stock_transactions" st
      ON st."reference_type" = 'ORDER' AND st."reference_id" = o."id"
    WHERE o."status" = 'CANCELLED'
    GROUP BY o."id", o."order_number"
  ) c
  WHERE c."net" <> 0;

  IF cancelled_net > 0 THEN
    RAISE EXCEPTION
      'Fulfilment backfill refused: % cancelled order(s) have a non-zero net stock movement (first: %). A cancellation must restore exactly what it took; nothing has been changed.',
      cancelled_net, sample;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. The backfill, read from the ledger.
--
-- `fulfilled_quantity` is what the stock ledger says actually left for this
-- order and product, netted against any reversal — not what the status
-- implies. Step 2 has already established the two agree, so this produces
-- `quantity` for realised lines and 0 for everything else; deriving it from
-- the ledger anyway means the column records what happened rather than what a
-- label asserts, which is the same rule `loadInventoryImpact` and
-- `cancelOrder` already follow.
--
-- GREATEST(..., 0) is belt and braces: step 2 has ruled out a negative net,
-- and a negative here would violate the constraint added below rather than
-- being silently stored.
-- ---------------------------------------------------------------------------

UPDATE "order_items" oi
   SET "fulfilled_quantity" = LEAST(
         oi."quantity",
         GREATEST(COALESCE((
           SELECT SUM(
                    CASE WHEN st."type" = 'STOCK_OUT'
                         THEN st."quantity"
                         ELSE -st."quantity"
                    END
                  )::int
           FROM "stock_transactions" st
           WHERE st."reference_type" = 'ORDER'
             AND st."reference_id" = oi."order_id"
             AND st."product_id" = oi."product_id"
         ), 0), 0)
       );

-- ---------------------------------------------------------------------------
-- 4. The invariants.
--
--     0 <= costed_quantity <= fulfilled_quantity <= quantity
--
-- The existing `order_items_costed_quantity_within_quantity` is now strictly
-- weaker than the pair below and is deliberately left in place: historical
-- migrations are not edited, and it still documents the outer bound at the
-- point a reader meets the column.
-- ---------------------------------------------------------------------------

ALTER TABLE "order_items"
  -- Units can ship in part or in full, never beyond what was ordered.
  ADD CONSTRAINT "order_items_fulfilled_quantity_within_quantity"
    CHECK ("fulfilled_quantity" >= 0 AND "fulfilled_quantity" <= "quantity"),
  -- A unit that never shipped has no acquisition cost to know. Costing may
  -- cover some of what left or all of it, and nothing that did not leave.
  ADD CONSTRAINT "order_items_costed_within_fulfilled"
    CHECK ("costed_quantity" <= "fulfilled_quantity");

-- ---------------------------------------------------------------------------
-- 5. The terminal guard.
--
-- The constraints above would have rejected a bad row already; this checks the
-- property they cannot express — that the backfill agreed with the status for
-- every line, which is the assumption every report reading this column will
-- inherit.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  wrong integer;
BEGIN
  SELECT COUNT(*) INTO wrong
  FROM "orders" o
  JOIN "order_items" oi ON oi."order_id" = o."id"
  WHERE oi."fulfilled_quantity" <> CASE
          WHEN o."status" IN ('CONFIRMED', 'COMPLETED') THEN oi."quantity"
          ELSE 0
        END;

  IF wrong > 0 THEN
    RAISE EXCEPTION
      'Fulfilment backfill failed: % order line(s) were left with a fulfilled quantity that does not match their order status.',
      wrong;
  END IF;
END $$;

-- No index. Nothing filters or sorts on this column today, and an outstanding
-- orders screen would need an expression index on (quantity - fulfilled_
-- quantity) rather than one on the column itself. Added when such a screen
-- exists and has been measured, not before.
