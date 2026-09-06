import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@clerk/nextjs/server", async () => {
  const { clerkServerMock } = await import("./clerk-mock");
  return clerkServerMock;
});

import { SALEABLE_LOT_SQL, blockedStockHint } from "@/lib/lot-status";
import { prisma } from "@/lib/prisma";
import { lockProduct } from "@/server/stock";

import { signOut } from "./clerk-mock";
import { resetDatabase, seedProduct } from "./database";

/**
 * One definition of "saleable", and proof that nothing else defines it.
 *
 * The behaviour of quarantined stock is covered by tests/saleable-stock.test.ts.
 * This file is about the *architecture*: that the rule lives in one place, that
 * both queries which care about it are built from that place, and that a second
 * copy cannot quietly appear later.
 *
 * The last of those is the one worth having a test for at all. A duplicated
 * status literal would not fail anything — it would be correct on the day it
 * was written and would only diverge when a fourth status arrived, at which
 * point stock excluded from sale might still be counted as available. Nothing
 * would raise an error; the number would just be wrong.
 */

beforeEach(async () => {
  signOut();
  await resetDatabase();
});

describe("the shared saleability rule", () => {
  it("is the predicate the FIFO partial index was built on", () => {
    /*
     * `stock_lots_fifo_saleable_idx` is defined `WHERE status = 'SALEABLE'`.
     * Postgres can only match a partial index when the query's predicate is
     * provably implied by the index's, so this string has to stay identical to
     * the migration's — byte for byte, not merely equivalent.
     */
    expect(SALEABLE_LOT_SQL).toBe("status = 'SALEABLE'");
  });

  it("names the blocked quantity when there is one, and stays quiet otherwise", () => {
    expect(blockedStockHint(10, 0)).toBeNull();
    expect(blockedStockHint(10, -1)).toBeNull();

    expect(blockedStockHint(40, 10)).toContain("40 on hand");
    expect(blockedStockHint(40, 10)).toContain("10 units");
    expect(blockedStockHint(40, 1)).toContain("1 unit");
    expect(blockedStockHint(40, 1)).not.toContain("1 units");
  });
});

describe("no second definition of saleability", () => {
  /** Every .ts/.tsx under a directory, minus generated output. */
  function sourceFiles(dir: string): string[] {
    const found: string[] = [];

    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);

      if (statSync(full).isDirectory()) {
        if (entry === "generated" || entry === "node_modules") continue;
        found.push(...sourceFiles(full));
        continue;
      }

      if (/\.tsx?$/.test(entry)) found.push(full);
    }

    return found;
  }

  it("keeps every quoted lot-status literal inside lot-status.ts", () => {
    const root = join(process.cwd(), "src");
    const shared = join("src", "lib", "lot-status.ts");

    const offenders = sourceFiles(root)
      .map((file) => ({ file: relative(process.cwd(), file), body: readFileSync(file, "utf8") }))
      .filter(({ file }) => file.split(sep).join("/") !== shared.split(sep).join("/"))
      .filter(({ body }) => /['"](SALEABLE|QUARANTINED|REJECTED)['"]/.test(body))
      .map(({ file }) => file);

    /*
     * Production code asks about saleability through `SALEABLE_LOT_SQL`. A hit
     * here means somebody spelled a status out again — which is how the FIFO
     * scan and the blocked-quantity aggregate would come to disagree.
     */
    expect(offenders).toEqual([]);
  });

  it("has both status-sensitive queries importing the shared rule", () => {
    const stock = readFileSync(join(process.cwd(), "src", "server", "stock.ts"), "utf8");

    expect(stock).toContain('from "@/lib/lot-status"');
    // The FIFO scan and the blocked aggregate, both built from the one string.
    expect(stock.match(/Prisma\.raw\(SALEABLE_LOT_SQL\)/g) ?? []).toHaveLength(2);
  });
});

describe("blocked quantity is the negation of the same rule", () => {
  /*
   * The whitelist is the point. Had the aggregate been written as
   * `status = 'QUARANTINED'` it would be correct today and would silently let
   * rejected stock count as available the moment anything reached that state.
   * Both non-saleable statuses are asserted for exactly that reason.
   */
  for (const status of ["QUARANTINED", "REJECTED"] as const) {
    it(`counts ${status} lots as blocked, not saleable`, async () => {
      const product = await seedProduct({
        sku: `LS-${status}`,
        stockQuantity: 12,
        lotUnitCost: "100.00",
      });

      await prisma.stockLot.updateMany({
        where: { productId: product.id },
        data: {
          status,
          statusChangedAt: new Date(),
          statusNote: "Fixture — set directly for this test",
        },
      });

      const locked = await prisma.$transaction((tx) => lockProduct(tx, product.id));

      expect(locked.stockQuantity).toBe(12);
      expect(locked.blockedQuantity).toBe(12);
      expect(locked.saleableQuantity).toBe(0);
    });
  }

  it("counts a mix across both blocked statuses", async () => {
    const product = await seedProduct({
      sku: "LS-MIX",
      stockQuantity: 4,
      lotUnitCost: "100.00",
    });

    await prisma.stockLot.updateMany({
      where: { productId: product.id },
      data: {
        status: "QUARANTINED",
        statusChangedAt: new Date(),
        statusNote: "Fixture",
      },
    });

    await prisma.stockLot.create({
      data: {
        productId: product.id,
        unitCost: "100.00",
        costSource: "OPENING",
        quantityReceived: 5,
        quantityRemaining: 5,
        sourceType: "MANUAL",
        sourceId: null,
        receivedAt: new Date(),
        status: "REJECTED",
        statusChangedAt: new Date(),
        statusNote: "Fixture",
      },
    });

    await prisma.stockLot.create({
      data: {
        productId: product.id,
        unitCost: "100.00",
        costSource: "OPENING",
        quantityReceived: 6,
        quantityRemaining: 6,
        sourceType: "MANUAL",
        sourceId: null,
        receivedAt: new Date(),
      },
    });

    await prisma.product.update({
      where: { id: product.id },
      data: { stockQuantity: 15 },
    });

    const locked = await prisma.$transaction((tx) => lockProduct(tx, product.id));

    expect(locked.stockQuantity).toBe(15);
    expect(locked.blockedQuantity).toBe(9);
    expect(locked.saleableQuantity).toBe(6);
  });

  it("reports nothing blocked when every lot is saleable", async () => {
    const product = await seedProduct({
      sku: "LS-CLEAN",
      stockQuantity: 7,
      lotUnitCost: "100.00",
    });

    const locked = await prisma.$transaction((tx) => lockProduct(tx, product.id));

    expect(locked.stockQuantity).toBe(7);
    expect(locked.blockedQuantity).toBe(0);
    expect(locked.saleableQuantity).toBe(7);
  });
});
