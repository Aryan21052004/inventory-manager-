import { isOrderStatus, type OrderStatus } from "@/lib/order-status";
import {
  readDateRange,
  readOne,
  type RawSearchParams,
} from "@/lib/date-range";

/**
 * The orders list's state, and how it maps to the URL.
 *
 * Same arrangement as the products list (src/lib/product-query.ts): the query
 * string is the state, so a filtered view is bookmarkable and the page stays a
 * server component. Shared by both sides, so no server-only import here.
 */

const ORDER_SORT_KEYS = [
  "orderNumber",
  "customer",
  "status",
  "total",
  "createdAt",
] as const;

export type OrderSortKey = (typeof ORDER_SORT_KEYS)[number];
export type SortDirection = "asc" | "desc";

const ORDER_PAGE_SIZES = [10, 25, 50, 100] as const;
const DEFAULT_ORDER_PAGE_SIZE = 10;

export interface OrderListParams {
  /** Matches the order number or the customer's name, case-insensitively. */
  search: string;
  customerId: string | null;
  status: OrderStatus | null;
  /** Inclusive `YYYY-MM-DD` bounds on the order date. */
  from: string | null;
  to: string | null;
  sort: OrderSortKey;
  direction: SortDirection;
  page: number;
  pageSize: number;
}

export const DEFAULT_ORDER_PARAMS: OrderListParams = {
  search: "",
  customerId: null,
  status: null,
  from: null,
  to: null,
  // Newest first: an orders list is a worklist, and the thing you want is the
  // one that just came in — unlike a catalogue, which reads alphabetically.
  sort: "createdAt",
  direction: "desc",
  page: 1,
  pageSize: DEFAULT_ORDER_PAGE_SIZE,
};

/** Re-exported so existing callers keep their import path. */
export type { RawSearchParams };

/**
 * Turns a query string into list parameters, discarding anything unrecognised.
 *
 * Nothing here trusts the URL — a status that is not one of the five, a sort
 * key outside the whitelist, a date that is not a date, each falls back to the
 * default rather than reaching the query builder.
 */
export function parseOrderListParams(raw: RawSearchParams): OrderListParams {
  const sort = readOne(raw, "sort");
  const status = readOne(raw, "status");
  const page = Number(readOne(raw, "page") ?? "1");
  const pageSize = Number(readOne(raw, "size") ?? DEFAULT_ORDER_PAGE_SIZE);
  const direction = readOne(raw, "dir");

  const range = readDateRange(raw);

  return {
    search: readOne(raw, "q") ?? "",
    customerId: readOne(raw, "customer"),
    status: isOrderStatus(status) ? status : null,
    // Swapping a backwards range happens in `readDateRange` now.
    from: range.from,
    to: range.to,
    sort: ORDER_SORT_KEYS.includes(sort as OrderSortKey)
      ? (sort as OrderSortKey)
      : DEFAULT_ORDER_PARAMS.sort,
    direction: direction === "asc" ? "asc" : "desc",
    page: Number.isInteger(page) && page >= 1 ? page : 1,
    pageSize: (ORDER_PAGE_SIZES as readonly number[]).includes(pageSize)
      ? pageSize
      : DEFAULT_ORDER_PAGE_SIZE,
  };
}

/** Serialises back to a query string, leaving defaults out. */
export function toOrderSearchParams(params: OrderListParams): URLSearchParams {
  const query = new URLSearchParams();

  if (params.search) query.set("q", params.search);
  if (params.customerId) query.set("customer", params.customerId);
  if (params.status) query.set("status", params.status);
  if (params.from) query.set("from", params.from);
  if (params.to) query.set("to", params.to);
  if (params.sort !== DEFAULT_ORDER_PARAMS.sort) query.set("sort", params.sort);
  if (params.direction !== DEFAULT_ORDER_PARAMS.direction) {
    query.set("dir", params.direction);
  }
  if (params.page > 1) query.set("page", String(params.page));
  if (params.pageSize !== DEFAULT_ORDER_PAGE_SIZE) {
    query.set("size", String(params.pageSize));
  }

  return query;
}

export function ordersHref(params: OrderListParams): string {
  const query = toOrderSearchParams(params).toString();
  return query ? `/orders?${query}` : "/orders";
}

/**
 * The href for a column heading. Clicking the active column flips the
 * direction; any other column starts descending, which for dates and money is
 * what someone means by "sort by this".
 */
export function orderSortHref(
  params: OrderListParams,
  key: OrderSortKey,
): string {
  const active = params.sort === key;

  return ordersHref({
    ...params,
    sort: key,
    direction: active && params.direction === "desc" ? "asc" : "desc",
    page: 1,
  });
}

export function hasActiveOrderFilters(params: OrderListParams): boolean {
  return Boolean(
    params.search ||
      params.customerId ||
      params.status ||
      params.from ||
      params.to,
  );
}
