import "server-only";

import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "@/generated/prisma/client";
import { env } from "@/lib/env";

/**
 * A single Prisma client for the whole process.
 *
 * Next.js hot-reloads server modules on every edit in development, which would
 * otherwise create a new client — and a new connection pool — on each reload
 * until Postgres refuses new connections. Stashing the instance on globalThis
 * keeps exactly one across reloads. In production the module is evaluated once,
 * so the global is not used.
 */

const createPrismaClient = () =>
  new PrismaClient({
    adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
    log:
      env.NODE_ENV === "development"
        ? ["query", "warn", "error"]
        : ["warn", "error"],
  });

const globalForPrisma = globalThis as unknown as {
  prisma: ReturnType<typeof createPrismaClient> | undefined;
};

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

/**
 * Cheap round-trip used by the settings page to report connection health.
 * Never throws — a database that is down is a state the UI renders, not a
 * crash.
 */
export async function checkDatabaseConnection(): Promise<
  { ok: true; latencyMs: number } | { ok: false; message: string }
> {
  const startedAt = performance.now();

  try {
    await prisma.$queryRaw`SELECT 1`;
    return { ok: true, latencyMs: Math.round(performance.now() - startedAt) };
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof Error ? error.message : "Unknown database error",
    };
  }
}
