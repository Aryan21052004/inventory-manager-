import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

import { config } from "dotenv";
import { Client } from "pg";

import { testDatabaseUrl } from "./database-url";

/**
 * Creates and migrates the test database, once, before any test file runs.
 *
 * The suite deletes rows wholesale, so it must never point at the development
 * or production database. `testDatabaseUrl` reads DATABASE_TEST_URL — named
 * explicitly, with no fallback — and refuses it if it addresses the same
 * database as DATABASE_URL or DIRECT_URL, which makes pointing the tests at
 * real data an error rather than an accident.
 *
 * That guard is what makes the CREATE DATABASE below safe to keep: by the time
 * it runs, the target has been shown not to be the application's.
 */
export default async function setup(): Promise<void> {
  config({ path: ".env.local", quiet: true });
  config({ path: ".env", quiet: true });

  const url = testDatabaseUrl();
  const parsed = new URL(url);
  const databaseName = parsed.pathname.slice(1);

  // CREATE DATABASE cannot run inside the database being created, so this
  // connects to the default maintenance database to issue it.
  const admin = new URL(url);
  admin.pathname = "/postgres";
  admin.search = "";

  const client = new Client({ connectionString: admin.toString() });
  await client.connect();

  try {
    const { rowCount } = await client.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [databaseName],
    );

    if (rowCount === 0) {
      // The name comes from our own derivation, not from user input, but it is
      // still an identifier being concatenated — quote it properly.
      await client.query(`CREATE DATABASE "${databaseName.replace(/"/g, '""')}"`);
    }
  } finally {
    await client.end();
  }

  /*
   * Migrate with the real CLI rather than `db push`. The point is to run the
   * same migrations production will run — including the hand-written SQL for
   * the check constraints and the clerk_id backfill, which a schema push would
   * skip entirely.
   */
  // Run the CLI's entry point with the current Node binary rather than going
  // through `npx`. On Windows that would mean spawning a .cmd shim, which
  // needs a shell and fails with EINVAL without one.
  const prismaCli = createRequire(import.meta.url).resolve(
    "prisma/build/index.js",
  );

  /*
   * Both connection variables are overridden, and that is the whole point.
   *
   * prisma.config.ts resolves its datasource as `DIRECT_URL ?? DATABASE_URL`,
   * which is correct on a pooled host — a transaction-mode pooler cannot carry
   * DDL. But this process has already loaded .env.local, so DIRECT_URL was in
   * the inherited environment, and overriding DATABASE_URL alone left `migrate
   * deploy` resolving the *production* direct connection. The test database got
   * no schema and every test then failed against an empty database, while any
   * pending migration would have been deployed to production by `npm test`.
   *
   * Passing both means the child cannot reach past them to .env.local, because
   * dotenv does not overwrite a variable that is already set.
   */
  execFileSync(process.execPath, [prismaCli, "migrate", "deploy"], {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url },
  });
}
