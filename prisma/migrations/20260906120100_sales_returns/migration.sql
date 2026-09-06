-- Sales returns: the receipt event, the returned batch, and quarantine.
--
-- A return is not a cancellation. A cancellation says the sale never happened —
-- the units never really left, so they go back into the batches they came from
-- and the order's revenue and cost are erased. A return says the sale did
-- happen and is being partly unwound: the goods left, sat in somebody else's
-- custody, and have come back as a new physical receipt.
--
-- Everything below follows from that one distinction:
--
--   * returned units arrive as NEW lots, never restored into the originals
--   * one lot per original cost layer, so two prices come back as two prices
--   * each lot is QUARANTINED until a person inspects it
--   * each lot carries no certificate until a person files one
--   * each lot is dated by the day it arrived, not the day the original did
--
-- ---------------------------------------------------------------------------
-- What this migration does NOT do
-- ---------------------------------------------------------------------------
--
-- No behaviour changes. FIFO still consumes every lot with stock remaining,
-- because every existing lot is SALEABLE and nothing can yet be anything else.
-- No quantity, cost, ledger row, consumption row or valuation is read or
-- written. There is no backfill: this business has no historical sales returns,
-- and inventing any would be the same fault as inventing a cost.
--
-- Revenue is untouched and stays untouched. `order_items.quantity`,
-- `unit_price`, `total` and `cost_total` keep describing the sale that was
-- made; a return is a separate economic event, netted at read time so gross
-- sales, returns and net sales stay three readable figures.

-- ---------------------------------------------------------------------------
-- 1. Whether a batch may be sold
-- ---------------------------------------------------------------------------
--
-- Lot-level rather than product-level, because it has to be: the same part
-- routinely holds saleable stock beside a returned batch awaiting inspection.
--
-- Status never changes a quantity. A quarantined lot's units are on the shelf,
-- inside `products.stock_quantity`, and inside the invariant
-- SUM(quantity_remaining) = stock_quantity. What status decides is whether FIFO
-- may draw them — which is why saleable stock is derived from this column and
-- never stored as a rival total.
--
-- There is no duration and no expiry. Different parts warrant different
-- inspections, so nothing computes when quarantine ends; a lot leaves
-- QUARANTINED only when somebody says so, and says why.
CREATE TYPE "LotStatus" AS ENUM ('SALEABLE', 'QUARANTINED', 'REJECTED');

