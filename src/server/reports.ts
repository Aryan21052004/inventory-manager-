import "server-only";

import { Prisma } from "@/generated/prisma/client";
import { endOfDayExclusive, startOfDay } from "@/lib/date-range";
import { toSafeError, type SafeError } from "@/lib/errors";
import {
  committedSpendStatuses,
  revenueStatuses,
  spendStatuses,
} from "@/lib/money-basis";
import type { Currency } from "@/lib/currency";
import {
  groupTotals,
  NO_MONEY,
  type MoneyByCurrency,
} from "@/lib/money-by-currency";
import { prisma } from "@/lib/prisma";
import type { ReportParams } from "@/lib/report-query";
import {
  certificateStatus,
  EXPIRING_SOON_DAYS,
  type CertificateStatus,
} from "@/lib/certificate-status";
import { requireUser } from "@/server/auth";
import { certificateFileUrl } from "@/server/certificates";

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

/**
 * What every `GROUP BY <currency column>` in this file comes back as.
 *
 * One row per currency, already summed by Postgres. `currency` is null for
 * rows recorded before per-record currency existed, and that null is a bucket
 * of its own — never folded into a named currency, never filled in from the
 * installation default.
 */
interface MoneySqlRow {
  currency: Currency | null;
  amount: string;
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
  valueAtCostByCurrency: MoneyByCurrency;
  /** `stockQuantity × sellingPrice`. A different basis — see the note below. */
  valueAtRetailByCurrency: MoneyByCurrency;
  /** Percentage of units on hand whose cost is known. */
  coverage: number;
}

export interface ValuationTotals {
  products: number;
  units: number;
  costedUnits: number;
  uncostedUnits: number;
  valueAtCostByCurrency: MoneyByCurrency;
  valueAtRetailByCurrency: MoneyByCurrency;
  /** Units whose product carries no reference price. Excluded from retail. */
  unpricedUnits: number;
  coverage: number;
  /** Retired products still holding stock, so it can be told apart. */
  retiredProducts: number;
  retiredUnits: number;
  retiredValueAtCostByCurrency: MoneyByCurrency;
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
  /**
   * The costed lots behind this product, one entry per currency they were
   * bought in. Aggregated in the database, so nothing here has been added
   * across two currencies. Null when the product holds no costed stock.
   */
  value_by_currency: { currency: Currency | null; amount: string }[] | null;
  /** `stockQuantity × sellingPrice`, null when the product has no price. */
  retail_value: string | null;
  retail_currency: Currency | null;
  /**
   * Sort keys only, never displayed. Null when no single defensible number
   * exists — several currencies, or one that was never recorded — which the
   * `NULLS LAST` in `orderBy` then pushes to the end in both directions.
   */
  value_at_cost: string | null;
  value_at_retail: string | null;
  unpriced_units: number;
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
 * whose price is known. Retail is `stockQuantity × sellingPrice` at the
 * catalogue's **reference** price.
 *
 * That qualifier is load-bearing. Retail used to be defended on the grounds
 * that the selling price "genuinely is authoritative in a way the old catalogue
 * cost never was" — a claim per-customer quoting withdrew. The same part goes
 * out at ₹12,000 to one customer and ₹13,500 to another, so no single figure is
 * what the shelf would realise. It is an indication, and the column says so.
 *
 * Both columns now disclose their own coverage: `uncostedUnits` for stock with
 * no known acquisition cost, `unpricedUnits` for stock whose product has no
 * reference price. Neither is valued at zero and neither is guessed.
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
     *
     * Two levels, because a product's lots no longer share a currency. The
     * inner grouping is by (product, currency) and is where the money is
     * actually added; the outer one collects those subtotals into a JSON list
     * and adds up only the unit counts, which are currency-agnostic. The
     * scalar `value` that survives is deliberately null unless the product
     * has exactly one known currency — it is the sort key, and there is no
     * defensible single figure to sort a mixed row by.
     */
    const lotAggregate = Prisma.sql`
      SELECT
        pc.product_id,
        SUM(pc.units)::int                                             AS units,
        SUM(pc.costed)::int                                            AS costed,
        SUM(pc.uncosted)::int                                          AS uncosted,
        JSONB_AGG(
          JSONB_BUILD_OBJECT('currency', pc.cost_currency, 'amount', pc.value::text)
          ORDER BY pc.cost_currency
        ) FILTER (WHERE pc.value IS NOT NULL)                          AS value_by_currency,
        CASE
          WHEN COUNT(*) FILTER (WHERE pc.value IS NOT NULL) = 1
           AND COUNT(*) FILTER (
                 WHERE pc.value IS NOT NULL AND pc.cost_currency IS NULL
               ) = 0
          THEN MAX(pc.value) FILTER (WHERE pc.value IS NOT NULL)
        END                                                            AS value
      FROM (
        SELECT
          l.product_id,
          l.cost_currency,
          SUM(l.quantity_remaining)                                        AS units,
          SUM(l.quantity_remaining) FILTER (WHERE l.unit_cost IS NOT NULL)  AS costed,
          SUM(l.quantity_remaining) FILTER (WHERE l.unit_cost IS NULL)      AS uncosted,
          SUM(l.quantity_remaining * l.unit_cost)
            FILTER (WHERE l.unit_cost IS NOT NULL)                         AS value
        FROM stock_lots l
        WHERE l.quantity_remaining > 0
        GROUP BY l.product_id, l.cost_currency
      ) pc
      GROUP BY pc.product_id
    `;

