import type {
  LotStatus,
  ProductStatus,
  StockTransactionType,
} from "@/generated/prisma/enums";
import type { CertificateStatus } from "@/lib/certificate-status";
import { PRODUCT_STATUSES } from "@/lib/product-query";
import {
  QUARANTINED_LOT_STATUS,
  REJECTED_LOT_STATUS,
  SALEABLE_LOT_STATUS,
} from "@/lib/lot-status";
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
  "certificates",
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
  certificates: "Certificate compliance register",
};

export const REPORT_DESCRIPTIONS: Record<ReportKey, string> = {
  valuation:
    "What is on the shelf and what it actually cost, at current state.",
  sales: "Realised sales, dated by when each order was confirmed.",
  purchases: "Procurement spend, dated by when each delivery was received.",
  movements:
    "What moved in and out of stock, dated by when each movement was recorded.",
  certificates:
    "Every batch on the shelf and the airworthiness paperwork covering it, at current state.",
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
    defaultDirection: "desc",
  },
  sales: {
    groupings: ["period", "product", "category", "customer"] as readonly string[],
    defaultGrouping: "period",
    sortKeys: ["value", "revenue", "units", "orders", "label"] as readonly string[],
    defaultSort: "value",
    defaultDirection: "desc",
  },
  purchases: {
    groupings: ["period", "supplier", "product", "category"] as readonly string[],
    defaultGrouping: "period",
    sortKeys: ["value", "units", "purchases", "label"] as readonly string[],
    defaultSort: "value",
    defaultDirection: "desc",
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
    defaultDirection: "desc",
  },
  /*
   * No groupings, for the same reason valuation has none and a sharper one
   * besides: this report *is* the detail. A compliance register exists so
   * somebody can point at the batch an auditor asked about, and any
   * aggregation would hide the row that answers the question.
   *
   * `expiry` is the default sort and, with the default direction below, the
   * ordering the dashboard already proved reads well — soonest problem first,
   * with undated rows (no expiry, and no certificate at all) last. Every
   * `orderBy` in this module appends NULLS LAST, so that falls out rather than
   * needing its own clause.
   */
  certificates: {
    groupings: [] as readonly string[],
    defaultGrouping: "lot",
    sortKeys: [
      "expiry",
      "sku",
      "name",
      "units",
      "received",
      "status",
      "supplier",
    ] as readonly string[],
    defaultSort: "expiry",
    /*
     * The one report that reads ascending by default. Soonest expiry first is
     * the order somebody works a compliance list in, and it is the order the
     * dashboard's attention card already uses. Every other report answers
     * "biggest first", so `desc` stays their default and this is the exception
     * rather than a change of convention.
     */
    defaultDirection: "asc",
    /*
     * Retired products are *in* the register — a discontinued part still
     * sitting on the shelf still has paperwork obligations, and silently
     * dropping it would be the omission this report exists to prevent. What is
     * defaulted is the *filter*: the screen opens on ACTIVE, because that is
     * the working set, and INACTIVE, DISCONTINUED or all of them are one
     * selection away. `pstatus=all` is how the URL says "no filter".
     */
    defaultProductStatus: "ACTIVE" as ProductStatus | null,
  },
} satisfies Record<
  ReportKey,
  {
    groupings: readonly string[];
    defaultGrouping: string;
    sortKeys: readonly string[];
    defaultSort: string;
    defaultDirection: "asc" | "desc";
    /** Only the compliance register sets one; every other report shows all. */
    defaultProductStatus?: ProductStatus | null;
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
/**
 * The compliance register's filter vocabularies, as literal tuples.
 *
 * Written out rather than derived from the Prisma enum objects because these
 * are *URL* vocabularies: a value arrives as a string and has to be checked
 * before it is trusted, and a tuple is what makes that check total. They are
 * read only by the parser below.
 *
 * `CERTIFICATE_STATUSES` deliberately mirrors `CertificateStatus` without
 * importing a runtime value from `certificate-status.ts` — that module is the
 * definition of the *rule*, and this workstream does not modify it.
 */
const CERTIFICATE_STATUSES: readonly CertificateStatus[] = [
  "MISSING",
  "EXPIRED",
  "EXPIRING_SOON",
  "VALID",
];

/*
 * Built from the constants in `lot-status.ts` rather than spelled again. That
 * module is the single definition of saleability, and a quoted status literal
 * anywhere else is exactly what the architecture guard in
 * `tests/lot-status.test.ts` refuses — it is how the FIFO scan and the
 * blocked-quantity aggregate would come to disagree.
 */
const LOT_STATUSES: readonly LotStatus[] = [
  SALEABLE_LOT_STATUS,
  QUARANTINED_LOT_STATUS,
  REJECTED_LOT_STATUS,
];

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

  /*
   * The compliance register's own filters. They live here with the rest of the
   * shared state for the same reason `movementType` does: the page and the CSV
   * route both read one parser, so a filter the screen honours cannot be one
   * the export quietly ignores. Every other report leaves them null.
   */

  /** Narrows to one derived compliance state. Never stored, never a column. */
  certificateStatus: CertificateStatus | null;
  /** The open label on the document — FAA 8130-3, EASA Form 1, and so on. */
  certificateType: string | null;
  /** Whether the batch may be sold, awaiting inspection, or condemned. */
  lotStatus: LotStatus | null;
  /** ACTIVE by default on the register, so retired stock is opt-in, not hidden. */
  productStatus: ProductStatus | null;
  /**
   * Batches drawn to zero. Excluded by default — there is nothing on the shelf
   * left to be uncertain about — but reachable, because their paperwork is
   * still the record of what covered the units that left.
   */
  includeEmptied: boolean;
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
    defaultDirection: "asc" | "desc";
    defaultProductStatus?: ProductStatus | null;
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
    /*
     * Explicit in the URL wins; otherwise the report's own default. Reports
     * that answer "biggest first" default to desc, and the compliance register
     * to asc, because soonest-expiry-first is the order it is read in.
     */
    direction:
      direction === "asc" || direction === "desc"
        ? direction
        : options.defaultDirection,
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
    certificateStatus: (() => {
      const value = readOne(raw, "cstatus");
      return CERTIFICATE_STATUSES.includes(value as CertificateStatus)
        ? (value as CertificateStatus)
        : null;
    })(),
    certificateType: readOne(raw, "ctype"),
    lotStatus: (() => {
      const value = readOne(raw, "lstatus");
      return LOT_STATUSES.includes(value as LotStatus)
        ? (value as LotStatus)
        : null;
    })(),
    productStatus: (() => {
      const value = readOne(raw, "pstatus");
      // An explicit "all" is how the URL asks for no filter at all, which is
      // distinct from the parameter being absent and taking the default.
      if (value === "all") return null;
      if (PRODUCT_STATUSES.includes(value as ProductStatus)) {
        return value as ProductStatus;
      }
      return options.defaultProductStatus ?? null;
    })(),
    includeEmptied: readOne(raw, "emptied") === "1",
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

/**
 * What a report opens on, so the URL can leave it out.
 *
 * Grouping, sort and direction every report has; the product-status default is
 * the compliance register's alone, and undefined elsewhere means "no filter",
 * which is what every other report already showed.
 */
export interface ReportDefaults {
  grouping: string;
  sort: string;
  direction: "asc" | "desc";
  productStatus?: ProductStatus | null;
}

/** Serialises back to a query string, leaving defaults out. */
export function toReportSearchParams(
  params: ReportParams,
  defaults: ReportDefaults,
): URLSearchParams {
  const query = new URLSearchParams();

  if (params.preset !== "12m") query.set("range", params.preset);
  if (params.preset === "custom") {
    if (params.from) query.set("from", params.from);
    if (params.to) query.set("to", params.to);
  }
  if (params.grouping !== defaults.grouping) query.set("group", params.grouping);
  if (params.sort !== defaults.sort) query.set("sort", params.sort);
  if (params.direction !== defaults.direction) {
    query.set("dir", params.direction);
  }
  if (params.page > 1) query.set("page", String(params.page));
  if (params.pageSize !== DEFAULT_REPORT_PAGE_SIZE) {
    query.set("size", String(params.pageSize));
  }
  if (params.supplierId) query.set("supplier", params.supplierId);
  if (params.customerId) query.set("customer", params.customerId);
  if (params.category) query.set("category", params.category);
  if (params.search) query.set("q", params.search);
  if (params.movementType) query.set("mtype", params.movementType);
  if (params.certificateStatus) query.set("cstatus", params.certificateStatus);
  if (params.certificateType) query.set("ctype", params.certificateType);
  if (params.lotStatus) query.set("lstatus", params.lotStatus);
  if (params.productStatus !== (defaults.productStatus ?? null)) {
    query.set("pstatus", params.productStatus ?? "all");
  }
  if (params.includeEmptied) query.set("emptied", "1");

  return query;
}

export function reportHref(
  report: ReportKey,
  params: ReportParams,
  defaults: ReportDefaults,
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
  defaults: ReportDefaults,
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
  defaults: ReportDefaults,
  key: string,
): string {
  const active = params.sort === key;

  return reportHref(
    report,
    {
      ...params,
      sort: key,
      /*
       * Clicking the active column flips it; clicking a new one starts from
       * that report's own default, so the compliance register opens each
       * column soonest-first rather than jumping to desc.
       */
      direction: active
        ? params.direction === "asc"
          ? "desc"
          : "asc"
        : defaults.direction,
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
