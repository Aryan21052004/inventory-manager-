# Session handover — uncommitted checkpoint

**Date:** 1 September 2026
**Branch:** `db/inventory-domain-model`
**HEAD:** `ee8f07c` — *refactor: remove threshold-based stock status*
**Working tree:** dirty, deliberately. One workstream sits on top of `ee8f07c`
and has not been committed, pending review.

This file covers **what is in the working tree and what to do with it**. For how
the system works — the rules, the FIFO costing model, the money definitions, the
things that will waste your afternoon — read `HANDOVER.md`, which is current as
of this checkpoint. Nothing here repeats it.

---

## 0. Recent history

```
ee8f07c  refactor: remove threshold-based stock status
403f811  refactor: remove dead code and settle two ambiguous names
b3eccfa  feat: add Tier 1 reports with CSV export
83e8d55  feat: rebuild the dashboard on real data, with honest costing
```

Nothing at or below `83e8d55` has been amended or rewritten.

---

## 1. What is uncommitted

**The stock movement summary — the first Tier 2 report.** Planned and approved
before implementation; documented in `HANDOVER.md` §13.

Eleven files, roughly +1,857 / −131, of which 770 lines are a new test file and
the rest of the deletions are documentation being rewritten. One new file:

```
tests/report-movements.test.ts     25 tests, mostly about direction
```

**No schema change, no migration, no new index.** `stock_transactions` already
carries every index this report reads through — `createdAt`,
`(productId, createdAt)`, `type`, `(referenceType, referenceId)`.

**Read-only.** The report adds one loader that runs three aggregate queries and
writes nothing. The stock engine, the ledger, `StockLot`,
`StockLotConsumption`, FIFO allocation and consumption, inventory locking,
valuation, receiving, order confirmation and cancellation, adjustments,
supplier and customer logic, certificates and the three Tier 1 report
calculations are all untouched — none of their files appears in the diff.

### The one thing to understand before reviewing it

`stock_transactions.quantity` is **always positive**; a check constraint
enforces it. Only STOCK_IN and STOCK_OUT carry their direction in the type.
ADJUSTMENT and REVERSAL carry it in the balance columns alone, and both
directions occur in real data — on the development database reversals net
+329 in and −225 out.

So every figure in this report is built from `new_stock - previous_stock`:

```sql
units_in  = SUM(GREATEST(delta, 0))
units_out = SUM(-LEAST(delta, 0))
net       = SUM(delta)
```

Nothing consults `type` to decide a sign. Two tests pin the two reversal
directions specifically, because a type-based rule inverts one of them and still
produces a table that looks entirely reasonable.

### What it deliberately does not do

- **No money.** No movement value, no cost of sales, no coverage. Per-movement
  cost already exists on `/stock-movements`.
- **No supplier or customer grouping or filter.** Only movements with a document
  reference have one, so such a grouping would drop opening stock and every
  manual adjustment, and its rows would then fail to sum to the report's own
  totals. Supplier provenance is a separate Tier 2 report.
- **No detail rows.** `/stock-movements` is the per-row ledger; the report links
  to it.
- **No reconstruction.** Stock that predates the ledger has no movement and is
  not reported. A test seeds 500 units with no ledger row and asserts the report
  says nothing about them.

---

## 2. Verification at this checkpoint

Everything below was run after the last edit, in this order:

| Gate | Result |
| --- | --- |
| `npx tsc --noEmit` | exit 0 |
| `npx eslint .` | exit 0 |
| `npm test` | **612 passed, 18 files** (was 581 — 31 added) |
| `npm run build` | compiled; `/reports`, `/reports/[report]`, `/api/reports/[report]/csv` all present |
| I-1 (`SUM(lot.quantityRemaining) == product.stockQuantity`) | **0 mismatches** |
| I-3 (`quantityRemaining == quantityReceived − SUM(consumptions)`) | **0 broken lots** |

The four financial figures are unchanged: valuation ₹18,104.96, uncosted 355
units, realised revenue ₹19,592.36, received spend ₹24,847.00.

The new report was reconciled against the ledger on live development data, all
read-only:

| Check | Result |
| --- | --- |
| report movements == `loadMovementStats().total` | 42 == 42 |
| report net change == `loadMovementStats().netChange` | 989 == 989 |
| `units_in − units_out == net` | 2102 − 1113 == 989 |
| net change == total stock on hand | 989 == 989 |

The last one holds only because every unit in this database arrived through the
ledger. It is not a guarantee the report makes, and nothing in the code depends
on it.

Direction sanity on the same data, which is the check worth repeating after any
edit to the loader:

```
STOCK_IN    13 movements   in 1748   out    0   net +1748
STOCK_OUT   19 movements   in    0   out  872   net  -872
ADJUSTMENT   4 movements   in   25   out   16   net    +9
REVERSAL     6 movements   in  329   out  225   net  +104
```

ADJUSTMENT and REVERSAL showing traffic in **both** columns is the evidence that
direction is being read from the balance rather than from the type.

---

## 3. What to do first

1. **Review the working tree.** `git diff HEAD` plus `git status` is the whole
   change set. No commit has been made and no commit message written.
2. **Browser QA is done** — see §4 for what was checked, the two cosmetic
   problems it found and fixed, and the two pre-existing shared-shell issues it
   found and deliberately left alone.
3. **Commit as one commit** once reviewed. Do not amend or rewrite anything at
   or below `ee8f07c`.

---

## 4. Open items and known gaps

**Browser QA is complete.** Run in setup mode — the previous dev server was
stopped and a fresh one started with `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=` and
`CLERK_SECRET_KEY=` blanked for that process, which is what the README's setup
mode exists for — against live development data. Everything below passed:

