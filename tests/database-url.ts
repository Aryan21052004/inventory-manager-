/**
 * Derives the test database URL from DATABASE_URL.
 *
 * Kept in its own module because both the global setup and every test process
 * need it, and because the guard below is worth having exactly one copy of: the
 * suite truncates tables, so handing it the development database would delete
 * real work. Appending `_test` is not a convention here, it is enforced.
 */
export function testDatabaseUrl(): string {
  const base = process.env["DATABASE_URL"];

  if (!base) {
    throw new Error(
      "DATABASE_URL is not set. Tests need a PostgreSQL server to run against.",
    );
  }

  const url = new URL(base);
  const name = url.pathname.slice(1);

  if (!name) {
    throw new Error(`DATABASE_URL has no database name: ${base}`);
  }

  url.pathname = `/${name.endsWith("_test") ? name : `${name}_test`}`;
  return url.toString();
}
