import type { StockTransactionType } from "@/generated/prisma/enums";
import {
  readDateRange,
  readOne,
  type RawSearchParams,
} from "@/lib/date-range";

/**
 * The stock movements list's state, and how it maps to the URL.
 *
 * Same arrangement as the products and orders lists: the query string is the
 * state, so a filtered view is bookmarkable and the page stays a server
 * component. Shared by both sides, so no server-only import here.
 */

const MOVEMENT_SORT_KEYS = [
  "createdAt",
  "product",
  "type",
  "quantity",
  "newStock",
] as const;

export type MovementSortKey = (typeof MOVEMENT_SORT_KEYS)[number];
export type SortDirection = "asc" | "desc";

export const MOVEMENT_TYPES: readonly StockTransactionType[] = [
  "STOCK_IN",
  "STOCK_OUT",
  "ADJUSTMENT",
  "REVERSAL",
] as const;

function isMovementType(value: unknown): value is StockTransactionType {
  return (
    typeof value === "string" &&
    (MOVEMENT_TYPES as readonly string[]).includes(value)
  );
}

export const MOVEMENT_TYPE_LABELS: Record<StockTransactionType, string> = {
  STOCK_IN: "Stock In",
  STOCK_OUT: "Stock Out",
  ADJUSTMENT: "Adjustment",
  REVERSAL: "Reversal",
};

const MOVEMENT_PAGE_SIZES = [10, 25, 50, 100] as const;
const DEFAULT_MOVEMENT_PAGE_SIZE = 25;

export interface MovementListParams {
  /** Matches the product name or SKU, case-insensitively. */
  search: string;
  productId: string | null;
  type: StockTransactionType | null;
  /** Inclusive `YYYY-MM-DD` bounds on the movement date. */
  from: string | null;
  to: string | null;
  sort: MovementSortKey;
  direction: SortDirection;
  page: number;
  pageSize: number;
}

export const DEFAULT_MOVEMENT_PARAMS: MovementListParams = {
  search: "",
  productId: null,
  type: null,
  from: null,
  to: null,
  // Newest first: a ledger is read backwards — the most recent event is what
  // explains the current state.
  sort: "createdAt",
  direction: "desc",
  page: 1,
  pageSize: DEFAULT_MOVEMENT_PAGE_SIZE,
};

/** Re-exported so existing callers keep their import path. */
export type { RawSearchParams };

/**
 * Turns a query string into list parameters, discarding anything unrecognised.
 *
 * Nothing here trusts the URL — a type that is not one of the four, a sort key
 * outside the whitelist, a date that is not a date, each falls back to the
 * default rather than reaching the query builder.
 */
export function parseMovementListParams(
  raw: RawSearchParams,
): MovementListParams {
  const sort = readOne(raw, "sort");
  const type = readOne(raw, "type");
  const page = Number(readOne(raw, "page") ?? "1");
  const pageSize = Number(readOne(raw, "size") ?? DEFAULT_MOVEMENT_PAGE_SIZE);
  const direction = readOne(raw, "dir");

  const range = readDateRange(raw);

  return {
    search: readOne(raw, "q") ?? "",
    productId: readOne(raw, "product"),
    type: isMovementType(type) ? type : null,
    // Swapping a backwards range happens in `readDateRange` now.
    from: range.from,
    to: range.to,
    sort: MOVEMENT_SORT_KEYS.includes(sort as MovementSortKey)
      ? (sort as MovementSortKey)
      : DEFAULT_MOVEMENT_PARAMS.sort,
    direction: direction === "asc" ? "asc" : "desc",
    page: Number.isInteger(page) && page >= 1 ? page : 1,
    pageSize: (MOVEMENT_PAGE_SIZES as readonly number[]).includes(pageSize)
      ? pageSize
      : DEFAULT_MOVEMENT_PAGE_SIZE,
  };
}

/** Serialises back to a query string, leaving defaults out. */
export function toMovementSearchParams(
  params: MovementListParams,
): URLSearchParams {
  const query = new URLSearchParams();

  if (params.search) query.set("q", params.search);
  if (params.productId) query.set("product", params.productId);
  if (params.type) query.set("type", params.type);
  if (params.from) query.set("from", params.from);
  if (params.to) query.set("to", params.to);
  if (params.sort !== DEFAULT_MOVEMENT_PARAMS.sort)
    query.set("sort", params.sort);
  if (params.direction !== DEFAULT_MOVEMENT_PARAMS.direction) {
    query.set("dir", params.direction);
  }
  if (params.page > 1) query.set("page", String(params.page));
  if (params.pageSize !== DEFAULT_MOVEMENT_PAGE_SIZE) {
    query.set("size", String(params.pageSize));
  }

  return query;
}

export function movementsHref(params: MovementListParams): string {
  const query = toMovementSearchParams(params).toString();
  return query ? `/stock-movements?${query}` : "/stock-movements";
}

/**
 * The href for a column heading. Clicking the active column flips the
 * direction; any other column starts descending, which for dates and quantities
 * is what someone means by "sort by this".
 */
export function movementSortHref(
  params: MovementListParams,
  key: MovementSortKey,
): string {
  const active = params.sort === key;

  return movementsHref({
    ...params,
    sort: key,
    direction: active && params.direction === "desc" ? "asc" : "desc",
    page: 1,
  });
}

export function hasActiveMovementFilters(params: MovementListParams): boolean {
  return Boolean(
    params.search ||
      params.productId ||
      params.type ||
      params.from ||
      params.to,
  );
}
