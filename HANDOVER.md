# Handover — Inventory Manager

An aviation-parts inventory system: products with airworthiness paperwork,
customer orders that deduct stock, and supplier purchases that add it, all
explained by a single append-only ledger.

Written for whoever picks this up next — a new developer, or a new session. It
covers what exists, the rules the code is built around, and the things that will
waste your afternoon if nobody tells you.

**Last updated:** 1 September 2026, after removing threshold-based stock
classification from the product entirely (§16), on top of the dead-code audit
and cleanup pass (§15), the Tier 1 Reports module (§13) and the Dashboard
rebuild (§12).

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
| Customers | Done | `/customers`, `/customers/[id]` |
| Suppliers | Done | `/suppliers`, `/suppliers/[id]` |
| Reports | Tier 1 done | `/reports`, `/reports/[report]` |
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
**Latest commit:** `403f811` — with the threshold-removal change set (§16)
uncommitted in the working tree on top of it.

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

**No tax, anywhere.** An order's grand total is `subtotal - discount`. The `tax`
column was dropped rather than left at zero, and a check constraint refuses a
total that implies one. A purchase total is the sum of its line totals.

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

**Reports beyond Tier 1.** Three are built (§13). Five more are designed and
deliberately not built: profitability and cost coverage, stock movement summary,
inventory ageing by lot, supplier provenance, and a certificate compliance
register. The last is the one worth doing next — an exportable airworthiness
register is not something generic ERP ships, and the data already supports it.

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

**Other gaps.** No user management UI. No Clerk webhook, so a name or email
changed in Clerk leaves a stale local mirror and a deletion is invisible
(`src/server/auth.ts` explains the trade-off). No partial receipts on purchases,
no returns workflow — `COMPLETED → CANCELLED` on an order is deliberately
refused because the goods have shipped.

---

## 9. Next development steps

The most logical next steps for the application:

1. **Reports Tier 2** — five are designed and unbuilt; see §13. Profitability is
   the obvious next one and carries the sharpest trap: it cannot report a margin
   until cost coverage is non-zero, and today it is zero. Use the helpers in
   `src/lib/cost-coverage.ts` and the dashboard's rules rather than subtracting
   by hand.
2. **Certificate compliance register** — Tier 2's most valuable report for this
   business, and the one no generic ERP ships. The data already supports it.
3. **Certificates on lots** — the change §10 was designed to make additive, and
   deferred twice now. Worth settling the business workflow first: whether the
   release authority is the supplier, the lot, or both. Deciding it alongside
   the register above would avoid two migrations over the same table.
4. **Historical as-of valuation** — reconstructible, but needs explicit handling
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

No link between certificates and suppliers. `Certificate` still points only at a
product. The release authority for an airworthiness document is often the
supplier, and that question interacts with the `Certificate.stockLotId` change
§10 was designed to make additive — both are deferred until the certificate
workflow is defined, and should be decided together.

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

### Two revenue bases

The Sales section reports **realised revenue** — `SUM(orders.total)`, after
order-level discounts. The Costing section works at **list price** —
`SUM(order_items.total)`, before them — because an order-level discount applies
to a whole order and apportioning it across individual FIFO-costed units would
mean inventing an allocation rule.

They differ by the discounts and a standing note on the page reconciles them.
The word "revenue" appears in one section only; the costing figures are named
for their basis in the code as well (`allSalesAtListPrice`,
`costedSalesAtListPrice`).

### Certificates on the dashboard

Expired, expiring within thirty days, and missing — over **ACTIVE products
only**, since a discontinued part is not being sold. A certificate with **no
expiry date is valid**; a Certificate of Conformity typically never expires and
flagging null expiries would alarm about a large share of legitimate documents.
Superseded certificates are ignored.

The products list has no certificate filter, so the affected products travel
with the counts rather than linking to a view that cannot filter.

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

Three reports are built. `/reports` is the index; `/reports/[report]` renders
one; `/api/reports/[report]/csv` exports it.

| Report | What it answers | Date basis |
| --- | --- | --- |
| **Stock valuation** | What is on the shelf and what it cost | current state |
| **Sales** | What sold, to whom, for how much | `orders.confirmed_at` |
| **Purchase spend** | What was bought and from whom | `purchases.received_at` |

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

### Dates, discounts and grouping

Grouping sales by product or category returns **null** for realised revenue
rather than an apportioned figure — an order-level discount is not split across
lines. Period and customer groupings can report it, because an order belongs to
each of those whole.

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

**The certificate compliance register is deferred**, along with the other four
Tier 2 reports. Certificates are unchanged, and `Certificate.stockLotId` was not
introduced.

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
