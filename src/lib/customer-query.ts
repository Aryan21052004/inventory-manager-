import type { CustomerStatus } from "@/generated/prisma/enums";

/**
 * The customers list's state, and how it maps to the URL.
 *
 * Same arrangement as the products, orders and stock movement lists: the query
 * string is the state, so a filtered view is bookmarkable and the page stays a
 * server component. Shared by both sides — the page parses with it, the filter
 * bar serialises with it — so no server-only import belongs here.
 */

export const CUSTOMER_SORT_KEYS = [
  "name",
  "email",
  "orders",
  "createdAt",
] as const;

export type CustomerSortKey = (typeof CUSTOMER_SORT_KEYS)[number];
export type SortDirection = "asc" | "desc";

/**
 * Lifetime value is deliberately absent from the sort keys.
 *
 * It is not a column — it is a sum over a filtered subset of another table —
 * and sorting the list by it would mean abandoning the Prisma query builder for
 * raw SQL across every filter combination. The figure is still shown on each
 * row; it is computed for the page being displayed, not for the catalogue.
 */

export const CUSTOMER_STATUSES = ["ACTIVE", "INACTIVE"] as const;

export function isCustomerStatus(value: unknown): value is CustomerStatus {
  return (
    typeof value === "string" &&
    (CUSTOMER_STATUSES as readonly string[]).includes(value)
  );
}

export const CUSTOMER_STATUS_LABELS: Record<CustomerStatus, string> = {
  ACTIVE: "Active",
  INACTIVE: "Archived",
};

export const CUSTOMER_PAGE_SIZES = [10, 25, 50, 100] as const;
export const DEFAULT_CUSTOMER_PAGE_SIZE = 10;

export interface CustomerListParams {
  /** Matches the name, email or phone, case-insensitively. */
  search: string;
  status: CustomerStatus | null;
  sort: CustomerSortKey;
  direction: SortDirection;
  page: number;
  pageSize: number;
}

export const DEFAULT_CUSTOMER_PARAMS: CustomerListParams = {
  search: "",
  status: null,
  // A directory is read alphabetically — unlike a ledger, where the newest
  // entry is the one that explains the current state.
  sort: "name",
  direction: "asc",
  page: 1,
  pageSize: DEFAULT_CUSTOMER_PAGE_SIZE,
};

/** What Next hands a page as `searchParams`. */
export type RawSearchParams = Record<string, string | string[] | undefined>;

function readOne(raw: RawSearchParams, key: string): string | null {
  const value = raw[key];
  const single = Array.isArray(value) ? value[0] : value;
  const trimmed = single?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Turns a query string into list parameters, discarding anything unrecognised.
 *
 * Nothing here trusts the URL. A status that is not one of the two, a sort key
 * outside the whitelist, a page that is not a number — each falls back to the
 * default rather than reaching the query builder. A query string is user input
 * like any other, and it is the one people edit by hand.
 */
export function parseCustomerListParams(
  raw: RawSearchParams,
): CustomerListParams {
  const sort = readOne(raw, "sort");
  const status = readOne(raw, "status");
  const direction = readOne(raw, "dir");
  const page = Number(readOne(raw, "page") ?? "1");
  const pageSize = Number(readOne(raw, "size") ?? DEFAULT_CUSTOMER_PAGE_SIZE);

  return {
    search: readOne(raw, "q") ?? "",
    status: isCustomerStatus(status) ? status : null,
    sort: CUSTOMER_SORT_KEYS.includes(sort as CustomerSortKey)
      ? (sort as CustomerSortKey)
      : DEFAULT_CUSTOMER_PARAMS.sort,
    direction: direction === "desc" ? "desc" : "asc",
    page: Number.isInteger(page) && page >= 1 ? page : 1,
    pageSize: (CUSTOMER_PAGE_SIZES as readonly number[]).includes(pageSize)
      ? pageSize
      : DEFAULT_CUSTOMER_PAGE_SIZE,
  };
}

/** Serialises back to a query string, leaving defaults out. */
export function toCustomerSearchParams(
  params: CustomerListParams,
): URLSearchParams {
  const query = new URLSearchParams();

  if (params.search) query.set("q", params.search);
  if (params.status) query.set("status", params.status);
  if (params.sort !== DEFAULT_CUSTOMER_PARAMS.sort) {
    query.set("sort", params.sort);
  }
  if (params.direction !== DEFAULT_CUSTOMER_PARAMS.direction) {
    query.set("dir", params.direction);
  }
  if (params.page > 1) query.set("page", String(params.page));
  if (params.pageSize !== DEFAULT_CUSTOMER_PAGE_SIZE) {
    query.set("size", String(params.pageSize));
  }

  return query;
}

export function customersHref(params: CustomerListParams): string {
  const query = toCustomerSearchParams(params).toString();
  return query ? `/customers?${query}` : "/customers";
}

/**
 * The href for a column heading. Clicking the active column flips the
 * direction; any other column starts ascending, which is what reading a list of
 * names or addresses wants.
 */
export function customerSortHref(
  params: CustomerListParams,
  key: CustomerSortKey,
): string {
  const active = params.sort === key;

  return customersHref({
    ...params,
    sort: key,
    direction: active && params.direction === "asc" ? "desc" : "asc",
    page: 1,
  });
}

export function hasActiveCustomerFilters(params: CustomerListParams): boolean {
  return Boolean(params.search || params.status);
}
