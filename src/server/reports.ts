import "server-only";

import { Prisma } from "@/generated/prisma/client";
import { endOfDayExclusive, startOfDay } from "@/lib/date-range";
import { toSafeError, type SafeError } from "@/lib/errors";
import {
  committedSpendStatuses,
  revenueStatuses,
  spendStatuses,
} from "@/lib/money-basis";
import { prisma } from "@/lib/prisma";
import type { ReportParams } from "@/lib/report-query";
import { requireUser } from "@/server/auth";

/**
 * The reporting queries.
 *
 * Three rules shape every one of them, and all three are about not producing a
 * number that is confidently wrong.
 *
 * **The financial definitions are not redefined here.** Revenue, spend and
 * committed spend come from src/lib/money-basis.ts, interpolated as enum arrays
 * rather than written out as string literals — so a report and the dashboard
 * cannot come to disagree about what counts. The literal-string form is what
 * let three modules drift apart before that file existed.
 *
 * **Dates are the economic event, not the paperwork.** Sales are dated by
 * `confirmed_at`, the moment stock left and cost was frozen; procurement by
 * `received_at`, the moment stock and cost arrived. A draft raised in March and
 * confirmed in June is June's revenue. `created_at` dates intent, and would
 * quietly move revenue into the month somebody started typing.
 *
 * **Unknown cost stays unknown.** Stock whose acquisition cost was never
 * recorded is excluded from value and counted separately — never zero, never
 * `standardCost`. Tier 1 reports no profitability figure at all, because the
 * only honest one on the current data would be an absence.
 *
 * Everything aggregates in Postgres. A report over a long history must never
 * become a page that loads the history to add it up.
 */

export type Result<T> = { ok: true; data: T } | { ok: false; error: SafeError };

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

