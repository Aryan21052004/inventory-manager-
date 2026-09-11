import { describe, expect, it } from "vitest";

import {
  groupTotals,
  isMixed,
  NO_MONEY,
  soleAmount,
  soleCurrency,
  sumByCurrency,
} from "@/lib/money-by-currency";

/**
 * The rules every monetary aggregate in the application now obeys.
 *
 * There are no exchange rates here and there never will be, so the one thing
 * these helpers must never do is turn two currencies into one number. The
 * tests below are mostly about the ways that could happen by accident: a
 * quiet re-sum, a null currency treated as "unset" and filled in, an empty
 * total flattened to zero, a single figure produced for a caller who asked
 * for one when no defensible single figure exists.
 */

describe("groupTotals", () => {
  it("keeps one entry per currency and never adds across them", () => {
    const total = groupTotals([
      { currency: "USD", amount: "100.00" },
      { currency: "INR", amount: "8000.00" },
    ]);

    expect(total).toEqual([
      { currency: "USD", amount: "100.00" },
      { currency: "INR", amount: "8000.00" },
    ]);
  });

  it("orders by the canonical currency list, with the unknown one last", () => {
    const total = groupTotals([
      { currency: null, amount: "5.00" },
      { currency: "INR", amount: "3.00" },
      { currency: "USD", amount: "1.00" },
    ]);

    expect(total.map((entry) => entry.currency)).toEqual(["USD", "INR", null]);
  });

  it("keeps a currency whose rows summed to zero", () => {
    // Different from "no rows in that currency", and the difference matters:
    // one is a business with no euro trade, the other is euro trade netting
    // out. Dropping the entry would make them indistinguishable.
    expect(groupTotals([{ currency: "EUR", amount: "0.00" }])).toEqual([
      { currency: "EUR", amount: "0.00" },
    ]);
  });

  it("reads a null amount as zero rather than dropping the currency", () => {
    expect(groupTotals([{ currency: "USD", amount: null }])).toEqual([
      { currency: "USD", amount: "0.00" },
    ]);
  });

  it("normalises every amount to the two places the columns carry", () => {
    /*
     * Raw SQL casting a numeric(12, 2) gives "400.00"; a Prisma groupBy
     * Decimal gives "400". The same money, and two loaders that disagree
     * about it will not compare equal — so the punctuation is settled here
     * rather than at every consumer.
     */
    expect(
      groupTotals([
        { currency: "USD", amount: "400" },
        { currency: "INR", amount: "15000.5" },
      ]),
    ).toEqual([
      { currency: "USD", amount: "400.00" },
      { currency: "INR", amount: "15000.50" },
    ]);
  });

  it("returns nothing for no rows", () => {
    expect(groupTotals([])).toEqual(NO_MONEY);
  });

  it("does not re-add rows the database already grouped", () => {
    /*
     * `groupTotals` orders and cleans; it does not sum. A caller that hands
     * it the same currency twice has skipped its GROUP BY, and the duplicate
     * showing through is the point — silently merging them would hide the
     * mistake. `sumByCurrency` is the helper for that case.
     */
    const total = groupTotals([
      { currency: "USD", amount: "10.00" },
      { currency: "USD", amount: "5.00" },
    ]);

    expect(total).toHaveLength(2);
  });
});

