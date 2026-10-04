import "server-only";

import { z } from "zod";

import { supabaseAuthConfigured } from "@/lib/supabase/config";

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
   *
   * `local` writes to a directory and is the development answer. `supabase`
   * writes to a private Storage bucket and is the production one — the local
   * driver cannot be used anywhere the application runs as more than one
   * process, because a file written to one instance's disk is unreadable from
   * the next and gone at the following deploy.
   *
   * The default stays `local` so a developer who has set nothing still gets a
   * working application. It is not a safe production default, which is why the
   * refinement below exists rather than a silent fallback.
   */
  FILE_STORAGE_DRIVER: z.enum(["local", "supabase"]).default("local"),

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

  /**
   * The Supabase project URL, e.g. `https://abcdefgh.supabase.co`.
   *
   * Optional at this level and required by the refinement below when the driver
   * is `supabase`, so a developer running on `local` is never asked for a
   * project they do not have.
   */
  SUPABASE_URL: z.string().url("SUPABASE_URL must be a URL").optional(),

  /**
   * The service-role key the storage driver authenticates with.
   *
   * Note the name: no `NEXT_PUBLIC_` prefix, so Next will not inline it into a
   * browser bundle. This module is `server-only` for the same reason. The key
   * bypasses row-level security, which is the point — the driver acts as the
   * application, and the application has already decided the caller may have
   * the file — and is exactly why it must never reach a client.
   */
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),

  /**
   * The bucket certificates live in. **It must be private.**
   *
   * Nothing here can check that, and a public bucket would make every stored
   * certificate readable by anyone who learned its object path — without any
   * code failing. It is stated here, in the driver, and in .env.example,
   * because it is the one piece of this design that lives in the Supabase
   * dashboard rather than in the repository.
   */
  SUPABASE_STORAGE_BUCKET: z.string().min(1).default("certificates"),
})
  /*
   * A driver that cannot work must not start.
   *
   * Selecting `supabase` without credentials would otherwise import cleanly and
   * fail at the first upload — which is to say, in front of a user, after they
   * had chosen a file. Failing here means it fails at boot, with a message
   * naming the variable that is missing.
   */
  .refine(
    (value) =>
      value.FILE_STORAGE_DRIVER !== "supabase" ||
      Boolean(value.SUPABASE_URL && value.SUPABASE_SERVICE_ROLE_KEY),
    {
      message:
        "FILE_STORAGE_DRIVER is \"supabase\", so SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are both required.",
      path: ["FILE_STORAGE_DRIVER"],
    },
  );

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
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    SUPABASE_STORAGE_BUCKET: process.env.SUPABASE_STORAGE_BUCKET,
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
 * Whether Supabase Auth is wired up. When false the app runs in "setup mode":
 * the proxy stops refreshing sessions, the `(app)` layout stops redirecting, and
 * the shell shows a banner explaining how to finish the setup. Production
 * refuses to start in that state.
 *
 * Read through `lib/supabase/config` rather than from `env` above, because the
 * browser client needs the same two values and this module is `server-only`.
 * One source of truth matters more than usual here: if the server validates a
 * session against one project and the browser obtains it from another, sign-in
 * appears to succeed while the server never recognises it.
 *
 * Only the publishable key is involved. It is browser-visible by design, and
 * authentication needs nothing more — `SUPABASE_SERVICE_ROLE_KEY` stays above,
 * server-only, for the Storage driver alone.
 */
export const authEnabled = supabaseAuthConfigured;

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
    "Supabase Auth is not configured. Set NEXT_PUBLIC_SUPABASE_URL and " +
      "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY before running in production — " +
      "refusing to serve an unauthenticated build. Note that NEXT_PUBLIC_ " +
      "values are compiled in at build time, so a deployment must be rebuilt " +
      "after they are set.",
  );
}