    /* Only the products this report is looking at, for the money queries. */
    const scope = Prisma.sql`${where} AND p.stock_quantity > 0`;

    const [rows, totals, countRows, costMoney, retailMoney, retiredMoney] =
      await Promise.all([
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
            lots.value_by_currency                      AS value_by_currency,
            (p.stock_quantity * p.selling_price)::text  AS retail_value,
            CASE WHEN p.selling_price IS NULL THEN NULL ELSE p.price_currency END
                                                        AS retail_currency,
            lots.value::text                            AS value_at_cost,
            CASE
              WHEN p.selling_price IS NOT NULL AND p.price_currency IS NOT NULL
              THEN (p.stock_quantity * p.selling_price)::text
            END                                         AS value_at_retail,
            CASE WHEN p.selling_price IS NULL THEN p.stock_quantity ELSE 0 END::int
                                                        AS unpriced_units,
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
        /*
         * Counts only. The three money figures that used to live here have
         * moved into the grouped queries below, because summing `lots.value`
           * over the whole page would add currencies together — which is the one
           * thing this application must never do.
           */
          prisma.$queryRaw<
            {
              products: number;
              units: number;
              costed_units: number;
              uncosted_units: number;
              unpriced_units: number;
              retired_products: number;
              retired_units: number;
            }[]
          >`
          SELECT
            COUNT(*)::int                                            AS products,
            COALESCE(SUM(COALESCE(lots.units, 0)), 0)::int           AS units,
            COALESCE(SUM(COALESCE(lots.costed, 0)), 0)::int          AS costed_units,
            COALESCE(SUM(COALESCE(lots.uncosted, 0)), 0)::int        AS uncosted_units,
            COALESCE(SUM(p.stock_quantity)
              FILTER (WHERE p.selling_price IS NULL), 0)::int       AS unpriced_units,
            COUNT(*) FILTER (WHERE p.status <> 'ACTIVE')::int        AS retired_products,
            COALESCE(SUM(COALESCE(lots.units, 0))
              FILTER (WHERE p.status <> 'ACTIVE'), 0)::int           AS retired_units
          FROM products p
          LEFT JOIN (${lotAggregate}) lots ON lots.product_id = p.id
          WHERE ${scope}
      `,
        prisma.$queryRaw<{ n: number }[]>`
          SELECT COUNT(*)::int AS n
          FROM products p
          WHERE ${scope}
      `,
        /*
         * Cost value across the report, per currency. Joined to the lots rather
         * than to the per-product aggregate so the grouping key is the lot's own
         * currency.
         */
        prisma.$queryRaw<MoneySqlRow[]>`
          SELECT
            l.cost_currency                                AS currency,
            SUM(l.quantity_remaining * l.unit_cost)::text  AS amount
          FROM stock_lots l
          JOIN products p ON p.id = l.product_id
          WHERE ${scope}
            AND l.quantity_remaining > 0
            AND l.unit_cost IS NOT NULL
          GROUP BY l.cost_currency
      `,
        /* Retail value, per the currency the catalogue price is quoted in. */
        prisma.$queryRaw<MoneySqlRow[]>`
          SELECT
            p.price_currency                               AS currency,
            SUM(p.stock_quantity * p.selling_price)::text  AS amount
          FROM products p
          WHERE ${scope} AND p.selling_price IS NOT NULL
          GROUP BY p.price_currency
      `,
        /* The same cost basis, narrowed to products no longer active. */
        prisma.$queryRaw<MoneySqlRow[]>`
          SELECT
            l.cost_currency                                AS currency,
            SUM(l.quantity_remaining * l.unit_cost)::text  AS amount
          FROM stock_lots l
          JOIN products p ON p.id = l.product_id
          WHERE ${scope}
            AND p.status <> 'ACTIVE'
            AND l.quantity_remaining > 0
            AND l.unit_cost IS NOT NULL
          GROUP BY l.cost_currency
      `,
      ]);

