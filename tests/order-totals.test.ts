import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";

import { resetDatabase } from "./database";

/**
 * Order totals, and the absence of both tax and discount.
 *
 * Removing a feature is harder to prove than adding one. A column can be
 * dropped while a form still posts the field, a calculation can be deleted
 * while a stale helper still adds it back, and nothing fails loudly — the
 * numbers are simply wrong in a way that looks plausible. These tests check the
 * places a removed money term could survive: the database schema, the
 * generated client, the arithmetic, and the source.
 *
 * Tax went first (§ the `remove_order_tax` migration). Discount followed (§20),
 * and this file is the proof for both, because they can fail in exactly the
 * same ways.
 *
 * One asymmetry is deliberate. `orderSchema` is a plain `z.object`, so Zod
 * strips unknown keys rather than rejecting them — a stale browser posting
 * `discount` after deployment has it silently ignored instead of erroring,
 * which is the behaviour we want in production and the reason the source scan
 * below covers `tests` as well as `src`. Nothing else would catch a caller
 * that still thinks the field exists.
 */

beforeEach(async () => {
  await resetDatabase();
});

async function createCustomer() {
  return prisma.customer.create({ data: { name: "Contoso Aviation" } });
}

// ---------------------------------------------------------------------------
// The schema
// ---------------------------------------------------------------------------

