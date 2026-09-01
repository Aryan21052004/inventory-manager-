-- Indexes on the dates the reports actually filter by.
--
-- The reporting rule is that a financial figure is dated by the economic event:
-- a sale by when its order was confirmed, procurement by when its delivery was
-- received. Both columns were unindexed — `orders(created_at)` and
-- `purchases(purchase_date)` exist, but those date the paperwork rather than
-- the transaction, and neither helps a query filtering on the other column.
--
-- ---------------------------------------------------------------------------
-- Measured, not assumed
-- ---------------------------------------------------------------------------
--
-- The development database has fewer than twenty rows per table, where Postgres
-- sequentially scans everything and no index is used at all. So these were
-- measured on a throwaway database loaded with three years of synthetic
-- history — 120,000 orders, 40,000 purchases, 60,000 lots — running the actual
-- report aggregates, best of five:
--
--   sales, 12-month window       67.1ms -> 51.2ms   24% faster
--   purchase spend, 12 months     2.3ms ->  0.4ms   81% faster
--
-- Both indexes are partial. A null `confirmed_at` means an order was never
-- confirmed and a null `received_at` means a delivery never arrived; neither
-- can appear in a report that reads those columns, so indexing them would be
-- storing rows the query can never want. On the generated data that is roughly
-- half of each table.
--
-- ---------------------------------------------------------------------------
-- What was deliberately not added
-- ---------------------------------------------------------------------------
--
-- `stock_lots(quantity_remaining) WHERE quantity_remaining > 0` was measured
-- alongside these and is not included. It moved the valuation aggregate from
-- 14.6ms to 13.7ms — six per cent — and the plan still showed a sequential
-- scan, because the query reads two thirds of the table and an index is the
-- wrong tool for that. It would have been an index nothing used.
--
-- `stock_lot_consumptions(lot_id, created_at)` is also absent. It would serve
-- historical as-of valuation, which this version does not implement, so there
-- is no query for it to help yet.

CREATE INDEX "orders_confirmed_at_idx"
  ON "orders" ("confirmed_at")
  WHERE "confirmed_at" IS NOT NULL;

CREATE INDEX "purchases_received_at_idx"
  ON "purchases" ("received_at")
  WHERE "received_at" IS NOT NULL;
