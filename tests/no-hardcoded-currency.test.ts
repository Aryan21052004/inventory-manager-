import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * No currency symbol is written by hand anywhere in the application.
 *
 * This exists because one was, and for a long time. `src/app/(app)/lots/
 * actions.ts` interpolated a literal `₹` in front of an unformatted decimal, so
 * a write-off toast read "₹1234.5" while every screen behind it read
 * "$1,234.50" — the app had two currencies, and neither was a setting.
 *
 * A grep over the repository is the only check that catches the *next* one. A
 * unit test on the formatter cannot: the failure mode is precisely a string
 * that never reaches the formatter.
 *
 * The rule: symbols come from `Intl` via src/lib/currency.ts, which is the one
 * file allowed to name them, and it names them only as labels for a menu.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(ROOT, "src");

/**
 * A currency symbol written by hand.
 *
 * `₹` and `€` have no other meaning in TypeScript, so any occurrence is one.
 * `$` is the awkward one — it opens every template interpolation (`${x}`),
 * prefixes every Prisma client method (`prisma.$transaction`) and anchors every
 * regex — so it counts only in the shapes a *price* actually takes:
 *
 *   `$1,234.56`   a symbol in front of a literal amount
 *   `` `$${x}` `` a symbol in front of an interpolated one, which is exactly
 *                 the shape the rupee bug had
 *   `"$"`         the symbol on its own, ready to be concatenated
 */
const SYMBOL_PATTERNS: readonly RegExp[] = [
  /₹/,
  /€/,
  /(?<![\w.$])\$(?=\d)/,
  /\$(?=\$\{)/,
  /["'`]\s*\$\s*["'`]/,
];

function hasHardCodedSymbol(line: string): boolean {
  return SYMBOL_PATTERNS.some((pattern) => pattern.test(line));
}

/**
 * Files that may legitimately contain a currency symbol.
 *
 * Exactly one, and it is the module that centralises them. Adding to this list
 * is how the bug above comes back, so anything new here wants a reason in the
 * commit that adds it.
 */
const ALLOWED = new Set(["src/lib/currency.ts"]);

/**
 * Generated and non-source trees. `src/generated` is the Prisma client — it
 * embeds the schema, including the rupee figures in its prose comments, and it
 * is not written by hand.
 */
const SKIPPED_DIRS = new Set(["generated", "node_modules"]);

function sourceFiles(dir: string): string[] {
  const found: string[] = [];

  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);

    if (statSync(path).isDirectory()) {
      if (SKIPPED_DIRS.has(entry)) continue;
      found.push(...sourceFiles(path));
      continue;
    }

    if (/\.(ts|tsx)$/.test(entry)) found.push(path);
  }

  return found;
}

/**
 * The file with its comments removed.
 *
 * Prose is not shipped behaviour, and this codebase's comments are full of
 * legitimate rupee figures — "the same part bought at ₹8,000, then ₹9,500" is
 * documentation of a costing rule, not a hard-coded symbol. Stripping them
 * keeps the check on the code.
 *
 * Block comments go wholesale; line comments only when the line is entirely a
 * comment. That second rule is deliberately conservative: stripping from `//`
 * to end-of-line would also eat the tail of any line containing a URL, and a
 * check that quietly removes code is a check that stops finding things.
 */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      return !trimmed.startsWith("//") && !trimmed.startsWith("*");
    })
    .join("\n");
}

describe("no hard-coded currency symbols", () => {
  const files = sourceFiles(SRC);

  /**
   * The detector, proved against known-bad and known-good lines.
   *
   * Without this the suite's most important assertion could pass because the
   * regex matches nothing at all, which is the failure mode every grep-based
   * test has. The first case is the exact line this rule was written for.
   */
  describe("the detector itself", () => {
    it("catches the shapes a hard-coded symbol takes", () => {
      const bad = [
        "        : `₹${outcome.writtenOffValue}`;",
        '        return "$" + amount;',
        "        const label = `$${total}`;",
        '        <span>$1,234.56</span>',
        '        hint="€0.00"',
      ];

      for (const line of bad) {
        expect(hasHardCodedSymbol(line), line).toBe(true);
      }
    });

    it("leaves ordinary TypeScript alone", () => {
      const good = [
        "        if (id) revalidatePath(`/customers/${id}`);",
        "        return prisma.$transaction(async (tx) => {",
        "        const rows = await prisma.$queryRaw<Row[]>`SELECT 1`;",
        "        if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;",
        "        message: `\"${customer.name}\" added.`,",
        "        const id = (name: string) => `${fieldId}-${name}`;",
      ];

      for (const line of good) {
        expect(hasHardCodedSymbol(line), line).toBe(false);
      }
    });
  });

  it("finds source files to check", () => {
    // A broken walk would make every assertion below vacuously true.
    expect(files.length).toBeGreaterThan(100);
  });

  it("has no currency symbol outside src/lib/currency.ts", () => {
    const offenders: string[] = [];

    for (const file of files) {
      const rel = relative(ROOT, file).split(sep).join("/");
      if (ALLOWED.has(rel)) continue;

      const code = withoutComments(readFileSync(file, "utf8"));

      for (const [index, line] of code.split("\n").entries()) {
        if (hasHardCodedSymbol(line)) {
          offenders.push(`${rel}:${index + 1} → ${line.trim()}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  /**
   * The one file that may name symbols may only name them as labels. If
   * `formatMoney` ever built a string out of a symbol rather than asking `Intl`
   * for one, the lakh grouping and the symbol placement would both become our
   * problem to get right in three locales.
   */
  it("keeps src/lib/currency.ts using Intl rather than string concatenation", () => {
    const source = readFileSync(join(SRC, "lib", "currency.ts"), "utf8");

    expect(source).toContain("Intl.NumberFormat");
    // Symbols appear only in the label table, never interpolated into output.
    expect(source).not.toMatch(/`\s*\$\{/);
    expect(source).not.toMatch(/["'`]₹["'`]\s*\+/);
  });

  /**
   * The old module-level constant must not come back. It is what made every
   * call site render dollars silently, and a default on `formatCurrency` would
   * be the same mistake wearing a different name.
   */
  it("does not reintroduce a module-level currency constant", () => {
    // Without comments: the module documents the constant it removed, and
    // that prose must not read as a reintroduction.
    const format = withoutComments(
      readFileSync(join(SRC, "lib", "format.ts"), "utf8"),
    );

    expect(format).not.toMatch(/const\s+CURRENCY\s*=/);
    expect(format).not.toMatch(/currency\s*[:=]\s*["']USD["']/);
    // The parameter is required: no `currency = ` default in the signature.
    expect(format).not.toMatch(/currency\s*:\s*Currency\s*=/);
  });
});
