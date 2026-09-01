/**
 * Inclusive calendar-day ranges, parsed from a query string and applied in SQL.
 *
 * This logic existed in three byte-identical copies — the orders, purchases and
 * stock movement query modules — and the reports module would have been the
 * fourth. It is small enough that duplicating it felt harmless, which is
 * precisely how the inclusive-end convention could have come to differ between
 * two lists without anybody noticing they disagreed about what "to the 26th"
 * meant.
 *
 * Two rules are worth stating because both are easy to get subtly wrong.
 *
 * **A range is inclusive at both ends.** "To the 26th" means the whole of the
 * 26th, so the upper bound is the start of the 27th and the comparison is
 * strictly less than. Using `<= 2026-08-26T00:00:00Z` would silently drop
 * everything that happened during the day somebody asked about — a whole day of
 * revenue missing from a report, with nothing to indicate it.
 *
 * **A backwards range is swapped, not rejected.** Somebody who types the dates
 * in the wrong order gets what they meant rather than an empty table that looks
 * like a bug.
 */

/** What Next hands a page as `searchParams`. */
export type RawSearchParams = Record<string, string | string[] | undefined>;

export interface DateRange {
  /** Inclusive `YYYY-MM-DD` lower bound, or null for unbounded. */
  from: string | null;
  /** Inclusive `YYYY-MM-DD` upper bound, or null for unbounded. */
  to: string | null;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export function readOne(raw: RawSearchParams, key: string): string | null {
  const value = raw[key];
  const single = Array.isArray(value) ? value[0] : value;
  const trimmed = single?.trim();
  return trimmed ? trimmed : null;
}

/**
 * A `YYYY-MM-DD` value from the query string, or null.
 *
 * Shape-checked rather than parsed with `Date`, deliberately: `new Date("last
 * tuesday")` is `Invalid Date` but `new Date("2026")` is a valid instant in
 * January, and a query string is the one input people edit by hand.
 */
export function readDate(raw: RawSearchParams, key: string): string | null {
  const value = readOne(raw, key);
  return value && ISO_DAY.test(value) ? value : null;
}

/** Reads `from`/`to`, swapping them if they arrived backwards. */
export function readDateRange(
  raw: RawSearchParams,
  fromKey = "from",
  toKey = "to",
): DateRange {
  const from = readDate(raw, fromKey);
  const to = readDate(raw, toKey);

  return {
    from: from && to && from > to ? to : from,
    to: from && to && from > to ? from : to,
  };
}

/** The inclusive lower bound as an instant: midnight UTC on the day itself. */
export function startOfDay(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

/**
 * The exclusive upper bound for an inclusive end date: midnight UTC on the
 * *following* day. Pair it with `<`, never `<=`.
 */
export function endOfDayExclusive(day: string): Date {
  const end = new Date(`${day}T00:00:00.000Z`);
  end.setUTCDate(end.getUTCDate() + 1);
  return end;
}

/** `YYYY-MM-DD` for a date, in UTC — the format the inputs and URL expect. */
export function toIsoDay(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/** The day `months` before today, for a default reporting window. */
export function monthsAgo(months: number, now: Date = new Date()): string {
  const date = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  date.setUTCMonth(date.getUTCMonth() - months);
  return toIsoDay(date);
}