export interface ReportPage<Row, Totals> {
  rows: Row[];
  totals: Totals;
  /** Rows matching the filters, which is what the pagination counts. */
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

/**
 * The date predicate, as SQL.
 *
 * Inclusive at both ends: the upper bound is midnight on the *following* day
 * compared with `<`, so "to the 26th" covers the whole of the 26th. Getting
 * this wrong drops a day of business from a report with nothing to show for it.
 *
 * A null bound produces no predicate rather than a very old or very future
 * date, so an all-time report genuinely scans without a date filter.
 */
function dateFilter(
  column: Prisma.Sql,
  from: string | null,
  to: string | null,
): Prisma.Sql {
  const clauses: Prisma.Sql[] = [];

  if (from) clauses.push(Prisma.sql`${column} >= ${startOfDay(from)}`);
  if (to) clauses.push(Prisma.sql`${column} < ${endOfDayExclusive(to)}`);

  return clauses.length === 0
    ? Prisma.sql`TRUE`
    : Prisma.join(clauses, " AND ");
}

/** `ORDER BY` from a whitelist, so nothing arbitrary reaches the query. */
function orderBy(
  columns: Record<string, string>,
  sort: string,
  direction: "asc" | "desc",
  fallback: string,
): Prisma.Sql {
  const column = columns[sort] ?? columns[fallback]!;
  return Prisma.raw(`${column} ${direction === "asc" ? "ASC" : "DESC"} NULLS LAST`);
}

// ---------------------------------------------------------------------------
// R1 · Stock valuation
// ---------------------------------------------------------------------------

export interface ValuationRow {
  productId: string;
  sku: string;
  name: string;
  category: string;
  supplierName: string | null;
  productStatus: string;
  units: number;
  costedUnits: number;
  uncostedUnits: number;
  /** Value of the costed units, at what was actually paid for them. */
  valueAtCost: string;
  /** `stockQuantity × sellingPrice`. A different basis — see the note below. */
  valueAtRetail: string;
  /** Percentage of units on hand whose cost is known. */
  coverage: number;
}

export interface ValuationTotals {
  products: number;
  units: number;
  costedUnits: number;
  uncostedUnits: number;
  valueAtCost: string;
  valueAtRetail: string;
  coverage: number;
  /** Retired products still holding stock, so it can be told apart. */
  retiredProducts: number;
  retiredUnits: number;
  retiredValueAtCost: string;
}

const VALUATION_SORTS: Record<string, string> = {
  value: "value_at_cost",
  retail: "value_at_retail",
  units: "units",
  uncosted: "uncosted_units",
  sku: "sku",
  name: "name",
  category: "category",
  coverage: "coverage",
};

interface ValuationSqlRow {
  product_id: string;
  sku: string;
  name: string;
  category: string;
  supplier_name: string | null;
  product_status: string;
  units: number;
  costed_units: number;
  uncosted_units: number;
  value_at_cost: string;
  value_at_retail: string;
  coverage: number;
}

/**
 * What is on the shelf and what it cost.
 *
 * Current state only. Historical as-of valuation is deliberately not offered:
 * it is reconstructible from the append-only consumption rows, but lots created
 * by the backfill carry a `received_at` in the past and a `created_at` at
 * migration time, so any as-of date before that boundary would misstate them.
 * Offering a date picker that implies otherwise would be worse than not
 * offering one.
 *
 * Two value columns, on two different bases, and the difference is not
 * cosmetic. Cost comes from the lots — what was actually paid, for the units
 * whose price is known. Retail is `stockQuantity × sellingPrice`, and the
 * selling price genuinely *is* authoritative in a way the old catalogue cost
 * never was. The report labels them separately so nobody reads them as two
 * estimates of one number.
 */
export async function loadValuationReport(
  params: ReportParams,
): Promise<Result<ReportPage<ValuationRow, ValuationTotals>>> {
  try {
    await requireUser();

    const filters: Prisma.Sql[] = [Prisma.sql`TRUE`];

    if (params.supplierId) {
      filters.push(Prisma.sql`p.supplier_id = ${params.supplierId}`);
    }
    if (params.category) {
      filters.push(Prisma.sql`p.category = ${params.category}`);
    }
    if (params.search) {
      filters.push(
        Prisma.sql`(p.name ILIKE ${"%" + params.search + "%"} OR p.sku ILIKE ${"%" + params.search + "%"})`,
      );
    }

    const where = Prisma.join(filters, " AND ");

    /*
     * Lots are aggregated per product in a subquery rather than joined
     * directly: joining would multiply the product row by its lot count and
     * make `stock_quantity × selling_price` sum once per lot.
     */
    const lotAggregate = Prisma.sql`
      SELECT
        l.product_id,
        SUM(l.quantity_remaining)                                      AS units,
        SUM(l.quantity_remaining) FILTER (WHERE l.unit_cost IS NOT NULL) AS costed,
        SUM(l.quantity_remaining) FILTER (WHERE l.unit_cost IS NULL)     AS uncosted,
        SUM(l.quantity_remaining * l.unit_cost)
          FILTER (WHERE l.unit_cost IS NOT NULL)                       AS value
      FROM stock_lots l
      WHERE l.quantity_remaining > 0
      GROUP BY l.product_id
    `;

    const [rows, totals, countRows] = await Promise.all([
      prisma.$queryRaw<ValuationSqlRow[]>`
        SELECT
          p.id                                        AS product_id,
          p.sku,
          p.name,
          p.category,
          s.name                                      AS supplier_name,
          p.status::text                              AS product_status,
          COALESCE(lots.units, 0)::int                AS units,
          COALESCE(lots.costed, 0)::int               AS costed_units,
          COALESCE(lots.uncosted, 0)::int             AS uncosted_units,
          COALESCE(lots.value, 0)::text               AS value_at_cost,
          (p.stock_quantity * p.selling_price)::text  AS value_at_retail,
          CASE
            WHEN COALESCE(lots.units, 0) = 0 THEN 0
            ELSE ROUND(COALESCE(lots.costed, 0)::numeric * 100 / lots.units, 1)
          END::float8                                 AS coverage
        FROM products p
        LEFT JOIN suppliers s ON s.id = p.supplier_id
        LEFT JOIN (${lotAggregate}) lots ON lots.product_id = p.id
        WHERE ${where} AND p.stock_quantity > 0
        ORDER BY ${orderBy(VALUATION_SORTS, params.sort, params.direction, "value")}, p.sku ASC
        LIMIT ${params.pageSize} OFFSET ${(params.page - 1) * params.pageSize}
      `,
      prisma.$queryRaw<
        {
          products: number;
          units: number;
          costed_units: number;
          uncosted_units: number;
          value_at_cost: string;
          value_at_retail: string;
          retired_products: number;
          retired_units: number;
          retired_value: string;
        }[]
      >`
        SELECT
          COUNT(*)::int                                            AS products,
          COALESCE(SUM(COALESCE(lots.units, 0)), 0)::int           AS units,
          COALESCE(SUM(COALESCE(lots.costed, 0)), 0)::int          AS costed_units,
          COALESCE(SUM(COALESCE(lots.uncosted, 0)), 0)::int        AS uncosted_units,
          COALESCE(SUM(COALESCE(lots.value, 0)), 0)::text          AS value_at_cost,
          COALESCE(SUM(p.stock_quantity * p.selling_price), 0)::text AS value_at_retail,
          COUNT(*) FILTER (WHERE p.status <> 'ACTIVE')::int        AS retired_products,
          COALESCE(SUM(COALESCE(lots.units, 0))
            FILTER (WHERE p.status <> 'ACTIVE'), 0)::int           AS retired_units,
          COALESCE(SUM(COALESCE(lots.value, 0))
            FILTER (WHERE p.status <> 'ACTIVE'), 0)::text          AS retired_value
        FROM products p
        LEFT JOIN (${lotAggregate}) lots ON lots.product_id = p.id
        WHERE ${where} AND p.stock_quantity > 0
      `,
      prisma.$queryRaw<{ n: number }[]>`
        SELECT COUNT(*)::int AS n
        FROM products p
        WHERE ${where} AND p.stock_quantity > 0
      `,
    ]);

    const t = totals[0] ?? {
      products: 0,
      units: 0,
      costed_units: 0,
      uncosted_units: 0,
      value_at_cost: "0",
      value_at_retail: "0",
      retired_products: 0,
      retired_units: 0,
      retired_value: "0",
    };

    const count = countRows[0]?.n ?? 0;

    return {
      ok: true,
      data: {
        rows: rows.map((row) => ({
          productId: row.product_id,
          sku: row.sku,
          name: row.name,
          category: row.category,
          supplierName: row.supplier_name,
          productStatus: row.product_status,
          units: row.units,
          costedUnits: row.costed_units,
          uncostedUnits: row.uncosted_units,
          valueAtCost: row.value_at_cost,
          valueAtRetail: row.value_at_retail,
          coverage: row.coverage,
        })),
        totals: {
          products: t.products,
          units: t.units,
          costedUnits: t.costed_units,
          uncostedUnits: t.uncosted_units,
          valueAtCost: t.value_at_cost,
          valueAtRetail: t.value_at_retail,
          coverage:
            t.units === 0
              ? 0
              : Math.round((t.costed_units / t.units) * 1000) / 10,
          retiredProducts: t.retired_products,
          retiredUnits: t.retired_units,
          retiredValueAtCost: t.retired_value,
        },
        total: count,
        page: params.page,
        pageSize: params.pageSize,
        pageCount: Math.max(1, Math.ceil(count / params.pageSize)),
      },
    };
  } catch (error) {
    return { ok: false, error: toSafeError(error, "loadValuationReport") };
  }
}

// ---------------------------------------------------------------------------
// R2 · Sales
// ---------------------------------------------------------------------------

export interface SalesRow {
  key: string;
  label: string;
  sublabel: string | null;
  orders: number;
  units: number;
  /** `SUM(order_items.total)` — before order-level discounts. */
  salesAtListPrice: string;
  /**
   * `SUM(orders.total)` — after order-level discounts.
   *
   * Null for product and category groupings. An order-level discount applies to
   * a whole order, and splitting it across the lines would mean inventing an
   * allocation rule. The report says so rather than showing an apportioned
   * figure nobody agreed the basis for.
   */
  realisedRevenue: string | null;
}

export interface SalesTotals {
  orders: number;
  units: number;
  salesAtListPrice: string;
  realisedRevenue: string;
  /** The gap between the two bases — order-level discounts, in total. */
  discounts: string;
}

const SALES_SORTS: Record<string, string> = {
  value: "sales_at_list_price",
  revenue: "realised_revenue",
  units: "units",
  orders: "orders",
  label: "label",
};

interface SalesSqlRow {
  key: string;
  label: string;
  sublabel: string | null;
  orders: number;
  units: number;
  sales_at_list_price: string;
  realised_revenue: string | null;
}

/**
 * Realised sales, dated by when each order was confirmed.
 *
 * Two revenue concepts, never conflated. **Realised revenue** is
 * `SUM(orders.total)` — what customers actually paid, after the order-level
 * discount. **Sales at list price** is `SUM(order_items.total)` — line prices
 * before it. They differ by the discounts, and the totals row shows that gap
 * explicitly so the two columns reconcile on screen rather than looking like
 * one of them is wrong.
 *
 * Grouping by product or category can only use the list-price basis. Realised
 * revenue exists at the order level and cannot be split across lines without an
 * allocation rule this system has not defined, so those groupings return null
 * for it rather than a plausible invention.
 */
export async function loadSalesReport(
  params: ReportParams,
): Promise<Result<ReportPage<SalesRow, SalesTotals>>> {
  try {
    await requireUser();

    const dated = dateFilter(Prisma.sql`o.confirmed_at`, params.from, params.to);
    const statuses = Prisma.sql`o.status = ANY(${revenueStatuses()}::"OrderStatus"[])`;

    const filters: Prisma.Sql[] = [statuses, dated];

    if (params.customerId) {
      filters.push(Prisma.sql`o.customer_id = ${params.customerId}`);
    }
    if (params.category) {
      filters.push(Prisma.sql`pr.category = ${params.category}`);
    }
    if (params.search) {
      filters.push(
        Prisma.sql`(pr.name ILIKE ${"%" + params.search + "%"} OR pr.sku ILIKE ${"%" + params.search + "%"} OR c.name ILIKE ${"%" + params.search + "%"})`,
      );
    }

    const where = Prisma.join(filters, " AND ");

    /*
     * Realised revenue is an order-level figure, so summing it across a join to
     * order_items would count it once per line. It is aggregated over distinct
     * orders — which is only meaningful when the grouping *is* the order or
     * something an order belongs to whole, hence the null for product and
     * category groupings below.
     */
    const grouped = (() => {
      switch (params.grouping) {
        case "product":
          return {
            key: Prisma.sql`pr.id`,
            label: Prisma.sql`pr.name`,
            sublabel: Prisma.sql`pr.sku`,
          };
        case "category":
          return {
            key: Prisma.sql`pr.category`,
            label: Prisma.sql`pr.category`,
            sublabel: Prisma.sql`NULL::text`,
          };
        case "customer":
          return {
            key: Prisma.sql`c.id`,
            label: Prisma.sql`c.name`,
            sublabel: Prisma.sql`NULL::text`,
          };
        case "period":
        default:
          return {
            key: Prisma.sql`to_char(date_trunc('month', o.confirmed_at), 'YYYY-MM')`,
            label: Prisma.sql`to_char(date_trunc('month', o.confirmed_at), 'YYYY-MM')`,
            sublabel: Prisma.sql`NULL::text`,
          };
      }
    })();

    const wantsRevenue =
      params.grouping === "period" || params.grouping === "customer";

    /*
     * The order total is divided by its line count and summed back, so an order
     * spanning several lines contributes its total exactly once per group
     * rather than once per line. Equivalent to a distinct sum, and it avoids a
     * second pass over the orders.
     */
    const revenueExpr = wantsRevenue
      ? Prisma.sql`COALESCE(SUM(o.total / NULLIF(line_counts.n, 0)), 0)::text`
      : Prisma.sql`NULL::text`;

    const base = Prisma.sql`
      FROM order_items oi
      JOIN orders o    ON o.id = oi.order_id
      JOIN products pr ON pr.id = oi.product_id
      JOIN customers c ON c.id = o.customer_id
      JOIN (
        SELECT order_id, COUNT(*)::numeric AS n FROM order_items GROUP BY order_id
      ) line_counts ON line_counts.order_id = o.id
      WHERE ${where}
    `;

    const [rows, totals, countRows] = await Promise.all([
      prisma.$queryRaw<SalesSqlRow[]>`
        SELECT
          ${grouped.key}::text                        AS key,
          ${grouped.label}::text                      AS label,
          ${grouped.sublabel}                         AS sublabel,
          COUNT(DISTINCT o.id)::int                   AS orders,
          COALESCE(SUM(oi.quantity), 0)::int          AS units,
          COALESCE(SUM(oi.total), 0)::text            AS sales_at_list_price,
          ${revenueExpr}                              AS realised_revenue
        ${base}
        GROUP BY ${grouped.key}, ${grouped.label}, ${grouped.sublabel}
        ORDER BY ${orderBy(SALES_SORTS, params.sort, params.direction, "value")}, label ASC
        LIMIT ${params.pageSize} OFFSET ${(params.page - 1) * params.pageSize}
      `,
      prisma.$queryRaw<
        { orders: number; units: number; list: string; revenue: string }[]
      >`
        SELECT
          COUNT(DISTINCT o.id)::int          AS orders,
          COALESCE(SUM(oi.quantity), 0)::int AS units,
          COALESCE(SUM(oi.total), 0)::text   AS list,
          COALESCE(SUM(o.total / NULLIF(line_counts.n, 0)), 0)::text AS revenue
        ${base}
      `,
      prisma.$queryRaw<{ n: number }[]>`
        SELECT COUNT(*)::int AS n FROM (
          SELECT ${grouped.key} ${base} GROUP BY ${grouped.key}
        ) g
      `,
    ]);

    const t = totals[0] ?? { orders: 0, units: 0, list: "0", revenue: "0" };
    const count = countRows[0]?.n ?? 0;

    return {
      ok: true,
      data: {
        rows: rows.map((row) => ({
          key: row.key,
          label: row.label,
          sublabel: row.sublabel,
          orders: row.orders,
          units: row.units,
          salesAtListPrice: row.sales_at_list_price,
          realisedRevenue: row.realised_revenue,
        })),
        totals: {
          orders: t.orders,
          units: t.units,
          salesAtListPrice: t.list,
          realisedRevenue: t.revenue,
          discounts: (Number(t.list) - Number(t.revenue)).toFixed(2),
        },
        total: count,
        page: params.page,
        pageSize: params.pageSize,
        pageCount: Math.max(1, Math.ceil(count / params.pageSize)),
      },
    };
  } catch (error) {
    return { ok: false, error: toSafeError(error, "loadSalesReport") };
  }
}

// ---------------------------------------------------------------------------
// R3 · Purchase spend
// ---------------------------------------------------------------------------

export interface PurchaseSpendRow {
  key: string;
  label: string;
  sublabel: string | null;
  purchases: number;
  units: number;
  /** RECEIVED only — goods actually delivered. */
  receivedSpend: string;
}

export interface PurchaseSpendTotals {
  purchases: number;
  units: number;
  receivedSpend: string;
  /** PENDING — placed with a supplier, not yet arrived. Never counted as spend. */
  committedSpend: string;
  committedPurchases: number;
}

const PURCHASE_SORTS: Record<string, string> = {
  value: "received_spend",
  units: "units",
  purchases: "purchases",
  label: "label",
};

interface PurchaseSqlRow {
  key: string;
  label: string;
  sublabel: string | null;
  purchases: number;
  units: number;
  received_spend: string;
}

/**
 * Procurement spend, dated by when each delivery was received.
 *
 * `received_at` rather than `purchase_date`, because the economic event is the
 * goods arriving: that is when stock and its cost entered the business. A
 * purchase placed in March and received in June is June's spend.
 *
 * **Spend is not cost of sales.** These are different events at different
 * times — on the current data there is procurement in June against no revenue
 * at all — so nothing here may be subtracted from sales to produce a margin.
 * COGS comes from `OrderItem.costTotal` and appears in no Tier 1 report.
 *
 * Committed spend is reported alongside but never added in: a pending purchase
 * is money promised, not money spent, and drafts and cancellations are neither.
 */
export async function loadPurchaseSpendReport(
  params: ReportParams,
): Promise<Result<ReportPage<PurchaseSpendRow, PurchaseSpendTotals>>> {
  try {
    await requireUser();

    const dated = dateFilter(Prisma.sql`p.received_at`, params.from, params.to);
    const statuses = Prisma.sql`p.status = ANY(${spendStatuses()}::"PurchaseStatus"[])`;

    const filters: Prisma.Sql[] = [statuses, dated];

    if (params.supplierId) {
      filters.push(Prisma.sql`p.supplier_id = ${params.supplierId}`);
    }
    if (params.category) {
      filters.push(Prisma.sql`pr.category = ${params.category}`);
    }
    if (params.search) {
      filters.push(
        Prisma.sql`(pr.name ILIKE ${"%" + params.search + "%"} OR pr.sku ILIKE ${"%" + params.search + "%"} OR s.name ILIKE ${"%" + params.search + "%"})`,
      );
    }

    const where = Prisma.join(filters, " AND ");

    const grouped = (() => {
      switch (params.grouping) {
        case "supplier":
          return {
            key: Prisma.sql`s.id`,
            label: Prisma.sql`s.name`,
            sublabel: Prisma.sql`NULL::text`,
          };
        case "product":
          return {
            key: Prisma.sql`pr.id`,
            label: Prisma.sql`pr.name`,
            sublabel: Prisma.sql`pr.sku`,
          };
        case "category":
          return {
            key: Prisma.sql`pr.category`,
            label: Prisma.sql`pr.category`,
            sublabel: Prisma.sql`NULL::text`,
          };
        case "period":
        default:
          return {
            key: Prisma.sql`to_char(date_trunc('month', p.received_at), 'YYYY-MM')`,
            label: Prisma.sql`to_char(date_trunc('month', p.received_at), 'YYYY-MM')`,
            sublabel: Prisma.sql`NULL::text`,
          };
      }
    })();

    const base = Prisma.sql`
      FROM purchase_items pi
      JOIN purchases p  ON p.id = pi.purchase_id
      JOIN products pr  ON pr.id = pi.product_id
      JOIN suppliers s  ON s.id = p.supplier_id
      WHERE ${where}
    `;

    const [rows, totals, committed, countRows] = await Promise.all([
      prisma.$queryRaw<PurchaseSqlRow[]>`
        SELECT
          ${grouped.key}::text               AS key,
          ${grouped.label}::text             AS label,
          ${grouped.sublabel}                AS sublabel,
          COUNT(DISTINCT p.id)::int          AS purchases,
          COALESCE(SUM(pi.quantity), 0)::int AS units,
          COALESCE(SUM(pi.total), 0)::text   AS received_spend
        ${base}
        GROUP BY ${grouped.key}, ${grouped.label}, ${grouped.sublabel}
        ORDER BY ${orderBy(PURCHASE_SORTS, params.sort, params.direction, "value")}, label ASC
        LIMIT ${params.pageSize} OFFSET ${(params.page - 1) * params.pageSize}
      `,
      prisma.$queryRaw<{ purchases: number; units: number; spend: string }[]>`
        SELECT
          COUNT(DISTINCT p.id)::int          AS purchases,
          COALESCE(SUM(pi.quantity), 0)::int AS units,
          COALESCE(SUM(pi.total), 0)::text   AS spend
        ${base}
      `,
      /*
       * Committed spend is dated by `purchase_date`, not `received_at` —
       * nothing has been received, so there is no receipt date to filter on.
       */
      prisma.$queryRaw<{ n: number; total: string }[]>`
        SELECT
          COUNT(*)::int                  AS n,
          COALESCE(SUM(p.total), 0)::text AS total
        FROM purchases p
        WHERE p.status = ANY(${committedSpendStatuses()}::"PurchaseStatus"[])
          AND ${dateFilter(Prisma.sql`p.purchase_date`, params.from, params.to)}
          ${params.supplierId ? Prisma.sql`AND p.supplier_id = ${params.supplierId}` : Prisma.empty}
      `,
      prisma.$queryRaw<{ n: number }[]>`
        SELECT COUNT(*)::int AS n FROM (
          SELECT ${grouped.key} ${base} GROUP BY ${grouped.key}
        ) g
      `,
    ]);

    const t = totals[0] ?? { purchases: 0, units: 0, spend: "0" };
    const c = committed[0] ?? { n: 0, total: "0" };
    const count = countRows[0]?.n ?? 0;

    return {
      ok: true,
      data: {
        rows: rows.map((row) => ({
          key: row.key,
          label: row.label,
          sublabel: row.sublabel,
          purchases: row.purchases,
          units: row.units,
          receivedSpend: row.received_spend,
        })),
        totals: {
          purchases: t.purchases,
          units: t.units,
          receivedSpend: t.spend,
          committedSpend: c.total,
          committedPurchases: c.n,
        },
        total: count,
        page: params.page,
        pageSize: params.pageSize,
        pageCount: Math.max(1, Math.ceil(count / params.pageSize)),
      },
    };
  } catch (error) {
    return { ok: false, error: toSafeError(error, "loadPurchaseSpendReport") };
  }
}
