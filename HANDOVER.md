# Handover — Inventory Manager

An aviation-parts inventory system: products with airworthiness paperwork,
customer orders that deduct stock, and supplier purchases that add it, all
explained by a single append-only ledger.

Written for whoever picks this up next — a new developer, or a new session. It
covers what exists, the rules the code is built around, and the things that will
waste your afternoon if nobody tells you.

**Last updated:** 7 September 2026, after building the sales-return workflow and
its quarantine inspection (`bc213eb`, `a8dc4f7`; §8 and §22), on top of
separating commercial order completion from physical fulfilment (§18), moving
airworthiness paperwork from the product to the batch it arrived on (§17), the
stock movement summary (§13),
the removal of threshold-based stock classification (§16), the dead-code audit
and cleanup pass (§15) and the Dashboard rebuild (§12).

---

## 1. Where the project stands

| Module | State | Pages |
| --- | --- | --- |
| Foundation, layout, theming | Done | — |
| Clerk authentication | Done | `/sign-in`, `/sign-up` |
| Dashboard | Done | `/dashboard` |
| Products & inventory | Done | `/products`, `/products/[id]` |
| Certificates | Done | on the product detail page |
| Orders | Done | `/orders`, `/orders/new`, `/orders/[id]`, `/orders/[id]/edit` |
| Purchases | Done | `/purchases`, `/purchases/new`, `/purchases/[id]`, `/purchases/[id]/edit` |
| Stock movements | Done | `/stock-movements` |
| Sales returns & quarantine inspection | Done | `/returns`, and the batch table on `/products/[id]` |
| Customers | Done | `/customers`, `/customers/[id]` |
| Suppliers | Done | `/suppliers`, `/suppliers/[id]` |
| Reports | Tier 1 done, plus stock movement summary | `/reports`, `/reports/[report]` |
| Settings | Partial | `/settings` reports database and auth health |

### Commit history

```
403f811        refactor: remove dead code and settle two ambiguous names
b3eccfa        feat: add Tier 1 reports with CSV export
83e8d55        feat: rebuild the dashboard on real data, with honest costing
8bdaa65        fix: return pre-costing stock to a lot when an order is cancelled
9f5069e        feat: add the suppliers module with an archive lifecycle
532c0bc        feat: cost inventory by FIFO lot instead of a fixed product price
c35dd1f        test: cover stock movements and update handover
eeb1e8e        feat: add stock movements ledger page
79555db        feat: add purchases with automatic stock receipt
e0b9655        feat: add order editing
1eaaa61        feat: add orders with automatic stock deduction
bfa5eef        feat: add product certificates and remove tax
bc643e3        feat: add products and inventory management
```

Four older commits precede these: the Clerk work, the domain model, and the
original scaffold, back to `03536e4`.

**Current branch:** `db/inventory-domain-model`
**Latest commit:** `a8dc4f7` — *feat: add sales return lot inspection workflow*.
The commit list above stops at `403f811`; everything from the threshold removal
(§16) through the sales-return workstream has been committed since, most
recently `bc213eb` (the return workflow) and `a8dc4f7` (quarantine inspection).
`git log --oneline` is the authoritative history.

There is **no git remote** — everything is local. `master` is still back at
`03536e4`; all real work is on the branch.

---

## 2. The rules the codebase is built on

These are not style preferences. Most of the code exists in the shape it does
because of one of them.

**Stock is a ledger, not a number.** `Product.stockQuantity` is the balance, and
every write to it is paired with a `StockTransaction` row in the same database
transaction. Nothing writes the quantity directly. If the two ever disagreed,
the ledger is what tells the truth — which is why the "Inventory Impact" panels
on orders and purchases, as well as the `/stock-movements` ledger, read from the
ledger, not from the document's status.

**There is one stock engine.** `src/server/stock.ts` exposes `lockProduct`,
`lockProducts` and `applyStockMovement`. Orders, purchases and manual
adjustments all go through it. Do not write a second one.

**Cost is a property of a batch, not of a product.** The same part is bought at
different prices at different times, so there is no single "cost of a product".
`StockLot` records what one delivery cost, `StockLotConsumption` records which
batches a sale drew from, and FIFO decides the order. `Product.standardCost` is
a planning reference — a prefill for purchase lines — and must never be used for
valuation, COGS or margin. See §10.

**The valuation layer is an index over the ledger, never a rival to it.**
`Product.stockQuantity` remains the only answer to "how many", and
`StockTransaction` the only record of what moved. Every lot is created by
exactly one `STOCK_IN`; every draw points at the `STOCK_OUT` that took it. The
invariant `SUM(stockLot.quantityRemaining) = Product.stockQuantity` holds for
every product, is asserted after every stock-moving test
(`expectLotsReconcile`), and is what keeps this a second *view* of inventory
rather than a second *copy* of it.

**Selling is not shipping.** An order may be confirmed — and completed — while
the warehouse cannot fill it. Confirmation deducts what is on the shelf and
records the rest on `OrderItem.fulfilledQuantity`; the shortfall is an
obligation, not negative stock and not a phantom batch. It is cleared later by
an explicit fulfilment. Three quantities therefore have to be kept apart, and
collapsing any pair of them produces a number that is wrong while looking
authoritative:

```
costedQuantity                        shipped, cost known
fulfilledQuantity - costedQuantity    shipped, cost unknown
quantity - fulfilledQuantity          never shipped, no cost exists
```

See §18.

**Unknown cost is recorded as unknown.** Stock that predates lot costing, or was
counted in by hand, carries `unitCost = NULL`. Nothing fills that in from
`standardCost`, from an average, or from zero — a guessed cost is
indistinguishable from a real one once written. Quantity and cost are separate
concerns: an order for 15 units against 10 costed and 5 uncosted **confirms**,
and reports a cost covering 10 of 15 rather than a whole-line figure.

**Derived values are never stored.** Certificate status (valid / expiring /
expired / missing) is computed from the data it describes rather than persisted:
it changes on its own as dates pass, so a stored column would be wrong every
morning.

**Stock is a quantity, not a classification.** `Product.stockQuantity` is a
count, and nothing turns it into a status. There is no minimum-stock level, no
low- or out-of-stock state, no threshold filter and no reorder point — see §16
for what was removed and why. A product holding four units holds four units; one
holding none holds none. What that stock is *worth* is a different question, and
it is answered from the lots.

**The server decides who did something.** `createdBy` is never a parameter, in
any module. It is read from the Clerk session, resolved through `clerkId` to a
local user id. A field the browser can set is a field the browser can lie about.

**The server computes money.** Order and purchase totals are calculated
server-side in integer cents from prices read in the transaction. Clients send
quantities and ids, never totals. One exception, deliberate: a purchase's
**unit cost** does come from the client, because it is the supplier's number,
not ours — but the line totals and grand total derived from it do not. Cost of
sale is never sent by a client at all: it is resolved from the lots at the
moment of confirmation and frozen on the order line.

**No tax and no discount, anywhere.** An order's grand total is `subtotal`. Both
columns were dropped rather than left at zero, and a check constraint refuses a
total that implies either. A purchase total is likewise the sum of its line
totals. See §20 for the discount removal.

**The database refuses invalid rows.** Check constraints enforce non-negative
money, balanced document totals, a coherent stock ledger, and one current
certificate per product (a partial unique index). Prisma's schema language
cannot express these, so they live in hand-written migration SQL.

**Authorisation follows the route tree.** `auth.protect()` in the `(app)` layout
protects everything beneath it. Roles are checked server-side in `requireRole`.
Hiding a button is a courtesy, never the control.

**Records with history are archived, never deleted.** A product that has traded
becomes DISCONTINUED; a customer who has ordered becomes INACTIVE; a supplier
who has been bought from becomes INACTIVE. The `Restrict` foreign keys would
refuse most of these deletes anyway — the status column exists so there is a
way to take something out of circulation without editing the past. Suppliers
are the one place where a `Restrict` is *not* enough on its own; see §11. Archiving is *only* about what a picker offers: an archived customer
keeps every order, still displays on them, still counts towards their spend, and
their existing drafts stay editable.

---

## 3. Layout

```
prisma/
  schema.prisma          The domain model, heavily commented
  migrations/            15 migrations; several carry hand-written SQL
  seed.ts                A small, self-consistent warehouse
src/
  app/
    (app)/               Authenticated pages — the auth boundary is its layout
      products/  orders/  purchases/  stock-movements/   Built modules
      customers/ suppliers/ dashboard/ settings/         Built
      reports/   reports/[report]/                       Tier 1 built (§13)
    api/certificates/[id]/file/          Authenticated certificate download
    api/reports/[report]/csv/            Report export, same loaders as the page
  components/
    layout/              Shell: sidebar, header, mobile drawer, user menu
    ui/                  Button, Card, Table, Dialog, badges, Pagination…
  lib/
    env.ts               Validated environment, read once at import
    errors.ts            AppError + toSafeError (nothing leaks to the browser)
    money-basis.ts       What counts as revenue, spend, commitment (§12)
    cost-coverage.ts     Margin over the costed portion only (§10)
    date-range.ts        Query-string date parsing, shared by every list
    csv.ts               RFC 4180 escaping, BOM, download headers
    *-status.ts          Derived status rules: stock, certificate, order, purchase
    *-query.ts           List URL state: product, order, purchase, stock-movement,
                         customer, supplier, report
    validation/          Zod schemas shared by forms and server actions
  server/
    auth.ts              Clerk session → local user, role checks
    stock.ts             The only way stock changes; FIFO lots live here
    stock-movements.ts   Read model over StockTransaction ledger
    products.ts  orders.ts  purchases.ts  certificates.ts
    customers.ts         Customer directory: CRUD, archiving, lifetime value
    suppliers.ts         Supplier directory, archive lifecycle, provenance
    dashboard.ts         Six independent snapshot loaders (§12)
    reports.ts           The three Tier 1 report queries (§13)
    storage/             Swappable file storage (interface + local driver)
tests/                   Integration tests against a real Postgres
```

**The pattern every module follows.** Logic lives in `src/server/*.ts` with no
`next/*` imports, so it is testable without faking a request. Server actions in
`src/app/(app)/*/actions.ts` are thin: parse a payload, call the logic,
revalidate, convert a thrown error into something a form can render. Pages are
server components reading their state from the query string.

---

## 4. Running it

```bash
npm install
cp .env.example .env.local     # then fill in DATABASE_URL and the Clerk keys
npm run db:migrate
npm run db:seed                # optional; clears the tables first
npm run dev
```