    const t = totals[0] ?? {
      products: 0,
      units: 0,
      costed_units: 0,
      uncosted_units: 0,
      unpriced_units: 0,
      retired_products: 0,
      retired_units: 0,
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
          valueAtCostByCurrency: groupTotals(row.value_by_currency ?? []),
          valueAtRetailByCurrency:
            row.retail_value === null
              ? NO_MONEY
              : groupTotals([
                  { currency: row.retail_currency, amount: row.retail_value },
                ]),
          unpricedUnits: row.unpriced_units,
          coverage: row.coverage,
        })),
        totals: {
          products: t.products,
          units: t.units,
          costedUnits: t.costed_units,
          uncostedUnits: t.uncosted_units,
          valueAtCostByCurrency: groupTotals(costMoney),
          valueAtRetailByCurrency: groupTotals(retailMoney),
          unpricedUnits: t.unpriced_units,
          coverage:
            t.units === 0
              ? 0
              : Math.round((t.costed_units / t.units) * 1000) / 10,
          retiredProducts: t.retired_products,
          retiredUnits: t.retired_units,
          retiredValueAtCostByCurrency: groupTotals(retiredMoney),
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
  /**
   * `SUM(order_items.total)` — what the customer was charged.
   *
   * One basis, not two. This used to sit beside a separate `realisedRevenue`
   * read from `SUM(orders.total)`, because an order-level discount made the two
   * genuinely different numbers. With the discount feature removed (§20),
   * `orders.total = orders.subtotal = SUM(order_items.total)` by check
   * constraint, so the distinction described a difference that can no longer
   * exist.
   */
  revenueByCurrency: MoneyByCurrency;
}

export interface SalesTotals {
  orders: number;
  units: number;
  revenueByCurrency: MoneyByCurrency;
}

const SALES_SORTS: Record<string, string> = {
  value: "revenue",
  revenue: "revenue",
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
  /** One entry per currency the group's orders were raised in. */
  revenue_by_currency: { currency: Currency | null; amount: string }[] | null;
  /** Sort key only. Null unless the group is in one known currency. */
  revenue: string | null;
}

/**
 * Realised sales, dated by when each order was confirmed.
 *
 * **One revenue basis.** Revenue is `SUM(order_items.total)`, which is what the
 * customer was charged, at every grouping.
 *
 * This carried two bases until the discount feature was removed (§20). An
 * order-level discount lived on the order rather than on its lines, so
 * `SUM(orders.total)` and `SUM(order_items.total)` were different numbers and
 * the report showed both plus the gap between them. It also meant revenue could
 * not be reported per product or per category at all — splitting an order-level
 * discount across lines would have meant inventing an allocation rule — so
 * those groupings returned null.
 *
 * Both consequences are gone. `orders.total = orders.subtotal =
 * SUM(order_items.total)` is now a check constraint, so summing the lines is
 * summing the order, and **revenue is reportable at every grouping** including
 * the two that previously could not have it.
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

    /*
     * No `line_counts` join, and no division.
     *
     * Revenue used to come from `orders.total`, an order-level figure, so
     * summing it across a join to `order_items` counted it once per line. The
     * fix was to divide each order's total by its line count and sum that back
     * — correct, but only necessary because the order carried a discount its
     * lines did not.
     *
     * Summing `order_items.total` needs none of that: it is already per-line,
     * so it groups by anything without double-counting. The join and the
     * division went with the discount (§20).
     */
    const base = Prisma.sql`
      FROM order_items oi
      JOIN orders o    ON o.id = oi.order_id
      JOIN products pr ON pr.id = oi.product_id
      JOIN customers c ON c.id = o.customer_id
      WHERE ${where}
    `;

    const [rows, totals, countRows, revenueMoney] = await Promise.all([
      /*
       * Grouped twice: by (group, currency) inside, where the money is added,
       * and by the group alone outside, where the per-currency subtotals are
       * collected into a list. An order carries exactly one currency, so
       * `COUNT(DISTINCT o.id)` never counts the same order in two buckets and
       * the order and unit counts add up across them safely.
       */
      prisma.$queryRaw<SalesSqlRow[]>`
        SELECT
          g.key,
          g.label,
          g.sublabel,
          SUM(g.orders)::int                          AS orders,
          SUM(g.units)::int                           AS units,
          JSONB_AGG(
            JSONB_BUILD_OBJECT('currency', g.currency, 'amount', g.revenue::text)
            ORDER BY g.currency
          )                                           AS revenue_by_currency,
          CASE
            WHEN COUNT(*) = 1 AND COUNT(*) FILTER (WHERE g.currency IS NULL) = 0
            THEN MAX(g.revenue)::text
          END                                         AS revenue
        FROM (
          SELECT
            ${grouped.key}::text                        AS key,
            ${grouped.label}::text                      AS label,
            ${grouped.sublabel}                         AS sublabel,
            o.currency                                  AS currency,
            COUNT(DISTINCT o.id)::int                   AS orders,
            COALESCE(SUM(oi.quantity), 0)::int          AS units,
            COALESCE(SUM(oi.total), 0)                  AS revenue
          ${base}
          GROUP BY ${grouped.key}, ${grouped.label}, ${grouped.sublabel}, o.currency
        ) g
        GROUP BY g.key, g.label, g.sublabel
        ORDER BY ${orderBy(SALES_SORTS, params.sort, params.direction, "value")}, label ASC
        LIMIT ${params.pageSize} OFFSET ${(params.page - 1) * params.pageSize}
      `,
      prisma.$queryRaw<{ orders: number; units: number }[]>`
        SELECT
          COUNT(DISTINCT o.id)::int          AS orders,
          COALESCE(SUM(oi.quantity), 0)::int AS units
        ${base}
      `,
      prisma.$queryRaw<{ n: number }[]>`
        SELECT COUNT(*)::int AS n FROM (
          SELECT ${grouped.key} ${base} GROUP BY ${grouped.key}
        ) g
      `,
      /* Revenue across the whole report, split by the order's currency. */
      prisma.$queryRaw<MoneySqlRow[]>`
        SELECT
          o.currency                        AS currency,
          COALESCE(SUM(oi.total), 0)::text  AS amount
        ${base}
        GROUP BY o.currency
      `,
    ]);

    const t = totals[0] ?? { orders: 0, units: 0 };
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
          revenueByCurrency: groupTotals(row.revenue_by_currency ?? []),
        })),
        totals: {
          orders: t.orders,
          units: t.units,
          revenueByCurrency: groupTotals(revenueMoney),
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
  receivedSpendByCurrency: MoneyByCurrency;
}

