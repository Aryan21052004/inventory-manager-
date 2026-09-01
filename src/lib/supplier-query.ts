import type { SupplierStatus } from "@/generated/prisma/enums";
import { readOne, type RawSearchParams } from "@/lib/date-range";

/**
 * The suppliers list's state, and how it maps to the URL.
 *
 * Same arrangement as the products, orders, customers and stock movement lists:
 * the query string is the state, so a filtered view is bookmarkable and the page
 * stays a server component. Shared by both sides — the page parses with it, the
 * filter bar serialises with it — so no server-only import belongs here.
 */

const SUPPLIER_SORT_KEYS = [
  "name",
  "accountNumber",
  "email",
  "leadTime",
  "purchases",
  "createdAt",
] as const;

export type SupplierSortKey = (typeof SUPPLIER_SORT_KEYS)[number];
export type SortDirection = "asc" | "desc";

/**
 * Two figures are deliberately absent from the sort keys: total purchased, and
 * the count of products supplied.
 *
 * Neither is a column. One is a sum over a filtered subset of another table —
 * received purchases only — and the other a count across a relation. Sorting by
 * either would mean abandoning the query builder for raw SQL across every
 * filter combination, which is the same trade the customers list declined for
 * lifetime value. Both are still shown on every row; they are computed for the
 * page being displayed, not for the whole directory.
 *
 * `purchases` is sortable because Prisma can order by a relation count
 * directly, which costs nothing extra.
 */

export const SUPPLIER_STATUSES = ["ACTIVE", "INACTIVE"] as const;

function isSupplierStatus(value: unknown): value is SupplierStatus {
  return (
    typeof value === "string" &&
    (SUPPLIER_STATUSES as readonly string[]).includes(value)
  );
}

export const SUPPLIER_STATUS_LABELS: Record<SupplierStatus, string> = {
  ACTIVE: "Active",
  INACTIVE: "Archived",
};

const SUPPLIER_PAGE_SIZES = [10, 25, 50, 100] as const;
const DEFAULT_SUPPLIER_PAGE_SIZE = 10;

export interface SupplierListParams {
  /** Matches the name, contact person, email, phone or account number. */
  search: string;
  status: SupplierStatus | null;
  sort: SupplierSortKey;
  direction: SortDirection;
  page: number;
  pageSize: number;
}

export const DEFAULT_SUPPLIER_PARAMS: SupplierListParams = {
  search: "",
  status: null,
  // A directory is read alphabetically, like the customers list — unlike a
  // ledger, where the newest entry is the one explaining the current state.
  sort: "name",
  direction: "asc",
  page: 1,
  pageSize: DEFAULT_SUPPLIER_PAGE_SIZE,
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
 * Nothing here trusts the URL. A status that is not one of the two, a sort key
 * outside the whitelist, a page that is not a number — each falls back to the
 * default rather than reaching the query builder. A query string is user input
 * like any other, and it is the one people edit by hand.
 */
export function parseSupplierListParams(
  raw: RawSearchParams,
): SupplierListParams {
  const sort = readOne(raw, "sort");
  const status = readOne(raw, "status");
  const direction = readOne(raw, "dir");
  const page = Number(readOne(raw, "page") ?? "1");
  const pageSize = Number(readOne(raw, "size") ?? DEFAULT_SUPPLIER_PAGE_SIZE);

  return {
    search: readOne(raw, "q") ?? "",
    status: isSupplierStatus(status) ? status : null,
    sort: SUPPLIER_SORT_KEYS.includes(sort as SupplierSortKey)
      ? (sort as SupplierSortKey)
      : DEFAULT_SUPPLIER_PARAMS.sort,
    direction: direction === "desc" ? "desc" : "asc",
    page: Number.isInteger(page) && page >= 1 ? page : 1,
    pageSize: (SUPPLIER_PAGE_SIZES as readonly number[]).includes(pageSize)
      ? pageSize
      : DEFAULT_SUPPLIER_PAGE_SIZE,
  };
}

/** Serialises back to a query string, leaving defaults out. */
export function toSupplierSearchParams(
  params: SupplierListParams,
): URLSearchParams {
  const query = new URLSearchParams();

  if (params.search) query.set("q", params.search);
  if (params.status) query.set("status", params.status);
  if (params.sort !== DEFAULT_SUPPLIER_PARAMS.sort) {
    query.set("sort", params.sort);
  }
  if (params.direction !== DEFAULT_SUPPLIER_PARAMS.direction) {
    query.set("dir", params.direction);
  }
  if (params.page > 1) query.set("page", String(params.page));
  if (params.pageSize !== DEFAULT_SUPPLIER_PAGE_SIZE) {
    query.set("size", String(params.pageSize));
  }

  return query;
}

export function suppliersHref(params: SupplierListParams): string {
  const query = toSupplierSearchParams(params).toString();
  return query ? `/suppliers?${query}` : "/suppliers";
}

/**
 * The href for a column heading. Clicking the active column flips the
 * direction; any other column starts ascending, which is what reading a list of
 * names or account numbers wants.
 */
export function supplierSortHref(
  params: SupplierListParams,
  key: SupplierSortKey,
): string {
  const active = params.sort === key;

  return suppliersHref({
    ...params,
    sort: key,
    direction: active && params.direction === "asc" ? "desc" : "asc",
    page: 1,
  });
}

export function hasActiveSupplierFilters(params: SupplierListParams): boolean {
  return Boolean(params.search || params.status);
}
