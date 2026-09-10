# Per-record currency — handover

Working state as of the C+D increment. Nothing is committed; everything below
lives in the working tree on `db/inventory-domain-model` at `0001777`.

## Where this came from

One installation-wide `AppSetting.currency` decided how *every* stored amount
was read. Changing it re-labelled history — 16,960 entered against a USD
purchase rendered as ₹16,960 the moment the setting moved to INR. No number
changed, which was the design; the meaning of every number did.

The fix is per-record currency. There is **no FX conversion anywhere and none
may be added**: a converted amount is indistinguishable from a real one once
written down.

## Status

| Phase | State |
|---|---|
| **0 — expand** | ✅ applied to dev (`20260910120000_per_record_currency_expand`) |
| **1 — backfill** | ✅ local only, 100 rows to USD, by explicit business decision |
| **2 — write paths** | 🟡 partial: A, B, C, D, E, G done + minimal F slice. **Rest of F and H–L not started** |
| **3 — contract** | ❌ not started, deliberately |

## Phase 2 progress against the approved A–L order

- **A — `DeclaredCost` + `LotSpec`** ✅ `KNOWN` arm requires `currency`; cost
  without currency is unspellable at the type level.
- **B — all five lot creation paths** ✅ purchase, adjustment, opening, return,
  reversal-shortfall.
- **C — FIFO consumption currency + mixed detection** ✅
- **D — OrderItem costing, incremental fulfilment, cancellation** ✅
- **E — purchase receiving** ✅ receipt stamps lots with `Purchase.currency`.
- **F — order/purchase creation, editing, lifecycle freeze** 🟡 **minimal slice
  only**: `createOrder` and `createPurchase` seed `currency` from
  `defaultCurrency`. Everything else in F is not started — no currency choice
  at entry, no change rules while editable, no lifecycle freeze guard, and no
  request-only acknowledgement for a currency change.
- **G — product price currency** ✅
- **H–L — reads, CSV, UI, entry UX, settings semantics** ❌

## Why the minimal F slice exists

C+D could not go green without it, and the reason is worth keeping.

`createPurchase` originally set no currency, so:

```
new purchase (currency NULL)
  → receipt creates lot with costCurrency NULL
    → FIFO draws a costed layer with no currency
      → correctly ruled indeterminate
        → costTotal NULL, costCurrency NULL, costedQuantity 0
```

That is the costing layer being *correct* — honest about a gap upstream — but
it turned 21 existing tests red. Seeding the currency at creation closes the
gap. The suite is green again at 1041.

A second, smaller cause was in the fixtures: several tests wrote
`prisma.stockLot.create` with a `unitCost` and no `costCurrency`, producing a
shape no real path can now produce. Those fixtures pair the two; **no assertion
was weakened.**

## The rules, as implemented

**Mixed currency is never blended and never converted.** In
`summariseAllocations` (`server/stock.ts`), the distinct currencies across
*costed* layers are collected. One known currency → normal total. More than
one, **or a single layer whose currency is null** → indeterminate:
`costTotal` null, `costCurrency` null, `costedQuantity` 0, and those units
join `uncostedQuantity` so coverage stays honest.

**Nothing is lost when that happens.** Every `StockLotConsumption` keeps its own
rate and currency. The real cost of sale is still fully reconstructible — just
not as one figure.

**Incremental fulfilment compares before it adds** (`fulfilOrder`). Same
currency → accumulate. Different, or this draw indeterminate, or the line was
*already* indeterminate → null/null/0.

That last case needs a probe: a line that went mixed reads exactly like a line
never costed (null total, 0 quantity, null currency). It is distinguished by
counting prior costed consumption rows on earlier transactions. Without it, a
later same-currency batch would resurrect a total covering only part of the
line.

**Physical operations are never blocked by a currency gap.** Receiving,
fulfilling and writing off all proceed with an unknown currency. Only
*arithmetic* and *auto-fill* are refused.

## Invariants to preserve

```
costCurrency != null  ⇒  costTotal != null
costTotal == null     ⇒  costCurrency == null
costedQuantity == 0   when the aggregate is mixed or unknown
unitCost == null      ⇒  costCurrency == null      (lots and consumptions)
sellingPrice == null  ⇒  priceCurrency == null
```

Asserted by `expectCostPairingHolds()` in `tests/fifo-cost-currency.test.ts`.
Phase 3 will enforce them in the database; until then they are application-only.

## Known defects still open

1. **`order-builder.tsx`** `:212` auto-fills a product price across currencies;
   `:428` formats it in the *order's* currency; `:490`/`:555` compare
   numerically regardless of currency.
2. **`purchase-builder.tsx`** `:178`/`:382` — same, for `lastPaidUnitCost`.
3. **31 `getCurrency()` invocations across 25 files** and **78
   `formatMoney`/`formatCurrency` call sites** still label persisted amounts
   with the default. None are in costing logic.
4. **`lots.ts:writeOffLot`** — `drainLot` now returns `costCurrency`, but the
   outcome does not carry it and `lots/actions.ts:110` still formats with
   `getCurrency()`.
5. **`lastPaidByProduct`** (`purchases.ts:399`) does not project
   `cost_currency`; it reads `stock_lots`, so adding it is one column.

## Phase 3 prerequisites

- F landed and soaked.
- ✅ `cancelOrder` nulls `costCurrency` (done this increment — was the hard
  blocker).
- Product update nulling `priceCurrency` when the price is cleared ✅ (done).
- `tests/database.ts` fixtures supplying currency.
- **An evidence-based production backfill.** Production has never been
  backfilled and its historical currencies are not recoverable from the
  database — `app_settings` keeps one `updated_at` and no history.

Keep all six columns nullable until then. `StockLot.costCurrency`,
`StockLotConsumption.costCurrency` and `OrderItem.costCurrency` stay nullable
**permanently** — null is a valid state for each.

## Local data

Dev was backfilled to USD on an explicit business decision (25 orders,
13 purchases, 14 priced products, 22 lots, 18 consumptions, 8 order items —
100 rows). No monetary value, quantity or timestamp changed; verified by
row-level digests before and after.

**Never repeat that on production without evidence.**

## Commands

```bash
npm run db:deploy     # migrations — NEVER db:migrate on dev, see below
npm test
npx vitest run tests/fifo-cost-currency.test.ts tests/lot-cost-currency.test.ts
```

⚠️ **`npm run db:migrate` (`prisma migrate dev`) will offer to reset the dev
database.** It treats the deliberate orphan record for
`20260908120000_order_images` as drift. Use `db:deploy`.
