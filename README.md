# Inventory Manager

Stock control for products, orders, purchases and suppliers, built as a
production-shaped Next.js application.

> **Status: foundation build.** The structure, layout, database schema, and
> shared UI are in place. The feature modules behind each page are scaffolded
> but not implemented — see [What is not built yet](#what-is-not-built-yet).

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

An initial migration is already committed at `prisma/migrations/0_init`, so this
applies it and generates the typed client.

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
| `npm run db:generate` | Regenerate the Prisma client                       |

## Project structure

```
prisma/
  schema.prisma          Database schema
  migrations/0_init/     Initial migration
src/
  app/
    (app)/               Authenticated pages, wrapped in the dashboard shell
      dashboard/         Live stock snapshot
      products/          + new-product-dialog.tsx
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
                         Skeleton, EmptyState, ErrorState, StatCard, Toaster…
  lib/
    env.ts               Validated environment configuration
    prisma.ts            Prisma singleton + connection health check
    errors.ts            AppError types and safe error normalisation
    format.ts            Locale-pinned currency, number and date formatters
    nav.ts               Single source of truth for navigation
    validation/          Zod schemas shared by forms and server actions
  server/
    dashboard.ts         Server-side read models
  proxy.ts               Clerk auth context (Next 16 `proxy` convention)
```

## Design notes

A few decisions worth knowing before extending this.

**Stock is a ledger, not a number.** `Product.quantity` is the single source of
truth for stock on hand, and every write to it must be paired with a
`StockMovement` row in the same transaction. The movement records a signed delta
and the resulting balance, so any quantity can be explained by replaying its
history.

**Derived values are never stored.** Stock status (in stock / low / out) is
computed from `quantity` against `reorderLevel` rather than persisted, so it
cannot drift from the numbers it describes.

**Authorisation follows the route tree.** Access is checked with
`auth.protect()` in the `(app)` layout rather than by path matching in the
proxy. A page added under that group is protected because of where it lives, and
the sign-in pages are public because they live outside it. This also matches
Clerk's current guidance, which deprecates matcher-based protection.

**Errors are normalised before display.** `toSafeError` in `src/lib/errors.ts`
passes through messages we wrote and replaces everything else with a generic
line, logging the original server-side. A Prisma error naming a column never
reaches the browser.

**Money is `Decimal`.** Prices and costs are `DECIMAL(14,2)` in Postgres and are
formatted from their string representation, so nothing rounds through a float.

## What is not built yet

The nine pages exist and are navigable; the modules behind them are not written.
Each page lists its own planned scope. The largest remaining piece is the
**automatic stock engine**:

- Confirming an order deducts the ordered quantity from stock
- Receiving a purchase adds the received quantity to stock
- Both write a `StockMovement` in the same transaction as the quantity change
- Confirmation is refused when stock is insufficient
- Cancelling a confirmed order returns the stock

Also outstanding: CRUD for every entity, the Clerk-to-database user sync webhook,
role-based access control, reporting queries, and CSV export.