| Command | Does |
| --- | --- |
| `npm test` | Vitest against a `..._test` database, created automatically |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm run build` | `prisma generate` then `next build` |
| `npm run db:studio` | Prisma Studio, for poking at data |

**Verification standard for this project:** tests, typecheck, lint and a
production build all pass before anything is committed. That has held for every
stage so far.

---

## 5. Testing

**583 tests across 17 files**, all against a **real PostgreSQL** database.
Clerk is the only thing mocked.

Real Postgres because most of what is worth proving *is* Postgres: that a unique
index rejects a duplicate SKU, that a `Restrict` foreign key stops a delete,
that `FOR UPDATE` holds under genuinely concurrent requests, that a rollback
undoes a half-finished deduction. A mocked Prisma client would only prove the
mock had been written to agree with the test.

| File | Covers |
| --- | --- |
| `tests/auth.test.ts` | Clerk-to-database identity, roles, first-sign-in races |
| `tests/stock.test.ts` | The stock engine: attribution, ledger integrity, limits |
| `tests/products.test.ts` | Catalogue CRUD, validation, search, filters |
| `tests/stock-adjustment.test.ts` | Manual adjustments, permissions, concurrency |
| `tests/certificates.test.ts` | Upload, replace, withdraw, status, file access |
| `tests/order-totals.test.ts` | Total arithmetic, and that tax is gone |
| `tests/orders.test.ts` | Orders: deduction, cancellation, editing, concurrency |
| `tests/purchases.test.ts` | Purchases: receiving, reversal, retired products |
| `tests/stock-movements.test.ts` | Ledger read model: filters, sorting, paging, stats |
| `tests/customers.test.ts` | Customer CRUD, archiving, permissions, lifetime value |
| `tests/suppliers.test.ts` | Supplier CRUD, archive lifecycle, provenance, deletion |
| `tests/stock-lots.test.ts` | FIFO allocation, lot invariants, partial cost coverage |
| `tests/stock-lot-backfill.test.ts` | What the backfill reconstructed, and what it refused to |
| `tests/dashboard.test.ts` | The six snapshots, and the margin that must stay null |
| `tests/reports.test.ts` | The three Tier 1 reports and their date bases |
| `tests/report-csv.test.ts` | Export escaping, and that it agrees with the page |
| `tests/date-range.test.ts` | The shared query-string date parser |

The concurrency tests are the ones to keep. They fire genuinely simultaneous
requests and assert that exactly one wins — they would pass trivially against a
read-then-write implementation run serially, and fail the moment it ships.

---

## 6. Things that will waste your afternoon

**A schema change needs a dev-server restart.** Not a hot reload. Turbopack
reloads your source, but the Prisma client's runtime metadata is initialised
once at process start, and `src/lib/prisma.ts` deliberately caches the client on
`globalThis` so hot reloads do not exhaust the connection pool. Symptom: a
`PrismaClientValidationError` or `Database not reachable` error. Fix: stop the
dev server (`Ctrl + C`) and start it again (`npm run dev`).

**New accounts are STAFF.** `syncUser` gives every new Clerk account the STAFF
role, because signing up must not be a route to ADMIN. Creating and editing
products, and manual stock adjustments, are ADMIN-only — so a fresh account sees
no "New product" button. Promote via `npm run db:studio` → `users` → set `role`
to `ADMIN`. There is no user-management UI yet.

**`prisma migrate deploy` does not wrap a migration in one transaction.** It
applies statements individually, so a migration that fails halfway leaves the
earlier statements committed. The `20260826140000_remove_order_tax` migration is
written to be re-runnable (`IF EXISTS`, a `WHERE` clause already satisfied) for
exactly this reason — it failed on the first attempt. Write new migrations the
same way.

**Clerk's `UserButton` cannot be server-rendered.** It emits its host element
only once the browser SDK has loaded, which the server never is. When the SDK
wins the race against hydration, React finds a div the server did not send and
discards the server HTML for the whole tree — which then trips a second,
confusing error about `next-themes`' inline script. `ClientUserButton` renders
it after hydration behind a matching placeholder. Do not "simplify" it back.

**The seed clears every table.** Never run `npm run db:seed` against a database
holding work you want to keep.

---

## 7. Known limitations in what *is* built

Things that work, with an edge worth knowing about.

**Stock movements has no reference-type filter.** `MovementListParams` carries a
search term, a product, a movement type and a date range — that is all. A row's
`referenceType` is surfaced and rendered (with a link for orders and purchases),
but you cannot filter the ledger down to "only order movements". Adding one
means a field on `MovementListParams`, a clause in `buildWhere`, and a control
in the filter bar; the tests already pin the rows such a filter would have to
select.

**The movement stats tiles ignore the filters.** `loadMovementStats` aggregates
the whole ledger, so the tiles describe the warehouse rather than the current
view. That is deliberate and tested — but it does mean the numbers do not move
when you filter, which reads oddly the first time.

**Read models carry no role check.** `listMovements`, `listProducts`,
`listOrders` and `listPurchases` all rely on `auth.protect()` in the `(app)`
layout rather than checking a role themselves. That is the established pattern,
not an oversight, and `tests/stock-movements.test.ts` pins it so a change is
deliberate. Write paths do check, in `requireRole`.

**Cancelling a received purchase can be refused.** If the goods have since been
sold, taking them back would drive stock below zero, so the whole cancellation
rolls back. Correct, but it means a received purchase is not always cancellable.

**Orders cannot be edited after confirmation, and purchases not after receipt.**
Both are deliberate — the document and the stock movement behind it have to keep
matching — but there is no "amend a confirmed order" workflow at all. Cancel and
re-raise is the only route.

**An order's customer cannot be changed after creation.** `updateOrder`
re-validates the order's existing `customerId` rather than accepting a new one.
That is what makes archiving safe — but it also means an order raised against
the wrong customer has to be cancelled and re-raised.

**Lifetime value is not a sortable column.** It is a sum over a filtered subset
of `orders`, not a column, so `listCustomers` aggregates it for the rows on the
current page only. Sorting by it would mean aggregating the whole customer base
on every load, in raw SQL, for every filter combination. The figure is shown per
row and in the stats tile; you just cannot order by it.

**The customer stats tiles ignore the filters**, exactly like the movement
tiles. They describe the customer base, not the current view.

---

## 8. What is not built

**Reports beyond Tier 1.** Four are built (§13) — the three Tier 1 reports and
the stock movement summary, which was the first of Tier 2. Four more are
designed and deliberately not built: profitability and cost coverage, inventory
ageing by lot, supplier provenance, and a certificate compliance register. The
last is the one worth doing next — an exportable airworthiness register is not
something generic ERP ships, and the data already supports it.

**Low and dead stock is removed from the product, not deferred.** It was the
sixth Tier 2 report, and the threshold machinery behind it was *built* — a
`minimumStock` column, a derived low/out-of-stock status, dashboard cards,
product tiles, a filter and a reorder marker. All of it has been removed at the
owner's direction (1 September 2026), column included; §16 records the removal.
Nothing threshold-driven is to be added back — no low- or out-of-stock report,
dashboard card or alert, no reorder points, no replenishment suggestions —
unless the owner asks for it explicitly. Physical stock quantity and the
inventory reporting that reads it are untouched; what is gone is turning a
quantity into an alert or a classification. The inventory reports that remain in
scope are **stock valuation** (built), **stock movement summary**, **inventory
ageing by lot** and **supplier provenance**.

**Sales returns are built.** The 4 September 2026 decision that put them out of
scope was reversed by the owner, and the workflow was then built in two commits:
`bc213eb` records returns, and `a8dc4f7` adds the inspection that follows one.
Anything in this file that still reads as a prohibition on returns predates
those commits; §22 carries the account, and §19 records the finding they close.

**What `bc213eb` built.** A `Return` document against a confirmed or completed
order, a `returnedQuantity` on the line kept distinct from `fulfilledQuantity`
(which is never reduced — the units did ship), and returned units arriving as
**new lots** rather than being written back into the batches they left. Each new
lot carries the cost those units actually shipped at, read from the original
`StockLotConsumption` rows, so a shipment drawn from two batches at two prices
comes back as two batches at those two prices and never one at the average; an
uncosted draw returns uncosted. Every return lot starts `QUARANTINED`, carries
no certificate, and records its provenance — the order line it came back from
and the batch it originally shipped on. The ledger row is a `STOCK_IN` against a
`SALES_RETURN` reference, deliberately not `ORDER`, so a return's movements stay
disjoint from the ones `cancelOrder` nets.

**What `a8dc4f7` built.** The inspection a quarantined batch waits for. An ADMIN
may **release** it to sale or **reject** it, and may then **write off** part or
all of a rejected batch; the transitions are exactly `QUARANTINED → SALEABLE`
and `QUARANTINED → REJECTED`, both terminal, with the table in
`src/lib/lot-status.ts`. Release and rejection move no stock at all — the units
were already counted, and what changes is whether FIFO may reach them. A
write-off does move stock, against **one named batch** through `drainLot` rather
than through FIFO, which would otherwise consume the saleable batches beside the
condemned one. Every decision records actor, timestamp and reason, and none is
reversible. `/returns` is the quarantine queue, ordered oldest first, and there
is deliberately no quarantine expiry — which is exactly why the queue has to
exist. Eligibility is `sourceType = SALES_RETURN`, never `costSource`: a return
of an uncosted shipment is an `UNKNOWN`-cost batch and is still a return.

The reason the codebase already carried is unchanged and remains the right one:
`COMPLETED → CANCELLED` on an order is still deliberately refused, because the
goods have shipped and putting units back because a status changed would invent
inventory that is physically somewhere else. A return is the opposite event and
now has its own document. An order carrying a return cannot be cancelled at all,
because the returned units are already back and cancelling would shelve them
twice.

`returnToLots` is still **not** the returns feature. It puts units back into
their originating batch at that batch's cost and serves **cancellation** — the
sale did not happen, rather than happened and was undone. The returns workflow
creates new lots instead, for the reasons above. See §19.

**Discounts are removed, not merely out of scope.** An earlier note here
recorded discount-aware *margin* as out of scope while `Order.discount` stayed
on the document. That was superseded within the day: the feature was removed
outright at the owner's direction (4 September 2026), column included. §20 is
the account.

Nothing is to be built back: no discount field on the schema, no discount input
on an order or purchase form, no discount arithmetic in costing, no
discount-based margin logic, no discount column on a report, and no discount UI
or validation. `total = subtotal` is a check constraint, so the database refuses
a total implying one whatever wrote it.

**Other gaps.** No user management UI. No Clerk webhook, so a name or email
changed in Clerk leaves a stale local mirror and a deletion is invisible
(`src/server/auth.ts` explains the trade-off). No partial receipts on purchases.

---

## 9. Next development steps

The most logical next steps for the application:

1. **Reports Tier 2** — the stock movement summary is built; four are designed
   and unbuilt; see §13. Profitability carries the sharpest trap: it cannot
   report a margin until cost coverage is non-zero, and today it is zero. Use
   the helpers in `src/lib/cost-coverage.ts` and the dashboard's rules rather
   than subtracting by hand.
2. **Certificate compliance register** — Tier 2's most valuable report for this
   business, and the one no generic ERP ships. Now unblocked: certificates live
   on lots (§17), so the register can be the lot-grain document it needs to be
   rather than a product-grain approximation. It still needs development data —
   the seed's synthetic samples are a start, not a substitute.
3. **Historical as-of valuation** — reconstructible, but needs explicit handling
   of the pre-costing migration boundary. See §13.

---

## 10. Cost, and why a product does not have one

The part of this codebase most likely to be misunderstood, so it gets a section.

### The problem it solves

`Product.costPrice` used to be a single number treated as *the* cost of the
stock. For an aviation parts business that is simply false: the same part is
bought at ₹8,000, then ₹9,500, then ₹7,800, and no column on the catalogue row
can describe a shelf holding a mix of all three. Stock was valued as
`stock_quantity × cost_price`, which was wrong by whatever the catalogue happened
to say, and editing that field silently restated every historical figure.

### What replaced it

| Thing | Means |
| --- | --- |
| `Product.standardCost` | A planning reference. Nullable. Prefills a purchase line and sorts the catalogue. **Never** valuation, COGS, or margin. |
| `PurchaseItem.unitCost` | What the supplier actually charged. Already existed; now it flows somewhere. |
| `StockLot` | One batch: what it cost, how many arrived, how many are left, which `STOCK_IN` created it. |
| `StockLotConsumption` | One draw against one batch. Append-only; a return is a negative row. |
| `OrderItem.costTotal` + `costedQuantity` | Cost of sale, frozen at confirmation, **with the coverage it describes**. |

### The flows

```
Purchase received → STOCK_IN → quantity up   → one StockLot per line, at its unitCost
Order confirmed   → STOCK_OUT → quantity down → FIFO draws oldest lots, freezes cost on the line
Order cancelled   → REVERSAL  → quantity up   → units return to their ORIGINAL lot at its original cost
Purchase cancelled→ REVERSAL  → quantity down → refused outright if any of its units were consumed
```

The quantity half of each line is exactly what it was before this change.

### Two rules that are easy to break

**Never substitute a cost.** `unitCost = NULL` means unknown and stays that way.
There is no fallback to `standardCost` anywhere, and adding one would defeat the
entire design.

**Never write `revenue - knownCost`.** When coverage is partial that is an upper
bound, not a profit — it is only true if the uncosted units were free. Use
`marginOf()` from `src/lib/cost-coverage.ts`, which apportions revenue to the
costed units and returns the coverage alongside. `coverageNote()` produces the
sentence the UI shows ("Margin calculated for 10 of 15 units; 5 units have
unknown acquisition cost.").

### Why FIFO

It matches physical rotation for shelf-life-controlled stock, needs no operator
input, and — this is the part worth keeping in mind — **shares its data
structure with specific-lot identification**. Switching to operator-chosen lots
later is a policy change in `allocateFifo`, not a schema redesign. That is also
why lots are never merged even when product and unit cost match: `StockLot` is
shaped to become what `Certificate.stockLotId` points at.

### The backfill, and what it deliberately did not do

Existing stock was attributed to received purchases newest-first (FIFO leaves the
newest on the shelf), with anything unprovable becoming an `UNKNOWN` lot.
Historical orders were **not** costed: replaying them through FIFO would have
assigned a COGS derived from a policy that did not exist when they happened.
Accurate margin therefore starts from this change and runs forward; older orders
show "Not available — the stock this order consumed has no recorded acquisition
cost", which is the truth.

Expect the uncosted share to be at its highest immediately after the migration
and to shrink on its own: uncosted lots are the oldest, so FIFO drains them
first.

---

## 11. Suppliers, and the two relationships

Suppliers look like customers and are not, in one way that matters. A customer
is referenced by one thing. A supplier is referenced by two, with different
foreign keys and different consequences:

| Relation | Column | On delete | What that means |
| --- | --- | --- | --- |
| `products` | `Product.supplierId`, nullable | `SetNull` | A product can exist before its supplier is known, and losing the supplier must not lose the product. |
| `purchases` | `Purchase.supplierId`, NOT NULL | `Restrict` | A purchase must always say who it was placed with. The database enforces it. |

### Deletion is stricter than for customers, and only half of it is a constraint

A supplier can be deleted only when they have **no purchases and no products**.

The purchases half is enforced by `Restrict` regardless of what the application
does; `deleteSupplier` checks it anyway so the refusal is a sentence somebody
can act on rather than a foreign key violation. That constraint is also the last
link in the provenance chain — a stock lot points at the purchase that delivered
it, and that purchase points at the supplier.

**The products half is the one worth remembering, because the database will not
stop it.** `Product.supplierId` is `SetNull`, so deleting a supplier with
products *succeeds* and silently blanks the sourcing on every catalogue row they
supply, with no ledger to explain it afterwards. Refusing that is application
logic in `deleteSupplier`, and the foreign key stays as it is as defence in
depth against a raw SQL delete. Do not "simplify" this by trusting the schema.

### Archiving

`SupplierStatus` mirrors `CustomerStatus`, and archiving is the normal end of a
supplier relationship. It takes them out of **two** pickers — new purchases and
the product form — and out of nothing else:

- an existing purchase keeps its supplier and stays editable;
- a **pending delivery can still be received**, because goods that physically
  arrived have to be bookable in;
- a product already sourced from them keeps the link and stays editable;
- no stock lot, quantity, or acquisition cost is touched. Archiving is one
  column on one row.

Moving a purchase *to* an archived supplier is refused — that is a new
assignment, not an existing obligation. Products follow the same shape:
`createProduct` refuses an archived supplier outright, and `updateProduct`
refuses one **only when it is a change**. Keeping the archived supplier a
product already has is allowed; choosing a different archived supplier is not.
Both checks compare against the record's current supplier inside the write
transaction, and both live on the server — the pickers exclude archived
suppliers as a convenience, never as the rule.

### One loader, two rules

`loadSupplierOptions(includeId?)` in `src/server/suppliers.ts` is the only
supplier picker loader. Products and purchases each used to keep their own, with
different `select`s and no notion of status.

`includeId` is not optional decoration. It keeps a named supplier in the list
whatever their status, and without it archiving would strand every document and
product already pointing at them: the select would find no matching option,
blank the field, and the save would reject a record nobody had edited. It takes
one id or several — the product list passes the archived supplier of whichever
row is being edited.

`loadSupplierFilterOptions()` is deliberately separate and returns **everyone**.
A picker asks who may be given new business; a filter asks whose records to
find. Excluding archived suppliers from a filter would make their history
unreachable from the only control that could reach it.

### Permissions

Create and edit are `requireUser()` — a purchase needs a supplier, both roles
raise purchases. Archive, reactivate and delete are `requireRole("ADMIN")`.

### What was deliberately not built

No link between certificates and suppliers, and none is needed. A certificate
now belongs to a **lot** (§17), and a lot already carries its provenance, so the
supplier follows the chain `StockLot → Purchase → Supplier` without a second
foreign key. Lots with no purchase behind them — opening stock, adjustments,
backfilled batches — correctly have no supplier at all.

What is still absent is an **issuing authority**. The release authority on an
airworthiness document is often the supplier but not always, and this model has
no field for it: `certificateType` is free text and the lot's supplier is an
acquisition fact, not an attestation. Anything reporting on this must say
"Supplier (lot provenance)" and must not imply the supplier issued the document.

---

## 12. The dashboard, and the number it must never print

The dashboard has six sections — needs attention, inventory, sales,
procurement, costing and coverage, recent activity — each loading behind its own
Suspense boundary so a slow aggregate delays its own card rather than the page.
A section that fails renders an error in place; the rest still paints.

"Needs attention" holds two stats — orders to action and deliveries outstanding
— plus the certificate table. It used to lead with low-stock and out-of-stock
cards; those are gone (§16), and nothing threshold-based replaced them. What is
left is work somebody has to do, which is what the section was for.

### The margin trap

`revenue - knownCost` is not margin when some units sold have no recorded
acquisition cost. It is an upper bound reached only if those units were free.

This is not hypothetical. Every order confirmed before FIFO costing shipped has
`costedQuantity = 0`, so on the development database that subtraction reports
the **entire revenue as profit, at one hundred per cent** — a confident,
plausible, catastrophically wrong number in the most prominent place in the app.

So `loadCosting` returns `margin: null` when nothing is costed. Not zero, not
the revenue: absent, so there is no number for the UI to render. At partial
coverage the revenue is apportioned to the costed units
(`unitPrice x costedQuantity` per line) and the coverage travels with the figure.

**That apportionment needs no basis qualifier any more.** It briefly did: while
an order-level discount existed, `unitPrice × costedQuantity` was a list-price
figure and the margin on the order page was higher than the margin on what the
customer actually paid. Removing the discount (§20) closed that gap by
construction — line prices *are* what the customer was charged — so "Gross
margin" on the order detail page is now correct without qualification.

### One revenue basis

The Sales and Costing sections report the same number, because
`orders.total = orders.subtotal = SUM(order_items.total)` by check constraint.

This was two bases until the discount was removed (§20). Sales reported
`SUM(orders.total)` net of an order-level discount, Costing worked at list price
from `SUM(order_items.total)`, the two did not reconcile whenever an order
carried a discount, and a standing paragraph on the page existed to explain why.
That paragraph is gone rather than reworded: an explanation of a difference that
can no longer occur is worse than no explanation. The fields renamed with it —
`allSalesAtListPrice` became `allRevenue`, `costedSalesAtListPrice` became
`costedRevenue` — because "at list price" no longer distinguishes anything.

### Certificates on the dashboard

Expired, expiring within thirty days, and missing — counted over **open stock
lots of ACTIVE products**. Per batch, not per product (§17): a part with two
batches, one released under a valid form and one with nothing filed, is exactly
one problem rather than one product's worth of doubt over both. Lots drawn to
zero are excluded — there is nothing on the shelf left to be uncertain about,
though their paperwork history survives.

A certificate with **no expiry date is valid**; a Certificate of Conformity
typically never expires and flagging null expiries would alarm about a large
share of legitimate documents. Superseded certificates are ignored.

The products list has no certificate filter, so the affected lots travel with
the counts rather than linking to a view that cannot filter.

### Retired stock is counted, and separated

Inventory value covers active, inactive and discontinued products alike — a
discontinued part on a shelf is still capital — with the retired share broken
out so it cannot be mistaken for stock that can still be sold.

### Money rules live in one place

`src/lib/money-basis.ts` owns what counts as revenue, open commitment, spend and
committed spend. Before it, `REVENUE_STATUSES` lived in the customers module, an
equivalent was private to suppliers, and orders and purchases filtered inline —
which is how `openValue` came to mean CONFIRMED while `lifetimeValue` meant
CONFIRMED + COMPLETED, both defensible and neither discoverable from the other.

In raw SQL, interpolate them as enum arrays rather than writing the strings out:

```sql
WHERE o.status = ANY(${revenueStatuses()}::"OrderStatus"[])
```

---

## 13. Reports

Four reports are built — the three Tier 1 reports and the first of Tier 2.
`/reports` is the index; `/reports/[report]` renders one;
`/api/reports/[report]/csv` exports it. All four read their state from the query
string through `reportParamsFor`, which is the only reason a page and its export
cannot come to answer differently phrased questions.

| Report | What it answers | Date basis |
| --- | --- | --- |
| **Stock valuation** | What is on the shelf and what it cost | current state |
| **Sales** | What sold, to whom, for how much | `orders.confirmed_at` |
| **Purchase spend** | What was bought and from whom | `purchases.received_at` |
| **Stock movement summary** | How much moved in and out, and net | `stock_transactions.created_at` |

### One date rule: the economic event

A sale is dated by when its order was **confirmed** — the moment stock left and
cost was frozen. Procurement by when its delivery was **received** — the moment
stock and cost arrived. Committed procurement by `purchase_date`, since nothing
has been received.

`created_at` is deliberately not used for anything financial: it dates the
moment a draft was started, so an order raised in March and confirmed in June
would land in March's revenue. Both chosen columns are fully populated for
realised documents — no row is silently dropped by a date filter.

### Spend is not cost of sales

The most natural wrong report to build. Buying and selling are different events
at different times: the development data has procurement in June against no
revenue at all. Nothing in the purchase report may be subtracted from the sales
report to produce a margin. COGS comes from `OrderItem.costTotal` and appears in
no Tier 1 report at all.

### No profitability in Tier 1

Deliberate. The only honest margin on data with no cost coverage is an absence,
and a report gets exported and forwarded where a caveat does not travel. When
Tier 2 adds it, it must follow the dashboard's rules exactly.

### Dates and grouping

Revenue is reported at **every** grouping, product and category included.

That is a change, and a capability gain rather than only a deletion. Those two
groupings used to return null: revenue came from `SUM(orders.total)`, an
order-level figure, and splitting an order-level discount across lines would
have meant inventing an allocation rule. Revenue is now `SUM(order_items.total)`,
which is already per-line, so it groups by anything without double-counting —
and the `line_counts` join and division that existed to avoid that
double-counting went with the discount (§20).

### CSV

Same query, same parser, same loader as the page — the export answers the
question the screen was showing rather than a second implementation that agrees
today and drifts tomorrow. Authentication is the loaders' own `requireUser()`,
so an unauthenticated request gets a 401 before a row is read.

The file carries a preamble naming the period, the grouping and the filters, and
restating the coverage caveats — a spreadsheet that gets forwarded still says
that uncosted stock was excluded rather than valued at zero. UTF-8 BOM for
Excel, CRLF endings, and quoting for commas, quotes, newlines and edge
whitespace.

### Indexes were measured, not assumed

`orders(confirmed_at)` and `purchases(received_at)` are partial indexes added in
`20260828140000_report_date_indexes`. They were measured on a throwaway database
loaded with three years of synthetic history — 120,000 orders, 40,000 purchases
— because the development database has fewer than twenty rows per table and
Postgres sequentially scans everything:

```
sales, 12-month window      67.1ms -> 51.2ms    24% faster
purchase spend, 12 months    2.3ms ->  0.4ms    81% faster
```

Two candidates were measured and **rejected**. A partial index on
`stock_lots(quantity_remaining)` moved valuation by six per cent and the plan
still showed a sequential scan — the query reads two thirds of the table, which
is the wrong shape for an index. `stock_lot_consumptions(lot_id, created_at)`
has no query to serve until as-of valuation exists.

### The stock movement summary, and the sign that is easy to get wrong

The first Tier 2 report, and the only one so far that reports quantities rather
than money.

**Direction comes from the balance, never from the type.** This is the whole of
it. `stock_transactions.quantity` is always positive — the column stores the
size of the move, and a check constraint enforces `quantity > 0`. Only STOCK_IN
and STOCK_OUT carry their direction in the type. ADJUSTMENT and REVERSAL go
either way, and on the development database both do: reversals net +329 in and
−225 out, adjustments +25 and −16. A `CASE` on the type inverts one kind of
reversal — a cancelled purchase's, or a cancelled order's, whichever way it is
written — and produces a table nobody would question.

The one expression correct for all four types is

```sql
delta = new_stock - previous_stock
```

which `stock_transactions_arithmetic_balances` guarantees. Everything the report
reports is built from it:

```sql
units_in  = SUM(GREATEST(delta, 0))
units_out = SUM(-LEAST(delta, 0))
net       = SUM(delta)
```

so `units_in - units_out = net` holds for every row and for the totals. Two
tests pin the two reversal directions specifically, because that is the failure
that would survive review.

**Dated by `created_at`, and here that *is* the economic event.** Unlike sales
and procurement, the ledger row is written inside the same database transaction
as the balance change — there is no second timestamp meaning "when it really
moved". `StockLot.receivedAt` exists for backfilled batches that arrived before
this system and does not apply: those lots carry no originating transaction and
so contribute no movement at all.

**Nothing is reconstructed.** Stock that predates the ledger has no movement and
is not reported. The report never derives a movement from an order, a purchase,
a lot or a current quantity — a test seeds 500 units with no ledger row behind
them and asserts the report says nothing about them.

**Aggregate only.** `/stock-movements` remains the per-row ledger, with the
reference document, the operator, the note and the per-movement cost. The report
links to it rather than reproducing it.

**Groupings: month, product, category, movement type. Filters: period, category,
search, movement type.** Sorted newest-first by default — `label` descending,
which for the default month grouping means the current month at the top. Busiest
first was tried and read badly: it scattered the months (08, 07, 06, 09) with
the current one last. Every other sort key stays available and an explicitly
chosen sort is untouched by that default.

Deliberately no supplier or customer, in either role.
Only movements carrying a document reference have one, so such a grouping would
silently drop opening stock and every manual adjustment — and its rows would
then fail to sum to the report's own totals. Supplier provenance is a separate
Tier 2 report with a query shaped for the question.

**No money at all.** No movement value, no cost of sales, no coverage. A "value
moved" column on a movement report is one screenshot away from being read as
cost of sales, and per-movement cost already exists on the ledger page.

**No migration and no new index.** `stock_transactions` already carries
`@@index([createdAt])`, `([productId, createdAt])`, `([type])` and
`([referenceType, referenceId])`; every access path this report uses was already
indexed. Following the rule set earlier in this section, an index would have to
be measured before it was added.

The movement type filter added one field to the shared `ReportParams`
(`movementType`, URL key `mtype`). It lives there rather than in a parser of its
own for the same reason the groupings do: the CSV route reads the same
parameters the page did, and a second parser is how the two drift apart.
`reportRowLabel` in `src/lib/report-query.ts` is the single place the raw enum
becomes "Stock In", so the screen and the export cannot spell it differently.

### Known limitations

**Historical COGS does not exist and is not reconstructed.** Orders confirmed
before FIFO costing have `costedQuantity = 0` by the deliberate backfill
decision. Any margin over that period is zero-coverage, and nothing fills the
gap.

**As-of valuation is deferred.** It is reconstructible — the consumption table
is append-only, and `quantityReceived - SUM(signed consumptions <= T)`
reproduces `quantityRemaining` exactly — but backfilled lots carry a
`receivedAt` in the past and a `createdAt` at migration time, so any as-of date
before that boundary would misstate them. There is deliberately no date picker
implying otherwise.

**The certificate compliance register is deferred**, along with the other three
Tier 2 reports. Certificates are unchanged, and `Certificate.stockLotId` was not
introduced.

**Browser QA of the stock movement summary is complete.** Run in setup mode
against live development data: the index, the report page, all four groupings,
the movement-type filter and Reset, category and search, pagination, the empty
state, the CSV download and the 375px layout. Two things are worth recording
because they are the ones the eye caught and the tests could not.

The first is the evidence that the sign rule works, visible on screen. Grouped
by movement type, the ledger reports:

| | Movements | Units in | Units out | Net |
| --- | ---: | ---: | ---: | ---: |
| Stock Out | 19 | — | 872 | −872 |
| Stock In | 13 | 1,748 | — | +1,748 |
| Reversal | 6 | **329** | **225** | +104 |
| Adjustment | 4 | **25** | **16** | +9 |

Reversal and Adjustment each carry traffic in *both* directions. That is what a
type-based sign rule cannot produce, and it is the fastest way to check the
report is still honest after any edit to the loader.

The second is that two cosmetic problems were found and fixed. The index grid
was `xl:grid-cols-3`, which left the fourth card alone on a second row; it is
`xl:grid-cols-4` now and the four render as one row. And the default sort was
`movements`, which is the ordering described above as reading badly; it is
`label` now.

**Two pre-existing issues in the shared report filter bar were found and
deliberately not fixed**, since neither belongs to this report and both predate
it. A `range=custom` URL renders a **blank Period trigger** — the control builds
its options from `RANGE_PRESETS.filter(p => p !== "custom")`, so a custom range
has no item to select; confirmed identical on `/reports/sales`. And a `?page=N`
beyond the last page renders the **empty state rather than clamping** to the
last page. Both affect all four reports.

---

## 14. The pre-costing cancellation bug

Worth knowing about because the shape of it will recur.

The backfill deliberately did not cost historical orders. What that left
unhandled is that those orders can still be **cancelled** — and when one was,
`returnToLots` found no consumption rows to attribute the returned stock to. It
returned zero silently: `stockQuantity` and the ledger rose, no lot did, and
`SUM(quantityRemaining) = stockQuantity` stopped being true on a live database.

`returnToLots` now reconciles against how many units the reversal restored, and
whatever the consumption rows cannot explain becomes an UNKNOWN lot dated to
when the units originally left. The same hole exists in the other direction on
purchases and is **refused** rather than repaired — an outbound shortfall cannot
become an uncosted lot, and taking it from another batch would corrupt that
batch's cost history.

The lesson for the next migration that declines to reconstruct something: check
what can still be *undone*, not only what can be read.

---

## 15. The cleanup pass, and the two names it settled

A dead-code audit over the whole repository after Tier 1 Reports landed. Worth
recording mainly for what it *kept*, because the next audit will ask the same
questions.

### What went

Roughly 200 lines across a dozen files, none of it in the inventory engine:
`ModulePlaceholder` (its last consumer was the placeholder `/reports` page,
rewritten in §13), `formatCompactCurrency`, `daysUntilExpiry`, `coverageLabel`,
`isUnlinked`, the report grouping constants superseded by `REPORT_CONFIG`, and
the tone helpers in `order-status.ts` and `purchase-status.ts` — those last two
had been quietly superseded by the badge components, which pair a tone with an
icon and so could never have used a colour-only map.

Three supplier re-export shims went with them (`@/server/products` and
`@/server/purchases` both re-exported `loadSupplierOptions`, and nothing had
imported either since the suppliers module took ownership), along with a
`REVENUE_STATUSES` re-export from customers, three obsolete `costPrice` keys in
the certificate fixtures that Zod had been silently stripping since `532c0bc`,
and the `@radix-ui/react-avatar` dependency — the avatar is Clerk's.

### Three duplicated implementations became one

`readOne` and `RawSearchParams` existed four times: once in `date-range.ts` and
once privately in each of the customer, product and supplier query modules. The
orders, purchases and movements modules had already been switched over during
the Reports work; these three were missed because they have no date filter and
so were not in that refactor's path.

More consequentially, the report page and the CSV route each held their own copy
of every report's groupings and sort keys. That is the one duplication that
could do real damage: add a sort key to the page, forget the route, and the
export answers a differently ordered question than the screen it came from,
silently. Both now go through `reportParamsFor(report, raw)`, and neither can
supply a configuration of its own.

### Two constants both called "open"

`money-basis.ts` had `OPEN_ORDER_STATUSES = [CONFIRMED]` — committed, awaiting
shipment. The customers module had `OPEN_STATUSES = [DRAFT, PENDING]` — raised,
not yet committed. Opposite ends of the same lifecycle, both called open, in a
codebase whose money definitions had already drifted once for exactly this
reason.

The customers one is now `UNCOMMITTED_ORDER_STATUSES`, private to its module.
The statuses themselves are unchanged; only the name is.

Note it is *not* called `ACTIONABLE_ORDER_STATUSES`, which was the first
suggestion: money-basis already exports that name for `[PENDING, CONFIRMED]`,
and reusing it would have replaced a vague collision with an exact one.

### One constant kept on purpose

`OPEN_ORDER_STATUSES` and `openOrderStatuses()` have no callers and are staying.
They are reserved for the reporting and operational layer, where "what have we
committed to ship" is a question that will be asked and should be asked in one
agreed way. The constant carries a comment saying so, because an audit that only
counts references will find it again.

The same applies to `supplierId` and `customerId` in `ReportParams`: no filter
control offers them yet, but all three loaders honour them and they round-trip
through the URL today.

### Two schema indexes, deliberately untouched

`Certificate @@index([certificateType])` and `User @@index([role])` have no query
filtering or sorting on those columns. That makes them *candidates*, not waste —
proving an index is unused needs a measurement on realistic volume, the way the
report indexes in §13 were measured, and dropping one costs a migration. Left in
place, recorded here for a future schema review.


---

## 16. Low and out-of-stock, and why the column went

The product used to classify stock. `Product.minimumStock` held a threshold,
`stockStatus()` compared the balance against it, and the result — NORMAL, LOW_STOCK
or OUT_OF_STOCK — drove two dashboard cards, two product tiles, a list filter, a
badge in four places, and a marker on the product detail bar. All of it is gone,
including the column.

### Why

The business does not work to fixed stock thresholds or reorder levels. Nobody
sets a minimum per part, so every minimum in the system was either zero or a
number somebody typed once to fill the field in. A threshold nobody maintains
does not produce a signal; it produces an alert whose only real input is whether
the field happened to get filled in. The dashboard led with two such cards.

This was a product decision, not a technical one, and it was made in both
directions deliberately: **the quantity stays, the classification goes.**

### The distinction that matters

"Out of stock" as a *physical fact* is useful and is still reported. A product
holding nothing shows `0`. A product holding four units shows `4`. Neither
carries a colour, a badge, or a status, and neither appears on a list of things
demanding action. If you find yourself adding one back, that is the line this
section exists to mark.

### What went

The schema column and its check constraint, dropped in
`20260901120000_remove_minimum_stock`. Two files: `src/lib/stock-status.ts` and
`src/components/ui/stock-status-badge.tsx`. `stockStatusWhere()` in the products
module — which was the only caller of Prisma's `product.fields.*` column
references anywhere in the codebase. The `low_stock` and `out_of_stock` counts
from `loadProductStats` and `loadAttention`. The `?stock=` query parameter and
the `minimumStock` sort key. The form field, the table column, the filter
select, the detail bar and its reorder marker, and the badges on the order
builder and the supplier detail page.

Two of the removals were already dead: `OrderLine.stockStatus` and
`PurchaseLine.stockStatus` were computed on every order and purchase detail load
and rendered nowhere.

### The one place removal could have broken a number

`loadAttention` ran a raw query shaped like this:

```sql
SELECT <out_of_stock count>, <low_stock count>, (uncorrelated subquery) AS uncosted_units
FROM products WHERE status = 'ACTIVE'
```

Delete the two counts and the `FROM products` becomes a row multiplier for a
scalar subquery — one row per active product, and **zero rows on an empty
catalogue**, at which point the `rows[0] ?? { uncosted_units: 0 }` fallback would
have reported no uncosted stock while uncosted lots sat in the table. The count
was never scoped to active products in the first place; the `FROM` was there to
host the threshold counts.

So the query was not trimmed, it was replaced: `loadAttention` now aggregates
`stock_lots` directly through Prisma. `loadProductStats` kept its raw SQL, since
its `FROM products` is still doing real work for `total`.

### What was deliberately not touched

The stock engine, the ledger, `StockLot`, `StockLotConsumption`, FIFO allocation
and consumption, inventory locking, valuation, order confirmation and stock
deduction, receiving, supplier provenance, certificates, and all three Tier 1
reports. Nothing threshold-shaped replaced what was removed, and no new stock
status concept was introduced.

The invariants and the report figures were re-checked afterwards and are
unchanged: I-1 and I-3 both clean, valuation ₹18,104.96, 355 uncosted units,
realised revenue ₹19,592.36, received spend ₹24,847.00.

### A stale link degrades rather than breaks

The old dashboard handed out `/products?stock=LOW_STOCK`, and some of those are
in people's bookmarks. `parseProductListParams` discards what it does not
recognise, so such a link now lands on an unfiltered list. Same for
`?sort=minimumStock`, which falls back to sorting by name. Both are pinned by
tests rather than left to chance.
---

## 17. Certificates belong to the batch, not the part

The change §10 was shaped to make additive, finally made. `Certificate` now
points at a `StockLot`.

```
Supplier → Purchase → StockLot → Certificate
```

### Why the product was the wrong owner

A certificate covers the units that arrived. Two deliveries of one part number
under two different releases were previously indistinguishable: the table
allowed one current certificate per product, so a part whose paperwork read as
valid could still have differently certified units sitting on the shelf. In an
aviation parts business that is not a rough edge — it is the system stating
something it cannot know.

The schema comment on `Certificate` had described this as a known limitation
since the certificates module was built, and `StockLot` was deliberately shaped
so the fix would be additive: one lot per receipt line, never merged even when
the product and unit cost match, precisely so there would be a batch for a
document to point at.

### The model

`stockLotId` is **nullable, for history only**. Certificates filed before this
change have no batch to point at, and inventing one would fabricate coverage
nobody can evidence. They keep a null and stay readable as the record of a
document that was filed against a part.

A check constraint makes that a database fact rather than a convention:

```sql
CHECK (stock_lot_id IS NOT NULL OR superseded_at IS NOT NULL)
```

A current certificate must name a batch. A row with no batch is history by
definition, so product-level coverage cannot come back through a side door.

`productId` is **kept**, and the two are made to agree by the database rather
than by application code — a composite foreign key onto a redundant unique key:

```sql
UNIQUE (id, product_id) ON stock_lots

