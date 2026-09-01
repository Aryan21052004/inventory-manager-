# Session handover — uncommitted checkpoint

**Date:** 1 September 2026
**Branch:** `db/inventory-domain-model`
**HEAD:** `403f811` — *refactor: remove dead code and settle two ambiguous names*
**Working tree:** dirty, deliberately. One workstream sits on top of `403f811`
and has not been committed, pending review.

This file covers **what is in the working tree and what to do with it**. For how
the system works — the rules, the FIFO costing model, the money definitions, the
things that will waste your afternoon — read `HANDOVER.md`, which is current as
of this checkpoint. Nothing here repeats it.

---

## 0. What was committed this session

The two workstreams the previous checkpoint left uncommitted are now in history,
as two commits, in the order that file recommended:

```
403f811  refactor: remove dead code and settle two ambiguous names
b3eccfa  feat: add Tier 1 reports with CSV export
83e8d55  feat: rebuild the dashboard on real data, with honest costing   (unchanged)
```

Nothing at or below `83e8d55` was amended or rewritten.

One caveat on the split, for anyone reading the two commits side by side. The
six list query modules were touched by *both* workstreams — the reports work
deduped them onto the new `src/lib/date-range.ts`, and the cleanup pass made
symbols in them module-private — and the two sets of hunks are interleaved
within the same files. They were split at file granularity rather than by hunk,
so those six files land whole in `b3eccfa` and carry a few lines of cleanup with
them. Both commits compile; neither is a pure single-purpose snapshot of those
particular files.

---

## 1. What is uncommitted

**Threshold-based stock classification, removed from the product.** Approved as
a plan before implementation; documented in `HANDOVER.md` §16.

`Product.minimumStock`, the derived `NORMAL`/`LOW_STOCK`/`OUT_OF_STOCK` status,
and every screen built on them are gone. The physical quantity is untouched: a
product holding four units shows `4`, one holding none shows `0`, and neither
carries a status, a badge, or a place on a list of things demanding action.

Roughly −681/+490 across 35 files. Two files deleted:

```
src/lib/stock-status.ts                    The threshold rule
src/components/ui/stock-status-badge.tsx   The pill that rendered it
```

One migration, `20260901120000_remove_minimum_stock`, dropping the column and
the hand-written check constraint from `20260825120000`. No historical migration
was modified. **It has already been applied** to both the development and the
test databases, so a fresh checkout of the parent commit will not match your
local database — this is the one part of the change set that is not purely in
the working tree.

Nothing in the inventory engine was touched: the ledger, `StockLot`,
`StockLotConsumption`, FIFO allocation and consumption, inventory locking,
valuation, receiving, order confirmation and stock deduction, supplier
provenance, certificates, and all three Tier 1 reports are as they were.

---

## 2. Verification at this checkpoint

Everything below was run after the last edit, in this order:

| Gate | Result |
| --- | --- |
| `npx tsc --noEmit` | exit 0 |
| `npx eslint .` | exit 0 |
| `npm test` | **581 passed, 17 files** (was 583 — see below) |
| `npm run build` | compiled; all 25 routes present |
| I-1 (`SUM(lot.quantityRemaining) == product.stockQuantity`) | **0 mismatches** |
| I-3 (`quantityRemaining == quantityReceived − SUM(consumptions)`) | **0 broken lots** |
| `minimum_stock` column / check constraint | **0 rows each** in `information_schema` / `pg_constraint` |

The invariant checks ran against the **development** database with read-only
`SELECT`s. No data was modified.

The four figures the reports were originally reconciled against are unchanged:
valuation ₹18,104.96, uncosted 355 units, realised revenue ₹19,592.36, received
spend ₹24,847.00 — 11 products, 14 lots, 989 units, as before.

**583 → 581.** Five tests deleted (three that only exercised the threshold rule,
one that only exercised its filter, one that rejected a negative minimum), and
three added: that the list reports a quantity rather than a classification, that
a stale `?stock=` parameter is ignored, and that a stale `?sort=minimumStock` key
falls back. Several more were rewritten rather than dropped — the summary-tile
test now pins `total`, `stockValue` and `uncostedUnits`; the combined-filter test
uses a non-threshold second filter; the dashboard's attention test pins
`uncostedUnits` and the absence of the removed counts.

---

## 3. What to do first

