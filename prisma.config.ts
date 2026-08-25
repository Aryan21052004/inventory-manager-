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
  datasource: {
    url: process.env["DATABASE_URL"],
  },
});
