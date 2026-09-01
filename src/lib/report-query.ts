import type { StockTransactionType } from "@/generated/prisma/enums";
import {
  monthsAgo,
  readDateRange,
  readOne,
  type RawSearchParams,
} from "@/lib/date-range";
import {
  isMovementType,
  MOVEMENT_TYPE_LABELS,
} from "@/lib/stock-movement-query";

/**
 * The reports' state, and how it maps to the URL.
 *
 * Same arrangement as every other list in the application: the query string is
 * the state, so a filtered report is bookmarkable, shareable, and — the reason
 * it matters more here than anywhere — the CSV endpoint can be handed the exact
 * same parameters the page was rendered from. A report and its export that ran
 * different queries would be two answers to one question.
 */

export const REPORT_KEYS = [
  "valuation",
  "sales",
  "purchases",
  "movements",
] as const;
export type ReportKey = (typeof REPORT_KEYS)[number];

export function isReportKey(value: unknown): value is ReportKey {
  return (
    typeof value === "string" && (REPORT_KEYS as readonly string[]).includes(value)
  );
}

export const REPORT_TITLES: Record<ReportKey, string> = {
  valuation: "Stock valuation",
  sales: "Sales",
  purchases: "Purchase spend",
  movements: "Stock movement summary",
};

export const REPORT_DESCRIPTIONS: Record<ReportKey, string> = {
  valuation:
    "What is on the shelf and what it actually cost, at current state.",
  sales: "Realised sales, dated by when each order was confirmed.",
  purchases: "Procurement spend, dated by when each delivery was received.",
  movements:
    "What moved in and out of stock, dated by when each movement was recorded.",
};

/**
 * What each report may be grouped and sorted by — the single definition.
 *
 * The page and the CSV route both read from here, and neither may hold its own
 * copy. They used to: the page had a `CONFIG` object and the route had three
 * parallel records saying the same thing, which meant a sort key added to one
 * and forgotten in the other would leave the export quietly answering a
 * differently ordered question than the screen it was downloaded from. That is
 * the one failure this module exists to prevent, so the definition is here and
 * `reportParamsFor` is the only way either of them reaches it.
 *
 * `period` means a calendar month. Deliberately not a free choice of day, week
 * or month in v1: a daily grouping over a year is 365 rows nobody reads, and
 * the useful question at this size is which month, which product, which
 * counterparty.
 *
 * Valuation has no groupings at all — it is a current-state snapshot per
 * product, not an aggregation over a period.
 */
export const REPORT_CONFIG = {
  valuation: {
    groupings: [] as readonly string[],
    defaultGrouping: "product",
    sortKeys: [
      "value",
      "retail",
      "units",
      "uncosted",
      "sku",
      "name",
      "category",
      "coverage",
    ] as readonly string[],
    defaultSort: "value",
  },
  sales: {
    groupings: ["period", "product", "category", "customer"] as readonly string[],
    defaultGrouping: "period",
    sortKeys: ["value", "revenue", "units", "orders", "label"] as readonly string[],
    defaultSort: "value",
  },
  purchases: {
    groupings: ["period", "supplier", "product", "category"] as readonly string[],
    defaultGrouping: "period",
    sortKeys: ["value", "units", "purchases", "label"] as readonly string[],
    defaultSort: "value",
  },
  /*
   * Deliberately no supplier or customer grouping. Only movements carrying a
   * document reference have either, so such a grouping would quietly drop
   * opening stock and every manual adjustment — and its rows would then fail to
   * sum to the report's own totals. Supplier-level provenance is a separate
   * Tier 2 report with a query shaped for the question.
   *
   * `label` is the default sort, which with the default `desc` direction puts
   * the newest month first. Busiest-first was tried and read badly: the default
   * grouping is by month, and ordering months by movement count scattered them
   * (08, 07, 06, 09) with the current month last. Sorting by the signed net
   * change would be worse still, pushing every month of net outflow to the
   * back. Every other sort key remains available and behaves as asked for.
   */
  movements: {
    groupings: ["period", "product", "category", "type"] as readonly string[],
    defaultGrouping: "period",
    sortKeys: [
      "movements",
      "products",
      "in",
      "out",
      "net",
      "label",
    ] as readonly string[],
    defaultSort: "label",
  },
} satisfies Record<
  ReportKey,
  {
    groupings: readonly string[];
    defaultGrouping: string;
    sortKeys: readonly string[];
    defaultSort: string;
  }
