import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { testDatabaseUrl } from "./database-url";

/**
 * The guard that keeps the test suite off the application's database.
 *
 * Deliberately connects to nothing. `testDatabaseUrl` is pure string and URL
 * work, and that is the point: the decision about which database may be
 * truncated has to be checkable without first opening a connection to find
 * out.
 *
 * The connection strings below are fabricated. The host happens to look like
 * the real one because the guard's job is to recognise exactly that shape.
 */

const PRODUCTION_POOLED =
  "postgresql://postgres:pretend@aws-0-ap-south-1.pooler.supabase.com:6543/postgres?schema=public";
const PRODUCTION_DIRECT =
  "postgresql://postgres:pretend@aws-0-ap-south-1.pooler.supabase.com:5432/postgres?schema=public";
const ISOLATED =
  "postgresql://postgres:postgres@localhost:5432/inventory_manager_test?schema=public";

const MANAGED = ["DATABASE_TEST_URL", "DATABASE_URL", "DIRECT_URL"] as const;

const saved = new Map<string, string | undefined>();

beforeEach(() => {
  saved.clear();
  for (const name of MANAGED) {
    saved.set(name, process.env[name]);
    delete process.env[name];
  }
});

afterEach(() => {
  for (const name of MANAGED) {
    const value = saved.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("requiring an explicit test database", () => {
  it("refuses to run when DATABASE_TEST_URL is unset", () => {
    process.env["DATABASE_URL"] = PRODUCTION_POOLED;
    process.env["DIRECT_URL"] = PRODUCTION_DIRECT;

    expect(() => testDatabaseUrl()).toThrow(/DATABASE_TEST_URL is not set/);
  });

  /*
   * The behaviour this module exists to remove. With DATABASE_URL present and
   * DATABASE_TEST_URL absent, the old implementation returned a derived
   * production URL; it must now fail instead of falling back.
   */
  it("does not fall back to DATABASE_URL", () => {
    process.env["DATABASE_URL"] = PRODUCTION_POOLED;

    expect(() => testDatabaseUrl()).toThrow();
  });

  it("accepts an isolated test database and returns it unchanged", () => {
    process.env["DATABASE_TEST_URL"] = ISOLATED;
    process.env["DATABASE_URL"] = PRODUCTION_POOLED;
    process.env["DIRECT_URL"] = PRODUCTION_DIRECT;

    expect(testDatabaseUrl()).toBe(ISOLATED);
  });

  it("accepts it when no application URLs are configured at all", () => {
    process.env["DATABASE_TEST_URL"] = ISOLATED;

    expect(testDatabaseUrl()).toBe(ISOLATED);
  });
});

describe("refusing the application's own database", () => {
  it("rejects a target matching DATABASE_URL", () => {
    process.env["DATABASE_TEST_URL"] = PRODUCTION_POOLED;
    process.env["DATABASE_URL"] = PRODUCTION_POOLED;

    // Caught by the `_test` rule first, which is itself the point: the
    // production database is not named like a disposable one.
    expect(() => testDatabaseUrl()).toThrow(/does not end in/);
  });

  it("rejects a target matching DATABASE_URL even when it is named like a test database", () => {
    const sharedName =
      "postgresql://postgres:pretend@db.example.com:6543/shared_test?schema=public";
    process.env["DATABASE_TEST_URL"] = sharedName;
    process.env["DATABASE_URL"] = sharedName;

    expect(() => testDatabaseUrl()).toThrow(
      /DATABASE_TEST_URL and DATABASE_URL address the same database/,
    );
  });

  /*
   * The variable that actually leaked. `prisma migrate deploy` resolves
   * DIRECT_URL before DATABASE_URL, so a guard that only knew about
   * DATABASE_URL would still have let DDL reach production.
   */
  it("rejects a target matching DIRECT_URL", () => {
    const sharedName =
      "postgresql://postgres:pretend@db.example.com:5432/shared_test?schema=public";
    process.env["DATABASE_TEST_URL"] = sharedName;
    process.env["DIRECT_URL"] = sharedName;

    expect(() => testDatabaseUrl()).toThrow(
      /DATABASE_TEST_URL and DIRECT_URL address the same database/,
    );
  });

  it("names the offending variable so the fix is obvious", () => {
    const sharedName =
      "postgresql://postgres:pretend@db.example.com:5432/shared_test";
    process.env["DATABASE_TEST_URL"] = sharedName;
    process.env["DIRECT_URL"] = sharedName;

    expect(() => testDatabaseUrl()).toThrow(/DIRECT_URL/);
  });

  /*
   * An omitted port is 5432, so comparing the written text would let the same
   * database through by simply leaving `:5432` off one of the two.
   */
  it("treats an omitted port as 5432 rather than as a different database", () => {
    process.env["DATABASE_TEST_URL"] =
      "postgresql://postgres:pretend@db.example.com:5432/shared_test";
    process.env["DATABASE_URL"] =
      "postgresql://postgres:pretend@db.example.com/shared_test";

    expect(() => testDatabaseUrl()).toThrow(/address the same database/);
  });

  it("compares the host case-insensitively", () => {
    process.env["DATABASE_TEST_URL"] =
      "postgresql://postgres:pretend@DB.Example.COM:5432/shared_test";
    process.env["DATABASE_URL"] =
      "postgresql://postgres:pretend@db.example.com:5432/shared_test";

    expect(() => testDatabaseUrl()).toThrow(/address the same database/);
  });
});

describe("refusing a database that is not marked disposable", () => {
  it("rejects a database name that does not end in _test", () => {
    process.env["DATABASE_TEST_URL"] =
      "postgresql://postgres:postgres@localhost:5432/inventory_manager?schema=public";

    expect(() => testDatabaseUrl()).toThrow(/does not end in/);
  });

  it("rejects a URL that names no database", () => {
    process.env["DATABASE_TEST_URL"] =
      "postgresql://postgres:postgres@localhost:5432";

    expect(() => testDatabaseUrl()).toThrow(/names no database/);
  });

  it("rejects a value that is not a URL", () => {
    process.env["DATABASE_TEST_URL"] = "inventory_manager_test";

    expect(() => testDatabaseUrl()).toThrow(/not a valid connection URL/);
  });
});

describe("keeping credentials out of error messages", () => {
  /*
   * A thrown error ends up in CI logs. The messages name a host, a port and a
   * database; they must never carry the password that sits between them.
   */
  it("never includes the password in a rejection", () => {
    const withPassword =
      "postgresql://postgres:sup3rs3cret@db.example.com:5432/shared_test";

    for (const [testUrl, appUrl] of [
      [withPassword, withPassword],
      ["postgresql://postgres:sup3rs3cret@db.example.com:5432/live", undefined],
      ["not-a-url-sup3rs3cret", undefined],
    ] as const) {
      process.env["DATABASE_TEST_URL"] = testUrl;
      if (appUrl) process.env["DATABASE_URL"] = appUrl;
      else delete process.env["DATABASE_URL"];

      let message = "";
      try {
        testDatabaseUrl();
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }

      expect(message).not.toBe("");
      expect(message).not.toContain("sup3rs3cret");
    }
  });
});
