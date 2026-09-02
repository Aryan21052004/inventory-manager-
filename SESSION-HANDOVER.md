# Session handover — uncommitted checkpoint

**Date:** 2 September 2026
**Branch:** `db/inventory-domain-model`
**HEAD:** `5ea7296` — *feat: add the stock movement summary report*
**Working tree:** dirty, deliberately. One workstream sits on top of `5ea7296`
and has not been committed, pending review.

This file covers **what is in the working tree and what to do with it**. For how
the system works — the rules, the FIFO costing model, the money definitions, the
things that will waste your afternoon — read `HANDOVER.md`, which is current as
of this checkpoint. Nothing here repeats it.

---

## 0. Recent history

```
5ea7296  feat: add the stock movement summary report
ee8f07c  refactor: remove threshold-based stock status
403f811  refactor: remove dead code and settle two ambiguous names
b3eccfa  feat: add Tier 1 reports with CSV export
83e8d55  feat: rebuild the dashboard on real data, with honest costing
```

Nothing at or below `83e8d55` has been amended or rewritten.

---

## 1. What is uncommitted

**Certificates moved from the product to the batch.** Planned and approved as a
workflow and schema design before any code was written; documented in full in
`HANDOVER.md` §17.

```
Supplier → Purchase → StockLot → Certificate
```

Twenty-one files (one added, twenty modified), +1,893 / −874, and **one new
migration**:
`20260901160000_certificates_on_lots`. It is already applied to the development
and test databases.

**The Certificate Compliance Register is deliberately NOT in this change.** This
workstream is the architecture the register will stand on; the register itself
is the next one.

### Decisions this implements

| | |
| --- | --- |
| **B1** | Product-level certificates still current are retired by the migration. Zero rows on dev; other environments not assumed. Already-superseded legacy rows keep `stockLotId = NULL` and stay readable. |
| **B2** | One certificate per lot. Many over time through supersession, one current. No join table. |
| **B3** | Order lines read the lots they actually consumed (`StockLotConsumption`); purchase lines read the lot the receipt created, and show nothing before receipt. |
| **B4** | Dashboard attention counts **open lots**, not products. Status rules unchanged — null expiry is VALID, 30-day window, UTC-day comparison. |
| **B5** | Certificate attachment removed from product creation entirely. No opening-stock exception. |
| **B6** | Supplier is derived from lot provenance and must be labelled "Supplier (lot provenance)". No issuer field invented. |

### The three things worth checking first in review

**The composite foreign key.** `certificates (stock_lot_id, product_id) →
stock_lots (id, product_id)`, with a redundant `UNIQUE (id, product_id)` on
`stock_lots` as its target. This is what makes a certificate naming one product
while its lot names another unrepresentable, rather than merely discouraged. It
relies on `MATCH SIMPLE` (the default) so null-lot legacy rows are exempt.

**The check constraint.** `CHECK (stock_lot_id IS NOT NULL OR superseded_at IS
NOT NULL)` — a current certificate must name a batch. Together with the
migration's retirement step this makes "product-level certificates are history,
never coverage" a database fact.

**`deleteProduct` ordering.** Certificates are now deleted explicitly *before*
lots, because the lot foreign key is `RESTRICT`. Without that the delete fails
outright on any never-traded product carrying paperwork. Pinned by a test.

### What was not touched

The stock engine, the ledger, `StockLot` quantities and provenance,
`StockLotConsumption`, FIFO allocation and consumption, inventory locking,
valuation, costing, purchase receiving and cancellation, order confirmation and
deduction, adjustments, customer and supplier logic, the CSV infrastructure, the
report framework, and all four reports. `certificateStatus()` and the file
storage layer are byte-for-byte unchanged.

---

## 2. Verification at this checkpoint

| Gate | Result |
| --- | --- |
| `npx tsc --noEmit` | exit 0 |
| `npx eslint .` | exit 0 |
| `npm test` | **621 passed, 18 files** (was 612 — 9 added) |
| `npm run build` | compiled; 5/5 static pages |
| I-1 (`SUM(lot.quantityRemaining) == product.stockQuantity`) | **0 mismatches** |
| I-3 (`quantityRemaining == quantityReceived − SUM(consumptions)`) | **0 broken lots** |
| `prisma migrate diff` (database ↔ schema) | **No difference detected** |

Financial regression, unchanged: valuation ₹18,104.96, uncosted 355 units,
realised revenue ₹19,592.36, received spend ₹24,847.00. Stock movement summary
still reconciles: 42 movements, net 989, equal to units on hand.

Certificate model, checked read-only on the development database:

```
lot column present           1     composite FK present          1
lot check constraint         1     per-lot unique index          1
old per-product unique       0     certificate/lot mismatches    0
certificates                 2     legacy rows with null lot     2
current rows with no lot     0  <- the check constraint holds
dashboard attention          11 of 11 open lots (all missing paperwork)
```

Both legacy rows were read back through `getCertificateHistory` and are intact.

Certificate status rules are unchanged and still covered: the `certificate
status` describe block passes in full — EXPIRED past the date, VALID with no
expiry however old, EXPIRING_SOON inside the window and on the day itself, and
the boundary exactly at `EXPIRING_SOON_DAYS`.