>;

export const GROUPING_LABELS: Record<string, string> = {
  period: "Month",
  product: "Product",
  category: "Category",
  customer: "Customer",
  supplier: "Supplier",
  type: "Movement type",
};

const REPORT_PAGE_SIZES = [25, 50, 100, 250] as const;
const DEFAULT_REPORT_PAGE_SIZE = 50;

/**
 * The reporting window, as a preset.
 *
 * The default is the last twelve months rather than all time. A report opened
 * cold should describe the business as it is now — an all-time total is a
 * different question, and one worth asking for deliberately.
 */
export const RANGE_PRESETS = ["12m", "3m", "ytd", "all", "custom"] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number];

export const RANGE_PRESET_LABELS: Record<RangePreset, string> = {
  "3m": "Last 3 months",
  "12m": "Last 12 months",
  ytd: "This year",
  all: "All time",
  custom: "Custom range",
};

export interface ReportParams {
  preset: RangePreset;
  /** Resolved from the preset, or read from the URL when the preset is custom. */
  from: string | null;
  to: string | null;
  grouping: string;
  sort: string;
  direction: "asc" | "desc";
  page: number;
  pageSize: number;
  /** Entity filters. Which apply depends on the report. */
  supplierId: string | null;
  customerId: string | null;
  category: string | null;
  search: string;
  /**
   * Narrows the stock movement summary to one ledger type. Ignored by every
   * other report, which is why it lives here with the rest of the shared state
   * rather than in a second parser the CSV route would have to duplicate.
   */
  movementType: StockTransactionType | null;
}

/**
 * Turns a preset into concrete bounds.
 *
 * `all` is unbounded on both sides — the only case where a report has no date
 * filter at all, which is why the SQL has to treat null bounds as "no
 * predicate" rather than substituting a very old date.
 */
function resolvePreset(
  preset: RangePreset,
  now: Date = new Date(),
): { from: string | null; to: string | null } {
  switch (preset) {
    case "all":
      return { from: null, to: null };
    case "3m":
      return { from: monthsAgo(3, now), to: null };
    case "ytd":
      return { from: `${now.getUTCFullYear()}-01-01`, to: null };
    case "custom":
      // Bounds come from the URL, not from here.
      return { from: null, to: null };
    case "12m":
    default:
      return { from: monthsAgo(12, now), to: null };
  }
}

export function parseReportParams(
  raw: RawSearchParams,
  options: {
    groupings: readonly string[];
    defaultGrouping: string;
    sortKeys: readonly string[];
    defaultSort: string;
  },
  now: Date = new Date(),
): ReportParams {
  const presetRaw = readOne(raw, "range");
  const preset: RangePreset = (RANGE_PRESETS as readonly string[]).includes(
    presetRaw ?? "",
  )
    ? (presetRaw as RangePreset)
    : "12m";

  const explicit = readDateRange(raw);

  /*
   * A custom range is whatever the URL says. Anything else is derived, so a
   * bookmarked "last 12 months" keeps meaning the last twelve months rather
   * than freezing the window it meant on the day it was saved.
   */
  const resolved =
    preset === "custom" ? explicit : resolvePreset(preset, now);

  const grouping = readOne(raw, "group");
  const sort = readOne(raw, "sort");
  const direction = readOne(raw, "dir");
  const page = Number(readOne(raw, "page") ?? "1");
  const pageSize = Number(readOne(raw, "size") ?? DEFAULT_REPORT_PAGE_SIZE);

  return {
    preset,
    from: resolved.from,
    to: resolved.to,
    grouping: options.groupings.includes(grouping ?? "")
      ? (grouping as string)
      : options.defaultGrouping,
    sort: options.sortKeys.includes(sort ?? "")
      ? (sort as string)
      : options.defaultSort,
    direction: direction === "asc" ? "asc" : "desc",
    page: Number.isInteger(page) && page >= 1 ? page : 1,
    pageSize: (REPORT_PAGE_SIZES as readonly number[]).includes(pageSize)
      ? pageSize
      : DEFAULT_REPORT_PAGE_SIZE,
    supplierId: readOne(raw, "supplier"),
    customerId: readOne(raw, "customer"),
    category: readOne(raw, "category"),
    search: readOne(raw, "q") ?? "",
    movementType: (() => {
      const value = readOne(raw, "mtype");
      return isMovementType(value) ? value : null;
    })(),
  };
}

