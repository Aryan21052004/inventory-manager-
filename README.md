# Inventory Manager

Stock control for products, orders, purchases and suppliers, built as a
production-shaped Next.js application.

> **Status: products and inventory.** The foundation, Clerk authentication, and
> the products + inventory module are built. Orders, purchases, customers,
> suppliers and reports are still scaffolded pages — see
> [What is not built yet](#what-is-not-built-yet).

## Stack

| Concern        | Choice                                            |
| -------------- | ------------------------------------------------- |
| Framework      | Next.js 16 (App Router, React 19, Turbopack)      |
| Language       | TypeScript, `strict` mode                          |
| Styling        | Tailwind CSS v4, CSS-variable design tokens        |
| Components     | Radix UI primitives, shadcn-style wrappers         |
| Database       | PostgreSQL                                         |
| ORM            | Prisma 7 with the `@prisma/adapter-pg` driver      |
| Authentication | Clerk                                              |
| Toasts         | Sonner                                             |
| Icons          | Lucide                                             |

## Getting started

### 1. Install dependencies

```bash
npm install
```

### 2. Configure the environment

```bash
cp .env.example .env.local
```

Then edit `.env.local`:

- **`DATABASE_URL`** — required. Point it at a PostgreSQL database.
- **`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`** and **`CLERK_SECRET_KEY`** — optional
  in development, required in production. Get them from
  [dashboard.clerk.com](https://dashboard.clerk.com).

`.env.local` is read by both Next.js and the Prisma CLI (see
`prisma.config.ts`), so there is only one file to keep in sync.

### 3. Create the database schema

```bash
npm run db:migrate
```

The migrations are already committed under `prisma/migrations`, so this applies
them and generates the typed client.

### 3a. Load the sample data (optional)

```bash
npm run db:seed
```

Prisma 7 does not run this as part of `db:reset`, so run it yourself after a
reset. It fills the database with a small, self-consistent warehouse: 2 users, 5
suppliers, 10 products, 5 customers, 6 purchase orders, 7 sales orders, and the
26 stock transactions that explain every unit on hand. Two products are left
below their minimum stock so the low-stock views have something to show. The
seed clears the tables first, so it is safe to re-run.

### 4. Run it

```bash
npm run dev
```

The app is at [http://localhost:3000](http://localhost:3000), which redirects to
`/dashboard`.

### Setup mode

Without Clerk keys the app runs in **setup mode**: authentication is disabled,
every route is publicly reachable, and a banner says so on every page. This
exists so the UI can be reviewed before an account exists.

It is a development-only convenience. Starting the server with
`NODE_ENV=production` and no Clerk keys throws on boot rather than serving an
unauthenticated app — see `src/lib/env.ts`.

The **Settings** page reports live status for the database and authentication,
and lists whatever setup steps are still outstanding.

## Scripts

| Script                | Does                                              |
| --------------------- | ------------------------------------------------- |
| `npm run dev`         | Development server                                 |
| `npm run build`       | Generate the Prisma client, then build             |
| `npm start`           | Serve the production build                         |
| `npm run lint`        | ESLint                                             |
| `npm run typecheck`   | `tsc --noEmit`                                     |
| `npm run db:migrate`  | Create and apply a migration (development)         |
| `npm run db:deploy`   | Apply pending migrations (production)              |
| `npm run db:push`     | Push the schema without a migration (prototyping)  |
| `npm run db:studio`   | Prisma Studio                                      |
| `npm run db:seed`     | Load the sample data (clears the tables first)     |
| `npm run db:reset`    | Drop and re-migrate; seed separately after it      |
| `npm run db:generate` | Regenerate the Prisma client                       |
| `npm test`            | Vitest, against a `..._test` database              |
| `npm run test:watch`  | Vitest in watch mode                               |

## Project structure

```
prisma/
  schema.prisma          Database schema
  migrations/            Migration history
  seed.ts                Sample data
src/
  app/
    (app)/               Authenticated pages, wrapped in the dashboard shell
      dashboard/         Live stock snapshot
      products/          List, detail, create/edit, stock adjustment
        actions.ts       Server actions (thin — logic lives in src/server)
        [id]/            Product detail, movement history, orders, purchases
      orders/  purchases/  customers/  suppliers/
      stock-movements/  reports/  settings/
      layout.tsx         Dashboard chrome + the authorisation boundary
      loading.tsx        Route-level skeleton
      error.tsx          Route-level error boundary
    (auth)/              sign-in and sign-up, no chrome
    layout.tsx           Fonts, providers, conditional ClerkProvider
    global-error.tsx     Last-resort boundary
    not-found.tsx
  components/
    layout/              Shell: sidebar, header, mobile drawer, user menu
    ui/                  Button, Card, Table, Dialog, Select, Badge,
                         Skeleton, EmptyState, ErrorState, StatCard,
                         Pagination, StockStatusBadge, Toaster…
  lib/
    env.ts               Validated environment configuration
    prisma.ts            Prisma singleton + connection health check
    errors.ts            AppError types and safe error normalisation
    format.ts            Locale-pinned currency, number and date formatters
    nav.ts               Single source of truth for navigation
    product-query.ts     The products list's URL state, parsed and serialised
    stock-status.ts      The derived in-stock / low / out rule, in one place
    validation/          Zod schemas shared by forms and server actions
  server/
    auth.ts              Clerk session to local user, and role checks
    dashboard.ts         Server-side read models
    products.ts          Catalogue reads and writes; no next/* imports
    stock.ts             The only way stock is allowed to change
tests/                   Integration tests (real Postgres, mocked Clerk)
  proxy.ts               Clerk auth context (Next 16 `proxy` convention)
```

## Design notes

A few decisions worth knowing before extending this.

**Stock is a ledger, not a number.** `Product.stockQuantity` is the single source
of truth for stock on hand, and every write to it must be paired with a
`StockTransaction` row in the same transaction. Each transaction records the size
of the move, its direction, and both the previous and resulting balance, so any
quantity can be explained by replaying its history. The ledger is append-only: a
mistake is corrected with a `REVERSAL` row pointing at the transaction it undoes,
never by editing or deleting one.

**Derived values are never stored.** Stock status (in stock / low / out) is
computed from `stockQuantity` against `minimumStock` rather than persisted, so it
cannot drift from the numbers it describes.

**The database refuses invalid rows, not just invalid relationships.** Alongside
the foreign keys, the migration adds check constraints: money is never negative,
a line always moves at least one unit, `total = subtotal - discount + tax` on
every order, a line total always equals quantity times price, and a stock
transaction's `previousStock`, `quantity` and `newStock` have to add up. Prisma's
schema language cannot express these, so they live in the migration SQL.

**Authorisation follows the route tree.** Access is checked with
`auth.protect()` in the `(app)` layout rather than by path matching in the
proxy. A page added under that group is protected because of where it lives, and
the sign-in pages are public because they live outside it. This also matches
Clerk's current guidance, which deprecates matcher-based protection.

**Clerk authenticates; the database authorises.** Clerk owns the credential —
password, MFA, sessions — and this app never sees or stores one. The `users`
table owns the local business identity: the `role` that decides what someone may
do here, and a row for foreign keys such as `stock_transactions.created_by` to
point at.

`clerkId` is the join between the two, and the only acceptable one. Email is
unique in our table and looks like it would work, but Clerk lets people change
their address; the next request would then look like a different person and
quietly create a second record. `clerkId` never changes.

Users are synced lazily by `resolveUser` in `src/server/auth.ts`: the first
authenticated request from an unknown Clerk account creates a local row (as
STAFF — signing up is not a route to ADMIN), and the unique index on `clerk_id`
makes concurrent first requests harmless, since the loser reads back the
winner's row. Rows that predate Clerk — the seeded accounts — carry an
`unlinked_` placeholder, and the first sign-in with a matching email claims the
row, which is how the seeded admin keeps its ADMIN role.

A Clerk webhook on `user.updated` / `user.deleted` is the production upgrade.
Lazy sync refreshes the local mirror only when a row is created or claimed, so
a later name or email change in Clerk leaves a stale value here, and a deletion
in Clerk is invisible — the user simply stops arriving, leaving a local row that
looks active forever. Identity itself is unaffected either way, because lookups
go through `clerkId`. Worth adding once there are real users; not worth the
endpoint, signature verification and replay handling while nothing depends on
the mirror being fresh.

**The server decides who did something, never the client.** `createdBy` is not
an input to `recordStockMovement` — it is read from the session. A field the
browser can set is a field the browser can lie about, and an audit log that
records whoever the request claimed to be is not an audit log. Role checks live
in `requireRole` for the same reason: hiding a button is a courtesy, not a
control, so every privileged path re-checks on the server against the role in
our database. Manual corrections (`ADJUSTMENT`, `REVERSAL`) are ADMIN-only,
because they change what the system believes with no document behind them.

**Errors are normalised before display.** `toSafeError` in `src/lib/errors.ts`
passes through messages we wrote and replaces everything else with a generic
line, logging the original server-side. A Prisma error naming a column never
reaches the browser.

**Money is `Decimal`.** Prices, costs and totals are `DECIMAL(12,2)` in Postgres
and are formatted from their string representation, so nothing rounds through a
float.

## Products and inventory

The catalogue and the stock engine behind it, built on the rules above.

**Every figure is queried, none are hardcoded.** The list filters, sorts and
pages in Postgres against the query string, so the browser receives one page of
rows rather than the catalogue plus the code to sift it. The state lives in the
URL, which makes a filtered view something you can bookmark or send someone.

**Stock status is derived, in one place and two languages.** `stockStatus()` in
`src/lib/stock-status.ts` is the rule; `stockStatusWhere()` in
`src/server/products.ts` is the same rule as a SQL filter, because a page of
products has to be narrowed in the database rather than after loading all of
them. They cannot share an implementation, so a test asserts they agree rather
than assuming it.

**Editing a product cannot change its stock.** `updateProductSchema` has no
`stockQuantity` field, so there is nothing for a tampered request to land on.
Stock moves only through the engine: a new product's opening balance is written
as a `STOCK_IN` in the same transaction that creates it, and a correction after
that is an ADMIN-only `ADJUSTMENT` with a mandatory reason.

**An adjustment is a count and a direction, never a signed number.** That is how
the operation is described out loud — "twenty fewer than the system thinks" —
and the sign is derived once on the way to the ledger. The server authenticates
the Clerk session, resolves the local user through `clerkId`, checks the ADMIN
role against our database, locks the product row `FOR UPDATE`, refuses a result
below zero, then writes the new quantity and the `ADJUSTMENT` row together. The
row lock is what makes simultaneous adjustments safe; without it two requests
read the same balance and the second overwrites the first.

**Server actions are thin.** `src/app/(app)/products/actions.ts` turns a
`FormData` into an object, revalidates, and converts a thrown error into
something a form can show. Every rule — who may write, what a duplicate SKU
does, that stock never moves without a ledger row — is in `src/server`, so it
holds however the operation is invoked and can be tested without faking a
request.

## Tests

```bash
npm test
```

Integration tests against a real PostgreSQL database, derived from
`DATABASE_URL` with `_test` appended and created and migrated automatically.
Clerk is the only thing mocked, because reaching a real identity provider from
a test would make the suite depend on a network and an account.

Real Postgres because most of what is worth proving here is Postgres behaviour:
that the unique index rejects a duplicate SKU, that a filter comparing two
columns returns what the derived status says it should, that a `Restrict`
foreign key stops a delete, and that `FOR UPDATE` holds under genuinely
concurrent adjustments. A mocked Prisma client would only prove the mock agreed
with the test.

| File                             | Covers                                       |
| -------------------------------- | -------------------------------------------- |
| `tests/auth.test.ts`             | Clerk-to-database identity, roles, races      |
| `tests/stock.test.ts`            | The stock engine: attribution, ledger, limits |
| `tests/products.test.ts`         | Catalogue CRUD, validation, search, filters   |
| `tests/stock-adjustment.test.ts` | Adjustments, permissions, concurrency         |

## What is not built yet

Products and inventory are complete. The remaining pages are navigable and each
lists its own planned scope. The largest outstanding piece is the **automatic
stock engine** for documents:

- Confirming an order deducts the ordered quantity from stock
- Receiving a purchase adds the received quantity to stock
- Both write a `StockTransaction` in the same transaction as the quantity change
- Confirmation is refused when stock is insufficient
- Cancelling a confirmed order returns the stock

The mechanism those need already exists — `recordStockMovement` in
`src/server/stock.ts` locks, validates and writes the ledger row — so what is
missing is the document lifecycle around it, not the stock handling.

Also outstanding: CRUD for orders, purchases, customers and suppliers; the
Clerk-to-database user sync webhook; reporting queries; and CSV export.