export interface PurchaseSpendTotals {
  purchases: number;
  units: number;
  receivedSpendByCurrency: MoneyByCurrency;
  /** PENDING — placed with a supplier, not yet arrived. Never counted as spend. */
  committedSpendByCurrency: MoneyByCurrency;
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
  /** One entry per currency the group's purchases were raised in. */
  received_spend_by_currency:
    { currency: Currency | null; amount: string }[] | null;
  /** Sort key only. Null unless the group is in one known currency. */
  received_spend: string | null;
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

    const [rows, totals, committed, countRows, spendMoney] = await Promise.all([
      /*
       * The same two-level grouping the sales report uses: (group, currency)
       * inside where the money is added, group alone outside where the
       * subtotals are gathered. A purchase has one currency, so the purchase
       * and unit counts still add up across the buckets.
       */
      prisma.$queryRaw<PurchaseSqlRow[]>`
        SELECT
          g.key,
          g.label,
          g.sublabel,
          SUM(g.purchases)::int              AS purchases,
          SUM(g.units)::int                  AS units,
          JSONB_AGG(
            JSONB_BUILD_OBJECT('currency', g.currency, 'amount', g.spend::text)
            ORDER BY g.currency
          )                                  AS received_spend_by_currency,
          CASE
            WHEN COUNT(*) = 1 AND COUNT(*) FILTER (WHERE g.currency IS NULL) = 0
            THEN MAX(g.spend)::text
          END                                AS received_spend
        FROM (
          SELECT
            ${grouped.key}::text               AS key,
            ${grouped.label}::text             AS label,
            ${grouped.sublabel}                AS sublabel,
            p.currency                         AS currency,
            COUNT(DISTINCT p.id)::int          AS purchases,
            COALESCE(SUM(pi.quantity), 0)::int AS units,
            COALESCE(SUM(pi.total), 0)         AS spend
          ${base}
          GROUP BY ${grouped.key}, ${grouped.label}, ${grouped.sublabel}, p.currency
        ) g
        GROUP BY g.key, g.label, g.sublabel
        ORDER BY ${orderBy(PURCHASE_SORTS, params.sort, params.direction, "value")}, label ASC
        LIMIT ${params.pageSize} OFFSET ${(params.page - 1) * params.pageSize}
      `,
      prisma.$queryRaw<{ purchases: number; units: number }[]>`
        SELECT
          COUNT(DISTINCT p.id)::int          AS purchases,
          COALESCE(SUM(pi.quantity), 0)::int AS units
        ${base}
      `,
      /*
       * Committed spend is dated by `purchase_date`, not `received_at` —
       * nothing has been received, so there is no receipt date to filter on.
       */
      prisma.$queryRaw<
        { n: number; currency: Currency | null; amount: string }[]
      >`
        SELECT
          COUNT(*)::int                   AS n,
          p.currency                      AS currency,
          COALESCE(SUM(p.total), 0)::text AS amount
        FROM purchases p
        WHERE p.status = ANY(${committedSpendStatuses()}::"PurchaseStatus"[])
          AND ${dateFilter(Prisma.sql`p.purchase_date`, params.from, params.to)}
          ${params.supplierId ? Prisma.sql`AND p.supplier_id = ${params.supplierId}` : Prisma.empty}
        GROUP BY p.currency
      `,
      prisma.$queryRaw<{ n: number }[]>`
        SELECT COUNT(*)::int AS n FROM (
          SELECT ${grouped.key} ${base} GROUP BY ${grouped.key}
        ) g
      `,
      /* Received spend across the whole report, split by purchase currency. */
      prisma.$queryRaw<MoneySqlRow[]>`
        SELECT
          p.currency                       AS currency,
          COALESCE(SUM(pi.total), 0)::text AS amount
        ${base}
        GROUP BY p.currency
      `,
    ]);