/**
 * The parameters for one named report, read from its query string.
 *
 * The page and the CSV route both call this and neither passes a configuration
 * of its own, which is what makes it impossible for the export to accept a
 * grouping or a sort key the page does not, or the reverse.
 */
export function reportParamsFor(
  report: ReportKey,
  raw: RawSearchParams,
  now: Date = new Date(),
): ReportParams {
  return parseReportParams(raw, REPORT_CONFIG[report], now);
}

/** Serialises back to a query string, leaving defaults out. */
export function toReportSearchParams(
  params: ReportParams,
  defaults: { grouping: string; sort: string },
): URLSearchParams {
  const query = new URLSearchParams();

  if (params.preset !== "12m") query.set("range", params.preset);
  if (params.preset === "custom") {
    if (params.from) query.set("from", params.from);
    if (params.to) query.set("to", params.to);
  }
  if (params.grouping !== defaults.grouping) query.set("group", params.grouping);
  if (params.sort !== defaults.sort) query.set("sort", params.sort);
  if (params.direction !== "desc") query.set("dir", params.direction);
  if (params.page > 1) query.set("page", String(params.page));
  if (params.pageSize !== DEFAULT_REPORT_PAGE_SIZE) {
    query.set("size", String(params.pageSize));
  }
  if (params.supplierId) query.set("supplier", params.supplierId);
  if (params.customerId) query.set("customer", params.customerId);
  if (params.category) query.set("category", params.category);
  if (params.search) query.set("q", params.search);
  if (params.movementType) query.set("mtype", params.movementType);

  return query;
}

export function reportHref(
  report: ReportKey,
  params: ReportParams,
  defaults: { grouping: string; sort: string },
): string {
  const query = toReportSearchParams(params, defaults).toString();
  return query ? `/reports/${report}?${query}` : `/reports/${report}`;
}

/**
 * The CSV endpoint for a report, carrying the same parameters.
 *
 * The export must answer the question the page is showing. Handing it the same
 * query string is what guarantees that, rather than a second implementation
 * that agrees today and drifts next time either is edited.
 */
export function reportCsvHref(
  report: ReportKey,
  params: ReportParams,
  defaults: { grouping: string; sort: string },
): string {
  const query = toReportSearchParams(params, defaults);
  // Paging is a screen concern. An export is the whole result.
  query.delete("page");
  query.delete("size");
  const search = query.toString();
  return search
    ? `/api/reports/${report}/csv?${search}`
    : `/api/reports/${report}/csv`;
}

export function reportSortHref(
  report: ReportKey,
  params: ReportParams,
  defaults: { grouping: string; sort: string },
  key: string,
): string {
  const active = params.sort === key;

  return reportHref(
    report,
    {
      ...params,
      sort: key,
      direction: active && params.direction === "desc" ? "asc" : "desc",
      page: 1,
    },
    defaults,
  );
}

/**
 * The label a grouped row is shown under.
 *
 * Only the movement summary needs a translation: it groups by the ledger's own
 * enum, and `STOCK_IN` is not what anybody wants to read. The mapping lives
 * here rather than in the page so the CSV cannot come to spell a movement type
 * differently from the screen it was downloaded from.
 */
export function reportRowLabel(grouping: string, label: string): string {
  if (grouping !== "type") return label;
  return MOVEMENT_TYPE_LABELS[label as StockTransactionType] ?? label;
}

/** A human sentence for the window a report covers, for the page and the CSV. */
export function describeRange(params: ReportParams): string {
  if (params.preset === "all") return "All time";
  if (params.from && params.to) return `${params.from} to ${params.to}`;
  if (params.from) return `${params.from} to date`;
  if (params.to) return `Up to ${params.to}`;
  return "All time";
}
