-- ---------------------------------------------------------------------------
-- Stock transactions: record why a movement happened.
--
-- Manual adjustments are the one kind of movement with no document behind
-- them — nothing to click through to and no order or purchase that explains
-- the change. Without somewhere to put the operator's reason, the audit trail
-- for exactly the movements that most need auditing reads "someone changed
-- this by 20". This column is where that reason goes.
--
-- Nullable, because the other movement types are already explained by the
-- reference they carry. `recordStockMovement` requires it for ADJUSTMENT and
-- REVERSAL, which keeps the rule in one place and lets it fail with a message
-- naming the field rather than as a constraint violation.
-- ---------------------------------------------------------------------------

ALTER TABLE "stock_transactions" ADD COLUMN "note" TEXT;