    const t = totals[0] ?? { purchases: 0, units: 0 };
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
          receivedSpendByCurrency: groupTotals(
            row.received_spend_by_currency ?? [],
          ),
        })),
        totals: {
          purchases: t.purchases,
          units: t.units,
          receivedSpendByCurrency: groupTotals(spendMoney),
          committedSpendByCurrency: groupTotals(committed),
          committedPurchases: committed.reduce((n, row) => n + row.n, 0),
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

// ---------------------------------------------------------------------------
// R4 · Stock movement summary
// ---------------------------------------------------------------------------

export interface MovementSummaryRow {
  key: string;
  label: string;
  sublabel: string | null;
  /** Ledger rows in this group. A confirmation and its cancellation are two. */
  movements: number;
  products: number;
  /** Units the group put on the shelf, as a positive number. */
  unitsIn: number;
  /** Units the group took off it, also as a positive number. */
  unitsOut: number;
  /** `unitsIn - unitsOut`. Negative when the group removed more than it added. */
  netChange: number;
}

export interface MovementSummaryTotals {
  movements: number;
  products: number;
  unitsIn: number;
  unitsOut: number;
  netChange: number;
}

const MOVEMENT_SORTS: Record<string, string> = {
  movements: "movements",
  products: "products",
  in: "units_in",
  out: "units_out",
  net: "net_change",
  label: "label",
};

interface MovementSqlRow {
  key: string;
  label: string;
  sublabel: string | null;
  movements: number;
  products: number;
  units_in: number;
  units_out: number;
  net_change: number;
}

/**
 * What moved in and out of stock, dated by when each movement was recorded.
 *
 * **Direction comes from the balance, never from the type.** `quantity` on a
 * ledger row is always positive — the column stores the size of the move — and
 * only STOCK_IN and STOCK_OUT carry their direction in the type. ADJUSTMENT and
 * REVERSAL go either way: a cancelled order's REVERSAL puts units back, a
 * cancelled purchase's takes them away, and both are the same type. The one
 * expression correct for all four is `new_stock - previous_stock`, which the
 * `stock_transactions_arithmetic_balances` check constraint guarantees. A CASE
 * on the type would invert one kind of reversal and still look plausible.
 *
 * **`created_at` is the economic event here**, unlike sales and procurement.
 * The ledger row is written inside the same database transaction as the balance
 * change, so there is no second timestamp meaning "when it really moved".
 * `StockLot.receivedAt` exists for backfilled batches that arrived before this
 * system and does not apply: those lots carry no originating transaction and so
 * contribute no movement at all. Nothing here invents one for them.
 *
 * Aggregate only. `/stock-movements` is the per-row ledger, with the reference
 * document, the operator, the note and the cost of each movement; this answers
 * how much moved, not which rows moved it.
 *
 * No money, deliberately. A "value moved" column on a movement report is one
 * screenshot away from being read as cost of sales, and per-movement cost
 * already exists on the ledger page.
 */
export async function loadMovementSummaryReport(
  params: ReportParams,
): Promise<Result<ReportPage<MovementSummaryRow, MovementSummaryTotals>>> {
  try {
    await requireUser();

    /*
     * The signed change one movement made. Everything below is built from this,
     * and nothing consults `type` to decide a direction.
     */
    const delta = Prisma.sql`(st.new_stock - st.previous_stock)`;

    const filters: Prisma.Sql[] = [
      dateFilter(Prisma.sql`st.created_at`, params.from, params.to),
    ];

    if (params.movementType) {
      filters.push(
        Prisma.sql`st.type = ${params.movementType}::"StockTransactionType"`,
      );
    }
    if (params.category) {
      filters.push(Prisma.sql`pr.category = ${params.category}`);
    }
    if (params.search) {
      filters.push(
        Prisma.sql`(pr.name ILIKE ${"%" + params.search + "%"} OR pr.sku ILIKE ${"%" + params.search + "%"})`,
      );
    }

    const where = Prisma.join(filters, " AND ");

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
        case "type":
          /*
           * The raw enum, translated for display by `reportRowLabel` — which
           * the page and the CSV route both call, so neither can come to spell
           * a movement type differently from the other.
           */
          return {
            key: Prisma.sql`st.type::text`,
            label: Prisma.sql`st.type::text`,
            sublabel: Prisma.sql`NULL::text`,
          };
        case "period":
        default:
          return {
            key: Prisma.sql`to_char(date_trunc('month', st.created_at), 'YYYY-MM')`,
            label: Prisma.sql`to_char(date_trunc('month', st.created_at), 'YYYY-MM')`,
            sublabel: Prisma.sql`NULL::text`,
          };
      }
    })();

    /*
     * Only the ledger and the catalogue. Orders, purchases, lots and
     * consumptions are deliberately not joined: none of them is needed to say
     * how much moved, and joining a document would drop every movement that has
     * none — opening stock and every manual adjustment.
     */
    const base = Prisma.sql`
      FROM stock_transactions st
      JOIN products pr ON pr.id = st.product_id
      WHERE ${where}
    `;

    const [rows, totals, countRows] = await Promise.all([
      prisma.$queryRaw<MovementSqlRow[]>`
        SELECT
          ${grouped.key}::text                         AS key,
          ${grouped.label}::text                       AS label,
          ${grouped.sublabel}                          AS sublabel,
          COUNT(*)::int                                AS movements,
          COUNT(DISTINCT st.product_id)::int           AS products,
          COALESCE(SUM(GREATEST(${delta}, 0)), 0)::int AS units_in,
          COALESCE(SUM(-LEAST(${delta}, 0)), 0)::int   AS units_out,
          COALESCE(SUM(${delta}), 0)::int              AS net_change
        ${base}
        GROUP BY ${grouped.key}, ${grouped.label}, ${grouped.sublabel}
        ORDER BY ${orderBy(MOVEMENT_SORTS, params.sort, params.direction, "label")}, label ASC
        LIMIT ${params.pageSize} OFFSET ${(params.page - 1) * params.pageSize}
      `,
      prisma.$queryRaw<
        {
          movements: number;
          products: number;
          units_in: number;
          units_out: number;
          net_change: number;
        }[]
      >`
        SELECT
          COUNT(*)::int                                AS movements,
          COUNT(DISTINCT st.product_id)::int           AS products,
          COALESCE(SUM(GREATEST(${delta}, 0)), 0)::int AS units_in,
          COALESCE(SUM(-LEAST(${delta}, 0)), 0)::int   AS units_out,
          COALESCE(SUM(${delta}), 0)::int              AS net_change
        ${base}
      `,
      prisma.$queryRaw<{ n: number }[]>`
        SELECT COUNT(*)::int AS n FROM (
          SELECT ${grouped.key} ${base} GROUP BY ${grouped.key}
        ) g
      `,
    ]);

    const t = totals[0] ?? {
      movements: 0,
      products: 0,
      units_in: 0,
      units_out: 0,
      net_change: 0,
    };
    const count = countRows[0]?.n ?? 0;

    return {
      ok: true,
      data: {
        rows: rows.map((row) => ({
          key: row.key,
          label: row.label,
          sublabel: row.sublabel,
          movements: row.movements,
          products: row.products,
          unitsIn: row.units_in,
          unitsOut: row.units_out,
          netChange: row.net_change,
        })),
        totals: {
          movements: t.movements,
          products: t.products,
          unitsIn: t.units_in,
          unitsOut: t.units_out,
          netChange: t.net_change,
        },
        total: count,
        page: params.page,
        pageSize: params.pageSize,
        pageCount: Math.max(1, Math.ceil(count / params.pageSize)),
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: toSafeError(error, "loadMovementSummaryReport"),
    };
  }
}

