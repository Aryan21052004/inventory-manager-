# Session handover — uncommitted checkpoint

**Date:** 2 September 2026
**Branch:** `db/inventory-domain-model`
**HEAD:** `93ce671` — *feat: attach certificates to the batch that arrived, not the part*
**Working tree:** dirty, deliberately. One workstream sits on top of `93ce671`
and has not been committed, pending review.

This file covers **what is in the working tree and what to do with it**. For how
the system works — the rules, the FIFO costing model, the money definitions, the
things that will waste your afternoon — read `HANDOVER.md`, which is current as
of this checkpoint. Nothing here repeats it; §18 there is the full account of
this change.

---

## 0. Recent history

```
93ce671  feat: attach certificates to the batch that arrived, not the part
5ea7296  feat: add the stock movement summary report
ee8f07c  refactor: remove threshold-based stock status
403f811  refactor: remove dead code and settle two ambiguous names
b3eccfa  feat: add Tier 1 reports with CSV export
```

Nothing at or below `93ce671` has been amended or rewritten. The certificate
workstream that was uncommitted in the previous handover is now committed at
HEAD; this is a separate change on top of it.

---

## 1. What is uncommitted

**Commercial order completion separated from physical fulfilment.** Approved as
an architecture and then as a written implementation plan before any code was
written. Documented in full in `HANDOVER.md` §18.

The business sells parts it does not yet hold. Confirmation used to refuse such
an order outright; it now deducts what is on the shelf, records the rest as an
obligation on the line, and an explicit operator action ships the remainder once
stock arrives.

```
Order 5, shelf holds 3
  →  CONFIRMED, confirmedAt set, 3 deducted and FIFO-costed
  →  2 outstanding: no movement, no lot, no consumption, no cost
  →  stockQuantity 0, never below

Receive 2  →  ordinary purchase receipt, ordinary lot, real price
Fulfil 2   →  STOCK_OUT, FIFO draws the new lot, costTotal += the real cost
```

Seventeen files modified, two added, +1,972 / −430, and **one new migration**:
`20260902120000_order_item_fulfilment`. It is already applied to the development
and test databases.

### Decisions this implements

| | |
| --- | --- |
| **C1** | Option C implemented as B — line-level `OrderItem.fulfilledQuantity`. Outstanding is derived (`quantity - fulfilledQuantity`), never stored. |
| **C2** | **No new `OrderStatus`.** Partial fulfilment is a fact about lines, not a state of the document. |
| **C3** | Confirmation *truncates* to what is on hand; explicit fulfilment *refuses* a request it cannot meet in full. The asymmetry is deliberate — see §18. |
| **C4** | Fulfilment takes explicit per-line quantities, prefilled to `min(outstanding, on hand)`. No automatic allocation of receipts to orders. |
| **C5** | Fulfilment stays available on a COMPLETED order, so outstanding units cannot be stranded by a terminal status. |
| **C6** | Coverage denominators moved from ordered quantity to `fulfilledQuantity` everywhere. An unfulfilled unit is not an uncosted unit. |
| **C7** | Fulfilment is authenticated-user work, not ADMIN-only — ordinary warehouse work backed by a document. |

### The three things worth checking first in review

**The migration's guards.** The backfill reads the **stock ledger**, not the
order status, and three pre-flight checks abort the whole migration rather than
invent data: every realised line must match its net STOCK_OUT, no DRAFT or
PENDING order may have moved stock, and every CANCELLED order must net to zero.
A terminal guard then verifies the result against the status. All four passed on
dev with zero mismatches, and the same guards will fire in any other
environment whose history does not match.

**`confirmOrder`'s new middle.** `take = min(item.quantity, stockQuantity)`, and
a line with `take === 0` writes **nothing at all** — no StockTransaction, no lot,
no consumption. The transaction is still all-or-nothing; what changed is that a
shortfall stopped being a failure. The old "every line is deducted or none is"
guarantee is gone on purpose and the module docstring says so.

**The two inverted tests.** `tests/orders.test.ts`'s concurrency case and
`tests/stock-lots.test.ts`'s "cannot draw the same lot units twice" both used to
assert that one of two competing orders was *refused*. Both now assert that both
succeed and that the shelf is not overdrawn — the stronger statement of the same
lock guarantee. Neither was deleted; read them before assuming a regression.

### What was not touched

The stock engine. `src/server/stock.ts` is byte-for-byte unchanged —
`applyStockMovement`, `allocateFifo`, `createLot`, `returnToLots`,
`drainPurchaseLots`, the locking discipline, all of it. So are
`src/server/purchases.ts`, `src/server/reports.ts`, `src/server/customers.ts`,
`src/server/certificates.ts`, `src/lib/money-basis.ts`, `prisma/seed.ts`, and
every historical migration.

