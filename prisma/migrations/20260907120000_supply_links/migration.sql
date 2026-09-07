-- Which delivery is expected to clear which outstanding order line.
--
-- The business sells parts it does not yet hold. Confirming an order against a
-- shelf that cannot fill it deducts what is there and records the rest as an
-- obligation on the line — `order_items.fulfilled_quantity`, added by
-- 20260902120000_order_item_fulfilment. Those outstanding units deliberately
-- have no stock transaction, no lot and no consumption row, because nothing has
-- moved. That is the right model, and it has one consequence: the ledger cannot
-- say which purchase will cover them, since there is nothing for a reference to
-- point at. This table is the only place that question has an answer.
--
-- ---------------------------------------------------------------------------
-- What this migration does NOT do
-- ---------------------------------------------------------------------------
--
-- No behaviour changes, and no existing table is touched. A supply link is an
-- expectation: it creates no stock, consumes none, costs nothing, reaches no
-- lot and fulfils no order. Receiving a purchase that carries links still
-- fulfils nothing — `fulfilOrder` remains the only route from outstanding to
-- shipped, driven by an operator, because deciding which of several waiting
-- orders gets a short delivery is a commercial judgement and settling it by
-- whoever's page refreshed first would bury that decision in a race.
--
-- `StockReferenceType` gains no value. That enum names the document that
-- *caused* a stock movement; a supply link causes none, and giving it a value
-- there would require inventing a movement to hang it on.
--
-- There is no backfill. Which purchase somebody had in mind for an order placed
-- last month is not recorded anywhere, and guessing it from product and date
-- would manufacture expectations nobody expressed.
--
-- No `received_quantity` on purchase lines. Receipt stays all-or-nothing; this
-- workstream links documents and does not redesign purchasing.

-- ---------------------------------------------------------------------------
-- The link
-- ---------------------------------------------------------------------------
--
-- Line to line, because outstanding quantity is a property of an order *line*
-- and a delivery covering one line of a three-line order has to be able to say
-- so. Many-to-many in both directions: one late line is routinely covered by
-- two consecutive deliveries, and one bulk purchase line by several waiting
-- orders. The quantity is what makes the row useful — without it, three orders
-- pointing at one ten-unit purchase line say only that they are all waiting on
-- it, not whether it covers them.
CREATE TABLE "supply_links" (
    "id"               TEXT NOT NULL,
    "quantity"         INTEGER NOT NULL,
    "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"       TIMESTAMP(3) NOT NULL,
    "order_item_id"    TEXT NOT NULL,
    "purchase_item_id" TEXT NOT NULL,

    CONSTRAINT "supply_links_pkey" PRIMARY KEY ("id")
);

-- Cascade on both sides. A link cannot outlive either line it joins: delete the
-- order line or the purchase line and there is nothing left for the expectation
-- to mean. This is the schema's existing ownership rule for line items, not a
-- new one — and it is why editing a draft order or a draft purchase needs no
-- special handling here.
ALTER TABLE "supply_links" ADD CONSTRAINT "supply_links_order_item_id_fkey"
    FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "supply_links" ADD CONSTRAINT "supply_links_purchase_item_id_fkey"
    FOREIGN KEY ("purchase_item_id") REFERENCES "purchase_items"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- One link per pair of lines. A second row for the same two lines would be a
-- second place to record one expectation; the quantity belongs on one row.
CREATE UNIQUE INDEX "supply_links_order_item_id_purchase_item_id_key"
    ON "supply_links"("order_item_id", "purchase_item_id");

-- Both directions are read: "what is covering this order line" on the order
-- page, "what is this delivery for" on the purchase page. Both are also the
-- aggregates the allocation guards sum under a lock, so neither is optional.
CREATE INDEX "supply_links_order_item_id_idx"    ON "supply_links"("order_item_id");
CREATE INDEX "supply_links_purchase_item_id_idx" ON "supply_links"("purchase_item_id");

-- ---------------------------------------------------------------------------
-- What the database refuses
-- ---------------------------------------------------------------------------
--
-- A link for nothing is not an expectation. Zero says "this delivery covers
-- none of this line", which is what the absence of a row already says, and a
-- negative quantity says nothing at all.
--
-- The two bounds that matter are deliberately *not* here, because neither can
-- be: "the links against one order line may not exceed its outstanding
-- quantity" and "the links against one purchase line may not exceed what that
-- line ordered" are both aggregates, and a row-level CHECK cannot read one.
-- `src/server/supply-links.ts` enforces both under row locks — the same shape
-- `costed_quantity` and `returned_quantity` use, and for the same reason.
ALTER TABLE "supply_links"
  ADD CONSTRAINT "supply_links_quantity_positive" CHECK ("quantity" > 0);