// ---------------------------------------------------------------------------
// R5 · Certificate compliance register
// ---------------------------------------------------------------------------

/**
 * One held batch and the paperwork covering it.
 *
 * Lot grain, not product grain, and that is the whole point of the report. A
 * part with two batches — one released under a valid form and one with nothing
 * filed — is one problem and one clean batch, not one product's worth of doubt
 * over both. Certificates have lived on lots since §17; this is the register
 * that makes that visible.
 */
export interface CertificateRegisterRow {
  lotId: string;
  productId: string;
  sku: string;
  productName: string;
  category: string | null;
  productStatus: string;
  receivedAt: Date;
  quantityRemaining: number;
  lotStatus: string;
  /** How the batch arrived: PURCHASE, OPENING, ADJUSTMENT, SALES_RETURN, MANUAL. */
  provenance: string;
  /** Purchase lots only. Null for every other provenance. */
  purchaseId: string | null;
  purchaseNumber: string | null;
  /**
   * **Supplier (lot provenance)** — the label any UI must use, per §17.
   *
   * An acquisition fact read from the purchase behind the batch, never an
   * attestation: it does not say the supplier issued the certificate, and lots
   * with no purchase behind them have no supplier at all.
   */
  supplierName: string | null;
  certificateId: string | null;
  certificateType: string | null;
  certificateNumber: string | null;
  issueDate: Date | null;
  /** Null means it does not expire. That is a complete answer, not a gap. */
  expiryDate: Date | null;
  /** Negative once expired; null when there is no certificate or no expiry. */
  daysToExpiry: number | null;
  status: CertificateStatus;
  /** The authenticated download route, or null when nothing is filed. */
  fileUrl: string | null;
  fileName: string | null;
}

export interface CertificateRegisterTotals {
  batches: number;
  units: number;
  valid: number;
  expiringSoon: number;
  expired: number;
  missing: number;
}

interface CertificateRegisterSqlRow {
  lot_id: string;
  product_id: string;
  sku: string;
  product_name: string;
  category: string | null;
  product_status: string;
  received_at: Date;
  quantity_remaining: number;
  lot_status: string;
  provenance: string;
  purchase_id: string | null;
  purchase_number: string | null;
  supplier_name: string | null;
  certificate_id: string | null;
  certificate_type: string | null;
  certificate_number: string | null;
  issue_date: Date | null;
  expiry_date: Date | null;
  file_name: string | null;
}

/**
 * `status` sorts by expiry as well, deliberately.
 *
 * The four states are derived from a date, so ordering by that date already
 * groups them — expired, then expiring, then dated-and-fine, with undated rows
 * (no expiry, and no certificate at all) last through the NULLS LAST every
 * `orderBy` in this module appends. A separate CASE ordering would be a second
 * expression of the same rule.
 */
const CERTIFICATE_REGISTER_SORTS: Record<string, string> = {
  expiry: "c.expiry_date",
  sku: "p.sku",
  name: "p.name",
  units: "l.quantity_remaining",
  received: "l.received_at",
  status: "c.expiry_date",
  supplier: "s.name",
};