FOREIGN KEY (stock_lot_id, product_id)
  REFERENCES stock_lots (id, product_id) ON DELETE RESTRICT
```

`MATCH SIMPLE` is the default and is what makes this work: a row with a null
`stock_lot_id` is exempt, so the legacy rows pass while every lot-linked row is
checked. Writing `MATCH FULL` would reject all of them. `product_id` therefore
sits in two foreign keys — this one and the existing `CASCADE` to `products` —
which is intentional and legal.

Uniqueness moved with the ownership: `certificates_one_current_per_product` was
dropped for `certificates_one_current_per_lot`. Two current certificates on one
product are now perfectly legal, because they cover different units.

### What the migration did, and deliberately did not

`20260901160000_certificates_on_lots` adds the column, the composite key, the
index and the check; retires any product-level certificate that was still
current; and swaps the partial unique indexes. On the development database the
retirement affected **zero rows** — both existing certificates were already
superseded — but other environments are not assumed to match.

**No backfill.** Both surviving rows belong to a product that happens to have
exactly one lot, so an "obvious" association was available and was not taken.
Which units a historical document covered cannot be established from the data,
and a product whose only batch looks obvious is still a guess. They stay with a
null lot, which is the truthful record.

No stock quantity, ledger row, lot, consumption or cost value was read or
written. Certificates never affected FIFO allocation, valuation or stock
movement and still do not.

### The workflow

Create the product → receive or record stock → attach the certificate to the
lot. Attachment is **always** a post-lot operation.

Receiving is untouched and must stay that way. Goods routinely arrive before
their paperwork, and a receipt that demanded a document would push people to
record stock they hold as stock they do not. `receivePurchase` creates the lot;
the document is filed against it afterwards, from the product detail page.

Creation no longer accepts a certificate at all. Opening stock does produce a
lot, so an exception was possible — and was rejected. A field that works only
when the operator happens to enter opening stock is worse than a field that is
not there.

### Where it surfaces

**Product detail** shows one panel per open batch, each with its own status
badge and attach/replace/withdraw controls, plus a product-wide history card.
That history is deliberately product-scoped rather than per lot, because it is
also the only place the legacy null-lot rows appear.

**Order lines** show the paperwork of the batches the order *actually drew
from*, read through `StockLotConsumption` — so the question answered is "what
covered the units that shipped", not "what covers this part number today". An
order drawing across three batches lists three; picking one would be presenting
a guess as the answer. Consumption quantities are signed, so a cancellation
nets its draws to zero and the line correctly lists nothing.

**Purchase lines** show the paperwork of the batch that delivery created, and
nothing at all before receipt — there is no lot yet, and inventing coverage for
goods that have not arrived is the same mistake as costing them early.

**The dashboard** counts open lots, not products (§12).

### What is still not modelled

There is no issuing authority. See §11: the supplier is an acquisition fact
derived from the lot's provenance, not an attestation, and lots with no purchase
behind them have no supplier at all. Anything reporting on this must label the
column **"Supplier (lot provenance)"**.

One certificate covers one lot. A single document covering a delivery split
across two purchase lines produces two lots and must be uploaded twice. That is
consistent with "two deliveries are two batches with two sets of paperwork", but
it is duplication, and a `CertificateLot` join table is the additive path if it
ever becomes a real problem.

The product detail lists **open** lots only, so a batch drawn to zero keeps its
paperwork but has no UI reaching it. Order lines are the route to it, and the
certificate compliance register will be the other.

### The trap worth knowing

`deleteProduct` now removes certificates **explicitly, before lots**. They used
to go with the product through `onDelete: Cascade`, which was enough when they
pointed only at products; the lot foreign key is `RESTRICT`, so leaving them to
the cascade makes the lot delete fail on any product carrying paperwork. The
ordering is certificates → consumptions → lots → transactions → product, and a
test pins it.

---

## 18. Selling what is not on the shelf

The business sells parts it does not yet hold. Until this change the system
refused that outright: `confirmOrder` checked every line against its balance and
threw `INSUFFICIENT_STOCK` if any came up short, so an order for one more unit
than existed could not be confirmed at all.

That was the wrong model, and the fix is not the one people reach for first.

### What was rejected, and why

**Negative stock.** One guard to remove, in theory. In practice five —
`applyStockMovement`, the pre-check, and three database CHECK constraints — plus
the FIFO scan (`WHERE quantity_remaining > 0` makes a deficit invisible, so it
is never drawn down or repaid), both reconciliation assertions, and the
valuation report's `stock_quantity > 0` filter, which would silently drop the
whole product. And after all that the sale stays permanently uncosted: when the
unit finally arrives at ₹9,500 that money lands in inventory value instead of
cost of sales. Both sides wrong at once, with no error raised.

**A phantom or negative lot.** Worse, because it fails quietly. It either
invents a unit that valuation then reports as on hand, or violates
`quantity_received > 0`. It also sits in the FIFO queue and contaminates the
*next* order. And it collides with the one distinction the costing layer exists
to protect: `LotCostSource.UNKNOWN` means "these units are real and we cannot
price them", not "these units are not real".

### What was built instead

`OrderItem.fulfilledQuantity` — how many of a line have physically left, as
distinct from how many were sold and from how many have a known cost.
Outstanding quantity is `quantity - fulfilledQuantity` and is **never stored**:
two columns that must agree are two columns that will not.

```
Order 5, shelf holds 3
  confirmOrder   take = min(5, 3) = 3
                 one STOCK_OUT for 3, FIFO-costed
                 fulfilledQuantity = 3, confirmedAt set
                 2 outstanding: no movement, no lot, no consumption, no cost
                 stockQuantity 0, never below

