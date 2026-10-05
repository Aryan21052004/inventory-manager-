import { beforeEach, describe, expect, it } from "vitest";

import { searchOrderProductsAction } from "@/app/(app)/orders/actions";
import { searchPurchaseProductsAction } from "@/app/(app)/purchases/actions";
import { searchOrderProducts } from "@/server/orders";
import { searchPurchaseProducts } from "@/server/purchases";

import { signOutSupabase } from "./supabase-auth-mock";
import { resetDatabase, seedProduct, signInWithRole } from "./database";

/**
 * The product-search Server Actions, and the session they must not assume.
 *
 * These two were the only mutating-or-reading `"use server"` exports in the
 * application that never checked who was calling. That is not the same as being
 * unreachable: a Server Action is a public HTTP endpoint whose id is recoverable
 * from the client bundle, and the `(app)` layout's session check runs during
 * *render* — after an action has already run. Signed out, they answered with the
 * catalogue: names, SKUs, selling prices, stock levels, and on the purchase side
 * the last price paid to a supplier.
 *
 * What follows is deliberately narrow. It proves the door is shut, that both
 * roles still get through it, and — the part worth as much as the refusal —
 * that shutting it changed nothing about what comes back.
 */

beforeEach(async () => {
  signOutSupabase();
  await resetDatabase();
});

/** Two active products and one retired, so "unchanged" has something to say. */
async function catalogue() {
  await seedProduct({
    sku: "SEARCH-A",
    name: "Alpha Bracket",
    sellingPrice: "25.00",
    stockQuantity: 7,
  });
  await seedProduct({
    sku: "SEARCH-B",
    name: "Beta Bracket",
    sellingPrice: "35.00",
    stockQuantity: 3,
  });
  await seedProduct({
    sku: "SEARCH-GONE",
    name: "Retired Bracket",
    sellingPrice: "15.00",
    stockQuantity: 1,
    status: "DISCONTINUED",
  });
}

describe("searchOrderProductsAction", () => {
  it("refuses a signed-out caller", async () => {
    await catalogue();

    /*
     * The standard failure, not a special one and not an empty list. An empty
     * list would be the dangerous outcome: indistinguishable from a search that
     * matched nothing, so a regression here would look like ordinary behaviour.
     */
    await expect(searchOrderProductsAction("Bracket")).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  it("refuses a signed-out caller even with an empty search", async () => {
    await catalogue();

    // The empty term is the one that returns the whole catalogue, so it is the
    // query an unauthenticated caller would actually have sent.
    await expect(searchOrderProductsAction("")).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  it("lets STAFF search", async () => {
    await signInWithRole("STAFF");
    await catalogue();

    const results = await searchOrderProductsAction("Bracket");

    expect(results.map((row) => row.sku).sort()).toEqual([
      "SEARCH-A",
      "SEARCH-B",
    ]);
  });

  it("lets ADMIN search", async () => {
    await signInWithRole("ADMIN");
    await catalogue();

    const results = await searchOrderProductsAction("Bracket");

    expect(results.map((row) => row.sku).sort()).toEqual([
      "SEARCH-A",
      "SEARCH-B",
    ]);
  });

  it("returns exactly what the underlying search returns", async () => {
    await signInWithRole("STAFF");
    await catalogue();

    /*
     * The guarantee that the fix was a gate and not a change. The action must
     * still be a pass-through: same rows, same order, same fields, including
     * the ACTIVE-only rule and the null-safe selling price.
     */
    for (const term of ["", "Bracket", "SEARCH-A", "nothing matches this"]) {
      expect(await searchOrderProductsAction(term)).toEqual(
        await searchOrderProducts(term),
      );
    }
  });

  it("still excludes retired products", async () => {
    await signInWithRole("STAFF");
    await catalogue();

    const results = await searchOrderProductsAction("");

    expect(results.some((row) => row.sku === "SEARCH-GONE")).toBe(false);
  });
});

describe("searchPurchaseProductsAction", () => {
  it("refuses a signed-out caller", async () => {
    await catalogue();

    await expect(searchPurchaseProductsAction("Bracket")).rejects.toMatchObject(
      { code: "UNAUTHORIZED" },
    );
  });

  it("refuses a signed-out caller even with an empty search", async () => {
    await catalogue();

    await expect(searchPurchaseProductsAction("")).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  it("lets STAFF search", async () => {
    await signInWithRole("STAFF");
    await catalogue();

    const results = await searchPurchaseProductsAction("Bracket");

    expect(results.map((row) => row.sku).sort()).toEqual([
      "SEARCH-A",
      "SEARCH-B",
    ]);
  });

  it("lets ADMIN search", async () => {
    await signInWithRole("ADMIN");
    await catalogue();

    const results = await searchPurchaseProductsAction("Bracket");

    expect(results.map((row) => row.sku).sort()).toEqual([
      "SEARCH-A",
      "SEARCH-B",
    ]);
  });

  it("returns exactly what the underlying search returns", async () => {
    await signInWithRole("STAFF");
    await catalogue();

    for (const term of ["", "Bracket", "SEARCH-B", "nothing matches this"]) {
      expect(await searchPurchaseProductsAction(term)).toEqual(
        await searchPurchaseProducts(term),
      );
    }
  });

  it("still reports the last paid cost it always did", async () => {
    await signInWithRole("STAFF");
    await catalogue();

    // The field that made this the more sensitive of the two. It must still be
    // present for a signed-in caller — the gate was the fix, not its removal.
    const results = await searchPurchaseProductsAction("SEARCH-A");

    expect(results).toHaveLength(1);
    expect(results[0]).toHaveProperty("lastPaidUnitCost");
  });
});

describe("no unauthenticated search remains", () => {
  /**
   * Both actions, checked as a set.
   *
   * Written as one test over a list rather than two more cases so that the
   * question it answers is the audit's question — "is there an unauthenticated
   * search action left?" — rather than a pair of assertions that happen to
   * cover today's two.
   */
  it("refuses every product-search action while signed out", async () => {
    await catalogue();

    const actions = [
      ["order", searchOrderProductsAction],
      ["purchase", searchPurchaseProductsAction],
    ] as const;

    for (const [label, action] of actions) {
      await expect(action("Bracket"), label).rejects.toMatchObject({
        code: "UNAUTHORIZED",
      });
    }

    /*
     * And the refusals above are the gate rather than an empty catalogue.
     *
     * Without this the whole file could pass against a database that simply had
     * nothing in it. The underlying functions are unguarded by design — they
     * are called during page renders that sit behind the layout check, and they
     * swallow their own errors — so signed out they still return these rows.
     * That is precisely what the actions were handing out, and no longer do.
     */
    expect(await searchOrderProducts("Bracket")).toHaveLength(2);
    expect(await searchPurchaseProducts("Bracket")).toHaveLength(2);
  });
});
