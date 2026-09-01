-- Remove the minimum-stock threshold from the catalogue.
--
-- `minimum_stock` existed for one purpose: to derive a low/out-of-stock status
-- over `stock_quantity`. That classification has been removed from the product
-- — the business does not work to fixed stock thresholds or reorder levels, so
-- a threshold turned a physical count into an alert nobody had asked for.
--
-- Physical stock is untouched. `stock_quantity` remains the balance,
-- `stock_transactions` remains the ledger that explains it, and the lot,
-- consumption and valuation tables are not referenced here at all. A product
-- holding nothing still holds nothing; it simply no longer says so in capitals.
--
-- The CHECK constraint is dropped explicitly. Postgres would remove it along
-- with its only column anyway, but it was written by hand in
-- 20260825120000_inventory_domain_model rather than generated, so dropping it
-- by name keeps this migration a complete record of what it undoes.
--
-- No index referenced the column.

ALTER TABLE "products" DROP CONSTRAINT IF EXISTS "products_minimum_stock_non_negative";

ALTER TABLE "products" DROP COLUMN "minimum_stock";