1. **Review the working tree.** `git diff` plus `git status` is the whole change
   set. No commit has been made and no commit message written.
2. **Browser QA is still outstanding, and could not be done here.** Details in
   §4 — this is the one item on the verification list that is not green.
3. **Commit as one commit** once reviewed. Do not amend or rewrite anything at
   or below `403f811`.

---

## 4. Open items and known gaps

**Browser QA was not performed.** The app is running with Clerk keys configured,
so every route redirects to sign-in, and signing in on the owner's behalf is not
something this session will do. Setup mode — which exists precisely for
reviewing the UI without an account — needs the Clerk keys absent, and a
`next dev` server (PID 11284) is already running against this directory on port
3000, which Next refuses to run a second instance alongside. Unblocking it is
one of: sign in yourself and click through, or stop that server so a fresh one
can be started with the Clerk variables blanked for that process only.

Five places to look at, all of them layout rather than logic:

- `/dashboard` — "Needs attention" now holds two stats, not four. The grid was
  narrowed from `xl:grid-cols-4` to `sm:grid-cols-2` to match; check it does not
  read as a row with two holes in it.
- `/products` — same change to the tile grid, leaving Products and Stock value.
- `/products/[id]` — the stock card lost its progress bar entirely. It is now
  two figures, On hand and Value at cost, with the costed-units line beneath.
- `/orders/new` — the product picker lost its "Stock status" column; the Stock
  number column is still there.
- `/suppliers/[id]` — the products table lost its "Stock" badge column; "On
  hand" remains.

**A product holding zero is not represented in the seed.** Every seeded product
ends with stock on hand, so the `0` case — the one this change set exists to
keep honest — has no example in the development database. It is covered by a
test (`reports the quantity on hand as a number, not a classification`), but if
you want to see it in the UI you will need to adjust a product down to zero.

**Cost coverage is 0% on the current data**, unchanged. Every order confirmed
before FIFO costing shipped has `costedQuantity = 0`, so no profitability path
has ever run against real costed sales. The dashboard and reports both suppress
margin rather than approximate it.

**The CSV export caps at 10,000 rows.** When it hits the cap the file says so in
its preamble rather than truncating silently.

**`monthsAgo` rolls forward on short months** — 31 March minus one month is
3 March. Pinned by a test rather than special-cased.

**Two schema indexes are candidates, not waste.** `Certificate` on
`certificateType` and `User` on `role`. Recorded in `HANDOVER.md` §15 for a
future schema review.

---

## 5. What not to change

Carried forward from the standing constraints on this project, and still in force:

- **Never** treat unknown acquisition cost as ₹0, and never substitute
  `standardCost` for it. `standardCost` is a reference/planning figure, not what
  anything actually cost.
- **Never** compute `revenue − knownCost` as margin when coverage is incomplete.
  Suppress the figure instead — `null`, not zero.
- Do not reconstruct historical COGS for pre-FIFO orders.
- Do not create a second inventory quantity system. `Product.stockQuantity` is
  the source of truth; `StockLot` is a valuation and provenance index over it.
- Do not modify Clerk authentication, the stock engine (`src/server/stock.ts`),
  FIFO allocation, inventory locking, or the certificate architecture without a
  deliberate decision to do so.
- Do not delete or squash historical migrations.
- **No threshold-based stock features.** Minimum stock levels, low- and
  out-of-stock reports, cards, badges, filters and alerts, reorder points and
  replenishment suggestions were removed from the product on 1 September 2026 —
  see `HANDOVER.md` §16. Do not reintroduce them, and do not invent a
  replacement stock-status concept. The physical quantity stays and is reported
  as a number; `0 units` is valid information and must not become a status.

---

## 6. Next development steps

Unchanged from `HANDOVER.md` §9, in priority order:

1. **Reports Tier 2** — five are designed and unbuilt. Profitability is the
   obvious next one and carries the sharpest trap: it cannot report a margin
   until cost coverage is non-zero, and today it is zero.
2. **Certificate compliance register** — Tier 2's most valuable report for this
   business and the one no generic ERP ships. The data already supports it.
3. **Certificates on lots** — deferred twice. Settle the business workflow first:
   whether release authority belongs to the supplier, the lot, or both.
4. **Historical as-of valuation** — reconstructible from the append-only
   consumption table, but needs explicit handling of the pre-costing migration
   boundary. See `HANDOVER.md` §13.