describe("amounts it refuses", () => {
  /*
   * The alternative to throwing is worse than it looks. Trimming a third
   * decimal produces a figure that is wrong by a hundredth and says nothing
   * about it; letting text through produces the string "NaN.NaN", which then
   * travels into a CSV or a page as though it were money. Neither is
   * recoverable downstream, and both look like data.
   */

  it("refuses a third decimal place rather than trimming it", () => {
    expect(() => groupTotals([{ currency: "USD", amount: "1.005" }])).toThrow(
      /at most two decimal places/,
    );
  });

  it("refuses text that is not a number at all", () => {
    for (const amount of ["", " ", ".", "-", "abc", "1.2.3", "1,234.00"]) {
      expect(() => groupTotals([{ currency: "USD", amount }])).toThrow(
        /at most two decimal places/,
      );
    }
  });

  it("refuses exponential notation, which is not how money is written", () => {
    expect(() => groupTotals([{ currency: "USD", amount: "1e3" }])).toThrow(
      /at most two decimal places/,
    );
  });

  it("refuses an amount too large to hold exactly", () => {
    // Past 2^53 minor units the low digits stop existing. A Decimal(12, 2)
    // column cannot get here; an unconstrained SUM() over enough rows could.
    expect(() =>
      groupTotals([{ currency: "USD", amount: "99999999999999999.99" }]),
    ).toThrow(/too large to represent exactly/);
  });

  it("accepts the forms the database actually produces", () => {
    // Postgres `::text` on a numeric(12, 2), a Prisma Decimal `toString`, a
    // one-place decimal, a negative from a reversal, and a bare zero.
    expect(
      groupTotals([
        { currency: "USD", amount: "400.00" },
        { currency: "USD", amount: "400" },
        { currency: "USD", amount: "400.5" },
        { currency: "USD", amount: "-40.50" },
        { currency: "USD", amount: "0" },
      ]).map((entry) => entry.amount),
    ).toEqual(["400.00", "400.00", "400.50", "-40.50", "0.00"]);
  });

  it("refuses through sumByCurrency too, not only groupTotals", () => {
    expect(() => sumByCurrency([{ currency: "USD", amount: "1.005" }])).toThrow(
      /at most two decimal places/,
    );
  });
});

describe("sumByCurrency", () => {
  it("adds within a currency", () => {
    expect(
      sumByCurrency([
        { currency: "USD", amount: "10.25" },
        { currency: "USD", amount: "5.75" },
      ]),
    ).toEqual([{ currency: "USD", amount: "16.00" }]);
  });

  it("keeps currencies apart while doing it", () => {
    expect(
      sumByCurrency([
        { currency: "USD", amount: "10.00" },
        { currency: "INR", amount: "800.00" },
        { currency: "USD", amount: "2.50" },
      ]),
    ).toEqual([
      { currency: "USD", amount: "12.50" },
      { currency: "INR", amount: "800.00" },
    ]);
  });

  it("keeps the unrecorded currency in its own bucket", () => {
    expect(
      sumByCurrency([
        { currency: null, amount: "40.00" },
        { currency: "USD", amount: "1.00" },
        { currency: null, amount: "2.00" },
      ]),
    ).toEqual([
      { currency: "USD", amount: "1.00" },
      { currency: null, amount: "42.00" },
    ]);
  });

  it("adds exactly, without drifting through a float", () => {
    // 0.1 + 0.2 in binary floating point is famously not 0.3.
    expect(
      sumByCurrency([
        { currency: "USD", amount: "0.10" },
        { currency: "USD", amount: "0.20" },
      ]),
    ).toEqual([{ currency: "USD", amount: "0.30" }]);
  });

  it("handles negatives, which a write-off reversal produces", () => {
    expect(
      sumByCurrency([
        { currency: "USD", amount: "100.00" },
        { currency: "USD", amount: "-40.50" },
      ]),
    ).toEqual([{ currency: "USD", amount: "59.50" }]);
  });
});

describe("reading a single figure back out", () => {
  it("gives the amount when there is exactly one known currency", () => {
    const total = groupTotals([{ currency: "USD", amount: "12.34" }]);

    expect(soleCurrency(total)).toBe("USD");
    expect(soleAmount(total)).toBe("12.34");
    expect(isMixed(total)).toBe(false);
  });

  it("gives nothing for a mixed total", () => {
    const total = groupTotals([
      { currency: "USD", amount: "1.00" },
      { currency: "EUR", amount: "1.00" },
    ]);

    expect(isMixed(total)).toBe(true);
    expect(soleCurrency(total)).toBeNull();
    expect(soleAmount(total)).toBeNull();
  });

  it("gives nothing when the one currency was never recorded", () => {
    /*
     * A historical amount with no currency is not a number this application
     * may compare with anything, sort against a labelled figure, or subtract
     * from. `soleAmount` withholding it is what stops the display layer
     * quietly captioning it with the installation default.
     */
    const total = groupTotals([{ currency: null, amount: "16960.00" }]);

    expect(isMixed(total)).toBe(false);
    expect(soleAmount(total)).toBeNull();
  });

  it("gives nothing for an empty total", () => {
    expect(soleCurrency(NO_MONEY)).toBeNull();
    expect(soleAmount(NO_MONEY)).toBeNull();
    expect(isMixed(NO_MONEY)).toBe(false);
  });
});
