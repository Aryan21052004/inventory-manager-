import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";

import { resetDatabase } from "./database";

/**
 * Order totals, and the absence of tax.
 *
 * Removing a feature is harder to prove than adding one. A column can be
 * dropped while a form still posts the field, a calculation can be deleted
 * while a stale helper still adds it back, and nothing fails loudly — the
 * numbers are simply wrong in a way that looks plausible. These tests check the
 * three places tax could survive: the database schema, the arithmetic, and the
 * source.
 *
 * Orders themselves are not built yet. What exists is the table, the check
 * constraint, and the rule; that rule is what is pinned here, so the module
 * built on top of it inherits a total that already cannot include tax.
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
    expect(names).toContain("discount");
    expect(names).toContain("total");
    expect(names).not.toContain("tax");
  });

  it("has no tax column anywhere in the database", async () => {
    // Not just `orders`: a tax column on order_items or purchases would be the
    // same feature wearing a different table.
    const columns = await prisma.$queryRaw<
      { table_name: string; column_name: string }[]
    >`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name ILIKE '%tax%'
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
        discount: "10.00",
        total: "90.00",
      },
    });

    // The generated types would already refuse `tax` at compile time; this
    // catches a client generated from a stale schema at runtime.
    expect(Object.keys(order)).not.toContain("tax");
  });
});

// ---------------------------------------------------------------------------
// The arithmetic
// ---------------------------------------------------------------------------

describe("the grand total", () => {
  it("is the subtotal minus the discount", async () => {
    const customer = await createCustomer();

    const order = await prisma.order.create({
      data: {
        orderNumber: "SO-TEST-0002",
        customerId: customer.id,
        subtotal: "1454.79",
        discount: "72.74",
        total: "1382.05",
      },
    });

    expect(Number(order.total)).toBe(
      Number(order.subtotal) - Number(order.discount),
    );
  });

  it("equals the subtotal when nothing is discounted", async () => {
    const customer = await createCustomer();

    const order = await prisma.order.create({
      data: {
        orderNumber: "SO-TEST-0003",
        customerId: customer.id,
        subtotal: "537.96",
        discount: "0.00",
        total: "537.96",
      },
    });

    expect(order.total.toString()).toBe(order.subtotal.toString());
  });

  it("is refused by the database when it does not balance", async () => {
    const customer = await createCustomer();

    // 100 - 10 + 20 tax = 110. Exactly the total the old formula produced, and
    // exactly what the check constraint now exists to reject — so tax cannot be
    // reintroduced by a caller doing the arithmetic itself.
    await expect(
      prisma.order.create({
        data: {
          orderNumber: "SO-TEST-0004",
          customerId: customer.id,
          subtotal: "100.00",
          discount: "10.00",
          total: "110.00",
        },
      }),
    ).rejects.toThrow();

    expect(await prisma.order.count()).toBe(0);
  });

  it("refuses a discount larger than the subtotal", async () => {
    const customer = await createCustomer();

    await expect(
      prisma.order.create({
        data: {
          orderNumber: "SO-TEST-0005",
          customerId: customer.id,
          subtotal: "50.00",
          discount: "60.00",
          total: "-10.00",
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

describe("the source tree", () => {
  it("contains no tax logic in the application code", async () => {
    const files = await sourceFiles("src");
    expect(files.length).toBeGreaterThan(30);

    /*
     * Identifiers rather than the word. `tax:` as an object key, `.tax` as a
     * property read, `taxRate`/`taxAmount`/`taxTotal`/`taxPct` as variables —
     * the shapes tax would actually take in code. Matching the bare word would
     * flag the sentence "there is deliberately no tax column" and train
     * everyone to ignore this test.
     */
    const patterns = [
      /\btax\s*:/i,
      /\.tax\b/i,
      /\btax(Rate|Amount|Total|Pct|Percent|Cents|able)\b/i,
      /\bgst\s*:/i,
      /\bcalculateTax\b/i,
    ];

    const offenders: string[] = [];

    for (const file of files) {
      const code = stripComments(await readFile(file, "utf8"));

      for (const pattern of patterns) {
        const match = pattern.exec(code);
        if (match) {
          offenders.push(`${relative(".", file)}: ${match[0]}`);
          break;
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("contains no tax logic in the seed or the schema", async () => {
    for (const path of ["prisma/seed.ts", "prisma/schema.prisma"]) {
      const source = await readFile(path, "utf8");
      const code =
        path.endsWith(".prisma")
          ? source.replace(/^\s*\/\/.*$/gm, "").replace(/^\s*\/\/\/.*$/gm, "")
          : stripComments(source);

      expect(code).not.toMatch(/\btax\s*:/i);
      expect(code).not.toMatch(/\btax(Pct|Cents|Rate|Amount)\b/i);
      // A `tax` column in the model body would be a bare identifier followed by
      // a Prisma type.
      expect(code).not.toMatch(/^\s*tax\s+Decimal/m);
    }
  });
});
