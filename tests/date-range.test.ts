import { describe, expect, it } from "vitest";

import {
  endOfDayExclusive,
  monthsAgo,
  readDate,
  readDateRange,
  readOne,
  startOfDay,
  toIsoDay,
} from "@/lib/date-range";
import { parseOrderListParams } from "@/lib/order-query";
import { parsePurchaseListParams } from "@/lib/purchase-query";
import { parseMovementListParams } from "@/lib/stock-movement-query";

/**
 * The shared date-range parsing, and the three parsers that now use it.
 *
 * This logic lived in three byte-identical copies before the reports module
 * would have made a fourth. The extraction is only safe if the behaviour it
 * replaced is pinned down, and two of those three parsers had no tests at all —
 * so the parser cases below exist to make the refactor safe rather than to
 * assume it was.
 *
 * The two rules worth protecting: a range is inclusive at both ends, and a
 * backwards range is swapped rather than returning nothing.
 */

describe("reading a query string", () => {
  it("takes the first value when a key repeats", () => {
    expect(readOne({ q: ["first", "second"] }, "q")).toBe("first");
  });

  it("treats blank and whitespace as absent", () => {
    expect(readOne({ q: "" }, "q")).toBeNull();
    expect(readOne({ q: "   " }, "q")).toBeNull();
    expect(readOne({}, "q")).toBeNull();
  });

  it("trims what it returns", () => {
    expect(readOne({ q: "  hello  " }, "q")).toBe("hello");
  });
});

describe("reading a date", () => {
  it("accepts a well-formed calendar day", () => {
    expect(readDate({ from: "2026-08-28" }, "from")).toBe("2026-08-28");
  });

  it("rejects anything that is not one", () => {
    /*
     * Shape-checked rather than parsed. `new Date("2026")` is a valid instant
     * in January, so handing a bare year to the query builder would silently
     * filter to a date nobody asked for.
     */
    for (const value of ["2026", "28-08-2026", "last tuesday", "2026-8-28", ""]) {
      expect(readDate({ from: value }, "from")).toBeNull();
    }
  });
});

describe("reading a range", () => {
  it("returns both bounds when both are given", () => {
    expect(readDateRange({ from: "2026-01-01", to: "2026-03-31" })).toEqual({
      from: "2026-01-01",
      to: "2026-03-31",
    });
  });

  it("swaps a backwards range rather than returning nothing", () => {
    // Somebody who types the dates the wrong way round gets what they meant,
    // not an empty table that looks like a bug.
    expect(readDateRange({ from: "2026-03-31", to: "2026-01-01" })).toEqual({
      from: "2026-01-01",
      to: "2026-03-31",
    });
  });

  it("leaves a one-sided range alone", () => {
    expect(readDateRange({ from: "2026-01-01" })).toEqual({
      from: "2026-01-01",
      to: null,
    });
    expect(readDateRange({ to: "2026-01-01" })).toEqual({
      from: null,
      to: "2026-01-01",
    });
  });
});

describe("turning a day into bounds", () => {
  it("starts at midnight UTC", () => {
    expect(startOfDay("2026-08-28").toISOString()).toBe(
      "2026-08-28T00:00:00.000Z",
    );
  });

  it("ends at midnight on the following day, exclusively", () => {
    /*
     * The bug this prevents: `<= 2026-08-28T00:00:00Z` would drop everything
     * that happened during the 28th, so a report for a single day would come
     * back empty and a report ending on the 28th would lose its last day of
     * business with nothing to indicate it.
     */
    expect(endOfDayExclusive("2026-08-28").toISOString()).toBe(
      "2026-08-29T00:00:00.000Z",
    );
  });

  it("crosses a month boundary", () => {
    expect(endOfDayExclusive("2026-08-31").toISOString()).toBe(
      "2026-09-01T00:00:00.000Z",
    );
  });

  it("crosses a year boundary", () => {
    expect(endOfDayExclusive("2026-12-31").toISOString()).toBe(
      "2027-01-01T00:00:00.000Z",
    );
  });
});

describe("relative windows", () => {
  it("counts months back from today", () => {
    const now = new Date("2026-08-28T12:00:00.000Z");
    expect(monthsAgo(12, now)).toBe("2025-08-28");
    expect(monthsAgo(3, now)).toBe("2026-05-28");
  });

  it("handles a month with fewer days", () => {
    // 31 March minus one month is not 31 February. JavaScript rolls forward,
    // which is the behaviour to know about rather than to be surprised by.
    const now = new Date("2026-03-31T12:00:00.000Z");
    expect(monthsAgo(1, now)).toBe("2026-03-03");
  });

  it("round-trips a date through the ISO day form", () => {
    expect(toIsoDay(new Date("2026-08-28T23:59:59.000Z"))).toBe("2026-08-28");
  });
});

// ---------------------------------------------------------------------------
// The three parsers that now share the logic
// ---------------------------------------------------------------------------

describe("the existing list parsers still behave the same", () => {
  const cases = [
    { name: "orders", parse: parseOrderListParams },
    { name: "purchases", parse: parsePurchaseListParams },
    { name: "stock movements", parse: parseMovementListParams },
  ] as const;

  for (const { name, parse } of cases) {
    describe(name, () => {
      it("reads a valid range", () => {
        const parsed = parse({ from: "2026-01-01", to: "2026-03-31" });
        expect(parsed.from).toBe("2026-01-01");
        expect(parsed.to).toBe("2026-03-31");
      });

      it("swaps a backwards range", () => {
        const parsed = parse({ from: "2026-03-31", to: "2026-01-01" });
        expect(parsed.from).toBe("2026-01-01");
        expect(parsed.to).toBe("2026-03-31");
      });

      it("discards a malformed date rather than passing it through", () => {
        const parsed = parse({ from: "not-a-date", to: "2026" });
        expect(parsed.from).toBeNull();
        expect(parsed.to).toBeNull();
      });

      it("defaults to no range at all", () => {
        const parsed = parse({});
        expect(parsed.from).toBeNull();
        expect(parsed.to).toBeNull();
      });

      it("ignores a sort key outside its whitelist", () => {
        const parsed = parse({ sort: "; DROP TABLE orders" });
        expect(parsed.sort).not.toContain("DROP");
      });
    });
  }
});