---

## 3. Browser QA — done

Run against the restarted dev server on 2 September 2026, after the stale Prisma
client was cleared. Everything below was observed in the browser; nothing here
is inferred from the test suite.

Certificates had to be attached through the UI first — the development database
carries no current paperwork — so three were filed, exercised, and then removed
again. They were plainly-labelled development samples (`DEV-QA-*`,
`SYNTHETIC-*.pdf`, PDF text reading "SYNTHETIC DEVELOPMENT SAMPLE - NOT A REAL
CERTIFICATE"), never anything resembling a genuine 8130-3 or EASA Form 1. The
database is back to its two legacy null-lot rows and nothing else.

### What passed

- **One panel per open batch**, each carrying its own lot identity. `PK-BOX-M`
  rendered two: "188 units of this batch still on the shelf · arrived on
  PO-2026-0003" and "300 units · no purchase behind it".
- **Two batches of one part in different states at the same time** — the case
  the whole change exists for. One read *Valid* with its document; the other
  read *No certificate*, on the same page, at the same moment.
- **Attach, replace, withdraw, and metadata correction** all worked. Replace
  retired the old row and the retired document appeared in the product-wide
  history card, still readable. Withdraw returned the batch to *No certificate*
  and kept the record.
- **All four statuses** rendered from real data: *Valid* (no expiry), *Expiring
  soon* (Sep 20, shown as "18d left"), *Expired* (with its release warning), and
  *No certificate*.
- **Per-lot scoping.** Every write to one batch left its sibling untouched.
- **Order detail** showed the paperwork of the batch actually consumed, with the
  consumed quantity (9 units) rather than the lot's remaining balance, and cost
  still `—` where the lot's cost is unknown.
- **Purchase detail** showed the created batch's paperwork per line — one line
  *Expiring soon*, the other *No certificate*, on the same delivery.
- **Dashboard at lot grain.** The column header reads BATCH, rows show the
  *lot's* quantity ("PK-BOX-M · 188 units", not the product's 488), and the
  summary read "1 expiring within 30 days · 10 with no certificate" across the
  11 open lots.
- **Legacy rows.** `CB-HDMI-2M` showed its open batch as *No certificate* while
  both superseded null-lot documents remained listed and viewable in the history
  card — B1 exactly: history, never coverage.
- **B5 in the browser.** The create-product dialog has ten fields, zero file
  inputs, and the word "certificate" appears nowhere in it.
- **File retrieval.** `/api/certificates/[id]/file` returned 200,
  `application/pdf`, the right filename and the right bytes.
- **No regression elsewhere.** `/reports`, `/reports/movements`,
  `/reports/valuation`, `/stock-movements`, `/purchases`, `/orders`,
  `/suppliers`, `/customers` and `/products` all returned 200 with no error
  markers, and the four financial figures on the dashboard were unmoved by the
  certificate writes.

### The defect it found, since fixed

**A lot's received date rendered two different days on one page.** The batch
panel showed the **UTC** day while the lot table below it showed the **local**
day, so a lot received at `2026-08-25T19:39:29.866Z` read "Received Aug 25,
2026" in the panel and "Aug 26, 2026" in the table two sections down.

The cause was in `src/app/(app)/products/[id]/page.tsx`: the panel was passed
`isoDay(lot.receivedAt)`. `isoDay` is for `DATE` columns — calendar days with no
time and no zone, which is what `issueDate` and `expiryDate` are — but
`StockLot.receivedAt` is a timestamp, so truncating it to the UTC day and then
formatting that locally moved it.

The panel now takes the timestamp itself and formats it exactly as the lot table
does. Re-checked in the browser: both surfaces read "Jul 23, 2026" and "Aug 26,
2026". `isoDay` stays, and is still correct for the four date columns that use
it. **This is the trap to remember: `receivedAt` is an instant, `issueDate` and
`expiryDate` are calendar days, and they must not be formatted the same way.**

### Not exercisable on the current development data

Three branches have no fixture to drive them through the UI. All three are
covered by tests instead.

- **An order drawing across several batches** — no order in the development data
  consumes more than one lot. Covered by `tests/orders.test.ts`, "lists every
  batch an order drew from, not one of them".
- **A cancellation netting a batch's draws to zero** — the cancelled orders here
  have no consumption rows at all, so they never reach the sum. Covered by
  "stops reporting a batch once a cancellation nets its draws to zero".
- **A purchase before receipt** — every purchase is RECEIVED or CANCELLED; there
  is no draft or ordered one to show the empty state on.

Also unexercised: a zero-stock product, because no active product currently
holds zero units.

### Copy corrected

Two dialogs still described the product-level model and now name the batch:

- `certificate-form-dialog.tsx` — "Record the certificate covering this batch".
- `certificate-panel.tsx`, withdraw confirmation — "will no longer cover this
  batch, and the batch will show as having no certificate".

Both verified in the browser. The history card still says "this part's batches",
and the withdraw dialog still speaks of "the product's certificate history" —
both correct, because that view is deliberately product-scoped so the legacy
null-lot rows remain reachable.

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
