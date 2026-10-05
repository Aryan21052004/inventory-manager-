import { tmpdir } from "node:os";
import { join } from "node:path";

import { config } from "dotenv";
import { vi } from "vitest";

import { testDatabaseUrl } from "./database-url";

/**
 * Runs in every test process before any test module is imported, which matters:
 * `src/lib/env.ts` validates the environment at import time and
 * `src/lib/prisma.ts` builds its client from it, so the database URL has to be
 * redirected before either is touched.
 */
config({ path: ".env.local", quiet: true });
config({ path: ".env", quiet: true });

process.env["DATABASE_URL"] = testDatabaseUrl();

/*
 * Supabase Auth is mocked in the tests, so these only need to be present for
 * `supabaseAuthConfigured` to be true. They are read at module scope by
 * src/lib/supabase/config.ts, so they have to be set before anything imports
 * it — which is why they are here rather than in a test file.
 *
 * Obviously fake values, and set unconditionally rather than filled in when
 * missing: a real project URL and key reaching this process would be a real
 * Supabase project one careless import away, and that project holds production
 * data.
 */
process.env["NEXT_PUBLIC_SUPABASE_URL"] = "https://fake-project.supabase.co";
process.env["NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"] =
  "sb_publishable_fake_for_tests";

/*
 * Uploads go to a scratch directory, never the one a developer is using. The
 * certificate tests write real files and delete them again, and pointing that
 * at `.storage` would have the suite quietly removing documents somebody had
 * uploaded through the app. Set before `src/lib/env.ts` is imported, for the
 * same reason DATABASE_URL is.
 */
process.env["FILE_STORAGE_DRIVER"] = "local";
process.env["FILE_STORAGE_DIR"] = join(tmpdir(), "inventory-manager-test-storage");

/*
 * Supabase Auth is mocked for the whole suite, from here rather than from each
 * test file.
 *
 * `getCurrentUser()` is Supabase-backed now, so every test that signs in needs
 * this mock — and registering it once in a setup file applies it to all of them
 * instead of repeating an identical `vi.mock` in thirty-seven places. A test
 * that wants different behaviour can still override it locally.
 *
 * The real module would build a client against a project URL and try to reach
 * it. The project in question holds production data, so no test may.
 */
vi.mock("@/lib/supabase/server", async () => {
  const { supabaseServerMock } = await import("./supabase-auth-mock");
  return supabaseServerMock;
});
