import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

import { config } from "dotenv";
import { Client } from "pg";

import { testDatabaseUrl } from "./database-url";

/**
 * Creates and migrates the test database, once, before any test file runs.
 *
 * The suite deletes rows wholesale, so it must never point at the development
 * database. `testDatabaseUrl` derives a separate `..._test` database from
 * DATABASE_URL and refuses to return the original, which makes pointing the
 * tests at real data an error rather than an accident.
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

  execFileSync(process.execPath, [prismaCli, "migrate", "deploy"], {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: url },
  });
}