/** Whole days between two calendar days, UTC — the reduction the status rule uses. */
function daysBetweenUtc(from: Date, to: Date): number {
  const a = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  const b = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
  return Math.round((b - a) / 86_400_000);
}

/**
 * The compliance register.
 *
 * **Current state, with no date range.** Like the valuation report and for the
 * same reason: it answers "what is on the shelf now and is its paperwork good",
 * not "what was covered in March". An as-of compliance question would need the
 * pre-costing boundary handling §13 defers, so there is deliberately no date
 * control implying one.
 *
 * **The join is the load-bearing part.** `LEFT JOIN`, so a batch with nothing
 * filed still produces a row — a register that silently omitted uncovered
 * batches would be worse than no register. And `superseded_at IS NULL`, so a
 * replaced document never reads as current coverage; the partial unique index
 * `certificates_one_current_per_lot` guarantees at most one such row per lot,
 * which is what makes the join safe without a DISTINCT.
 *
 * Legacy certificates carrying a null `stock_lot_id` cannot appear at all: the
 * join is on the lot, and `certificates_lot_required_unless_historical` already
 * guarantees every one of them is superseded. They stay readable as history on
 * the product page, which is the only place they were ever coverage.
 *
 * **Status is computed by `certificateStatus()`**, not spelled again here. That
 * function is the single definition of the rule — including that a null expiry
 * is VALID — and a second copy is exactly how a report and the dashboard come
 * to disagree about what "expiring" means. The SQL filters on *dates*, and the
 * status filter is the date predicate equivalent to the state asked for.
 *
 * **Lot status is not compliance.** A quarantined or rejected batch is
 * physically held and appears here with whatever certificate state it actually
 * has, which may be VALID. The two are separate columns and separate filters
 * because they are separate questions.
 */
export async function loadCertificateRegisterReport(
  params: ReportParams,
  now: Date = new Date(),
): Promise<
  Result<ReportPage<CertificateRegisterRow, CertificateRegisterTotals>>
