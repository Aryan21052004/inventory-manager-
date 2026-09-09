import { describe, expect, it } from "vitest";

import {
  CURRENCIES,
  CURRENCY_LABELS,
  CURRENCY_LOCALES,
  DEFAULT_CURRENCY,
  currencyLabel,
  formatMoney,
  isCurrency,
} from "@/lib/currency";
import { formatCurrency } from "@/lib/format";

/**
 * How money renders, in each of the three currencies.
 *
 * The assertions are on exact strings rather than on "contains a rupee sign",
 * and deliberately so. The two things most likely to break here are invisible
 * to a looser check: the grouping (Indian lakhs are the whole reason INR has
 * its own locale) and the non-breaking space some ICU versions place after a
 * symbol. Both are what a user actually sees.
 *
 * Nothing here touches the database. These are the formatting rules, and they
 * hold whatever the setting happens to be.
 */

/**
 * ICU renders the gap after a currency symbol as U+00A0 in some locales and
 * U+0020 in others, and it has changed between Node releases. Normalising both
 * to a plain space keeps these tests about grouping and symbols rather than
 * about which Node the suite is running on.
 */
function normalise(value: string): string {
  return value.replace(/ /g, " ");
}

describe("currency formatting", () => {
  describe("USD", () => {
    it("renders with a dollar sign and thousands grouping", () => {
      expect(normalise(formatMoney(1234.56, "USD"))).toBe("$1,234.56");
    });

    it("groups in thousands, not lakhs", () => {
      expect(normalise(formatMoney(180104.96, "USD"))).toBe("$180,104.96");
    });

    it("always shows two decimal places", () => {
      expect(normalise(formatMoney(10, "USD"))).toBe("$10.00");
      expect(normalise(formatMoney(0, "USD"))).toBe("$0.00");
    });
  });

  describe("INR", () => {
    it("renders with a rupee sign", () => {
      expect(normalise(formatMoney(1234.56, "INR"))).toBe("₹1,234.56");
    });

    /*
     * The reason INR gets its own locale. `en-US` would render this as
     * ₹180,104.96; `en-IN` groups the lakh separately, which is how the figure
     * is read by the people reading it.
     */
    it("groups in lakhs and crores", () => {
      expect(normalise(formatMoney(180104.96, "INR"))).toBe("₹1,80,104.96");
    });

    it("groups a crore correctly", () => {
      expect(normalise(formatMoney(12345678.9, "INR"))).toBe("₹1,23,45,678.90");
    });

    it("leaves figures below a lakh ungrouped beyond thousands", () => {
      expect(normalise(formatMoney(99999.5, "INR"))).toBe("₹99,999.50");
    });
  });

  describe("EUR", () => {
    it("renders with a euro sign and thousands grouping", () => {
      expect(normalise(formatMoney(1234.56, "EUR"))).toBe("€1,234.56");
    });

    it("groups in thousands, not lakhs", () => {
      expect(normalise(formatMoney(180104.96, "EUR"))).toBe("€180,104.96");
    });
  });

  describe("input shapes", () => {
    /*
     * Money reaches the formatter as a decimal *string* far more often than as
     * a number — the loaders return `::text` from SQL and `.toFixed(2)` from
     * TypeScript, precisely so a float never sits between Postgres and the
     * screen.
     */
    it("accepts a decimal string", () => {
      expect(normalise(formatMoney("1234.56", "USD"))).toBe("$1,234.56");
      expect(normalise(formatMoney("180104.96", "INR"))).toBe("₹1,80,104.96");
    });

    it("accepts a number", () => {
      expect(normalise(formatMoney(1234.56, "USD"))).toBe("$1,234.56");
    });

    /**
     * A Prisma `Decimal` is an object with a `toString`. The formatter reads it
     * through that rather than coercing, which is what keeps a 12-digit amount
     * off the float path.
     */
    it("accepts anything with a toString, as a Decimal has", () => {
      const decimalLike = { toString: () => "9876.54" };
      expect(normalise(formatMoney(decimalLike, "EUR"))).toBe("€9,876.54");
    });

    it("renders a negative amount", () => {
      expect(normalise(formatMoney(-1234.56, "USD"))).toBe("-$1,234.56");
    });

    it("falls back to zero rather than NaN for an unreadable value", () => {
      expect(normalise(formatMoney("not a number", "USD"))).toBe("$0.00");
      expect(normalise(formatMoney({ toString: () => "" }, "INR"))).toBe("₹0.00");
    });

    /**
     * Null is not formattable, and that is the design.
     *
     * An unknown acquisition cost is `null` in the database, and it is a
     * different fact from zero: "5 units of unknown cost" and "5 units that
     * cost nothing" are opposite statements about the same shelf. The whole
     * costing layer exists to keep them apart, so the formatter refuses null at
     * the type level and every caller decides for itself what to show instead
     * — "Unknown", "—", or a sentence explaining the gap.
     */
    it("refuses null at the type level", () => {
      // @ts-expect-error null is not Money; callers must handle it themselves
      expect(() => formatMoney(null, "USD")).toThrow();
      // @ts-expect-error undefined is not Money either
      expect(() => formatMoney(undefined, "INR")).toThrow();
    });

    /*
     * And the guard callers actually use, so the pattern is pinned rather than
     * only described: null is branched on before the value reaches formatting.
     */
    it("is guarded by callers rather than absorbed", () => {
      const render = (cost: string | null) =>
        cost === null ? "Unknown" : formatMoney(cost, "INR");

      expect(render(null)).toBe("Unknown");
      expect(normalise(render("800.00"))).toBe("₹800.00");
    });
  });

  describe("formatCurrency", () => {
    it("delegates to formatMoney, so both render identically", () => {
      for (const currency of CURRENCIES) {
        expect(formatCurrency("1234.56", currency)).toBe(
          formatMoney("1234.56", currency),
        );
      }
    });

    /*
     * The property that replaced `const CURRENCY = "USD"`. If this ever passes
     * with one argument, a call site somewhere is silently rendering a default.
     */
    it("requires the currency argument", () => {
      // @ts-expect-error the second argument is required and must stay required
      expect(() => formatCurrency("1234.56")).toThrow();
    });
  });

  describe("the supported set", () => {
    it("is exactly USD, INR and EUR", () => {
      expect([...CURRENCIES]).toEqual(["USD", "INR", "EUR"]);
    });

    it("defaults to INR", () => {
      expect(DEFAULT_CURRENCY).toBe("INR");
    });

    it("pins INR to en-IN and leaves USD and EUR on en-US", () => {
      expect(CURRENCY_LOCALES.INR).toBe("en-IN");
      expect(CURRENCY_LOCALES.USD).toBe("en-US");
      expect(CURRENCY_LOCALES.EUR).toBe("en-US");
    });

    it("gives every currency a label and a locale", () => {
      for (const currency of CURRENCIES) {
        expect(currencyLabel(currency)).toBe(CURRENCY_LABELS[currency]);
        expect(currencyLabel(currency).length).toBeGreaterThan(0);
        expect(CURRENCY_LOCALES[currency].length).toBeGreaterThan(0);
      }
    });

    it("narrows a supported code and rejects everything else", () => {
      expect(isCurrency("USD")).toBe(true);
      expect(isCurrency("INR")).toBe(true);
      expect(isCurrency("EUR")).toBe(true);
      expect(isCurrency("GBP")).toBe(false);
      expect(isCurrency("usd")).toBe(false);
      expect(isCurrency("")).toBe(false);
      expect(isCurrency(null)).toBe(false);
      expect(isCurrency(undefined)).toBe(false);
      expect(isCurrency(42)).toBe(false);
    });
  });

  /**
   * The formatter cache returns the same instance per currency and never a
   * shared mutable one. Two different currencies asked for in succession must
   * not interfere — the bug a module-level "current formatter" would have.
   */
  describe("formatter isolation", () => {
    it("keeps currencies independent across interleaved calls", () => {
      const first = normalise(formatMoney(180104.96, "INR"));
      const second = normalise(formatMoney(180104.96, "USD"));
      const third = normalise(formatMoney(180104.96, "INR"));

      expect(first).toBe("₹1,80,104.96");
      expect(second).toBe("$180,104.96");
      expect(third).toBe(first);
    });
  });
});
