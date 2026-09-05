import { readOne, type RawSearchParams } from "@/lib/date-range";

/**
 * The products list's state, and how it maps to the URL.
 *
 * The query string is the state. Not component state — the URL — because that
 * is what makes a filtered view something you can bookmark, send to a
 * colleague, or come back to with the browser's back button. It also means the
 * page stays a server component: the filters arrive as `searchParams`, the
 * query runs on the server, and the browser is never handed the whole catalogue
 * to filter for itself.
 *
 * This module is shared by both sides — the page parses with it, the filter bar
 * serialises with it — so it must stay free of any server-only import.
 */

/*
 * Cost is deliberately not among these.
 *
 * `standardCost` was a sortable column until the catalogue stopped carrying a
 * cost at all. Browsing a product list by cost only makes sense when a product
 * *has* one, and the same part bought at ₹8,000, ₹9,500 and ₹11,000 does not —
 * whatever such a column ranked by would be one arbitrary batch, or an average
 * of batches nobody bought at. It is not replaced by last-paid or average cost
 * for that reason. Actual inventory value is a question the valuation report
 * answers properly, per lot, disclosing its own coverage.
 */
const PRODUCT_SORT_KEYS = [
  "name",
  "sku",
  "category",
  "sellingPrice",
  "stockQuantity",
  "supplier",
  "createdAt",
] as const;

export type ProductSortKey = (typeof PRODUCT_SORT_KEYS)[number];
export type SortDirection = "asc" | "desc";

export const PRODUCT_STATUSES = [
  "ACTIVE",
  "INACTIVE",
  "DISCONTINUED",
] as const;

export type ProductStatusFilter = (typeof PRODUCT_STATUSES)[number];

const PAGE_SIZES = [10, 25, 50, 100] as const;
const DEFAULT_PAGE_SIZE = 10;

export interface ProductListParams {
  /** Matches product name or SKU, case-insensitively. */
  search: string;
  category: string | null;
  status: ProductStatusFilter | null;
  supplierId: string | null;
  sort: ProductSortKey;
  direction: SortDirection;
  page: number;
  pageSize: number;
}

export const DEFAULT_LIST_PARAMS: ProductListParams = {
  search: "",
  category: null,
  status: null,
  supplierId: null,
  sort: "name",
  direction: "asc",
  page: 1,
  pageSize: DEFAULT_PAGE_SIZE,
};

/*
 * `RawSearchParams` and `readOne` come from src/lib/date-range.ts, which is
 * where the query-string primitives live now. This module had its own private
 * copy of both — identical to the other five lists', and to the shared one.
 */
export type { RawSearchParams };

/**
 * Turns a query string into list parameters, discarding anything unrecognised.
 *
 * Nothing here trusts the URL. A sort key that is not in the whitelist, a page
 * that is not a number, a status that is not one of the three — each falls back
 * to the default rather than reaching the query builder. A query string is
 * user input like any other, and it is the one people edit by hand.
 */
export function parseProductListParams(
  raw: RawSearchParams,
): ProductListParams {
  const sort = readOne(raw, "sort");
  const direction = readOne(raw, "dir");
  const status = readOne(raw, "status");
  const page = Number(readOne(raw, "page") ?? "1");
  const pageSize = Number(readOne(raw, "size") ?? DEFAULT_PAGE_SIZE);

  return {
    search: readOne(raw, "q") ?? "",
    category: readOne(raw, "category"),
    status: PRODUCT_STATUSES.includes(status as ProductStatusFilter)
      ? (status as ProductStatusFilter)
      : null,
    supplierId: readOne(raw, "supplier"),
    sort: PRODUCT_SORT_KEYS.includes(sort as ProductSortKey)
      ? (sort as ProductSortKey)
      : DEFAULT_LIST_PARAMS.sort,
    direction: direction === "desc" ? "desc" : "asc",
    // A page below 1 or a non-number is not an error worth a 400 — it is a
    // mangled link, and the first page is what the person wanted.
    page: Number.isInteger(page) && page >= 1 ? page : 1,
    pageSize: (PAGE_SIZES as readonly number[]).includes(pageSize)
      ? pageSize
      : DEFAULT_PAGE_SIZE,
  };
}

/**
 * Serialises parameters back into a query string, leaving defaults out.
 *
 * An unfiltered list should be `/products`, not `/products?q=&page=1&sort=name`
 * — the second is the same page wearing a URL nobody wants to share.
 */
export function toSearchParams(params: ProductListParams): URLSearchParams {
  const query = new URLSearchParams();

  if (params.search) query.set("q", params.search);
  if (params.category) query.set("category", params.category);
  if (params.status) query.set("status", params.status);
  if (params.supplierId) query.set("supplier", params.supplierId);
  if (params.sort !== DEFAULT_LIST_PARAMS.sort) query.set("sort", params.sort);
  if (params.direction !== DEFAULT_LIST_PARAMS.direction) {
    query.set("dir", params.direction);
  }
  if (params.page > 1) query.set("page", String(params.page));
  if (params.pageSize !== DEFAULT_PAGE_SIZE) {
    query.set("size", String(params.pageSize));
  }

  return query;
}

/** `/products` plus whatever of the state is not already the default. */
export function productsHref(params: ProductListParams): string {
  const query = toSearchParams(params).toString();
  return query ? `/products?${query}` : "/products";
}

/**
 * The href for a column heading.
 *
 * Clicking the column already being sorted by flips the direction; clicking any
 * other column starts it at ascending, which is what reading a list of names or
 * SKUs wants. Either way it returns to page one — page four of the old ordering
 * has nothing to do with page four of the new one.
 */
export function sortHref(
  params: ProductListParams,
  key: ProductSortKey,
): string {
  const active = params.sort === key;

  return productsHref({
    ...params,
    sort: key,
    direction: active && params.direction === "asc" ? "desc" : "asc",
    page: 1,
  });
}

/** True when any filter is narrowing the list — drives the "Clear" control. */
export function hasActiveFilters(params: ProductListParams): boolean {
  return Boolean(
    params.search ||
      params.category ||
      params.status ||
      params.supplierId,
  );
}
