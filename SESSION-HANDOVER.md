# Session handover — checkpoint, since committed

**Written:** 2 September 2026, when the work below was uncommitted.
**Branch:** `db/inventory-domain-model`
**Checkpoint HEAD:** `93ce671` — *feat: attach certificates to the batch that arrived, not the part*
**Status now:** the workstream this file describes was reviewed and committed as
`884d431` — *feat: support partial order fulfilment*. The working tree is clean;
current HEAD is `0f60ebe`, eight commits further on.

This file covers **the partial-fulfilment workstream and the decisions taken
around it**. It is kept as the record of that change rather than as a live
to-do list — §6 says where each of its next steps ended up. For how the system
works — the rules, the FIFO costing model, the money definitions, the things
that will waste your afternoon — read `HANDOVER.md`, which is current as of
`0f60ebe`. Nothing here repeats it; §18 there is the full account of this
change.

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

**Since this checkpoint was written**, all of it and more has been committed:

```
0f60ebe  feat: link outstanding order lines to the deliveries meant for them
0379a56  docs: update handover after sales returns
a8dc4f7  feat: add sales return lot inspection workflow
bc213eb  feat: add sales return workflow
a500fca  refactor: make the adjustment cost API refuse silence too
19aab14  refactor: ask the cost question once, and make the answer structural
5621e52  refactor: remove Product.standardCost, require an opening cost basis
077ca67  feat: price orders per customer, remove the discount feature
884d431  feat: support partial order fulfilment   ← the workstream below
```

---

## 1. What this checkpoint covered (committed as `884d431`)

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

**The link from a purchase to the order waiting on it is now built** (`0f60ebe`).
`SupplyLink` joins `OrderItem` ↔ `PurchaseItem` many-to-many with an explicit
positive quantity, so "which delivery is meant for this backlog" is answerable
from the data. It is advisory only — no stock, no lot, no cost, no ledger row,
and receiving a linked delivery still fulfils nothing. `StockReferenceType` was
deliberately **not** given an ORDER↔PURCHASE value: that enum names the document
that caused a stock movement, and a link causes none. `HANDOVER.md` §18 is the
account.

**No outstanding-orders screen.** Outstanding quantity is visible on an order
and in the orders list, and a link now says what is expected to cover it; there
is still no "what do we owe" view across the book. This is also why the
migration adds **no index** — such a screen would need an expression index on
the difference, not one on the column.

**A business question left open, and it matters.** If goods physically reach the
customer while this system says nothing shipped, units left from a source it
does not track. The deficit model records that faithfully as an obligation, but
the more accurate long-run model may be an inbound movement recording the
untracked acquisition, followed by an ordinary fulfilment. The answer decides
whether outstanding quantities clear in days or sit open indefinitely.

**Three development rows remain** from browser QA (listed in §3). They are
ordinary orders and a purchase, not synthetic paperwork, and can be left or
cancelled as you prefer.

**Returns were closed here, and have since been built.** The 4 September 2026
decision that closed them was reversed by the owner the following day, and the
workflow shipped in `bc213eb` (recording a return: the return document,
`returnedQuantity`, cost layers read from the original consumption rows,
quarantined return lots and their provenance) and `a8dc4f7` (inspecting one:
ADMIN-only release, rejection, targeted partial write-off, the `/returns`
quarantine queue and the audit fields behind each decision). Two of the three
questions were answered by building it — a returned part is quarantined rather
than going straight back to sellable stock, and revenue is unchanged because
`fulfilledQuantity` is never reduced. Credit versus replacement is still settled
commercially elsewhere. `HANDOVER.md` §8 is the current account; §19 and §22
there record the reversal from where the original decisions were written.

**The discount feature is removed outright**, superseding the "out of scope for
margin" note that stood here earlier the same day. Column, constraint, form
field, report column and explanatory copy are all gone; `total = subtotal` is a
check constraint. It collapsed the two revenue bases into one, which made
revenue reportable at product and category grouping for the first time and made
the order page's "Gross margin" correct without changing any margin logic.
`HANDOVER.md` §20 is the account. **The migration is written but has not been
applied to production** — see §7 below.

**Where the costing review's findings now stand.** G1 (adjustment cost) and G2
(reversal netting) are implemented and tested; returns are implemented
(`bc213eb`, `a8dc4f7`); discount-in-margin was resolved by removing the discount
feature outright (§20); the seed's single-price data and `Product.standardCost`
are live work; landed cost is a business question. `HANDOVER.md` §19 has the
table.

---

## 5. What not to change

- **The stock engine.** It did not need to change for this and it did not.
- **Any negative-stock guard**, in code or in the database.
- **`confirmedAt` on confirmation.** The sales report dates revenue by it; an
  unfulfilled order that left it null would vanish from every financial report.
- **The coverage denominator.** `fulfilledQuantity`, never `quantity`.
  `marginOf` takes it as a required argument on purpose.
- **`LotCostSource.UNKNOWN`.** It means "real units we cannot price", not
  "units that do not exist". Nothing about outstanding quantity may borrow it.
- **Threshold vocabulary.** Ordered / Fulfilled / Outstanding. Not low stock,
  out of stock, short, or reorder — §16 removed that at the owner's direction.
- **`COMPLETED → CANCELLED` stays refused**, and an order carrying a return
  cannot be cancelled at all — the returned units are already back, and
  cancelling would shelve them twice. The returns workflow built in `bc213eb`
  and `a8dc4f7` does not change either rule; a return is a new physical event
  with its own document, not a cancellation. `returnToLots` still serves
  **cancellation** only — a sale that did not happen, rather than one undone —
  and its name refers to the lots units go back into, not to a customer return.
  (This bullet previously prohibited building returns at all. That decision was
  reversed by the owner on 5 September 2026; see `HANDOVER.md` §8.)
- **Product-level selling prices.** `Product.sellingPrice` is an optional
  *reference* that prefills a new order line. It is never historical revenue and
  must never overwrite an existing `OrderItem.unitPrice` — see `HANDOVER.md`
  §21. The quoted price on a line is the only price any money figure may read.
- **Discounts.** Removed entirely, not deferred. No discount field on any
  schema, no input on any form, no arithmetic in costing, no margin logic, no
  report column, no UI. `total = subtotal` is enforced by check constraint. If a
  commercial need ever arises it is a new feature with a new decision behind it,
  not a restoration. See `HANDOVER.md` §20.

---

## 6. Next development steps

1. ~~**Review and commit this workstream.**~~ **Done** — committed as
   `884d431`.
2. **Answer the business question in §4.** Still open. It is the only thing here
   that could change the shape of what has been built, and it decides whether
   outstanding quantities are expected to clear in days or to sit open
   indefinitely. Unaffected by the sales-return work.
3. ~~**The ORDER↔PURCHASE link.**~~ **Done** — committed as `0f60ebe`; see
   `HANDOVER.md` §18. The outstanding-orders screen that was to sit on top of it
   is **not** built and is still a separate step, and it is the one that would
   need the expression index described in §4.
4. **Certificate compliance register** — still the most valuable unbuilt report,
   unchanged in scope by this workstream, by the sales-return work or by the
   supply links.

Item 4 and the outstanding-orders screen are both still open, and this file does
not order them against each other; `HANDOVER.md` §9 lists the register among its
own priorities. Which goes first is an owner decision that has not been taken.

**Built since this checkpoint, and not on the list above:** the sales-return
workflow and its quarantine inspection (`bc213eb`, `a8dc4f7`), inserted ahead of
these items at the owner's direction. See `HANDOVER.md` §8.
