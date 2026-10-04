-- Close the Supabase Data API to the browser roles.
--
-- ---------------------------------------------------------------------------
-- What was wrong
-- ---------------------------------------------------------------------------
--
-- On a Supabase project, PostgREST serves schema `public` over HTTP, acting as
-- `anon` for an unauthenticated caller and `authenticated` for a signed-in one.
-- Supabase's default privileges granted both roles the complete privilege set
-- — INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN —
-- on every table this schema creates, and row-level security was enabled on
-- none of them.
--
-- The consequence was not theoretical. Anyone holding the project's publishable
-- key could read and write the whole database directly, bypassing this
-- application entirely; `users` was writable, so a caller could set their own
-- `role` to ADMIN and defeat `requireRole()`, which treats that column as the
-- single gate. A publishable key is designed to be public, so the only thing
-- standing in the way was that nobody had looked.
--
-- ---------------------------------------------------------------------------
-- Why revoking is safe here
-- ---------------------------------------------------------------------------
--
-- This application never uses the Data API. Business data goes through Prisma
-- in `src/server/*`, every one of those modules is `server-only`, and no client
-- component imports them — so the only Supabase endpoints the code touches are
-- `/storage/v1/object/*` for certificate files and, later, `/auth/v1/*` for
-- sessions. Neither is PostgREST, and neither is affected by anything below.
--
-- ---------------------------------------------------------------------------
-- Why row-level security as well, with no policies
-- ---------------------------------------------------------------------------
--
-- Revoking today's grants is not durable on its own. `ALTER DEFAULT PRIVILEGES`
-- re-grants them to every table a later migration creates, which is why the
-- defaults are corrected here too. RLS is the second line: enabled with no
-- policies it denies everything by default, so a grant re-introduced by a
-- future migration, a dashboard action, or a Supabase upgrade does not quietly
-- reopen the hole.
--
-- It costs this application nothing because Prisma connects as `postgres`,
-- which holds BYPASSRLS. That is load-bearing: if the runtime is ever moved to
-- a role without BYPASSRLS, these tables will deny it every row until policies
-- exist. Change the connecting role and this migration's assumption has to be
-- revisited.
--
-- `_prisma_migrations` is deliberately left without RLS. It is Prisma's own
-- bookkeeping rather than application data, and the schema engine must be able
-- to read and write it to function.
--
-- ---------------------------------------------------------------------------
-- Why the revokes are guarded
-- ---------------------------------------------------------------------------
--
-- `anon`, `authenticated` and `postgres` are roles Supabase's platform creates
-- at the cluster level. They do not exist on a plain PostgreSQL server, and
-- `tests/global-setup.ts` runs `prisma migrate deploy` against a database it
-- has just created on whatever server DATABASE_URL names. An unguarded
-- `REVOKE ... FROM anon` would therefore fail with `role "anon" does not
-- exist` and break every local run and every test run.
--
-- So each revoke is conditional on the role being present, which also makes
-- this migration a no-op on a local database that has no Data API to close.
-- REVOKE and `ENABLE ROW LEVEL SECURITY` are both idempotent, so re-running it
-- changes nothing.

-- ---------------------------------------------------------------------------
-- 1. Existing objects, and 2. the defaults that govern future ones
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  -- The two roles PostgREST assumes: `anon` for an unauthenticated caller,
  -- `authenticated` for one presenting a valid session.
  browser_roles text[] := ARRAY['anon', 'authenticated'];
  browser_role text;
  can_set_defaults boolean;
BEGIN
  -- `ALTER DEFAULT PRIVILEGES FOR ROLE postgres` requires membership in that
  -- role. On Supabase the migration connects as `postgres` itself.
  can_set_defaults :=
    EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres')
    AND pg_has_role(current_user, 'postgres', 'USAGE');

  FOREACH browser_role IN ARRAY browser_roles LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = browser_role) THEN
      RAISE NOTICE 'role % is absent; nothing to revoke', browser_role;
      CONTINUE;
    END IF;

    -- Existing objects. `public` currently holds 17 tables, no sequences and
    -- no functions; the latter two statements are no-ops today and are kept so
    -- the migration states the whole intent rather than only the part that
    -- happens to have matter in it.
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM %I',
      browser_role);
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM %I',
      browser_role);
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM %I',
      browser_role);

    -- Future objects created by `postgres`, which is the role `prisma migrate`
    -- runs as, so this is what governs every table a later migration adds.
    --
    -- Supabase keeps a second set of defaults for objects created by
    -- `supabase_admin`. Those are not touched: `postgres` is not a member of
    -- `supabase_admin` and so cannot alter them, and they do not apply to
    -- anything this schema creates.
    IF can_set_defaults THEN
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM %I',
        browser_role);
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I',
        browser_role);
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM %I',
        browser_role);
    ELSE
      RAISE NOTICE
        'not a member of role postgres; default privileges left unchanged';
    END IF;
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- 3. Row-level security on the sixteen domain tables
-- ---------------------------------------------------------------------------
--
-- Listed one by one rather than looped over the catalogue, so that which
-- tables are covered is a fact about this file and not about whatever happened
-- to exist when it ran.

ALTER TABLE "app_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "customers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "suppliers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "products" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "orders" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "order_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "order_item_images" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "purchases" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "purchase_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "supply_links" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "stock_transactions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "stock_lots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "stock_lot_consumptions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "returns" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "certificates" ENABLE ROW LEVEL SECURITY;

-- No policies are created. An RLS-enabled table with no policy denies every
-- row to every role that does not bypass RLS, which is exactly the intent: the
-- Data API roles get nothing, and Prisma is unaffected because `postgres`
-- bypasses RLS. Policies become necessary only if the application's own
-- connection is ever moved to a role that does not.