-- ---------------------------------------------------------------------------
-- 2. The receipt event
-- ---------------------------------------------------------------------------
--
-- `received_at` is when the goods physically arrived and is deliberately not
-- `created_at`: it becomes the `received_at` of every lot this return creates,
-- so returned stock sits in FIFO where it actually re-entered the building,
-- behind anything received while it was away.
--
-- There is no return_lines table. A return's per-line quantity is the sum of
-- the lots naming that line (see step 4), and a stored copy would be a second
-- number to keep in step with the first.
CREATE TABLE "returns" (
  "id"            TEXT         NOT NULL,
  "return_number" TEXT         NOT NULL,
  "received_at"   TIMESTAMP(3) NOT NULL,
  "note"          TEXT,
  "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "order_id"      TEXT         NOT NULL,
  "created_by"    TEXT,

  CONSTRAINT "returns_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "returns_return_number_key" ON "returns"("return_number");
CREATE INDEX "returns_order_id_idx"     ON "returns"("order_id");
CREATE INDEX "returns_received_at_idx"  ON "returns"("received_at");
CREATE INDEX "returns_created_by_idx"   ON "returns"("created_by");

-- Restrict: an order with returned goods against it is history, and history is
-- not something a delete should take with it.
ALTER TABLE "returns"
  ADD CONSTRAINT "returns_order_id_fkey"
    FOREIGN KEY ("order_id") REFERENCES "orders"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- SetNull rather than cascade: the goods still came back even if the person who
-- booked them in is later removed.
ALTER TABLE "returns"
  ADD CONSTRAINT "returns_created_by_fkey"
    FOREIGN KEY ("created_by") REFERENCES "users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 3. How much of a line has come back
-- ---------------------------------------------------------------------------
--
-- A fourth quantity that does not disturb the three already here:
--
--     costed_quantity                        shipped, cost known
--     fulfilled_quantity - costed_quantity   shipped, cost unknown
--     quantity - fulfilled_quantity          never shipped, no cost exists
--     returned_quantity                      shipped, then came back
--
-- `fulfilled_quantity` is deliberately NOT decremented by a return. It records
-- a physical event that happened, and reducing it would contradict a shipment
-- the ledger still carries — and would drag `costed_quantity` down with it to
-- preserve costed <= fulfilled, reporting a return as a *costing* gap.
--
-- Units still with the customer are `fulfilled_quantity - returned_quantity`,
-- and are not a column for the same reason the outstanding quantity is not one.
ALTER TABLE "order_items"
  ADD COLUMN "returned_quantity" INTEGER NOT NULL DEFAULT 0;

-- The constraint is what makes over-return, and repeated return of the same
-- units, unrepresentable rather than merely refused by a code path.
ALTER TABLE "order_items"
  ADD CONSTRAINT "order_items_return_bounds"
    CHECK ("returned_quantity" >= 0
       AND "returned_quantity" <= "fulfilled_quantity");

-- ---------------------------------------------------------------------------
-- 4. The returned batch
-- ---------------------------------------------------------------------------
--
-- `status` defaults to SALEABLE, which is correct for every one of the lots
-- already here: none is a customer return, and none has ever been quarantined.
--
-- There is no `return_id` column. `stock_lots` already carries the polymorphic
-- (source_type, source_id) pair the ledger uses, and a return lot is
-- SALES_RETURN with the return's id — the same shape purchase lots use. A
-- typed foreign key beside it would be two representations of one fact.
--
-- `order_item_id` is a real column because *which line* is genuinely new
-- information with no existing slot, and it is what makes a return_lines table
-- unnecessary.
--
-- `origin_lot_id` is the lineage pointer: the batch these units originally
-- shipped from. It reaches the original cost, the original certificate and —
-- one hop further — the supplier, all as history rather than as claims about
-- these units now. Nothing is copied across it. The return lot's certificate
-- slot starts empty, and its supplier is nobody, because a customer is not a
-- source of supply.
ALTER TABLE "stock_lots"
  ADD COLUMN "status"            "LotStatus" NOT NULL DEFAULT 'SALEABLE',
  ADD COLUMN "order_item_id"     TEXT,
  ADD COLUMN "origin_lot_id"     TEXT,
  ADD COLUMN "status_changed_by" TEXT,
  ADD COLUMN "status_changed_at" TIMESTAMP(3),
  ADD COLUMN "status_note"       TEXT;

ALTER TABLE "stock_lots"
  ADD CONSTRAINT "stock_lots_order_item_id_fkey"
    FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "stock_lots"
  ADD CONSTRAINT "stock_lots_origin_lot_id_fkey"
    FOREIGN KEY ("origin_lot_id") REFERENCES "stock_lots"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "stock_lots"
  ADD CONSTRAINT "stock_lots_status_changed_by_fkey"
    FOREIGN KEY ("status_changed_by") REFERENCES "users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "stock_lots_order_item_id_idx"     ON "stock_lots"("order_item_id");
CREATE INDEX "stock_lots_origin_lot_id_idx"     ON "stock_lots"("origin_lot_id");
CREATE INDEX "stock_lots_status_changed_by_idx" ON "stock_lots"("status_changed_by");

-- ---------------------------------------------------------------------------
-- 5. What the database refuses
-- ---------------------------------------------------------------------------

-- A returned batch is costed, on the same terms as every other costed source.
-- This completes the pairing the schema comment states: PURCHASE, OPENING,
-- ADJUSTMENT and RETURN all carry a cost, and UNKNOWN is the one value that
-- carries none and must carry none.
ALTER TABLE "stock_lots"
  ADD CONSTRAINT "stock_lots_return_cost_known"
    CHECK ("cost_source" <> 'RETURN' OR "unit_cost" IS NOT NULL);

-- A return lot names the line it came back from, and nothing else does. Written
-- as an equivalence so both halves are refused: a SALES_RETURN lot with no line
-- has lost its provenance, and a purchase lot naming an order line is a
-- confusion about where stock came from.
ALTER TABLE "stock_lots"
  ADD CONSTRAINT "stock_lots_return_provenance"
    CHECK (("source_type" = 'SALES_RETURN') = ("order_item_id" IS NOT NULL));

-- The inspection record is all-or-nothing. A release or a rejection is a
-- judgement somebody made, and the note is the only durable account of why —
-- a timestamp with no finding beside it explains nothing a year later.
ALTER TABLE "stock_lots"
  ADD CONSTRAINT "stock_lots_status_audit_paired"
    CHECK (("status_changed_at" IS NULL) = ("status_note" IS NULL));

-- A lot can only reach REJECTED by an act, so a rejected lot always carries the
-- record of it. SALEABLE is deliberately not constrained the same way: it is
-- also the state every lot is born in, and demanding an inspection record for
-- ordinary purchased stock would be false.
ALTER TABLE "stock_lots"
  ADD CONSTRAINT "stock_lots_rejected_is_explained"
    CHECK ("status" <> 'REJECTED' OR "status_changed_at" IS NOT NULL);

-- ---------------------------------------------------------------------------
-- 6. The two scans that must stay fast
-- ---------------------------------------------------------------------------
--
-- FIFO gains `AND status = 'SALEABLE'` when quarantine goes live. A partial
-- index keeps that scan exactly as narrow as it is today rather than filtering
-- rows the planner had to read first.
CREATE INDEX "stock_lots_fifo_saleable_idx"
  ON "stock_lots"("product_id", "received_at", "id")
  WHERE "status" = 'SALEABLE';

-- The quarantine queue, oldest first. There is deliberately no expiry, so
-- visibility is the only thing standing between a batch and sitting unnoticed
-- forever — this index is what makes that queue cheap enough to always show.
CREATE INDEX "stock_lots_quarantine_queue_idx"
  ON "stock_lots"("received_at")
  WHERE "status" = 'QUARANTINED';
