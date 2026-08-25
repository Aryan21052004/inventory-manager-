/**
 * Stock status, derived — never stored.
 *
 * There is no `status` column for this and there should not be one. A stored
 * copy is a second answer to a question the data already answers, and the two
 * drift the moment anything writes a quantity without remembering to
 * recalculate: the row says LOW_STOCK, the quantity says 400, and the report
 * built on the column disagrees with the report built on the number. Deriving
 * it costs a comparison and cannot be wrong.
 *
 * The same three rules have to hold in SQL as well, because filtering a page of
 * products by status has to happen in the database rather than after loading
 * the whole catalogue. `stockStatusWhere` in src/server/products.ts is that
 * translation, and it mirrors the boundaries below exactly.
 */

export type StockStatus = "NORMAL" | "LOW_STOCK" | "OUT_OF_STOCK";

export interface StockLevel {
  stockQuantity: number;
  minimumStock: number;
}

/**
 * The rules, in order:
 *
 *   OUT_OF_STOCK   stock = 0
 *   LOW_STOCK      stock > 0 and stock <= minimumStock
 *   NORMAL         stock > minimumStock
 *
 * Note the boundary: at exactly the minimum a product is low, not normal. The
 * minimum is the level at which you reorder, so reaching it is the signal.
 *
 * `<= 0` rather than `=== 0` for the first rule. A negative quantity is not
 * reachable — the column has a non-negative check constraint and the stock
 * engine refuses to write one — but if one ever appeared, calling it out of
 * stock is the honest reading, and falling through to LOW_STOCK would be wrong.
 */
export function stockStatus({
  stockQuantity,
  minimumStock,
}: StockLevel): StockStatus {
  if (stockQuantity <= 0) return "OUT_OF_STOCK";
  if (stockQuantity <= minimumStock) return "LOW_STOCK";
  return "NORMAL";
}

export const STOCK_STATUSES: readonly StockStatus[] = [
  "NORMAL",
  "LOW_STOCK",
  "OUT_OF_STOCK",
];

export function isStockStatus(value: unknown): value is StockStatus {
  return (
    typeof value === "string" &&
    STOCK_STATUSES.includes(value as StockStatus)
  );
}

const STOCK_STATUS_LABELS: Record<StockStatus, string> = {
  NORMAL: "In stock",
  LOW_STOCK: "Low stock",
  OUT_OF_STOCK: "Out of stock",
};

export function stockStatusLabel(status: StockStatus): string {
  return STOCK_STATUS_LABELS[status];
}
