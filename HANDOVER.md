# Handover — Inventory Manager

An aviation-parts inventory system: products with airworthiness paperwork,
customer orders that deduct stock, and supplier purchases that add it, all
explained by a single append-only ledger.

Written for whoever picks this up next — a new developer, or a new session. It
covers what exists, the rules the code is built around, and the things that will
waste your afternoon if nobody tells you.

**Last updated:** 26 August 2026, after adding the Stock Movements test suite.

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
| Suppliers | **Placeholder** | `/suppliers` |
| Customers | **Placeholder** | `/customers` |
| Reports | **Placeholder** | `/reports` |
| Settings | Partial | `/settings` reports database and auth health |

### Commit history

```
eeb1e8e        feat: add stock movements ledger page
79555db        feat: add purchases with automatic stock receipt
e0b9655        feat: add order editing
1eaaa61        feat: add orders with automatic stock deduction
bfa5eef        feat: add product certificates and remove tax
bc643e3        feat: add products and inventory management
8a00813        Replace removed Clerk control components with Show
ffb2ce6        Make Clerk the sole authentication provider
230a251        Build the inventory domain model
03536e4        Scaffold inventory manager foundation
```

**Current branch:** `db/inventory-domain-model`
**Latest commit:** `eeb1e8e` — plus one commit adding the stock movements tests
and this update, which is the tip once it lands.

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

**Derived values are never stored.** Stock status (in stock / low / out) and
certificate status (valid / expiring / expired / missing) are computed from the
data they describe. Certificate status especially: it changes on its own as
dates pass, so a stored column would be wrong every morning.

**The server decides who did something.** `createdBy` is never a parameter, in
any module. It is read from the Clerk session, resolved through `clerkId` to a
local user id. A field the browser can set is a field the browser can lie about.

**The server computes money.** Order and purchase totals are calculated
server-side in integer cents from prices read in the transaction. Clients send
quantities and ids, never totals. One exception, deliberate: a purchase's
**unit cost** does come from the client, because it is the supplier's number,
not ours — but the line totals and grand total derived from it do not.

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

---

## 3. Layout

```
prisma/
  schema.prisma          The domain model, heavily commented
  migrations/            8 migrations; several carry hand-written SQL
  seed.ts                A small, self-consistent warehouse
src/
  app/
    (app)/               Authenticated pages — the auth boundary is its layout
      products/  orders/  purchases/  stock-movements/   Built modules
      dashboard/ settings/                               Built
      suppliers/ customers/ reports/                     Placeholders
    api/certificates/[id]/file/          Authenticated certificate download
  components/
    layout/              Shell: sidebar, header, mobile drawer, user menu
    ui/                  Button, Card, Table, Dialog, badges, Pagination…
  lib/
    env.ts               Validated environment, read once at import
    errors.ts            AppError + toSafeError (nothing leaks to the browser)
    *-status.ts          Derived status rules: stock, certificate, order, purchase
    *-query.ts           List URL state: product, order, purchase, stock-movement
    validation/          Zod schemas shared by forms and server actions
  server/
    auth.ts              Clerk session → local user, role checks
    stock.ts             The only way stock changes
    stock-movements.ts   Read model over StockTransaction ledger
    products.ts  orders.ts  purchases.ts  certificates.ts  dashboard.ts
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

**297 tests across 9 files**, all against a **real PostgreSQL** database. Clerk
is the only thing mocked.

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

---

## 8. What is not built

**`/suppliers`, `/customers`, `/reports` are placeholders.**
- **Suppliers (`/suppliers`):** Supplier information and purchase history are
  shown on the purchase detail page, and suppliers can be chosen on products.
  A standalone supplier CRUD list/detail module is still placeholder.
- **Customers (`/customers`):** Customer information and order history are
  shown on the order detail page, and customers can be chosen on orders.
  A standalone customer CRUD list/detail module is still placeholder.
- **Reports (`/reports`):** Valuation, movement, low-stock/dead-stock, and
  supplier spend summaries across date ranges with CSV export.

**Other gaps.** No user management UI. No Clerk webhook, so a name or email
changed in Clerk leaves a stale local mirror and a deletion is invisible
(`src/server/auth.ts` explains the trade-off). No partial receipts on purchases,
no returns workflow — `COMPLETED → CANCELLED` on an order is deliberately
refused because the goods have shipped.

---

## 9. Next development steps

The most logical next steps for the application:

1. **Suppliers module (`/suppliers`)**:
   - Follow the `products`/`orders` pattern: `src/lib/supplier-query.ts`,
     `src/server/suppliers.ts`, server actions for CRUD, list table with
     contact details, and supplier detail page linking to products and purchases.
2. **Customers module (`/customers`)**:
   - Same pattern: `src/lib/customer-query.ts`, `src/server/customers.ts`,
     server actions for CRUD, list table, and customer detail page linking to
     lifetime orders.
3. **Reports module (`/reports`)**:
   - Aggregates over `Product`, `StockTransaction`, `Order`, and `Purchase`
     with date range filtering and CSV export.
