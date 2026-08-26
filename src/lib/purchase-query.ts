import { isPurchaseStatus, type PurchaseStatus } from "@/lib/purchase-status";

/**
 * The purchases list's state, and how it maps to the URL.
 *
 * Same arrangement as the products and orders lists: the query string is the
 * state, so a filtered view is bookmarkable and the page stays a server
 * component. Shared by both sides, so no server-only import here.
 */

export const PURCHASE_SORT_KEYS = [
  "purchaseNumber",
  "supplier",
  "status",
  "total",
  "purchaseDate",
] as const;

export type PurchaseSortKey = (typeof PURCHASE_SORT_KEYS)[number];
export type SortDirection = "asc" | "desc";

export const PURCHASE_PAGE_SIZES = [10, 25, 50, 100] as const;
export const DEFAULT_PURCHASE_PAGE_SIZE = 10;

export interface PurchaseListParams {
  /** Matches the purchase number or the supplier's name, case-insensitively. */
  search: string;
  supplierId: string | null;
  status: PurchaseStatus | null;
  /** Inclusive `YYYY-MM-DD` bounds on the purchase date. */
  from: string | null;
  to: string | null;
  sort: PurchaseSortKey;
  direction: SortDirection;
  page: number;
  pageSize: number;
}

export const DEFAULT_PURCHASE_PARAMS: PurchaseListParams = {
  search: "",
  supplierId: null,
  status: null,
  from: null,
  to: null,
  // Newest first: a purchase list is a worklist, and the thing you want is
  // usually the delivery that just landed.
  sort: "purchaseDate",
  direction: "desc",
  page: 1,
  pageSize: DEFAULT_PURCHASE_PAGE_SIZE,
};

export type RawSearchParams = Record<string, string | string[] | undefined>;

function readOne(raw: RawSearchParams, key: string): string | null {
  const value = raw[key];
  const single = Array.isArray(value) ? value[0] : value;
  const trimmed = single?.trim();
  return trimmed ? trimmed : null;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function readDate(raw: RawSearchParams, key: string): string | null {
  const value = readOne(raw, key);
  return value && ISO_DAY.test(value) ? value : null;
}

/**
 * Turns a query string into list parameters, discarding anything unrecognised.
 * A query string is user input like any other, and it is the one people edit by
 * hand.
 */
export function parsePurchaseListParams(
  raw: RawSearchParams,
): PurchaseListParams {
  const sort = readOne(raw, "sort");
  const status = readOne(raw, "status");
  const page = Number(readOne(raw, "page") ?? "1");
  const pageSize = Number(readOne(raw, "size") ?? DEFAULT_PURCHASE_PAGE_SIZE);
  const direction = readOne(raw, "dir");

  const from = readDate(raw, "from");
  const to = readDate(raw, "to");

  return {
    search: readOne(raw, "q") ?? "",
    supplierId: readOne(raw, "supplier"),
    status: isPurchaseStatus(status) ? status : null,
    // A backwards range returns nothing and looks like a bug. Swapping is what
    // the person meant.
    from: from && to && from > to ? to : from,
    to: from && to && from > to ? from : to,
    sort: PURCHASE_SORT_KEYS.includes(sort as PurchaseSortKey)
      ? (sort as PurchaseSortKey)
      : DEFAULT_PURCHASE_PARAMS.sort,
    direction: direction === "asc" ? "asc" : "desc",
    page: Number.isInteger(page) && page >= 1 ? page : 1,
    pageSize: (PURCHASE_PAGE_SIZES as readonly number[]).includes(pageSize)
      ? pageSize
      : DEFAULT_PURCHASE_PAGE_SIZE,
  };
}

/** Serialises back to a query string, leaving defaults out. */
export function toPurchaseSearchParams(
  params: PurchaseListParams,
): URLSearchParams {
  const query = new URLSearchParams();

  if (params.search) query.set("q", params.search);
  if (params.supplierId) query.set("supplier", params.supplierId);
  if (params.status) query.set("status", params.status);
  if (params.from) query.set("from", params.from);
  if (params.to) query.set("to", params.to);
  if (params.sort !== DEFAULT_PURCHASE_PARAMS.sort) {
    query.set("sort", params.sort);
  }
  if (params.direction !== DEFAULT_PURCHASE_PARAMS.direction) {
    query.set("dir", params.direction);
  }
  if (params.page > 1) query.set("page", String(params.page));
  if (params.pageSize !== DEFAULT_PURCHASE_PAGE_SIZE) {
    query.set("size", String(params.pageSize));
  }

  return query;
}

export function purchasesHref(params: PurchaseListParams): string {
  const query = toPurchaseSearchParams(params).toString();
  return query ? `/purchases?${query}` : "/purchases";
}

/**
 * The href for a column heading. Clicking the active column flips the
 * direction; any other column starts descending, which for dates and money is
 * what someone means by "sort by this".
 */
export function purchaseSortHref(
  params: PurchaseListParams,
  key: PurchaseSortKey,
): string {
  const active = params.sort === key;

  return purchasesHref({
    ...params,
    sort: key,
    direction: active && params.direction === "desc" ? "asc" : "desc",
    page: 1,
  });
}

export function hasActivePurchaseFilters(params: PurchaseListParams): boolean {
  return Boolean(
    params.search ||
      params.supplierId ||
      params.status ||
      params.from ||
      params.to,
  );
}