Purchase of 2 received   ordinary receipt, ordinary lot, real price

  fulfilOrder    operator states 2
                 one STOCK_OUT for 2, FIFO draws the new lot
                 fulfilledQuantity = 5, costTotal += the real cost
```

Every negative-stock protection is intact. Nothing in `src/server/stock.ts`
changed — not the engine, not FIFO, not lot creation, not `returnToLots`.

### The rules that are easy to get wrong

**`confirmedAt` is set even when nothing shipped.** The sales report dates
realised revenue by `orders.confirmed_at`. An order confirmed against an empty
shelf that left it null would vanish from every financial report. The sale
happened; only the shipping is outstanding.

**Never write a zero-quantity movement.** A line that can take nothing produces
no `StockTransaction`, no lot and no consumption row. The ledger records what
moved, and nothing moved — `stock_transactions_quantity_positive` would reject
the row anyway.

**Confirmation truncates; fulfilment refuses.** Confirming is a commitment to
sell, so a shortfall is the point and gets recorded. Fulfilling is an assertion
that units are physically going out, so asking to ship 2 when 1 is there is a
mistake in the request and is rejected rather than quietly reduced.

**An unfulfilled unit is not an uncosted unit.** Coverage is measured against
`fulfilledQuantity`, never `quantity` — in `cost-coverage.ts`, on the order
detail page, and in the dashboard's costing section. Counting outstanding units
as uncosted reports a procurement backlog as a costing failure. `marginOf` takes
`fulfilledQuantity` as a *required* argument for exactly this reason: a default
would silently preserve the old arithmetic wherever an author had not thought
about it.

**Fulfilment stays available on a COMPLETED order.** Completion is commercial,
fulfilment is physical. If completing sealed the outstanding quantity there
would be no route left to ship it — COMPLETED is terminal and
`COMPLETED → CANCELLED` is refused — and no route to undo the completion either.

**No automatic allocation.** Receiving a delivery fulfils nothing. When a short
delivery lands against three waiting orders, which customer gets it is a
commercial decision, and settling it by whoever's page refreshed first would
bury that decision in a race.

**No new OrderStatus.** "Partially fulfilled" is a fact about an order's lines,
not a state of the document. A sixth status would give the same order two places
to disagree with itself about how much had shipped.

### Cancellation needed no logic change

`cancelOrder` was already ledger-driven: it nets the STOCK_OUT and REVERSAL rows
and restores only what actually left. An order that shipped nothing writes no
reversal and creates no uncosted shortfall lot; one that shipped 3 of 5 returns
exactly 3, to the batches they came from at the prices those batches cost. The
only addition is bookkeeping — `fulfilledQuantity` is reset to 0 alongside
`costTotal` and `costedQuantity`, in the same `updateMany`, so
`costedQuantity <= fulfilledQuantity` never briefly breaks.

`holdsDeductedStock` was renamed `mayHoldDeductedStock`. The hedge is the point:
a CONFIRMED order may now be holding everything, some of it, or nothing, and
only the ledger can say which.

### Concurrency

No second model. Order row `FOR UPDATE`, then product rows sorted by id, then
the lots underneath them — the same sequence `confirmOrder` and `cancelOrder`
already used, so nothing new can deadlock. The order lock serialises two
fulfilments of one order; the product lock serialises a fulfilment against a
concurrent confirmation.

**One existing guarantee genuinely inverted.** Two orders for 70 and 50 against
100 units used to end with one confirmed and one refused. Both now succeed: the
first takes 70, the second takes the remaining 30 and owes 20. The lock
guarantee is unchanged and is what the rewritten tests assert — the two ledger
rows chain, and together they remove exactly the 100 that existed. The same
inversion applies to `tests/stock-lots.test.ts`'s "cannot draw the same lot
units twice", which now asserts the stronger form directly: the lot hands out
exactly 10, never 12.

### Migration

One migration, `20260902120000_order_item_fulfilment`, additive only. Not one
existing constraint was dropped or relaxed.

The backfill reads the **ledger**, not the order status, and three pre-flight
guards abort the whole migration rather than let it invent data: every realised
line must match its net STOCK_OUT, no DRAFT or PENDING order may have moved
stock, and every CANCELLED order must net to zero. A terminal guard then checks
the result against the status. All four passed on dev with zero mismatches.

Two new CHECK constraints enforce
`0 <= costed_quantity <= fulfilled_quantity <= quantity`. The older
`order_items_costed_quantity_within_quantity` is now strictly weaker and is
deliberately left in place — historical migrations are not edited.

**No index.** Nothing filters or sorts on the column, and an outstanding-orders
screen would need an expression index on the difference rather than one on the
column itself. Added when such a screen exists and has been measured.

### Where it surfaces

Order builder (a short line is informational, not an error, and Save-and-confirm
is no longer disabled), order detail (Ordered / Fulfilled / Outstanding columns,
a Fulfil action, and cost read against fulfilled units), the orders table (an
outstanding indicator beside the status, shown only on CONFIRMED and COMPLETED —
a draft owes nothing and a cancelled order owes nothing), and the dashboard's
costing section.

Vocabulary is **Ordered / Fulfilled / Outstanding**. Not "low stock", "out of
stock", "short" or "reorder" — §16 removed threshold language at the owner's
direction and this did not bring it back. "Outstanding" describes an obligation
on an order, never a state of a product.

### What is still not modelled

**No link from a purchase to the order waiting on it.** `StockReferenceType` has
no ORDER↔PURCHASE pair, so "which delivery will clear this backlog" is a question
the data cannot answer. That is the natural next workstream, and it is additive.

**No outstanding-orders screen.** Outstanding quantity is visible on an order and
in the orders list, but there is no "what do we owe" view across the book.

**A business question left open.** If goods physically reach the customer while
this system says nothing shipped, then units left the building from a source it
does not track — a consignment shelf, a direct-ship supplier. The deficit model
records that faithfully as an obligation, but the more accurate long-run model
may be an inbound movement recording the untracked acquisition followed by an
ordinary fulfilment. Which is right determines whether outstanding quantities are
expected to clear in days or to sit open indefinitely.

---

## 19. The costing hardening pass, and the scope line drawn under it

A review of the FIFO and lot-costing layer against the business rule that
**there is no fixed product cost** (4 September 2026). The review's conclusion
was that the architecture is sound and should be kept: cost belongs to the
batch, unknown cost stays unknown, and an order may be confirmed against an
empty shelf and costed later at the price actually paid. §10 and §18 remain the
account of how that works, and none of it changed.

What the review turned up was six findings around the model rather than in it.
Where each of them stands:

| Finding | Status |
| --- | --- |
| Upward adjustments created `UNKNOWN`-cost lots | **Implemented** — below |
| Reversal netting in `returnToLots` | **Implemented** — below |
| No sales-return workflow | **Implemented** — `bc213eb` and `a8dc4f7`, §8 and §22 |
| Order-level discount absent from margin | **Resolved** — the discount feature was removed, §20 |
| Seed exercises one price per product | **Resolved** — §22 |
| `Product.standardCost` still present | **Resolved** — removed, §22 |
| No landed-cost model | **Deferred business decision** — §22 |

One of those rows has since been reopened and then closed by building it. Sales
returns were closed here as an external credit-note process; the business
decided on 5 September 2026 that returned parts physically come back and must be
tracked as inventory, and the workflow was built in `bc213eb` and `a8dc4f7`. See
§8 for what those commits contain and §22 for the design constraints they were
held to. Nothing else in this table is backlog.

### What was fixed

**Reversal netting (`returnToLots`).** The function decides how many units a
reversal puts back into each batch, and it did that by netting the consumption
rows written against the document's movements — but it was handed only the
*outbound* half of those movements. Negative rows written by a prior REVERSAL
hang off that reversal's own transaction id, so they were invisible to it, the
draw looked larger than it was, and the lots were over-restored.

Two shapes came out of that, and only one announced itself. Where the document
was a lot's sole consumer, the over-restore pushed `quantityRemaining` past
`quantityReceived` and the check constraint refused the write — loud, and
harmless. Where another document had since drawn from the same lot, the lot had
room to absorb the excess: nothing was refused, and `SUM(quantityRemaining)`
quietly stopped equalling `Product.stockQuantity`. **I-1 broken with no error
raised** is the failure this fix exists to remove.

Three changes, all in `src/server/stock.ts` and the one caller in
`src/server/orders.ts`:

* `cancelOrder` passes **every** ledger row for the order, not just the
  `STOCK_OUT`s. The parameter was renamed `sourceTransactionIds` →
  `documentTransactionIds` so that half of them cannot be passed by accident.
* The unit cost is read from `StockLot` rather than from whichever consumption
  row was encountered first. The values agree today, but "the first row we saw"
  is a property of query order.
* `Math.max(0, shortfall)` is gone. A negative shortfall means the lots were
  given back more than the ledger restored, and it now raises the same way
  `allocateFifo` raises when lots do not cover a movement. It used to be
  swallowed *after* the lots had already been incremented, which is precisely
  how the silent shape stayed silent.

**Read this next part before touching the tests.** No path writes a second
REVERSAL against one order — `cancelOrder` is the only writer and it runs once,
on a status that becomes terminal. The sales-return workflow does not change
that: a return writes a `STOCK_IN` under a `SALES_RETURN` reference, which
`cancelOrder`'s netting never gathers, and an order carrying a return cannot be
cancelled at all. **The defect therefore has no reachable trigger.** The fix is
kept because the netting is now correct by construction rather than correct by
accident, and because the shortfall guard converts a class of silent corruption
into a loud failure. `tests/stock-lot-reversal.test.ts` constructs the
second-reversal state by hand for that reason, and for no other; its
`simulateSecondReversal` helper is a test fixture, not a sketch of a feature.

**Acquisition cost on an upward adjustment.** An adjustment that adds stock
creates a batch, and a batch has an acquisition cost or honestly does not. This
was neither asked nor recorded: every increase produced an `UNKNOWN` lot, so a
cost the operator knew perfectly well was discarded by the shape of the form,
`LotCostSource.ADJUSTMENT` was an enum value nothing could produce, and uncosted
units accumulated in the FIFO queue — draining first, so they suppressed cost
coverage on the *next* sales rather than the last.

The fix is a **required answer, not a required number**. An increase must state
either a cost (→ `ADJUSTMENT` lot at that price) or that the cost is unknown
together with an explanation of why (→ `UNKNOWN` lot, no price). Neither is
pre-selected, and the form cannot be submitted without a choice.

Requiring a cost outright was considered and rejected. Units found in a corner
with no paperwork genuinely have no acquisition cost, and a mandatory field
there would guarantee an invented one — the single thing this costing model
exists to prevent. What changed is not what the system can record; it is that an
unknown cost became something the operator **said** rather than something the
form **assumed**. Both explanations are written to the ledger note, because why
the stock changed and why nobody can price it are different facts with different
consequences — the second explains every uncosted sale that batch will produce.

Nothing is defaulted from `Product.standardCost` here or anywhere else, and
existing `UNKNOWN` adjustment lots were left alone. Back-filling them would be
the fabrication this fixes.

### Returns: closed here, then built

This section closed returns on 4 September 2026 as an external credit-note
process. The owner reversed that the following day, and the workflow was built
in `bc213eb` and `a8dc4f7`. §8 is the current account; this note is kept only so
the reversal is legible from where the original decision was recorded.

Two of the three questions raised as blocking a return design were answered by
building it: a returned part does **not** re-enter sellable stock — it arrives
quarantined and waits for an inspection — and the order's revenue is unchanged,
since `fulfilledQuantity` is never reduced and `returnedQuantity` is a separate
counter. Whether a return is a credit or a replacement remains **settled
commercially elsewhere**; this system records the physical event and no money
moves on it.

**`returnToLots` is still not the returns feature.** It serves cancellation,
which is a different event: the sale did not happen, rather than happened and
was undone. The name is about the *lots* units go back to, not about a customer
return. The returns workflow creates new lots instead — see §8.

### Discounts in margin: resolved by removal

Briefly recorded here as out of scope, then superseded the same day. Rather than
keep the discount on the document and exclude it from margin, the feature was
removed outright (§20).

That resolves the finding rather than accepting it. The defect was that margin
valued costed units at line price while `Order.total` was net of a discount, so
the two disagreed; with no discount, line price *is* what the customer was
charged and the two are the same number. The "Gross margin" figure on the order
page became correct as a side effect of the removal, with no margin logic
changed at all.

### What remains

Two findings from the same review are still live work, and one is a question
rather than work. None has been started:

* **The seed uses `standardCost` as every purchase line's unit cost**, so the
  demo dataset has exactly one price per part — the world this costing model
  exists to reject. The *test* fixtures already exercise multiple prices, mixed
  FIFO draws and uncosted lots; the gap is `prisma/seed.ts` alone.
* **`Product.standardCost` is still present.** It feeds no money figure — only a
  purchase-line prefill and a catalogue column — but it is still there. §10's
  rules about it are unchanged and still binding.
* **No landed-cost model.** `StockLot.unitCost` is a 1:1 copy of the invoice
  line, so if freight, duty or certification are material then it is invoice
  cost rather than acquisition cost, and valuation is understated by that
  component. Whether that is true is a business question, not a code question.

### Where it surfaces

* `src/lib/validation/adjustment.ts` — the cost-basis choice, its conditional
  requirements, and the two helpers (`adjustmentNote`,
  `adjustmentUnitCostCents`) that keep `adjustStock` thin.
* `src/app/(app)/products/stock-adjustment-dialog.tsx` — the unselected-by-
  default choice, shown only for an increase and cleared when direction changes.
* `src/server/stock.ts` — `returnToLots`.
* `tests/stock-adjustment-cost.test.ts`, `tests/stock-lot-reversal.test.ts`.

No schema change, no migration, and no seed change was needed for any of it.

---

## 20. The discount, and why removing it simplified the reports

`Order.discount` is gone — column, constraint, form field, report column and
all — at the owner's direction (4 September 2026). The business does not
discount, and a field nobody uses is a field that eventually gets used by
accident.

The invariant is now, and the check constraint enforces it:

```text
total = subtotal
```

### It was never really about the column

The column drop was about twenty lines. The reason this was a real piece of work
is that **the discount was the sole reason two revenue bases existed**.

An order-level discount lives on the order, not on its lines, so
`SUM(orders.total)` and `SUM(order_items.total)` were genuinely different
numbers. Everything downstream had to cope with that:

* the sales report carried **both** figures plus the gap between them;
* it could not report revenue per product or per category **at all** — splitting
  an order-level figure across lines needs an allocation rule nobody agreed —
  so those groupings returned null;
* the SQL joined a `line_counts` subquery and divided each order's total by its
  line count, so an order spanning several lines contributed its total once per
  group rather than once per line;
* the CSV export carried two explanatory footnotes;
* the dashboard's Costing section worked at list price while its Sales section
  reported realised revenue, and a standing paragraph on the page existed purely
  to tell the reader why two figures that both look like revenue disagreed.

All of that was correct, and all of it described a difference that can no longer
occur. `orders.total = orders.subtotal = SUM(order_items.total)` is now a check
constraint, so summing the lines *is* summing the order.

### What that bought

**Revenue is reportable at every grouping**, product and category included. That
is a capability the report did not previously have, gained by deletion rather
than by writing an apportionment rule.

**The `line_counts` join and its division are gone.** They existed only to avoid
double-counting an order-level figure. `SUM(order_items.total)` is already
per-line and groups by anything safely.

**The order page's "Gross margin" became correct.** It valued costed units at
line price while `Order.total` was net of the discount, so on a discounted order
it read high. No margin logic changed; the discrepancy simply stopped existing.
This is the finding recorded in §19 as G4, and it was resolved by removal rather
than by the apportionment that had been designed for it.

**The explanatory copy went with the thing it explained.** The dashboard
paragraph reconciling two bases was deleted rather than reworded — an
explanation of a difference that cannot occur is worse than no explanation.

### What was renamed

`allSalesAtListPrice` → `allRevenue`, and `costedSalesAtListPrice` →
`costedRevenue`. Their values did not change. "At list price" was meaningful
only in contrast to a discounted total, and a qualifier that no longer
distinguishes anything is a qualifier that misleads.

### The migration, and the honest part

`20260904120000_remove_order_discount` follows the tax removal exactly — drop
the constraints, restate the totals, drop the column, rebuild the constraints,
every statement re-runnable because Prisma applies a migration file statement by
statement rather than in one transaction.

**Statement 2 restates historical totals, and that is destructive.** For an
order that carried a discount, `total` recorded what the customer was charged;
afterwards it records the sum of the line prices, which is larger. Revenue over
any period containing such an order rises accordingly.

There is no way around it. `total = subtotal − discount` and `total = subtotal`
cannot both hold for a discounted order. The alternative — rewriting
`order_items.unit_price` to absorb the discount — would falsify what each line
sold for, which the schema explicitly forbids, and rounding would not land
exactly.

So the migration carries a gate rather than a silent `UPDATE`: run the query in
its header first, and if any order has a non-zero discount, **stop**, export
those rows, and record what was restated. If the query returns nothing, the
migration is completely lossless.

### Two columns holding one number, on purpose

`total` and `subtotal` are now always equal, which is the duplication this
codebase otherwise argues against — see the note on `OrderItem.fulfilledQuantity`
about two stored numbers that must agree eventually disagreeing.

Kept anyway, deliberately. `total` is what every list, report, dashboard and
export reads; collapsing the pair would touch far more code than it would
simplify, for no behavioural gain. `CHECK (total = subtotal)` is what makes the
redundancy safe — the database arbitrates the agreement rather than trusting
whatever writes an order.

### How the removal is proved

`tests/order-totals.test.ts` was the "prove tax is really gone" suite and is now
the proof for both terms. It checks the four places a removed money term can
survive:

* the **schema** — no `discount` column on `orders`, and none anywhere in the
  database under any table;
* the **constraints** — no surviving check names `discount`, and
  `orders_total_balances` is exactly `CHECK (total = subtotal)`;
* the **generated client** — the field is absent at runtime, catching a client
  generated from a stale schema;
* the **source** — a scan for identifier shapes (`discount:`, `.discount`,
  `discountCents`) rather than the bare word, so prose about the removal does
  not trip it.

**The source scan covers `tests/` as well as `src/`, and that is load-bearing.**
`orderSchema` is a plain `z.object`, so Zod *strips* an unknown `discount`
rather than rejecting it — deliberately, so a stale browser posting the old
field after deployment is ignored instead of erroring. The cost of that
leniency is that a caller still sending `discount` fails silently and for ever.
Nothing else would catch it. The scan found one such fixture during the removal
that a regex sweep had missed.

The file excludes itself from its own scan, because it is where the patterns are
written down and therefore necessarily contains every shape they match.

### What must not come back

No discount field on any schema. No discount input on an order or purchase form.
No discount arithmetic in costing or valuation. No discount-based margin logic.
No discount column on a report or export. If a commercial need for one ever
arises, it is a new feature with a new decision behind it — not a restoration.

---

## 21. A product does not have one selling price either

The mirror of §10, on the other side of the ledger. The same part is quoted at
₹12,000 to one customer, ₹13,500 to another and ₹11,800 to a third, so no single
column on the catalogue row can say what it sells for — exactly as no single
column could say what it cost.

```text
Product.sellingPrice   optional reference — prefills a line, never history
OrderItem.unitPrice    what this customer was quoted, frozen on the order
StockLot.unitCost      what the batch actually cost — untouched by any of this
```

### What was already right

Almost all of it, which is why this was a small change. `OrderItem.unitPrice`
already existed, already stored the price per line, and **every revenue figure
already read it** — directly, or through `order_items.total` and `orders.total`,
which the check constraints tie together. Margin already took it as a parameter.
Customer lifetime value already derived from it. No report anywhere used
`Product.sellingPrice` as historical revenue.

Confirmation, completion and cancellation never touched the price and still do
not. A confirmed order was already immutable, because `isEditable` permits edits
in no status but DRAFT and PENDING.

### The defect

`updateOrder` deleted every line and recreated it at the **current** catalogue
price. Quote ₹12,500, let the reference move to ₹16,000, edit the quantity — and
the quote silently became ₹16,000 while the order was still a draft and nothing
on the screen said so.

Three things reinforced it and all three are gone: the edit page seeded the
builder from current product prices (with a comment explaining why), the
`OrderProductOption.sellingPrice` docstring justified that on the grounds that
`updateOrder` recalculated from it, and a test asserted the whole arrangement.

The fix: the quote travels with the request, and the edit page seeds each line
from its **stored** price. Preservation is then structural — an untouched line
round-trips unchanged, and a deliberate re-quote arrives as a different number.

Lines are still replaced wholesale rather than diffed, which is safe precisely
because the price arrives with each one. The alternative — the server deciding
which changes were "intentional" — cannot distinguish a re-quote from a stale
client, so it would either block legitimate re-pricing or guess.

### The trust boundary inverted, and what replaced it

This is the part worth reading twice. The architecture used to treat a
client-supplied price as an attack, and said so in three places: the line schema
did not accept one, the module docstring read *"a total the browser calculated is
a total the browser chose"*, and the server comment read *"so the client cannot
name its own price."*

Per-customer quoting requires the opposite. The quote exists nowhere but the
submission, so it has to be an input. The protection did not disappear — it moved:

* **Bounds instead of derivation.** Non-negative, at most two decimal places,
  within the `Decimal(12, 2)` ceiling. The floor mirrors
  `order_items_unit_price_non_negative`; the ceiling turns a typo into a field
  error rather than a numeric-overflow. **No minimum or maximum sale price is
  imposed** — there is no business rule for one, and inventing a threshold would
  refuse legitimate quotes.
* **Attribution, unchanged.** `Order.createdBy` is resolved from the session and
  is not an input, so every quote is traceable to a person. There is no approval
  workflow and none was asked for.
* **Visibility.** The builder shows the reference price beside the quote and the
  deviation beneath it, so quoting away from the catalogue is a seen choice
  rather than something only the saved order would reveal.

Derived money is still server money. A line total, subtotal or grand total sent
from the browser is ignored and recomputed — a client that sends a believable
price and an invented total gets the price and none of the total.

Zero is a valid quote, deliberately. A free-of-charge line is a real commercial
decision; a blank field is not, which is why the blank is refused and the zero
is not.

### The reference price's three remaining jobs

It prefills a new order line, it values the valuation report's retail column,
and it drives the indicative margin panel on the product page. All three now
handle a null, because a part that is only ever quoted has no list price.

**Retail valuation changed basis.** It used to be defended on the grounds that
the selling price *"genuinely is authoritative in a way the old catalogue cost
never was"* — a claim per-customer quoting withdraws. The column now discloses
its own coverage the way the cost column always has: `valueAtRetail` for the
products that have a reference, `unpricedUnits` for the stock that does not.
Neither is valued at zero and neither is guessed.

### Migration

One statement, and it cannot lose data:

```sql
ALTER TABLE "products" ALTER COLUMN "selling_price" DROP NOT NULL;
```

A widening change — every existing row keeps its value, nothing is rewritten, no
total is restated, and **no backfill was needed anywhere**, because every
existing `OrderItem` already carried its historical price. That is the finding
this whole section rests on.

Optional for the same reason `standardCost` became optional on this table, and
the note there makes the argument: requiring a figure means every form has to
produce one whether anyone knows it or not.

### What must not come back

No code path may read `Product.sellingPrice` to compute historical revenue,
margin, or customer value. It prefills and it indicates; it never settles what
something sold for. If a figure has to be right, it comes from
`OrderItem.unitPrice`.

---

## 22. Removing the product cost, and the decisions taken around it

The last column claiming a product has one cost is gone (5 September 2026).
`Product.costPrice` became `Product.standardCost` became nothing at all.

This section is the record of a business review, not only of a code change. Most
of what was decided was decided **not** to be built, and those decisions are
written down here because an undocumented deferral comes back as a surprise.

### Why the column went rather than got fixed

The business buys the same part at ₹8,000, then ₹9,500, then ₹11,000. A single
figure on the catalogue row cannot describe a shelf of mixed deliveries, so
whichever price it held was wrong about the other two — while reading, to every
consumer downstream, exactly like a real cost. Being plausibly wrong is what
made it worth removing rather than documenting.

Nothing was valued from it. §10 is still the account of how costing works, and
none of it changed: cost belongs to the batch, unknown cost stays unknown, and
`StockLotConsumption` freezes what a sale actually drew. The removal moved no
money, which is what made it safe to do in one step — see the verification
below.

**FIFO was not redesigned, and specific-lot selection was not added.** The
existing model already gives the property the business cares about: the actual
lot and its actual acquisition price stay traceable through
`StockLotConsumption`. An explicit lot-selection feature can be added later if
the warehouse workflow turns out to need one; it is not needed for costing to be
correct.

### What replaced the two things the column was used for

**The purchase-line prefill.** Kept, because it was genuinely useful, but it is
now a *read* rather than a stored figure: `lastPaidByProduct` in
src/server/purchases.ts takes the most recent `PURCHASE` lot per product and the
line renders **"Last paid ₹X on \[date]"**. The date is load-bearing — it says
this is one past invoice rather than a standing price. A part never received
shows nothing and the box starts blank, because a prefill nobody can source is
worse than an empty one.

It is computed at query time and stored nowhere. That is the whole point: a
`lastPurchaseCost` or `averageCost` column would be the removed mistake under a
better name, drifting from the lots on the next delivery. **Do not add one.**

Only `PURCHASE` lots count. `OPENING` and `ADJUSTMENT` costs are operator
assertions about units that arrived without a supplier invoice behind them —
real costs for valuation, and wrong answers to "what did we last pay".

**Catalogue browsing by cost.** Removed outright, and deliberately not replaced
by last-paid or average cost. Ranking a catalogue by cost only means something
when a product has one; ordering it on an arbitrary batch, or on an average
nobody paid, would be a worse answer wearing the same column heading. Actual
inventory value is the valuation report's question, which answers it per lot and
discloses its own coverage.

### The opening-stock hole, closed

`standardCost` was never the only way an uncosted lot appeared. Creating a
product with an opening balance offered one optional cost box, and leaving it
blank produced an `UNKNOWN` lot silently. So the uncosted opening units in this
system did not come from anyone deciding a cost was unrecoverable — they came
from a form that never asked.

Opening stock now mirrors the adjustment cost basis already shipped (§19):

```text
Opening stock
├── KNOWN   → operator enters the actual opening unit cost
└── UNKNOWN → operator enters a reason, written into the ledger note
```

No default, both answers real, and **no invented cost**. UNKNOWN remains fully
available, because stock predating the paperwork genuinely has no provable cost
and demanding a number would guarantee a fabricated one. What changed is that
unknown became something an operator *said* rather than something a form
*assumed*. A product opening at zero stock is asked nothing — no units, no
batch, nothing to cost.

### Deferred, and why

**Landed costs — deferred, not rejected.** Freight, duty, inspection and
certification are not allocated into inventory cost, and nothing is to be built
toward them until the business confirms three things: that these costs exist
separately, that they are material, and that they need to be inside inventory
valuation rather than treated as period expense. The schema currently holds no
evidence any of them are tracked separately, which is why the question is open
rather than answered.

**Sales returns — a real inventory workflow, now built.** §19 closed this as an
external credit-note process; that was reversed. Physical aviation parts come
back, and they are inventory when they do. It was deliberately not built in
*this* pass, because a return is not an order cancellation and giving it the
cancellation's shape would be the expensive mistake. A cancellation undoes a
movement that should not have happened; a return is a *new physical event* for
units that genuinely left and have genuinely come back, possibly damaged,
possibly uncertified, possibly months later.

It was built afterwards, in `bc213eb` and `a8dc4f7`; §8 is the account of what
those commits contain. The constraints below were written before any of it
existed and were followed, with one deliberate departure noted at the end. They
are recorded here as the reasoning behind the implementation, not as outstanding
design work:

- a **new `RETURN` lot**, with `sourceType = ORDER` and `sourceId` the original
  order — never a write back into the lot the units originally left;
- cost **inherited from the actual `StockLotConsumption` rows** that shipped the
  returned units, so a return cannot invent a cost any more than a receipt can;
- returned inventory **separately identifiable**, and certificate coverage
  **separately decided** — a certificate that covered the original shipment is
  not automatically valid for what came back;
- **quarantine first.** Returned parts do not silently rejoin saleable stock:

```text
Customer return → Quarantine / returned lot → Inspection → Released to saleable
```

- **`receivedAt` is the return date, not the original receipt date.** This one is
  worth stating plainly because it is the decision most likely to be quietly
  reversed by someone "restoring" the original dating. A returned unit enters
  inventory as a new physical event and is therefore the *newest* lot for FIFO,
  not a resurrection of an old one. If the business ever wants an exception, it
  has to be an explicit rule with its own reasoning — not a default inherited
  from how cancellation happens to work.

**The one departure.** The outline above says the return lot should carry
`sourceType = ORDER` with the original order as `sourceId`. The implementation
uses a distinct `SALES_RETURN` reference type instead, because `cancelOrder`
gathers a document's movements with `referenceType = 'ORDER' AND referenceId =
orderId` and nets them to decide what to restore. A return carrying that
reference would be swept into that netting and mis-restore the lots. Separating
the reference makes the two documents' movements disjoint by construction rather
than by remembering. The order line is still recorded on the lot — as
`orderItemId`, which is what carries the provenance the outline was asking for.

### Migration

Irreversible, and one table:

```sql
ALTER TABLE "products" DROP CONSTRAINT "products_standard_cost_non_negative";
ALTER TABLE "products" DROP COLUMN "standard_cost";
```

The constraint is dropped explicitly although Postgres would drop it with the
column, because it was added by hand in an earlier migration and Prisma does not
know it exists — a reader diffing the schema would have no reason to believe it
went too.

**No backfill, deliberately.** Twelve products carried a value here. They were
planning figures somebody typed, not prices anybody paid, and writing them into
`stock_lots.unit_cost` would have converted an estimate into a recorded
acquisition cost indistinguishable from a real one — the exact confusion the
costing layer exists to prevent. They were exported to a backup **outside this
repository** and then discarded. The export is not committed and is not a
fallback: it is a paper record of what was thrown away.

### Verification

The dev database was measured before and after. **Every field was identical** —
valuation ₹18,104.96, 634 costed units, 375 uncosted, realised revenue
₹23,283.93, received spend ₹26,449.50, all 29 historical `OrderItem.unitPrice`
values unchanged, and I-1, I-3, the fulfilment invariant, negative-stock checks
and cost reconciliation all clean on both sides. The code change moved no money,
which is the claim this section rests on.

### The fixture now shows the business it describes

The seed's purchase lines carry their own unit cost, because a cost is a fact
about a delivery. `KB-MECH-87` is bought three times at three prices — 42.50,
then 46.00, then 39.80 — so a development database always contains the case the
costing layer exists for: one product, three lots, three acquisition costs, and
a FIFO sale costed against the units it actually consumed. A fixture where every
product had exactly one price could not tell a working implementation from a
broken one.

### What must not come back

No column, field, or cached figure on `Product` that claims to be what the stock
cost — under any name, including `standardCost`, `lastPurchaseCost` and
`averageCost`. tests/product-cost-removal.test.ts asserts their absence from the
table, the row, the API and the sort whitelist, precisely because a removed
concept returns as a convenience rather than as a decision.
