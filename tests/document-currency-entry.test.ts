import { describe, expect, it } from "vitest";

import { DEFAULT_CURRENCY, type Currency } from "@/lib/currency";
import {
  carriedAcrossCurrencyChange,
  clearedByCurrencyChange,
  prefillableAmount,
  sameKnownCurrency,
  type PricedLine,
} from "@/lib/document-currency";

/**
 * What the entry forms do when the currency changes underneath them.
 *
 * The rule lives in `@/lib/document-currency` rather than in the two builders
 * so it can be tested at all — the suite runs in Node with no DOM — and so the
 * order and purchase forms cannot drift apart while both claim to implement
 * the same policy.
 *
 * Everything here is about *which figures the form may discard on the
 * operator's behalf*. Nothing converts, because nothing in this system can.
 */

/** The selector's starting value, as both builders compute it. */
function initialSelection(params: {
  stored: Currency | null;
  installationDefault: Currency;
}): Currency {
  return params.stored ?? params.installationDefault;
}

const line = (
  key: string,
  amount: string,
  prefilled: boolean,
): PricedLine => ({ key, amount, prefilled });

describe("what the selector starts on", () => {
  it("offers the installation default for a document being created", () => {
    expect(
      initialSelection({ stored: null, installationDefault: "EUR" }),
    ).toBe("EUR");

    // And the default really is the app's, not a literal repeated here.
    expect(
      initialSelection({ stored: null, installationDefault: DEFAULT_CURRENCY }),
    ).toBe(DEFAULT_CURRENCY);
  });

  it("shows an existing document its own currency, not today's default", () => {
    // The regression this whole change exists to prevent: a EUR order opened
    // after the setting moved to USD must still read EUR.
    expect(
      initialSelection({ stored: "EUR", installationDefault: "USD" }),
    ).toBe("EUR");
  });

  it("falls back to the default only for a legacy document with none", () => {
    expect(
      initialSelection({ stored: null, installationDefault: "INR" }),
    ).toBe("INR");
  });
});

describe("what a currency change clears", () => {
  it("clears figures the form prefilled and keeps figures somebody typed", () => {
    const lines = [
      line("catalogue-priced", "89.99", true),
      line("typed", "120.00", false),
      line("also-prefilled", "12.50", true),
    ];

    expect(clearedByCurrencyChange(lines)).toEqual([
      "catalogue-priced",
      "also-prefilled",
    ]);
  });

  it("keeps every figure when the operator typed all of them", () => {
    const lines = [line("a", "10.00", false), line("b", "20.00", false)];

    expect(clearedByCurrencyChange(lines)).toEqual([]);
  });

  it("never rewrites a figure — it only names the ones to clear", () => {
    const lines = [line("a", "89.99", true)];

    clearedByCurrencyChange(lines);

    // No conversion, no rounding, no mutation. The caller empties the box.
    expect(lines[0]!.amount).toBe("89.99");
  });
});

describe("what needs acknowledging", () => {
  const baseline = new Map([
    ["kept", "10.00"],
    ["reentered", "10.00"],
  ]);

  it("flags a figure that survived the change untouched", () => {
    const lines = [line("kept", "10.00", false), line("reentered", "830.00", false)];

    expect(
      carriedAcrossCurrencyChange(lines, baseline, { from: "USD", to: "INR" }),
    ).toEqual(["kept"]);
  });

  it("flags nothing when the currency has not actually moved", () => {
    const lines = [line("kept", "10.00", false)];

    expect(
      carriedAcrossCurrencyChange(lines, baseline, { from: "USD", to: "USD" }),
    ).toEqual([]);
  });

  it("flags nothing on a document that has no stored currency yet", () => {
    // A new document, or a legacy row being given a currency for the first
    // time: there is no previous denomination to have carried a figure across.
    const lines = [line("kept", "10.00", false)];

    expect(
      carriedAcrossCurrencyChange(lines, baseline, { from: null, to: "INR" }),
    ).toEqual([]);
  });

  it("stops flagging once the figure is re-entered", () => {
    const lines = [line("kept", "825.00", false)];

    expect(
      carriedAcrossCurrencyChange(lines, baseline, { from: "USD", to: "INR" }),
    ).toEqual([]);
  });

  it("treats a cleared prefill as re-entered rather than carried", () => {
    // The form empties prefilled boxes on a currency change, so they no longer
    // match the baseline and do not demand an acknowledgement of their own.
    const lines = [line("kept", "", true)];

    expect(
      carriedAcrossCurrencyChange(lines, baseline, { from: "USD", to: "INR" }),
    ).toEqual([]);
  });
});

describe("orders and purchases answer identically", () => {
  /*
   * The two builders map different field names onto the same shape — a quoted
   * price and a supplier's unit cost — and then ask the same two questions.
   * This is the guard against one of them growing its own rules later.
   */
  const orderLines = [
    line("part-a", "89.99", true),
    line("part-b", "120.00", false),
  ];
  const purchaseLines = [
    line("part-a", "42.50", true),
    line("part-b", "60.00", false),
  ];

  it("clears the prefilled side and keeps the typed side on both", () => {
    expect(clearedByCurrencyChange(orderLines)).toEqual(["part-a"]);
    expect(clearedByCurrencyChange(purchaseLines)).toEqual(["part-a"]);
  });

  it("asks for the same acknowledgement on both", () => {
    const orderBaseline = new Map([["part-b", "120.00"]]);
    const purchaseBaseline = new Map([["part-b", "60.00"]]);

    expect(
      carriedAcrossCurrencyChange(orderLines, orderBaseline, {
        from: "USD",
        to: "EUR",
      }),
    ).toEqual(["part-b"]);

    expect(
      carriedAcrossCurrencyChange(purchaseLines, purchaseBaseline, {
        from: "USD",
        to: "EUR",
      }),
    ).toEqual(["part-b"]);
  });
});

