import "server-only";

import { z } from "zod";

/**
 * Environment configuration, validated once at import time.
 *
 * This module is server-only. Client components must never import it — the
 * secrets would be bundled and shipped to the browser. Anything the client
 * needs is passed down as a prop from a server component.
 */

const schema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),

  /**
   * PostgreSQL connection string. Prisma opens the connection lazily, so an
   * unreachable database does not stop the app booting — it surfaces as a
   * handled error on the pages that actually query.
   */
  DATABASE_URL: z
    .string()
    .min(1, "DATABASE_URL is required")
    .refine(
      (value) =>
        value.startsWith("postgres://") || value.startsWith("postgresql://"),
      "DATABASE_URL must be a postgres:// or postgresql:// connection string",
    ),

  /**
   * Clerk keys. Optional in development so the foundation can be run and
   * reviewed before an account exists; required in production, where serving
   * an unauthenticated app would be a security hole rather than a convenience.
   */
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: z.string().optional(),
  CLERK_SECRET_KEY: z.string().optional(),

  NEXT_PUBLIC_APP_NAME: z.string().default("Inventory Manager"),

  /**
   * Where uploaded certificates are stored.
   *
   * An enum rather than a free string, so an unknown value fails here — at
   * import, with a readable message — instead of at the first upload. The
   * exhaustiveness check in src/server/storage/index.ts is tied to this list,
   * which means adding a driver name without implementing it is a compile
   * error.
   */
  FILE_STORAGE_DRIVER: z.enum(["local"]).default("local"),

  /**
   * Root directory for the local driver. Relative paths resolve against the
   * process working directory.
   *
   * Note where the default is *not*: anywhere under `public/`. Next serves that
   * directory statically with no session in the way, so a certificate written
   * there would be downloadable by anyone who learned its filename. Keeping the
   * default outside it means the safe arrangement is also the one you get by
   * doing nothing.
   */
  FILE_STORAGE_DIR: z.string().min(1).default(".storage"),
});

function load() {
  const parsed = schema.safeParse({
    NODE_ENV: process.env.NODE_ENV,
    DATABASE_URL: process.env.DATABASE_URL,
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY:
      process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
    CLERK_SECRET_KEY: process.env.CLERK_SECRET_KEY,
    NEXT_PUBLIC_APP_NAME: process.env.NEXT_PUBLIC_APP_NAME,
    FILE_STORAGE_DRIVER: process.env.FILE_STORAGE_DRIVER,
    FILE_STORAGE_DIR: process.env.FILE_STORAGE_DIR,
  });

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");

    throw new Error(
      `Invalid environment configuration:\n${details}\n\n` +
        `Copy .env.example to .env.local and fill in the values.`,
    );
  }

  return parsed.data;
}

export const env = load();

/**
 * Whether Clerk is wired up. When false the app runs in "setup mode": the
 * middleware stops guarding routes and the shell shows a banner explaining how
 * to finish the setup. Production refuses to start in that state.
 */
export const authEnabled = Boolean(
  env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY && env.CLERK_SECRET_KEY,
);

/**
 * `next build` runs with NODE_ENV=production, but compiling a bundle is not the
 * same as serving it — CI and Docker images are routinely built without runtime
 * secrets. The guard therefore skips the build phase and fires when the server
 * actually starts, which is the moment an unauthenticated app would become
 * reachable.
 */
const isBuildPhase = process.env.NEXT_PHASE === "phase-production-build";

if (!authEnabled && env.NODE_ENV === "production" && !isBuildPhase) {
  throw new Error(
    "Clerk is not configured. Set NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY and " +
      "CLERK_SECRET_KEY before running in production — refusing to serve an " +
      "unauthenticated build.",
  );
}
