import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

/**
 * Test configuration.
 *
 * These are integration tests, not unit tests with a mocked Prisma client. The
 * behaviour worth proving here — that a unique index stops a duplicate user
 * under concurrency, that a foreign key really points where we think, that a
 * check constraint rejects bad arithmetic — is behaviour of Postgres. A mock
 * would only assert that we mocked it correctly. So the suite runs against a
 * real database, created and migrated by `tests/global-setup.ts`.
 *
 * Supabase Auth is the one thing that is mocked (in `tests/setup.ts`), because
 * reaching a real identity provider from a test would make the suite depend on
 * a network and an account — and the project it would reach holds production
 * data.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // `server-only` throws when imported outside a React Server Component.
      // That guard is doing its job in the app and is meaningless here, so it
      // resolves to nothing under test.
      "server-only": fileURLToPath(
        new URL("./tests/stubs/server-only.ts", import.meta.url),
      ),
    },
  },
  test: {
    environment: "node",
    globalSetup: ["./tests/global-setup.ts"],
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.ts"],
    /*
     * One process. The tests share a database and truncate between cases, so
     * running files in parallel would have them deleting each other's rows.
     */
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