describe("the orders table", () => {
  it("has no tax column", async () => {
    const columns = await prisma.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'orders'
    `;

    const names = columns.map((column) => column.column_name);

    expect(names).toContain("subtotal");
    expect(names).toContain("total");
    expect(names).not.toContain("tax");
    expect(names).not.toContain("discount");
  });

  it("has no discount-related check constraint left", async () => {
    const constraints = await prisma.$queryRaw<
      { conname: string; def: string }[]
    >`
      SELECT conname, pg_get_constraintdef(oid) AS def
      FROM pg_constraint
      WHERE conrelid = 'orders'::regclass AND contype = 'c'
    `;

    for (const constraint of constraints) {
      expect(constraint.def).not.toMatch(/discount/i);
      expect(constraint.def).not.toMatch(/tax/i);
    }

    // And the one that replaced them is actually present.
    const balances = constraints.find((c) => c.conname === "orders_total_balances");
    expect(balances?.def.replace(/[()"\s]/g, "")).toBe("CHECKtotal=subtotal");
  });

  it("has no tax or discount column anywhere in the database", async () => {
    // Not just `orders`: either one on order_items or purchases would be the
    // same feature wearing a different table.
    const columns = await prisma.$queryRaw<
      { table_name: string; column_name: string }[]
    >`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public'
        AND (column_name ILIKE '%tax%' OR column_name ILIKE '%discount%')
    `;

    expect(columns).toEqual([]);
  });

  it("is not exposed as a field by the Prisma client", async () => {
    const customer = await createCustomer();
    const order = await prisma.order.create({
      data: {
        orderNumber: "SO-TEST-0001",
        customerId: customer.id,
        subtotal: "100.00",
        total: "100.00",
      },
    });

    // The generated types would already refuse either at compile time; this
    // catches a client generated from a stale schema at runtime.
    expect(Object.keys(order)).not.toContain("tax");
    expect(Object.keys(order)).not.toContain("discount");
  });
});

// ---------------------------------------------------------------------------
// The arithmetic
// ---------------------------------------------------------------------------

describe("the grand total", () => {
  it("equals the subtotal, always", async () => {
    const customer = await createCustomer();

    const order = await prisma.order.create({
      data: {
        orderNumber: "SO-TEST-0003",
        customerId: customer.id,
        subtotal: "537.96",
        total: "537.96",
      },
    });

    expect(order.total.toString()).toBe(order.subtotal.toString());
  });

  it("is refused by the database when it does not balance", async () => {
    const customer = await createCustomer();

    // A total larger than the subtotal is what a tax term would produce, and a
    // smaller one is what a discount would. The constraint rejects both, so
    // neither can be reintroduced by a caller doing the arithmetic itself.
    await expect(
      prisma.order.create({
        data: {
          orderNumber: "SO-TEST-0004",
          customerId: customer.id,
          subtotal: "100.00",
          total: "110.00",
        },
      }),
    ).rejects.toThrow();

    expect(await prisma.order.count()).toBe(0);
  });

  it("refuses a total below the subtotal, which is what a discount would be", async () => {
    const customer = await createCustomer();

    await expect(
      prisma.order.create({
        data: {
          orderNumber: "SO-TEST-0005",
          customerId: customer.id,
          subtotal: "50.00",
          total: "40.00",
        },
      }),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// The source
// ---------------------------------------------------------------------------

/**
 * Walks the application source, skipping generated code.
 *
 * `src/generated` is Prisma's output: it is rewritten by `prisma generate` and
 * reflects the schema, so scanning it would be testing Prisma rather than this
 * codebase. If tax came back to the schema, the two database tests above would
 * catch it first.
 */
async function sourceFiles(root: string): Promise<string[]> {
  const found: string[] = [];

  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);

      if (entry.isDirectory()) {
        if (entry.name === "generated" || entry.name === "node_modules") continue;
        await walk(path);
      } else if ([".ts", ".tsx"].includes(extname(entry.name))) {
        found.push(path);
      }
    }
  }

  await walk(root);
  return found;
}

/**
 * Strips comments, so prose explaining *why* there is no tax does not read as
 * tax logic.
 *
 * Deliberately crude — it does not understand strings containing `//`, and it
 * does not need to. Erring towards stripping too much would hide a real usage,
 * so the patterns below are matched against identifiers rather than the bare
 * word, which keeps a false negative from being silent.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/*
 * Identifiers rather than the bare word. `tax:` as an object key, `.discount`
 * as a property read, `taxRate` / `discountPct` / `discountCents` as variables
 * — the shapes a removed money term would actually take in code. Matching the
 * word itself would flag the sentence "there is deliberately no discount
 * column" and train everyone to ignore these tests.
 */
const REMOVED_TERM_PATTERNS = [
  /\btax\s*:/i,
  /\.tax\b/i,
  /\btax(Rate|Amount|Total|Pct|Percent|Cents|able)\b/i,
  /\bgst\s*:/i,
  /\bcalculateTax\b/i,
  /\bdiscount\s*:/i,
  /\.discount\b/i,
  /\bdiscount(Rate|Amount|Total|Pct|Percent|Cents|TooLarge)\b/i,
];

async function offendingFiles(files: string[]): Promise<string[]> {
  const offenders: string[] = [];

  for (const file of files) {
    const code = stripComments(await readFile(file, "utf8"));

    for (const pattern of REMOVED_TERM_PATTERNS) {
      const match = pattern.exec(code);
      if (match) {
        offenders.push(`${relative(".", file)}: ${match[0]}`);
        break;
      }
    }
  }

  return offenders;
}

describe("the source tree", () => {
  it("contains no tax or discount logic in the application code", async () => {
    const files = await sourceFiles("src");
    expect(files.length).toBeGreaterThan(30);

    expect(await offendingFiles(files)).toEqual([]);
  });

  /*
   * The tests too, and this one is load-bearing rather than tidiness.
   *
   * `orderSchema` is a plain `z.object`, so Zod strips an unknown `discount`
   * instead of rejecting it. That is deliberate — a stale browser posting the
   * old field after deployment should be ignored, not error — but the cost of
   * the leniency is that a caller which still sends `discount` fails silently
   * and for ever. Nothing else in this suite would notice. This does.
   */
  it("contains no tax or discount logic in the tests", async () => {
    /*
     * This file is excluded from its own scan, and for a dull reason rather
     * than a convenient one: it is where the patterns are written down, so it
     * necessarily contains every shape they match. `stripComments` removes
     * prose, not regex literals. Excluding one file by name is a smaller hole
     * than loosening the patterns until they stop matching themselves.
     */
    const files = (await sourceFiles("tests")).filter(
      (file) => !file.endsWith("order-totals.test.ts"),
    );
    expect(files.length).toBeGreaterThan(10);

    expect(await offendingFiles(files)).toEqual([]);
  });

  it("contains no tax or discount logic in the seed or the schema", async () => {
    for (const path of ["prisma/seed.ts", "prisma/schema.prisma"]) {
      const source = await readFile(path, "utf8");
      const code =
        path.endsWith(".prisma")
          ? source.replace(/^\s*\/\/.*$/gm, "").replace(/^\s*\/\/\/.*$/gm, "")
          : stripComments(source);

      expect(code).not.toMatch(/\btax\s*:/i);
      expect(code).not.toMatch(/\btax(Pct|Cents|Rate|Amount)\b/i);
      expect(code).not.toMatch(/\bdiscount\s*:/i);
      expect(code).not.toMatch(/\bdiscount(Pct|Cents|Rate|Amount)\b/i);
      // Either column in the model body would be a bare identifier followed by
      // a Prisma type.
      expect(code).not.toMatch(/^\s*tax\s+Decimal/m);
      expect(code).not.toMatch(/^\s*discount\s+Decimal/m);
    }
  });
});
