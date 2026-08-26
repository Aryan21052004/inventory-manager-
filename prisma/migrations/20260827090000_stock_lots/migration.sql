-- Variable-cost inventory, part 1 of 3: the valuation layer.
--
-- Purely additive. Two new tables, one new enum, two new columns on
-- order_items, and nothing existing is altered or dropped — so this migration
-- can be applied and left to sit while the code that reads it is written. The
-- rename of products.cost_price is deliberately NOT here; it is part 3, and it
-- runs only after part 2 has populated the lots that replace it.
--
-- The tables added here are a valuation and provenance index over the existing
-- stock ledger, not a second inventory system. products.stock_quantity remains
-- the authoritative quantity and stock_transactions remains the authoritative
-- record of movement; every lot points at the STOCK_IN that created it, and
-- every draw points at the STOCK_OUT that took it.

-- CreateEnum
CREATE TYPE "LotCostSource" AS ENUM ('PURCHASE', 'OPENING', 'ADJUSTMENT', 'UNKNOWN');

-- CreateTable
CREATE TABLE "stock_lots" (
    "id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "unit_cost" DECIMAL(12,2),
    "cost_source" "LotCostSource" NOT NULL,
    "quantity_received" INTEGER NOT NULL,
    "quantity_remaining" INTEGER NOT NULL,
    "source_type" "StockReferenceType" NOT NULL,
    "source_id" TEXT,
    "received_at" TIMESTAMP(3) NOT NULL,
    "stock_transaction_id" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_lots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_lot_consumptions" (
    "id" TEXT NOT NULL,
    "lot_id" TEXT NOT NULL,
    "stock_transaction_id" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unit_cost" DECIMAL(12,2),
    "total_cost" DECIMAL(12,2),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_lot_consumptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "stock_lots_stock_transaction_id_key" ON "stock_lots"("stock_transaction_id");

-- CreateIndex
CREATE INDEX "stock_lots_product_id_received_at_id_idx" ON "stock_lots"("product_id", "received_at", "id");

-- CreateIndex
CREATE INDEX "stock_lots_source_type_source_id_idx" ON "stock_lots"("source_type", "source_id");

-- CreateIndex
CREATE INDEX "stock_lot_consumptions_stock_transaction_id_idx" ON "stock_lot_consumptions"("stock_transaction_id");

-- CreateIndex
CREATE INDEX "stock_lot_consumptions_lot_id_idx" ON "stock_lot_consumptions"("lot_id");

-- AddForeignKey
ALTER TABLE "stock_lots" ADD CONSTRAINT "stock_lots_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_lots" ADD CONSTRAINT "stock_lots_stock_transaction_id_fkey" FOREIGN KEY ("stock_transaction_id") REFERENCES "stock_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_lots" ADD CONSTRAINT "stock_lots_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_lot_consumptions" ADD CONSTRAINT "stock_lot_consumptions_lot_id_fkey" FOREIGN KEY ("lot_id") REFERENCES "stock_lots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_lot_consumptions" ADD CONSTRAINT "stock_lot_consumptions_stock_transaction_id_fkey" FOREIGN KEY ("stock_transaction_id") REFERENCES "stock_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "order_items"
  ADD COLUMN "cost_total" DECIMAL(12,2),
  ADD COLUMN "costed_quantity" INTEGER NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- Constraints.
--
-- The arithmetic of the valuation layer, enforced where it cannot be argued
-- with. The application maintains these too, but a check constraint is what
-- stops a future caller — or a hand-run UPDATE at 2am — from writing a lot
-- that says it has more units left than ever arrived.
-- ---------------------------------------------------------------------------

ALTER TABLE "stock_lots"
  -- A lot that received nothing is not a batch, it is a mistake.
  ADD CONSTRAINT "stock_lots_quantity_received_positive"
    CHECK ("quantity_received" > 0),
  -- You cannot have fewer than none left, nor more left than ever arrived.
  ADD CONSTRAINT "stock_lots_quantity_remaining_within_received"
    CHECK ("quantity_remaining" >= 0 AND "quantity_remaining" <= "quantity_received"),
  ADD CONSTRAINT "stock_lots_unit_cost_non_negative"
    CHECK ("unit_cost" IS NULL OR "unit_cost" >= 0),
  -- A purchase always has a cost: purchase_items.unit_cost is NOT NULL, so a
  -- lot sourced from one can never legitimately be uncosted. This is the
  -- constraint that stops proven cost being quietly discarded.
  ADD CONSTRAINT "stock_lots_purchase_cost_known"
    CHECK ("cost_source" <> 'PURCHASE' OR "unit_cost" IS NOT NULL),
  -- And the converse: UNKNOWN means unknown. If a cost is present, the source
  -- has to say where it came from.
  ADD CONSTRAINT "stock_lots_unknown_cost_is_null"
    CHECK ("cost_source" <> 'UNKNOWN' OR "unit_cost" IS NULL),
  -- Mirrors stock_transactions_reference_pairing: the polymorphic pair only
  -- means anything together, and MANUAL is the one type with nothing to point
  -- at.
  ADD CONSTRAINT "stock_lots_source_pairing"
    CHECK (("source_type" = 'MANUAL') = ("source_id" IS NULL));

ALTER TABLE "stock_lot_consumptions"
  -- Signed: positive draws, negative returns. Zero moves nothing and would be
  -- a row that claims something happened when nothing did.
  ADD CONSTRAINT "stock_lot_consumptions_quantity_non_zero"
    CHECK ("quantity" <> 0),
  -- Both money columns are known together or unknown together. A total with no
  -- rate, or a rate with no total, is a half-written row.
  ADD CONSTRAINT "stock_lot_consumptions_cost_pairing"
    CHECK (("unit_cost" IS NULL) = ("total_cost" IS NULL)),
  -- The arithmetic has to add up, signed along with the quantity, so a plain
  -- SUM over these rows nets returns against draws.
  ADD CONSTRAINT "stock_lot_consumptions_total_balances"
    CHECK ("total_cost" IS NULL OR "total_cost" = "quantity" * "unit_cost");

ALTER TABLE "order_items"
  -- Cost can cover some of a line or all of it, never more than it.
  ADD CONSTRAINT "order_items_costed_quantity_within_quantity"
    CHECK ("costed_quantity" >= 0 AND "costed_quantity" <= "quantity"),
  -- Coverage and total travel together. A total covering zero units, or zero
  -- units with a total, is the exact confusion this pair exists to prevent.
  ADD CONSTRAINT "order_items_cost_pairing"
    CHECK (("cost_total" IS NULL) = ("costed_quantity" = 0));