> {
  try {
    await requireUser();

    const filters: Prisma.Sql[] = [Prisma.sql`TRUE`];

    /*
     * One reference day for the whole report, derived from `now` rather than
     * read from the database as `CURRENT_DATE`.
     *
     * This matters beyond testability. Row status is computed by
     * `certificateStatus(…, now)` in TypeScript while the totals are counted in
     * SQL; two clocks — the application's and the database's — could disagree
     * across midnight or a timezone and show four EXPIRING_SOON rows above a
     * total that said three. One date, passed in, makes that unrepresentable.
     *
     * Expiry is a DATE column, so the reference is a calendar day with no time
     * and no zone — the same reduction `toUtcDay` performs.
     */
    const today = now.toISOString().slice(0, 10);
    const asOf = Prisma.sql`${today}::date`;
    const horizon = Prisma.sql`${today}::date + ${EXPIRING_SOON_DAYS} * INTERVAL '1 day'`;

    /*
     * Batches drawn to zero are excluded unless asked for. There is nothing on
     * the shelf left to be uncertain about, and their paperwork survives — the
     * toggle is what reaches it.
     */
    if (!params.includeEmptied) {
      filters.push(Prisma.sql`l.quantity_remaining > 0`);
    }

    if (params.productStatus) {
      filters.push(
        Prisma.sql`p.status = ${params.productStatus}::"ProductStatus"`,
      );
    }
    if (params.lotStatus) {
      filters.push(Prisma.sql`l.status = ${params.lotStatus}::"LotStatus"`);
    }
    if (params.certificateType) {
      filters.push(Prisma.sql`c.certificate_type = ${params.certificateType}`);
    }
    if (params.supplierId) {
      filters.push(Prisma.sql`pu.supplier_id = ${params.supplierId}`);
    }
    if (params.category) {
      filters.push(Prisma.sql`p.category = ${params.category}`);
    }
    if (params.search) {
      const like = `%${params.search}%`;
      filters.push(
        Prisma.sql`(p.name ILIKE ${like} OR p.sku ILIKE ${like} OR c.certificate_number ILIKE ${like})`,
      );
    }

    /*
     * The compliance filter, in dates rather than a second copy of the rule.
     * Each branch is the SQL equivalent of one `certificateStatus()` outcome,
     * and the horizon is the same exported constant, so the two cannot drift by
     * editing one.
     */
    if (params.certificateStatus) {
      switch (params.certificateStatus) {
        case "MISSING":
          filters.push(Prisma.sql`c.id IS NULL`);
          break;
        case "EXPIRED":
          filters.push(
            Prisma.sql`c.expiry_date IS NOT NULL AND c.expiry_date < ${asOf}`,
          );
          break;
        case "EXPIRING_SOON":
          filters.push(
            Prisma.sql`c.expiry_date IS NOT NULL AND c.expiry_date >= ${asOf} AND c.expiry_date <= ${horizon}`,
          );
          break;
        case "VALID":
          filters.push(
            Prisma.sql`c.id IS NOT NULL AND (c.expiry_date IS NULL OR c.expiry_date > ${horizon})`,
          );
          break;
      }
    }

    const where = Prisma.join(filters, " AND ");

    /*
     * One FROM clause shared by all three queries, so the rows, the totals and
     * the count cannot describe different sets.
     *
     * The purchase join tests `source_type = 'PURCHASE'`, which is what keeps
     * opening, adjustment and sales-return batches supplier-less rather than
     * borrowing one. `source_id` is a polymorphic pointer with no foreign key
     * behind it, so that type test is the whole guarantee.
     */
    const from = Prisma.sql`
      FROM stock_lots l
      JOIN products p ON p.id = l.product_id
      LEFT JOIN certificates c
        ON c.stock_lot_id = l.id AND c.superseded_at IS NULL
      LEFT JOIN purchases pu
        ON l.source_type = 'PURCHASE' AND pu.id = l.source_id
      LEFT JOIN suppliers s ON s.id = pu.supplier_id
    `;

    const [rows, totalRows, countRows] = await Promise.all([
      prisma.$queryRaw<CertificateRegisterSqlRow[]>`
        SELECT
          l.id                  AS lot_id,
          p.id                  AS product_id,
          p.sku,
          p.name                AS product_name,
          p.category,
          p.status::text        AS product_status,
          l.received_at,
          l.quantity_remaining,
          l.status::text        AS lot_status,
          l.source_type::text   AS provenance,
          pu.id                 AS purchase_id,
          pu.purchase_number,
          s.name                AS supplier_name,
          c.id                  AS certificate_id,
          c.certificate_type,
          c.certificate_number,
          c.issue_date,
          c.expiry_date,
          c.file_name
        ${from}
        WHERE ${where}
        ORDER BY ${orderBy(CERTIFICATE_REGISTER_SORTS, params.sort, params.direction, "expiry")}, p.sku ASC, l.received_at ASC, l.id ASC
        LIMIT ${params.pageSize} OFFSET ${(params.page - 1) * params.pageSize}
      `,
      /*
       * Totals are counted over every matching batch rather than the page, by
       * the same date arithmetic. The four states are mutually exclusive and
       * sum to `batches`.
       */
      prisma.$queryRaw<
        {
          batches: number;
          units: number;
          valid: number;
          expiring_soon: number;
          expired: number;
          missing: number;
        }[]
      >`
        SELECT
          COUNT(*)::int                               AS batches,
          COALESCE(SUM(l.quantity_remaining), 0)::int AS units,
          COUNT(*) FILTER (
            WHERE c.id IS NOT NULL
              AND (
                c.expiry_date IS NULL
                OR c.expiry_date > ${horizon}
              )
          )::int                                      AS valid,
          COUNT(*) FILTER (
            WHERE c.expiry_date IS NOT NULL
              AND c.expiry_date >= ${asOf}
              AND c.expiry_date <= ${horizon}
          )::int                                      AS expiring_soon,
          COUNT(*) FILTER (
            WHERE c.expiry_date IS NOT NULL AND c.expiry_date < ${asOf}
          )::int                                      AS expired,
          COUNT(*) FILTER (WHERE c.id IS NULL)::int    AS missing
        ${from}
        WHERE ${where}
      `,
      prisma.$queryRaw<{ n: number }[]>`
        SELECT COUNT(*)::int AS n
        ${from}
        WHERE ${where}
      `,
    ]);

    const t = totalRows[0] ?? {
      batches: 0,
      units: 0,
      valid: 0,
      expiring_soon: 0,
      expired: 0,
      missing: 0,
    };

    const total = countRows[0]?.n ?? 0;

    return {
      ok: true,
      data: {
        rows: rows.map((row) => {
          // The one definition of the rule, called rather than re-implemented.
          const status = certificateStatus(
            row.certificate_id === null ? null : { expiryDate: row.expiry_date },
            now,
          );

          return {
            lotId: row.lot_id,
            productId: row.product_id,
            sku: row.sku,
            productName: row.product_name,
            category: row.category,
            productStatus: row.product_status,
            receivedAt: row.received_at,
            quantityRemaining: row.quantity_remaining,
            lotStatus: row.lot_status,
            provenance: row.provenance,
            purchaseId: row.purchase_id,
            purchaseNumber: row.purchase_number,
            supplierName: row.supplier_name,
            certificateId: row.certificate_id,
            certificateType: row.certificate_type,
            certificateNumber: row.certificate_number,
            issueDate: row.issue_date,
            expiryDate: row.expiry_date,
            daysToExpiry:
              row.expiry_date === null
                ? null
                : daysBetweenUtc(now, row.expiry_date),
            status,
            fileUrl:
              row.certificate_id === null
                ? null
                : certificateFileUrl(row.certificate_id),
            fileName: row.file_name,
          };
        }),
        totals: {
          batches: t.batches,
          units: t.units,
          valid: t.valid,
          expiringSoon: t.expiring_soon,
          expired: t.expired,
          missing: t.missing,
        },
        total,
        page: params.page,
        pageSize: params.pageSize,
        pageCount: Math.max(1, Math.ceil(total / params.pageSize)),
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: toSafeError(error, "loadCertificateRegisterReport"),
    };
  }
}
