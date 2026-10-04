import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Three boundaries the authentication rewrite has to keep, checked by reading
 * the source.
 *
 * A grep is the only thing that catches the *next* violation. A unit test cannot:
 * each failure mode here is an import that should not exist, and code that
 * shouldn't be there passes every test written about the code that should.
 *
 *   1. No Clerk component is rendered by the application any more.
 *   2. No client component can reach a service-role credential.
 *   3. No client component reads application data through PostgREST.
 *
 * The second and third are the ones with teeth. `anon` and `authenticated` hold
 * no privilege on any table (see the 20261004120000 migration), so a PostgREST
 * query would fail rather than leak — but the way someone would "fix" that
 * failure is by granting the privilege back, and then it leaks. Catching the
 * query is catching the first step.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(ROOT, "src");

function sourceFiles(dir: string): string[] {
  const found: string[] = [];

  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);

    if (statSync(path).isDirectory()) {
      // Prisma's generated client is not ours to police.
      if (entry === "generated") continue;
      found.push(...sourceFiles(path));
      continue;
    }

    if (/\.tsx?$/.test(entry)) found.push(path);
  }

  return found;
}

const FILES = sourceFiles(SRC).map((path) => ({
  path: relative(ROOT, path).split(sep).join("/"),
  source: readFileSync(path, "utf8"),
}));

/** Lines that are only commentary. Imports are what matter, not prose about them. */
function codeLines(source: string): string[] {
  return source
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      return (
        trimmed !== "" &&
        !trimmed.startsWith("//") &&
        !trimmed.startsWith("*") &&
        !trimmed.startsWith("/*")
      );
    });
}

const clientFiles = () => FILES.filter((file) => /^\s*"use client"/m.test(file.source));

describe("no Clerk component is rendered any more", () => {
  /*
   * `src/server/auth.ts` keeps `currentUser` from the server SDK as rollback-only
   * migration code, which is deliberate and is not a component. Everything else
   * must be free of Clerk.
   */
  const ALLOWED_SERVER_SDK_IMPORT = "src/server/auth.ts";

  it("imports no Clerk UI component anywhere", () => {
    const offenders = FILES.filter((file) => {
      if (file.path === ALLOWED_SERVER_SDK_IMPORT) return false;

      return codeLines(file.source).some((line) =>
        /from\s+["']@clerk\/nextjs["']/.test(line),
      );
    }).map((file) => file.path);

    expect(offenders).toEqual([]);
  });

  it("names none of the Clerk components in executable code", () => {
    const components = [
      "ClerkProvider",
      "SignInButton",
      "UserButton",
      "clerkMiddleware",
    ];

    const offenders: string[] = [];

    for (const file of FILES) {
      for (const line of codeLines(file.source)) {
        for (const component of components) {
          // `<Component` or a bare identifier in an import list.
          if (new RegExp(`<${component}\\b|\\b${component}\\s*[,}]`).test(line)) {
            offenders.push(`${file.path}: ${component}`);
          }
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("keeps only the server-SDK import, and only in the legacy resolver", () => {
    const withClerk = FILES.filter((file) =>
      codeLines(file.source).some((line) => /@clerk\//.test(line)),
    ).map((file) => file.path);

    expect(withClerk).toEqual([ALLOWED_SERVER_SDK_IMPORT]);
  });
});

describe("no client component can reach a privileged credential", () => {
  it("names no service-role variable in a client component", () => {
    const offenders = clientFiles()
      .filter((file) => /SERVICE_ROLE|service_role/.test(file.source))
      .map((file) => file.path);

    expect(offenders).toEqual([]);
  });

  /*
   * `src/lib/env.ts` is `server-only`, so importing it from a client component is
   * a build error rather than a leak — but the build error arrives late and reads
   * obscurely, and this says what the actual rule is.
   */
  it("imports the server-only env module from no client component", () => {
    const offenders = clientFiles()
      .filter((file) =>
        codeLines(file.source).some((line) =>
          /from\s+["']@\/lib\/env["']/.test(line),
        ),
      )
      .map((file) => file.path);

    expect(offenders).toEqual([]);
  });

  it("imports the server Supabase client from no client component", () => {
    const offenders = clientFiles()
      .filter((file) =>
        codeLines(file.source).some((line) =>
          /from\s+["']@\/lib\/supabase\/server["']/.test(line),
        ),
      )
      .map((file) => file.path);

    expect(offenders).toEqual([]);
  });
});

describe("the browser Supabase client is used for auth and nothing else", () => {
  /**
   * The PostgREST surface of supabase-js. `.auth.` is the permitted one; these
   * are the calls that would read or write application data, which belongs to
   * Prisma on the server.
   */
  const DATA_API_CALLS = [
    /\.from\s*\(/,
    /\.rpc\s*\(/,
    /\.schema\s*\(/,
  ];

  it("calls no PostgREST method on a Supabase client", () => {
    const offenders: string[] = [];

    for (const file of FILES) {
      // Only files that actually hold a Supabase client can misuse one.
      if (!/createSupabase(Browser|Server)Client|createServerClient|createBrowserClient/.test(file.source)) {
        continue;
      }

      for (const line of codeLines(file.source)) {
        if (!/supabase\s*\./.test(line)) continue;
        if (DATA_API_CALLS.some((pattern) => pattern.test(line))) {
          offenders.push(`${file.path}: ${line.trim()}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("uses the browser client only through supabase.auth", () => {
    const uses: string[] = [];

    for (const file of clientFiles()) {
      if (!/createSupabaseBrowserClient/.test(file.source)) continue;

      for (const line of codeLines(file.source)) {
        const match = /supabase\.(\w+)/.exec(line);
        if (match?.[1]) uses.push(match[1]);
      }
    }

    // Every property reached on a browser client, deduplicated.
    expect([...new Set(uses)]).toEqual(["auth"]);
  });
});
