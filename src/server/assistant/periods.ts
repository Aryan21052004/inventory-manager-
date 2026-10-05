import "server-only";

import { AppError } from "@/lib/errors";
import { toIsoDay } from "@/lib/date-range";

/**
 * Reporting windows the assistant can name, and how each becomes the query
 * string the reports already parse.
 *
 * The output is fed to `reportParamsFor`, the same parser the report pages and
 * their CSV export use, so "this month" in the assistant is the same window a
 * person would get by choosing those dates on the report screen.
 *
 * **UTC, like the reports.** Every report bounds its dates at midnight UTC
 * (src/lib/date-range.ts). The assistant uses the same calendar so its figures
 * reconcile with the screens, and the prompt tells the model to say so.
 *
 * Where a report preset already means the same thing — the last 3 or 12
 * months, the year to date, all time — the preset is used rather than its
 * resolved dates, so the link the assistant hands back is the report's own
 * preset and keeps meaning "the last 12 months" when it is opened tomorrow.
 */

export const PERIODS = [
  "this_month",
  "last_month",
  "last_3_months",
  "last_12_months",
  "year_to_date",
  "all_time",
  "custom",
] as const;

export type Period = (typeof PERIODS)[number];

export const PERIOD_DESCRIPTION =
  "Reporting window, in UTC calendar days. this_month runs from the 1st of the current month to today. " +
  "Use custom with from/to for any other range. Defaults to last_12_months when neither period nor from is given.";

/** The `range`/`from`/`to` keys a report's query string carries. */
export interface ReportWindow {
  range: string;
  from?: string;
  to?: string;
}

function firstOfMonth(year: number, month: number): Date {
  return new Date(Date.UTC(year, month, 1));
}

export function reportWindow(
  input: { period?: Period; from?: string; to?: string },
  now: Date,
): ReportWindow {
  const today = toIsoDay(now);
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();

  // Explicit dates win when no named period was chosen, and are required when
  // the custom one was.
  const period: Period =
    input.period ?? (input.from || input.to ? "custom" : "last_12_months");

  switch (period) {
    case "this_month":
      return { range: "custom", from: toIsoDay(firstOfMonth(year, month)), to: today };
    case "last_month": {
      const start = firstOfMonth(year, month - 1);
      const end = new Date(firstOfMonth(year, month).getTime() - 24 * 60 * 60 * 1000);
      return { range: "custom", from: toIsoDay(start), to: toIsoDay(end) };
    }
    case "last_3_months":
      return { range: "3m" };
    case "last_12_months":
      return { range: "12m" };
    case "year_to_date":
      return { range: "ytd" };
    case "all_time":
      return { range: "all" };
    case "custom":
      if (!input.from) {
        throw new AppError(
          "BAD_REQUEST",
          "A custom period needs a from date (YYYY-MM-DD).",
        );
      }
      return { range: "custom", from: input.from, to: input.to ?? today };
  }
}