- `/reports` — the fourth card renders with the right title, description and
  icon, and the four now sit on **one row** at 1440px (see the fix below).
- `/reports/movements` — tiles read 2,102 in, 1,113 out, net 989, 42 movements
  across 11 products, matching the SQL reconciliation exactly.
- **All four groupings** — Month, Product (name plus SKU sublabel), Category and
  Movement type. The first column header follows the grouping, and
  `reportRowLabel` turns `STOCK_IN` into "Stock In" only under the type
  grouping.
- **Movement-type filter and Reset** — driven through the select itself, not
  just the URL. Adjustment gives 25 in / 16 out / net 9 across 4 products;
  Reset clears the filter and the grouping and removes its own button.
- **Category and search** — Packaging gives 7 movements across 2 products;
  `q=PK-BOX` gives 4 movements across 1 product, and the label reads "product"
  rather than "products".
- **Pagination** — the footer renders and Previous/Next are correctly inert at
  "Page 1 of 1". Multi-page ordering could not be exercised through the UI: the
  smallest page size is 25 and the catalogue produces at most 11 groups. It is
  covered at the loader level by a test that pages at size 2 and asserts no row
  repeats.
- **Empty state** — a window with no movements renders "No movements in this
  period", not a table of zeroes.
- **CSV export** — 200, `text/csv; charset=utf-8`,
  `attachment; filename="movements-2026-09-01.csv"`, `nosniff`,
  `private, no-store`, CRLF, and a **UTF-8 BOM confirmed at the byte level**
  (`EF BB BF` — a `fetch().text()` check reports no BOM because TextDecoder
  strips it, which is worth knowing before anybody "fixes" it). Preamble,
  header, translated labels and TOTAL row all agree with the page.
- **375px** — no horizontal overflow, and exactly three columns visible: Month,
  Movements, Net change. The `lg:` and `sm:` columns hide as intended.
- **Negative net change** — renders in the destructive colour with no `+`
  prefix; positives carry the `+`; zero renders as an em dash.

**The best single check to repeat after any edit to the loader** is the type
grouping. Reversal shows 329 in *and* 225 out; Adjustment shows 25 in *and* 16
out. Traffic in both columns for those two types is what a type-based sign rule
cannot produce.

### Two cosmetic problems were found, and both are fixed

**The index wrapped 3 + 1.** The grid was `xl:grid-cols-3`, which left the
fourth card alone on a second row with empty space beside it. Now
`xl:grid-cols-4`; verified as a single row of four 268px columns at 1440px.

**The default sort read badly.** `defaultSort` was `movements` — busiest first,
chosen to match the other reports' "largest value first". Under the default
month grouping that ordered the months 08, 07, 06, 09, with the current month
last. It is `label` now, which with the default `desc` direction gives
2026-09, 2026-08, 2026-07, 2026-06. Every sort key remains available and an
explicitly chosen sort is unaffected — `?sort=movements` still returns
31, 6, 3, 2 and `?sort=label&dir=asc` still returns oldest-first. The
`orderBy` fallback in the loader was moved to `label` with it, so the config
and the query cannot disagree about what "no valid sort chosen" means. One
consequence worth knowing: for the product, category and type groupings the
default is now reverse-alphabetical rather than busiest-first.

### Two pre-existing shared-shell issues — found, recorded, deliberately not fixed

Both live in the filter bar and the report shell that all four reports share,
both predate this workstream, and neither is in scope for it.

1. **`range=custom` renders a blank Period trigger.** The control builds its
   options from `RANGE_PRESETS.filter(p => p !== "custom")`, so a custom range
   has no item to select and Radix shows an empty trigger. The period is still
   applied and still named in the empty state and the CSV preamble — only the
   control is blank. Confirmed identical on `/reports/sales?range=custom`.
2. **`?page=N` beyond the last page shows the empty state rather than
   clamping.** `/reports/movements?group=product&page=2` renders "No movements
   in this period" although the filters match 11 groups. The count and page
   count are correct; only the requested offset is out of range.

**No seeded product holds zero units**, unchanged from the last checkpoint.

**Cost coverage is 0% on the current data**, unchanged. No profitability path
has ever run against real costed sales.

**The CSV export caps at 10,000 rows**, unchanged, and the movement summary
inherits it. Its groupings collapse to months, categories, types or the product
count, so the cap is not reachable in practice.

**`monthsAgo` rolls forward on short months** — 31 March minus one month is
3 March. Pinned by a test rather than special-cased.

**Two schema indexes are candidates, not waste.** `Certificate` on
`certificateType` and `User` on `role`. Recorded in `HANDOVER.md` §15.

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
  replacement stock-status concept. `0 units` is valid information and must not
  become a status.
- **Never read a movement's direction from its type.** `quantity` is unsigned
  and ADJUSTMENT and REVERSAL go both ways. `new_stock - previous_stock` is the
  only expression correct for all four types, and the check constraint
  guarantees it.
- **Do not add a second report parameter parser.** The page and the CSV route
  both go through `reportParamsFor` and `REPORT_CONFIG`; that is the only reason
  an export cannot answer a differently phrased question than the screen it came
  from.

---

## 6. Next development steps

1. **Reports Tier 2, continued** — four remain designed and unbuilt; see §13.
   Profitability carries the sharpest trap: it cannot report a margin until cost
   coverage is non-zero, and today it is zero.
2. **Certificate compliance register** — Tier 2's most valuable report for this
   business and the one no generic ERP ships. The data already supports it.
3. **Certificates on lots** — deferred twice. Settle the business workflow first:
   whether release authority belongs to the supplier, the lot, or both.
4. **Historical as-of valuation** — reconstructible from the append-only
   consumption table, but needs explicit handling of the pre-costing migration
   boundary. See `HANDOVER.md` §13.
