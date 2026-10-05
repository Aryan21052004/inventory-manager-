# Inventory Manager

Stock control for products, orders, purchases and suppliers, built as a
production-shaped Next.js application.

> **Status: products, inventory and certificates.** The foundation, Supabase
> Auth, the products + inventory module, and product certificates are
> built. Orders, purchases, customers, suppliers and reports are still
> scaffolded pages — see [What is not built yet](#what-is-not-built-yet).

This is an aviation-parts inventory system, which shapes two decisions you will
meet early: every part can carry airworthiness paperwork with its own expiry and
audit trail, and **the system calculates no tax and applies no discounts** — an
order's grand total is `subtotal`, enforced by a check constraint. Prices are
quoted per customer: `Product.sellingPrice` is an optional reference that
prefills a line, and `OrderItem.unitPrice` is what was actually charged.

## Stack

| Concern        | Choice                                            |
| -------------- | ------------------------------------------------- |
| Framework      | Next.js 16 (App Router, React 19, Turbopack)      |
| Language       | TypeScript, `strict` mode                          |
| Styling        | Tailwind CSS v4, CSS-variable design tokens        |
| Components     | Radix UI primitives, shadcn-style wrappers         |
| Database       | PostgreSQL                                         |
| ORM            | Prisma 7 with the `@prisma/adapter-pg` driver      |
| Authentication | Supabase Auth (`@supabase/ssr`)                    |
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
- **`NEXT_PUBLIC_SUPABASE_URL`** and **`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`**
  — optional in development, required in production. Both come from the
  Supabase dashboard under Project Settings → API. The publishable key is
  browser-visible by design and carries no privilege: `anon` and
  `authenticated` hold no grant on any table.
- **`DATABASE_TEST_URL`** — required to run the tests, and only then. It must
  name a disposable database whose name ends in `_test`, and not the one
  `DATABASE_URL` or `DIRECT_URL` addresses. There is no fallback: the suite
  truncates every table, so it refuses to guess where.

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
26 stock transactions that explain every unit on hand. The quantities range
from single figures to a few hundred, so every screen that reports one has
something real to report. The seed clears the tables first, so it is safe to
re-run.

### 4. Run it

```bash
npm run dev
```

The app is at [http://localhost:3000](http://localhost:3000), which redirects to
`/dashboard`.

### Setup mode

Without `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
the app runs in **setup mode**: authentication is disabled, every route is
publicly reachable, and a banner says so on every page. This exists so the UI
can be reviewed before an account exists.

It is a development-only convenience. Starting the server with
`NODE_ENV=production` and either value missing throws on boot rather than
serving an unauthenticated app — see `src/lib/env.ts`. Note that
`NEXT_PUBLIC_` values are compiled in at build time, so a deployment has to be
rebuilt after they are set, not merely restarted.

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
        [id]/            Product detail, movement history, certificates
      api/
        certificates/    Authenticated file download — the only route to a
                         stored certificate; no public URLs exist
      orders/  purchases/  customers/  suppliers/
      stock-movements/  reports/  settings/
      layout.tsx         Dashboard chrome + the authorisation boundary
      loading.tsx        Route-level skeleton
      error.tsx          Route-level error boundary
    (auth)/              sign-in and sign-up, no chrome
    layout.tsx           Fonts, theme provider and toasts
    global-error.tsx     Last-resort boundary
    not-found.tsx
  components/
    layout/              Shell: sidebar, header, mobile drawer, user menu
    ui/                  Button, Card, Table, Dialog, Select, Badge,
                         Skeleton, EmptyState, ErrorState, StatCard,
                         Pagination, Toaster…
  lib/
    env.ts               Validated environment configuration
    prisma.ts            Prisma singleton + connection health check
    errors.ts            AppError types and safe error normalisation
    format.ts            Locale-pinned currency, number and date formatters
    nav.ts               Single source of truth for navigation
    product-query.ts     The products list's URL state, parsed and serialised
    certificate-status.ts  The derived valid / expiring / expired / missing rule
    validation/          Zod schemas shared by forms and server actions
  server/
    auth.ts              Supabase session to local user, and role checks
    dashboard.ts         Server-side read models
    products.ts          Catalogue reads and writes; no next/* imports
    certificates.ts      Certificate upload, replacement, withdrawal, access
    stock.ts             The only way stock is allowed to change
    storage/             Swappable file storage (interface + local driver)
  proxy.ts               Supabase session refresh (Next 16 `proxy` convention)
tests/                   Integration tests (real Postgres, mocked Supabase Auth)
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

**Derived values are never stored.** Certificate status — valid, expiring,
expired, missing — is computed from the expiry date rather than persisted,
because it changes on its own as dates pass: a stored column would be wrong
every morning until something remembered to recalculate it.

**No tax and no discount, anywhere.** An order's grand total is `subtotal`, and
there is no column for either term to come back through. Both were dropped
rather than left defaulting to zero — a zero column is a field the UI eventually
renders and a value a report eventually sums. The check constraint `total =
subtotal` means the database refuses a total that implies either, whatever wrote
it.

**The database refuses invalid rows, not just invalid relationships.** Alongside
the foreign keys, the migration adds check constraints: money is never negative,
a line always moves at least one unit, `total = subtotal` on every order, a
line total always equals quantity times price, and a stock
transaction's `previousStock`, `quantity` and `newStock` have to add up. Prisma's
schema language cannot express these, so they live in the migration SQL.

**Authorisation follows the route tree.** Access is checked by
`getCurrentUser()` in the `(app)` layout, which redirects to `/sign-in` when
there is no session, rather than by path matching in the proxy. A page added
under that group is protected because of where it lives, and the sign-in pages
are public because they live outside it. Path matching would be a second
description of the route tree, free to drift from the real one and leave a page
reachable; refreshing the session is the only thing the proxy does.

**Supabase Auth authenticates; the database authorises.** Supabase Auth owns
the credential — password, email confirmation, recovery, sessions — and this
app never sees or stores one. The `users` table owns the local business
identity: the `role` that decides what someone may do here, and a row for
foreign keys such as `stock_transactions.created_by` to point at.

The session is verified with `getClaims()`, never `getSession()`. The latter
decodes a cookie the browser supplied and will decode a forged one just as
happily; `getClaims()` verifies the token's signature, which is the difference
between reading a claim and trusting it.

`supabaseUserId` is the join between the two, and the only identity key. Email
is unique in our table and looks like it would work, but a user can change
their address; the next request would then look like a different person and
quietly create a second record. `supabaseUserId` never changes.

Email is used for exactly one thing: a one-time adoption. A row whose
`supabase_user_id` is NULL and whose address matches a newly confirmed Auth
account is claimed by it — which is how the seeded admin keeps its ADMIN role
rather than arriving as a brand-new STAFF account. Adoption requires a
*confirmed* address, because an unconfirmed one proves only that somebody typed
it, and the claim is a compare-and-set against `supabase_user_id IS NULL`, so
two concurrent first requests cannot both take the row. An Auth account with no
matching row gets a new one as STAFF: signing up is not a route to ADMIN, and an
existing ADMIN is never downgraded.

The local mirror still refreshes only when a row is created or claimed, so a
later name change on the Auth account leaves a stale value here, and a deleted
Auth user leaves a row that looks active forever. Identity itself is unaffected,
because lookups go through `supabaseUserId`. The remedy is cheaper than it was
under a third-party provider: `auth.users` lives in the same PostgreSQL
database, so reconciling is a query or a trigger rather than an HTTP endpoint
with signature verification and replay handling. Worth doing once there are
real users.

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

**Stock is a quantity, not a classification.** The catalogue reports how many
units a product holds and stops there. A product holding four units shows four;
one holding none shows zero. There is no minimum-stock level, no low- or
out-of-stock status, no threshold filter and no reorder point — the business
does not work to fixed thresholds, so a threshold would turn a physical count
into an alert nobody had asked for. What the stock is *worth* is a separate
question, answered from the lots.

**Editing a product cannot change its stock.** `updateProductSchema` has no
`stockQuantity` field, so there is nothing for a tampered request to land on.
Stock moves only through the engine: a new product's opening balance is written
as a `STOCK_IN` in the same transaction that creates it, and a correction after
that is an ADMIN-only `ADJUSTMENT` with a mandatory reason.

**An adjustment is a count and a direction, never a signed number.** That is how
the operation is described out loud — "twenty fewer than the system thinks" —
and the sign is derived once on the way to the ledger. The server verifies the
Supabase session, resolves the local user through `supabaseUserId`, checks the
ADMIN role against our database, locks the product row `FOR UPDATE`, refuses a
result below zero, then writes the new quantity and the `ADJUSTMENT` row
together. The
row lock is what makes simultaneous adjustments safe; without it two requests
read the same balance and the second overwrites the first.

**Server actions are thin.** `src/app/(app)/products/actions.ts` turns a
`FormData` into an object, revalidates, and converts a thrown error into
something a form can show. Every rule — who may write, what a duplicate SKU
does, that stock never moves without a ledger row — is in `src/server`, so it
holds however the operation is invoked and can be tested without faking a
request.

## Certificates

Aviation parts carry paperwork, and an uncertified part is unsellable. Each
product may have one *current* certificate and any number of retired ones.

**Nothing is overwritten.** Replacing a certificate retires the old row and
inserts a new one; the old row keeps pointing at the old file and both survive.
"Remove" is a withdrawal, not a deletion — the product reads as having no
certificate while the record of the document that once covered it stays in the
history. For a part whose paperwork someone may ask about in ten years, a system
that can be made to forget on request is not an audit trail.

**One current certificate per product** is a partial unique index
(`WHERE superseded_at IS NULL`), not just a code path. Two uploads racing each
other would otherwise both retire the old row and both insert a new one, leaving
a product with two certificates claiming to be current.

**Certificate type is free text with suggestions**, for the same reason
`Product.category` is. FAA 8130-3, EASA Form 1, a Certificate of Conformity and
an Airworthiness Certificate are the common ones, but a part under Transport
Canada or CAAC must not need a migration to record.

**Expiry is optional and means what it says.** A Certificate of Conformity
typically never expires; a null expiry date is a complete answer, not a missing
one, and such a certificate is `VALID`. The four states are `MISSING`,
`EXPIRED`, `EXPIRING_SOON` (within 30 days) and `VALID`.

### Files

**A file is identified by reading it.** The browser supplies a filename and a
`Content-Type`, and neither is evidence — renaming `payload.html` to
`certificate.pdf` takes a second. `sniffFileType` checks the leading bytes
against the signatures for PDF, JPEG and PNG, and that result is what gets
stored and what the download route later sends back, alongside `nosniff`.

**Storage is behind an interface.** `FileStorage` is four operations — put, get,
delete, exists — keyed by an opaque string, which S3, Supabase, Cloudinary and a
local directory can all implement. `LocalFileStorage` is the development driver;
swapping it means writing one class and adding a case to the switch in
`src/server/storage/index.ts`. No call site knows which driver it has.

Note what the interface deliberately lacks: a URL. A storage layer that hands
out URLs is one whose files are reachable by anyone holding one. The storage key
never leaves the server, and the only address a browser sees is
`/api/certificates/{id}/file`, which checks the Supabase session before it
resolves anything. Uploads go nowhere near `public/` — Next serves that directory
statically, with no session in the way.

**Reading requires a session; changing requires ADMIN.** Viewing and downloading
are part of doing the job, so any signed-in user may. Uploading, replacing,
editing and withdrawing are ADMIN, checked on the server against the role in our
database.

## Tests

```bash
npm test
```

Integration tests against a real PostgreSQL database, named explicitly by
`DATABASE_TEST_URL` and created and migrated automatically. Nothing is derived
from `DATABASE_URL` and there is no fallback to it: the suite truncates every
table, so a guard refuses any URL whose database name does not end in `_test`,
or that addresses the same database as `DATABASE_URL` or `DIRECT_URL`.

Supabase Auth is the only thing mocked, because reaching a real identity
provider from a test would make the suite depend on a network and an account —
and the project it would reach holds production data.

Real Postgres because most of what is worth proving here is Postgres behaviour:
that the unique index rejects a duplicate SKU, that a filter comparing two
columns returns what the derived status says it should, that a `Restrict`
foreign key stops a delete, and that `FOR UPDATE` holds under genuinely
concurrent adjustments. A mocked Prisma client would only prove the mock agreed
with the test.

| File                             | Covers                                       |
| -------------------------------- | -------------------------------------------- |
| `tests/supabase-auth.test.ts`    | Auth-to-database identity, roles, adoption    |
| `tests/stock.test.ts`            | The stock engine: attribution, ledger, limits |
| `tests/products.test.ts`         | Catalogue CRUD, validation, search, filters   |
| `tests/stock-adjustment.test.ts` | Adjustments, permissions, concurrency         |
| `tests/certificates.test.ts`     | Upload, replace, withdraw, status, access     |
| `tests/order-totals.test.ts`     | Total arithmetic, and that tax is gone        |

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

Also outstanding: CRUD for orders, purchases, customers and suppliers;
reconciling the local `users` mirror with `auth.users`; reporting queries; and
CSV export.
