import { config } from "dotenv";
import { defineConfig } from "prisma/config";

/**
 * Prisma CLI configuration.
 *
 * Next.js reads .env.local automatically but the Prisma CLI does not, so both
 * files are loaded here in Next's precedence order. dotenv does not overwrite a
 * variable that is already set, which is what makes .env.local win over .env
 * and a real shell variable win over both.
 */
// `quiet` suppresses dotenv's startup banner, which would otherwise be written
// to stdout and end up inside the output of commands such as `migrate diff`.
config({ path: ".env.local", quiet: true });
config({ path: ".env", quiet: true });

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    // Run by `prisma db seed` and by `prisma migrate reset`. tsx is used rather
    // than plain node because the generated Prisma Client is TypeScript source.
    seed: "tsx prisma/seed.ts",
  },
  /*
   * The connection migrations and introspection use.
   *
   * Prisma 7 removed `directUrl` from the schema — connection URLs live here
   * now — and there is no separate "direct" field here either, because there no
   * longer needs to be: this datasource *is* the schema engine's, while the
   * running application opens its own in src/lib/prisma.ts. Pointing this one
   * at DIRECT_URL is the whole of the split.
   *
   * It matters on a pooled host. A transaction-mode pooler cannot carry DDL or
   * the advisory lock `migrate` takes, so migrations need the direct port while
   * the application keeps the pooled one. Locally there is one database and one
   * URL, so DATABASE_URL is the fallback and nothing changes.
   *
   * `process.env` rather than Prisma's `env()` helper, which throws on a
   * missing variable and would therefore break every developer who has no
   * DIRECT_URL set.
   */
  datasource: {
    url: process.env["DIRECT_URL"] ?? process.env["DATABASE_URL"],
  },
});