All five negative-stock protections are intact and verified present:
`products_stock_quantity_non_negative`, `stock_transactions_stock_non_negative`,
`stock_lots_quantity_received_positive`,
`stock_lots_quantity_remaining_within_received`, and the
`if (newStock < 0)` guard in `applyStockMovement`.

---

## 2. Verification at this checkpoint

| Gate | Result |
| --- | --- |
| `npx tsc --noEmit` | exit 0 |
| `npx eslint .` | exit 0 |
| `npm test` | **652 passed, 19 files** (was 623 — 29 added) |
| `npm run build` | compiled; 5/5 static pages |
| `prisma migrate status` | up to date, no drift |
| I-1 (`SUM(lot.quantityRemaining) == product.stockQuantity`) | **0 mismatches** |
| I-3 (`quantityRemaining == quantityReceived − SUM(consumptions)`) | **0 broken lots** |
| I-F (`0 <= costed <= fulfilled <= quantity`) | **0 violations** |
| I-L (`fulfilledQuantity` == net ledger, realised orders) | **0 mismatches** |
| Negative stock / zero-quantity movements / bad lots | **0 of each** |

**Financial regression.** Immediately after the migration and before browser QA
the baseline was unchanged: valuation ₹18,104.96, uncosted 355 units, realised
revenue ₹19,592.36, received spend ₹24,847.00 — the code change moved no money.

Browser QA then created real documents (§3), so the current figures differ, and
every delta is accounted for:

| Figure | Before | Now | Why |
| --- | --- | --- | --- |
| Valuation | ₹18,104.96 | ₹18,062.46 | −₹42.50: the one keyboard consumed at confirmation. The 4 received at ₹50 were all consumed again, netting zero. |
| Uncosted units | 355 | 355 | unchanged — nothing touched an UNKNOWN lot |
| Realised revenue | ₹19,592.36 | ₹20,042.31 | +₹449.95: SO-2026-0016. SO-2026-0017 was cancelled and is correctly excluded. |
| Received spend | ₹24,847.00 | ₹25,047.00 | +₹200.00: PO-2026-0008 |

Stock movement summary still reconciles: units in 2,110 − units out 1,122 = net
988, equal to units on hand.

Two new reconciliation helpers in `tests/database.ts` —
`expectFulfilmentReconciles` (the invariant chain) and
`expectFulfilmentMatchesLedger` (the column against the STOCK_OUT rows) — are
called by every new stock-moving test alongside the existing two.

The backfill, read back after the migration:

```
status       lines  ordered  fulfilled
CANCELLED        7      341          0
COMPLETED       15      543        543
DRAFT            1      233          0
```

---

## 3. Browser QA — done

Run against a restarted dev server on 2 September 2026. The server that was
already on port 3000 held a **stale Prisma client** from before
`prisma generate` and returned "Orders could not be loaded" for every list; it
was stopped and restarted, after which everything below was observed in the
browser. Nothing here is inferred from the test suite.

`db:seed` was **not** run. Two orders and one purchase were created through the
UI and are still in the development database:

- **SO-2026-0016** — Calder & Voss, 5 × Aurora keyboard against 1 in stock.
  Confirmed, completed while outstanding, then fulfilled in two steps.
- **SO-2026-0017** — Wren Dental, 6 × Standing Desk against 4 in stock.
  Confirmed, then cancelled, to exercise cancellation of a partial fulfilment.
- **PO-2026-0008** — Kestrel, 4 × Aurora keyboard at $50.00, received.

### What passed

- **Order builder.** "Save and confirm" is enabled on a short line. The warning
  is informational, not an error: *"Confirming will fulfil what is in stock and
  leave 4 units outstanding, to be shipped once more arrives."* The line shows
  `1` on hand with `4 outstanding` underneath.
- **Confirmation against a short shelf.** Order confirmed, stock 1 → 0, never
  negative. Inventory impact read *"1 units deducted, 1 → 0"* — the ledger, not
  the ordered quantity.
- **Order detail.** Ordered 5 / Fulfilled 1 / *4 outstanding*. Margin note:
  *"Margin calculated for 1 of 5 units. 4 units are still outstanding and have
  no cost of sale yet."*
- **Completion with outstanding quantity.** Allowed, and the **Fulfil 4 units**
  button remained — the stranding case is handled.
- **FIFO across two prices.** After receiving 4 at $50.00 and fulfilling 2, COGS
  read $142.50 = 1 × $42.50 + 2 × $50.00. After the remaining 2, $242.50.
- **Certificates followed the consumed lots.** The line showed two provenance
  rows — *"4 units · PO-2026-0008"* and *"1 unit · PO-2026-0001"* — with no code
  change to the certificate layer and no product-level fallback.
