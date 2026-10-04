/**
 * The database the test suite runs against, read from DATABASE_TEST_URL.
 *
 * ## Why this is explicit rather than derived
 *
 * This module used to take DATABASE_URL and append `_test` to the database
 * name. That read as a safety feature and was the opposite of one: it kept the
 * production host, port, credentials and privileges, and left the suite one
 * string operation away from the real database. It also silently returned
 * DATABASE_URL untouched when the name already ended in `_test`.
 *
 * So the test database is now named outright, in its own variable, with no
 * fallback. There is deliberately nothing here that reads DATABASE_URL as a
 * source: a missing DATABASE_TEST_URL is an error, not an invitation to borrow
 * the application's connection. The suite deletes every row in nineteen tables;
 * the one thing it must never do is guess where.
 *
 * ## The refusals
 *
 * Being explicit removes the derivation, but a human can still paste the wrong
 * string into the wrong variable, so three checks stand in the way:
 *
 *  1. The database name must end in `_test`, so the target says out loud that
 *     it is disposable.
 *  2. It must not be the same host, port and database as DATABASE_URL.
 *  3. Nor the same as DIRECT_URL — the one that actually leaked. `migrate
 *     deploy` resolves DIRECT_URL first (see prisma.config.ts), so a test run
 *     that only overrode DATABASE_URL was still pointing DDL at production.
 *
 * The comparison is against the configured values rather than against a
 * recognised hostname, so it keeps working when the production host changes.
 *
 * ## No connection string reaches an error message
 *
 * The messages below name a host, a port and a database and nothing else. A
 * connection URL carries a password, and a thrown error ends up in CI logs.
 */

interface DatabaseLocation {
  host: string;
  port: string;
  database: string;
}

/**
 * The parts of a connection URL that decide *which* database is addressed.
 *
 * The port is defaulted rather than compared as written: `host/db` and
 * `host:5432/db` are the same database, and a guard that treated them as
 * different would be trivially defeated by leaving the port off.
 */
function locationOf(url: URL): DatabaseLocation {
  return {
    // Hostnames are case-insensitive; database names are not.
    host: url.hostname.toLowerCase(),
    port: url.port === "" ? "5432" : url.port,
    database: decodeURIComponent(url.pathname.replace(/^\//, "")),
  };
}

function describe(location: DatabaseLocation): string {
  return `${location.host}:${location.port}/${location.database}`;
}

function parseOrNull(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/** The connection variables the test database must not collide with. */
const APPLICATION_URL_VARIABLES = ["DATABASE_URL", "DIRECT_URL"] as const;

export function testDatabaseUrl(): string {
  const raw = process.env["DATABASE_TEST_URL"];

  if (!raw) {
    throw new Error(
      "DATABASE_TEST_URL is not set.\n" +
        "The test suite needs a database of its own: it deletes every row in " +
        "nineteen tables, so it will not fall back to the one the application " +
        "uses. Set DATABASE_TEST_URL to a disposable database whose name ends " +
        "in `_test` — see .env.example.",
    );
  }

  const url = parseOrNull(raw);

  if (!url) {
    throw new Error(
      "DATABASE_TEST_URL is not a valid connection URL. (Its value is not " +
        "shown here because a connection string carries a password.)",
    );
  }

  const target = locationOf(url);

  if (!target.database) {
    throw new Error(
      `DATABASE_TEST_URL names no database (host ${target.host}:${target.port}).`,
    );
  }

  if (!target.database.endsWith("_test")) {
    throw new Error(
      `DATABASE_TEST_URL names the database "${target.database}", which does ` +
        "not end in `_test`.\n" +
        "The suite truncates every application table, so the name has to say " +
        "that the database is disposable. Rename it, or point " +
        "DATABASE_TEST_URL at one that is.",
    );
  }

  for (const variable of APPLICATION_URL_VARIABLES) {
    const configured = process.env[variable];
    if (!configured) continue;

    const other = parseOrNull(configured);
    if (!other) continue;

    const application = locationOf(other);

    if (
      application.host === target.host &&
      application.port === target.port &&
      application.database === target.database
    ) {
      throw new Error(
        `DATABASE_TEST_URL and ${variable} address the same database ` +
          `(${describe(target)}).\n` +
          "The test suite deletes every row in nineteen tables. Point " +
          "DATABASE_TEST_URL at a database that exists for no other purpose.",
      );
    }
  }

  // Returned as written. Normalising it through URL.toString() would re-encode
  // the password and reorder parameters, and nothing here needs it changed.
  return raw;
}
