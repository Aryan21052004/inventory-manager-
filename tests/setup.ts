import { tmpdir } from "node:os";
import { join } from "node:path";

import { config } from "dotenv";

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
 * Clerk is mocked in the tests, so these only need to be present for
 * `authEnabled` to be true. They are set unconditionally rather than filled in
 * when missing — a real key reaching this process would be a real Clerk
 * instance one careless import away.
 */
process.env["NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY"] = "pk_test_fake_for_tests";
process.env["CLERK_SECRET_KEY"] = "sk_test_fake_for_tests";

/*
 * Uploads go to a scratch directory, never the one a developer is using. The
 * certificate tests write real files and delete them again, and pointing that
 * at `.storage` would have the suite quietly removing documents somebody had
 * uploaded through the app. Set before `src/lib/env.ts` is imported, for the
 * same reason DATABASE_URL is.
 */
process.env["FILE_STORAGE_DRIVER"] = "local";
process.env["FILE_STORAGE_DIR"] = join(tmpdir(), "inventory-manager-test-storage");