- **Repeated fulfilment** bounded correctly; the button disappeared at 5 of 5.
- **Cancelling a partial fulfilment.** Dialog: *"Cancelling will restore the 4
  units this order actually shipped… Any outstanding units are simply no longer
  owed."* Restored exactly 4 (0 → 4), `fulfilledQuantity` and cost cleared.
- **Orders table** showed *"4 outstanding"* beside Confirmed, and nothing on
  drafts, cancellations or fully-fulfilled orders.
- **Sales report** included the partially-fulfilled order at its full commercial
  value ($449.95, 5 units) in 2026-09, dated by `confirmedAt`.
- **Dashboard costing** read *"5 of 548 units fulfilled"* — the denominator is
  fulfilled units, not units sold.
- **Dark mode** applied; every new element uses existing tokens.

### Two defects found in QA and fixed

1. **Outstanding shown on uncommitted orders.** A draft or cancelled order
   rendered its whole quantity as "outstanding", because the subtraction is
   arithmetically correct and meaningless there. Now gated on CONFIRMED or
   COMPLETED, in both the orders table and the order detail line.
2. **Horizontal page overflow on mobile.** The order detail's products table
   gained a column and pushed the page past 375px. Root cause was latent: the
   grid child holding the card had no `min-w-0`, so it refused to shrink and the
   table's own `overflow-x-auto` wrapper was never constrained. Fixed with
   `min-w-0`; the page now measures 375 = 375 and the table scrolls inside its
   card.

---

## 4. Open items and known gaps

**Synthetic development fixtures exist but are not in the development database.**
`prisma/seed.ts` now creates four clearly-synthetic certificates covering the
required states — valid with no expiry, superseded plus its current replacement,
expiring soon, expired, and batches deliberately left uncovered. They are
**unmistakably** development samples: types like "SAMPLE Conformity Record",
numbers like `DEV-SAMPLE-0001`, filenames prefixed `SYNTHETIC-`, and PDF bodies
whose visible text reads "SYNTHETIC DEVELOPMENT SAMPLE - NOT A REAL
CERTIFICATE". Nothing resembles a genuine 8130-3 or EASA Form 1.

The seed has **not been run**, because `db:seed` clears every table and would
destroy the development data the four financial regression figures are measured
against. Run it deliberately when you want the fixtures, and expect those
figures to change with the data.

The seed writes files straight into `FILE_STORAGE_DIR` with the same
`certificates/<uuid>.pdf` key format the storage layer uses, because
`src/server/storage` is `server-only` and cannot be imported from a plain
script. If that key format ever changes, this is a second place to change.

**A batch drawn to zero keeps its paperwork but has no UI reaching it.** The
product detail lists open lots only. Order lines reach it, and the certificate
compliance register will.

**Cost coverage is 0% on the current data**, unchanged.

**Two pre-existing shared-shell issues, still unfixed and still out of scope:**
`range=custom` renders a blank Period trigger in the report filter bar, and a
`?page=N` beyond the last page shows the empty state rather than clamping.

---

## 5. What not to change

Carried forward, and still in force:

- **Never** treat unknown acquisition cost as ₹0, and never substitute
  `standardCost` for it.
- **Never** compute `revenue − knownCost` as margin when coverage is incomplete.
  Suppress the figure instead — `null`, not zero.
- Do not reconstruct historical COGS for pre-FIFO orders.
- Do not create a second inventory quantity system. `Product.stockQuantity` is
  the source of truth; `StockLot` is a valuation and provenance index over it.
- Do not modify Clerk authentication, the stock engine, FIFO allocation,
  inventory locking, or the certificate *file storage* layer without a
  deliberate decision.
- Do not delete or squash historical migrations.
- **No threshold-based stock features** — see `HANDOVER.md` §16.
- **Never read a movement's direction from its type.** `new_stock -
  previous_stock` is the only expression correct for all four types.
- **Do not add a second report parameter parser.**
- **A certificate belongs to a lot, never to a product.** Do not reintroduce a
  product-level current certificate, do not backfill legacy rows onto a lot, and
  do not invent an issuing authority. `0 units` and "no paperwork on file" are
  both valid answers.
- **Certificate presence must never affect inventory.** Nothing in FIFO,
  valuation, allocation or stock movement may consult a certificate.

---

## 6. Next development steps

1. **Certificate compliance register** — now unblocked. A current-state, flat,
   **lot-grain** register: product/SKU, lot, supplier (lot provenance),
   purchase, lot quantity, certificate type, number, issue date, expiry, days
   remaining, status. It reuses the existing report framework — same
   `REPORT_CONFIG`, same parser, same loader for page and CSV.
2. **Reports Tier 2, continued** — profitability and cost coverage, inventory
   ageing by lot, supplier provenance. Profitability still cannot report a
   margin until cost coverage is non-zero.
3. **Historical as-of valuation** — reconstructible from the append-only
   consumption table, but needs explicit handling of the pre-costing migration
   boundary. See `HANDOVER.md` §13.