/**
 * Whether a screen may subtract one figure from another.
 *
 * The order builder shows how far a quote sits from the catalogue's reference
 * price. That difference only exists when both are denominated in the same
 * thing; across two currencies it is a number with no meaning, and the screen
 * shows the reference in its own currency instead.
 */
describe("when two figures can be compared at all", () => {
  it("compares two figures quoted in the same currency", () => {
    expect(sameKnownCurrency("USD", "USD")).toBe(true);
    expect(sameKnownCurrency("INR", "INR")).toBe(true);
  });

  it("refuses two figures quoted in different currencies", () => {
    // Symmetric: neither side is the one with authority over the other.
    expect(sameKnownCurrency("USD", "INR")).toBe(false);
    expect(sameKnownCurrency("INR", "USD")).toBe(false);
  });

  it("refuses a reference whose currency was never recorded", () => {
    expect(sameKnownCurrency("USD", null)).toBe(false);
  });

  it("refuses a document that has no currency of its own", () => {
    expect(sameKnownCurrency(null, "USD")).toBe(false);
  });

  it("never fills a missing currency in — not even with the default", () => {
    /*
     * Two unknowns are not a match. The installation default proposes a
     * currency for a document being created; it is not a fact about a figure
     * that already exists, so it can neither name one nor make two comparable.
     */
    expect(sameKnownCurrency(null, null)).toBe(false);
    expect(sameKnownCurrency(DEFAULT_CURRENCY, null)).toBe(false);
    expect(sameKnownCurrency(null, DEFAULT_CURRENCY)).toBe(false);
  });
});

/**
 * Whether a line may start at a figure something else already recorded.
 *
 * One decision with two vocabularies, which is why it lives in the library and
 * not in either builder: an order line offers the catalogue's selling price, a
 * purchase line offers the last cost paid, and both must first ask whether that
 * figure is denominated in what the document is denominated in.
 *
 * `null` is the whole answer on the refusing side — it is what leaves the box
 * empty *and* what marks the line as the operator's own, so the two can never
 * drift apart in a caller.
 */
describe("what a new line may start at", () => {
  it("offers the figure when it was recorded in this currency", () => {
    expect(
      prefillableAmount({
        amount: "12000.00",
        currency: "INR",
        documentCurrency: "INR",
      }),
    ).toBe("12000.00");
  });

  it("offers nothing when it was recorded in something else", () => {
    /*
     * Not a default in this document's currency — a different number. 40.00 off
     * a dollar price list is not the opening quote for a rupee order, and
     * 40.00 paid to a supplier in dollars is not what this delivery cost in
     * rupees. Nothing converts either one, so nothing may carry it across.
     */
    expect(
      prefillableAmount({
        amount: "40.00",
        currency: "USD",
        documentCurrency: "INR",
      }),
    ).toBeNull();
  });

  it("offers nothing when nobody recorded what the figure is in", () => {
    // An unknown denomination is not this document's by default. Treating it
    // as one is the precise assumption this whole change set exists to remove.
    expect(
      prefillableAmount({
        amount: "40.00",
        currency: null,
        documentCurrency: "USD",
      }),
    ).toBeNull();
  });

  it("offers nothing when there is no figure at all", () => {
    // A part that is only ever quoted, or one never yet received: nothing to
    // offer, whatever the currencies say.
    expect(
      prefillableAmount({
        amount: null,
        currency: null,
        documentCurrency: "USD",
      }),
    ).toBeNull();
  });

  it("offers a genuine zero when the currency matches", () => {
    /*
     * Free of charge is a figure somebody set, not a missing one — a warranty
     * replacement still arrives and still has to be counted in. It is offered
     * like any other amount and stays reference-sourced, so a later currency
     * change clears it along with the rest.
     */
    expect(
      prefillableAmount({
        amount: "0.00",
        currency: "EUR",
        documentCurrency: "EUR",
      }),
    ).toBe("0.00");
  });

  it("offers nothing for a zero recorded in another currency", () => {
    // Zero is the same number everywhere, but the claim behind it is not:
    // nobody priced this in euros, so nothing is asserted for it here.
    expect(
      prefillableAmount({
        amount: "0.00",
        currency: "USD",
        documentCurrency: "EUR",
      }),
    ).toBeNull();
  });

  it("offers nothing when the document has no currency of its own", () => {
    expect(
      prefillableAmount({
        amount: "40.00",
        currency: "USD",
        documentCurrency: null,
      }),
    ).toBeNull();
  });

  it("never rewrites the figure — it passes it through or drops it", () => {
    const recorded = { amount: "89.99", currency: "USD" as const };

    // Through unchanged: no conversion, no rounding, no re-scaling.
    expect(prefillableAmount({ ...recorded, documentCurrency: "USD" })).toBe(
      "89.99",
    );
    // Or not at all. There is no third answer, and in particular no converted
    // one — null is what "we cannot say" looks like.
    expect(
      prefillableAmount({ ...recorded, documentCurrency: "INR" }),
    ).toBeNull();
    // And the recorded figure itself is untouched either way.
    expect(recorded.amount).toBe("89.99");
  });
});
