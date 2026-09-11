import "server-only";

import { EXPIRING_SOON_DAYS } from "@/lib/certificate-status";
import { toSafeError, type SafeError } from "@/lib/errors";
import {
  actionableOrderStatuses,
  outstandingPurchaseStatuses,
  revenueStatuses,
} from "@/lib/money-basis";
import type { Currency } from "@/lib/currency";
import {
  groupTotals,
  NO_MONEY,
  soleAmount,
  soleCurrency,
  type MoneyByCurrency,
} from "@/lib/money-by-currency";
import { prisma } from "@/lib/prisma";

/**
 * Read model for the dashboard.
 *
 * The page answers one question — *what needs my attention right now?* — and
 * the shape of this module follows from that. Each section loads on its own so
 * a slow aggregate delays only its own card, and every figure is read from the
 * database rather than assembled from anything the browser sent.
 *
 * ---------------------------------------------------------------------------
 * The rule this file exists to protect
 * ---------------------------------------------------------------------------
 *
 * `revenue - knownCost` is not margin when some of the units sold have no
 * recorded acquisition cost. It is an upper bound that is only reached if those
 * units were free.
 *
 * That is not a hypothetical here. Every order placed before cost tracking
 * existed has `costedQuantity = 0`, so on a database carrying any history the
 * naive subtraction reports the entire revenue as profit — a confident,
 * plausible, catastrophically wrong number, in the most prominent place in the
 * application. `loadCostingSnapshot` therefore returns coverage alongside every
 * money figure, and refuses to produce a margin at all when nothing is costed.
 *
 * Money definitions live in src/lib/money-basis.ts. They are not repeated here,
 * because three modules having their own opinion about what "value" meant is
 * exactly how they drifted apart in the first place.
 */

export type Result<T> = { ok: true; data: T } | { ok: false; error: SafeError };

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface AttentionSnapshot {
  /** Orders that need somebody to act — PENDING and CONFIRMED, never DRAFT. */
  actionableOrderCount: number;
  /** Purchases raised but not yet on the shelf, drafts included. */
  outstandingPurchaseCount: number;
  /** Units on hand with no recorded acquisition cost. */
  uncostedUnits: number;
  certificates: CertificateAttention;
}

/**
 * Paperwork that needs doing, with the products named.
 *
 * The counts alone would not be actionable: the products list has no
 * certificate filter, so there is no view to send somebody to. The affected
 * lots travel with the counts instead, capped, each linking to the product
 * detail page where its batch and paperwork live.
 *
 * **Counted per open lot, not per product.** Paperwork covers the units that
 * arrived, so a part with two batches — one released under a valid 8130-3, one
 * with nothing filed — contributes exactly one problem, not one product's
 * worth of doubt over both. Lots drawn to zero are excluded: there is nothing
 * on the shelf to be uncertain about.
 *
 * Scoped to ACTIVE products. A discontinued part is not being sold, so its
 * paperwork is not what anybody needs to act on this morning.
 */
export interface CertificateAttention {
  expiredCount: number;
  expiringSoonCount: number;
  missingCount: number;
  /** Soonest problem first: expired before expiring, oldest expiry first. */
  lots: CertificateAttentionLot[];
  /** True when more lots are affected than the list shows. */
  hasMore: boolean;
}

export interface CertificateAttentionLot {
  lotId: string;
  productId: string;
  name: string;
  sku: string;
  /** Units still on the shelf in this batch — what the problem actually covers. */
  quantityRemaining: number;
  status: "EXPIRED" | "EXPIRING_SOON" | "MISSING";
  expiryDate: Date | null;
  /** Negative once expired. Null when there is no certificate at all. */
  daysRemaining: number | null;
}

export interface InventorySnapshot {
  productCount: number;
  totalUnits: number;
  /**
   * Stock at actual acquisition cost, over every product still holding units —
   * active, inactive and discontinued alike. Money tied up in a retired part is
   * still money tied up.
   */
  stockValueByCurrency: MoneyByCurrency;
  costedUnits: number;
  uncostedUnits: number;
  /** The retired share, so it can be told apart from what is still sellable. */
  retired: RetiredInventory;
}

/**
 * Stock held in products that are no longer sellable.
 *
 * Counted separately rather than excluded. The previous dashboard filtered
 * these out of its valuation entirely, which understated the warehouse: a
 * discontinued part sitting on a shelf is capital, and somebody deciding what
 * to write off needs to see it. Separating it is what stops it being mistaken
 * for stock that can still be sold.
 */
export interface RetiredInventory {
  productCount: number;
  units: number;
  valueByCurrency: MoneyByCurrency;
  uncostedUnits: number;
}

export interface SalesSnapshot {
  draftCount: number;
  pendingCount: number;
  confirmedCount: number;
  completedCount: number;
  cancelledCount: number;
  /** CONFIRMED + COMPLETED. Draft and cancelled are not revenue. */
  realisedRevenueByCurrency: MoneyByCurrency;
  /** CONFIRMED only — committed but not yet shipped. */
  openOrderValueByCurrency: MoneyByCurrency;
  recentOrders: RecentOrder[];
}

export interface RecentOrder {
  id: string;
  orderNumber: string;
  status: string;
  customerName: string;
  total: string;
  /**
   * The currency this order was raised in, as recorded on the order itself.
   *
   * Carried because the total is meaningless without it, and because the
   * alternative — letting the page label it with `AppSetting.defaultCurrency`
   * — is the bug this whole change set exists to remove: yesterday's dollar
   * order would silently become a rupee one the moment somebody changed the
   * setting. Null for orders raised before the column existed, which is a fact
   * the page states rather than papers over.
   */
  currency: Currency | null;
  createdAt: Date;
}

export interface ProcurementSnapshot {
  draftCount: number;
  pendingCount: number;
  receivedCount: number;
  cancelledCount: number;
  /** RECEIVED only. */
  receivedSpendByCurrency: MoneyByCurrency;
  /** PENDING only — placed with a supplier, not yet arrived. */
  committedSpendByCurrency: MoneyByCurrency;
  recentPurchases: RecentPurchase[];
}

export interface RecentPurchase {
  id: string;
  purchaseNumber: string;
  status: string;
  supplierName: string;
  total: string;
  /** The currency this purchase was raised in. See `RecentOrder.currency`. */
  currency: Currency | null;
  purchaseDate: Date;
}

/**
 * What the sold stock cost, and how much of it we can actually account for.
 *
 * `margin` is null whenever `costedUnits` is zero. That is not a formatting
 * convenience — it is the guarantee that no caller can render a profit figure
 * for a business whose costs are entirely unknown.
 */
export interface CostingSnapshot {
  /** Units sold on realised orders. */
  unitsSold: number;
  /**
   * Units of those that have physically shipped.
   *
   * The denominator every coverage figure below is read against, and
   * deliberately not `unitsSold`. An order confirmed against a shelf that
   * could not fill it leaves units sold but unfulfilled, and those have no
   * acquisition cost for the plainest of reasons: nothing has been acquired
   * against them yet. Counting them as uncosted would report a procurement
   * backlog as a costing failure — two different problems with two different
   * remedies, and this section exists to keep exactly that kind of pair apart.
   */
  fulfilledUnits: number;
  /** How many of the *fulfilled* units have a recorded acquisition cost. */
  costedUnits: number;
  /** Units sold that have not shipped, so carry no cost of sale yet. */
  outstandingUnits: number;
  /**
   * Cost of the costed units, in the currency each lot was bought in.
   *
   * Empty when none are costed. Denominated in `OrderItem.costCurrency`,
   * which is the *supplier's* currency and has no reason to match the one the
   * customer was billed in — the two are only comparable when they happen to
   * agree, which is what `marginByCurrency` below checks.
   */
  knownCogsByCurrency: MoneyByCurrency;
  /**
   * Costed sales at list price — `unitPrice × costedQuantity` summed per line,
   * covering only the units whose cost is known.
   *
   * It is *apportioned*, which is why it is not called revenue: setting a
   * line's whole value against a cost that covers only part of it is what
   * produces a margin approaching one hundred per cent on a business whose
   * costs are unknown.
   *
   * It used to carry a second caveat — that it was a *list-price* basis, before
   * the order-level discount, and so would not reconcile with the Sales
   * section's realised revenue. That caveat is gone with the discount feature
   * (§20). Line prices are what the customer was charged, so this figure and
   * the Sales section are now on the same basis and do reconcile.
   */
  costedRevenueByCurrency: MoneyByCurrency;
  /**
   * `costedRevenue - knownCogs`, and empty far more often than it used to be.
   *
   * A margin is a subtraction, and subtracting money is only meaningful inside
   * one currency. This is therefore computed **only** when the costed revenue
   * and the cost of those sales are each in exactly one currency and it is the
   * same one. Sales billed in dollars against stock bought in rupees have no
   * margin this application can state, and it says nothing rather than
   * inventing a rate — the two figures are both on the snapshot, so anything
   * that needs to explain the gap can compare them itself.
   */
  marginByCurrency: MoneyByCurrency;
  /**
   * Percentage of costed sales at list price. Null under exactly the same
   * conditions as `marginByCurrency` being empty: a ratio of two figures in
   * different currencies is no more defensible than their difference.
   */
  marginPercent: number | null;
  /**
   * Every unit sold on a realised order, costed or not, at its line price.
   *
   * The denominator the coverage figures are read against, and on the same
   * basis as `costedRevenue` above so the two are comparable. This is the sum
   * of `order_items.total`, which since the discount removal (§20) is also
   * `SUM(orders.total)` — so unlike before, it agrees with the Sales section.
   */
  allRevenueByCurrency: MoneyByCurrency;
  /** Stock on hand with no recorded cost, mirrored here for the section. */
  uncostedStockUnits: number;
}

export interface RecentMovement {
  id: string;
  type: string;
  /**
   * The signed effect on stock: negative for anything that took units away.
   *
   * The column stores the size of the move and leaves the direction to `type`,
   * so a raw `quantity` renders as "+120" on an outbound movement. Deriving the
   * sign from the two balances is the one form that cannot disagree with what
   * actually happened.
   */
  change: number;
  newStock: number;
  createdAt: Date;
  productName: string;
  productSku: string;
}

/**
 * What every `GROUP BY <currency column>` in this file comes back as.
 *
 * Postgres has already summed within each currency; `currency` is null for
 * rows that predate per-record currency, and that null stays its own bucket.
 */
interface MoneySqlRow {
  currency: Currency | null;
  amount: string;
}

const RECENT_LIMIT = 5;
const CERTIFICATE_LIST_LIMIT = 5;

// ---------------------------------------------------------------------------
// Needs attention
// ---------------------------------------------------------------------------

/**
 * Uncosted stock is a property of the lots, not of the catalogue.
 *
 * This used to ride along inside a raw query over `products` that existed to
 * host two threshold counts. Those counts are gone, and the aggregate goes back
 * to the table it was always describing — `stock_lots` — where an empty
 * catalogue can no longer decide how many rows come back.
 */
export async function loadAttention(): Promise<Result<AttentionSnapshot>> {
  try {
    const [uncosted, actionableOrderCount, outstandingPurchaseCount, certificates] =
      await Promise.all([
        prisma.stockLot.aggregate({
          _sum: { quantityRemaining: true },
          where: { quantityRemaining: { gt: 0 }, unitCost: null },
        }),
        prisma.order.count({ where: { status: { in: actionableOrderStatuses() } } }),
        prisma.purchase.count({
          where: { status: { in: outstandingPurchaseStatuses() } },
        }),
        loadCertificateAttention(),
      ]);

    return {
      ok: true,
      data: {
        actionableOrderCount,
        outstandingPurchaseCount,
        uncostedUnits: uncosted._sum.quantityRemaining ?? 0,
        certificates,
      },
    };
  } catch (error) {
    return { ok: false, error: toSafeError(error, "loadAttention") };
  }
}

interface CertificateRow {
  lot_id: string;
  product_id: string;
  name: string;
  sku: string;
  quantity_remaining: number;
  expiry_date: Date | null;
  has_certificate: boolean;
}

/**
 * Open stock lots whose airworthiness paperwork needs attention.
 *
 * The current certificate is the one with `superseded_at IS NULL`; a lot has
 * at most one, enforced by a partial unique index. The three states mirror
 * `certificateStatus()` in src/lib/certificate-status.ts exactly — expired,
 * within thirty days, or absent — and the boundaries are written out again
 * here because the filtering has to happen in Postgres rather than after
 * loading every batch.
 *
 * A certificate with **no expiry date is not a problem**. A Certificate of
 * Conformity typically never expires, and treating a null expiry as suspicious
 * would flag a large share of legitimate documents. It is `VALID`, and absent
 * from every count below.
 */
async function loadCertificateAttention(): Promise<CertificateAttention> {
  const rows = await prisma.$queryRaw<CertificateRow[]>`
    SELECT
      l.id           AS lot_id,
      p.id           AS product_id,
      p.name,
      p.sku,
      l.quantity_remaining,
      c.expiry_date,
      (c.id IS NOT NULL) AS has_certificate
    FROM stock_lots l
    JOIN products p ON p.id = l.product_id
    LEFT JOIN certificates c
      ON c.stock_lot_id = l.id AND c.superseded_at IS NULL
    WHERE p.status = 'ACTIVE'
      AND l.quantity_remaining > 0
      AND (
        c.id IS NULL
        OR (
          c.expiry_date IS NOT NULL
          AND c.expiry_date < CURRENT_DATE + ${EXPIRING_SOON_DAYS} * INTERVAL '1 day'
        )
      )
    ORDER BY
      -- Expired first, then soonest to expire, then the ones with no paperwork
      -- at all. Nulls last puts missing certificates behind dated problems,
      -- which is the order somebody would work through them in.
      c.expiry_date ASC NULLS LAST,
      p.name ASC,
      l.received_at ASC
  `;

  const today = new Date();
  const todayUtc = Date.UTC(
    today.getUTCFullYear(),
    today.getUTCMonth(),
    today.getUTCDate(),
  );

  let expiredCount = 0;
  let expiringSoonCount = 0;
  let missingCount = 0;

  const lots: CertificateAttentionLot[] = rows.map((row) => {
    if (!row.has_certificate) {
      missingCount += 1;
      return {
        lotId: row.lot_id,
        productId: row.product_id,
        name: row.name,
        sku: row.sku,
        quantityRemaining: row.quantity_remaining,
        status: "MISSING" as const,
        expiryDate: null,
        daysRemaining: null,
      };
    }

    const expiry = row.expiry_date!;
    const expiryUtc = Date.UTC(
      expiry.getUTCFullYear(),
      expiry.getUTCMonth(),
      expiry.getUTCDate(),
    );
    const daysRemaining = Math.round((expiryUtc - todayUtc) / 86_400_000);

    if (daysRemaining < 0) expiredCount += 1;
    else expiringSoonCount += 1;

    return {
      lotId: row.lot_id,
      productId: row.product_id,
      name: row.name,
      sku: row.sku,
      quantityRemaining: row.quantity_remaining,
      status: daysRemaining < 0 ? ("EXPIRED" as const) : ("EXPIRING_SOON" as const),
      expiryDate: expiry,
      daysRemaining,
    };
  });

  return {
    expiredCount,
    expiringSoonCount,
    missingCount,
    lots: lots.slice(0, CERTIFICATE_LIST_LIMIT),
    hasMore: lots.length > CERTIFICATE_LIST_LIMIT,
  };
}

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

interface InventoryRow {
  product_count: number;
  total_units: number;
  costed_units: number;
  uncosted_units: number;
  retired_product_count: number;
  retired_units: number;
  retired_uncosted_units: number;
}

export async function loadInventory(): Promise<Result<InventorySnapshot>> {
  try {
    /*
     * Valuation comes from the lots, never from a column on the product.
     *
     * `stock_quantity × standard_cost` — the form this used to take — asserted
     * that every unit on hand was bought at the same price, which is the
     * assumption the costing layer exists to remove. Units whose cost was never
     * established are excluded from the value and counted separately: valuing
     * them at zero would understate the warehouse invisibly, and valuing them
     * at the catalogue's planning figure would be a guess indistinguishable
     * from a fact.
     *
     * Retired products are included in the totals and broken out alongside.
     * Stock in a discontinued part is still capital, and whoever is deciding
     * what to write off needs to see it — but so is the distinction between
     * that and stock still on sale.
     */
    const [rows, value, retiredValue] = await Promise.all([
      /*
       * Counts only. The two valuations left this query when lots stopped
       * sharing a currency: a single `SUM(quantity × unit_cost)` over the
       * whole warehouse would be adding dollars to rupees.
       */
      prisma.$queryRaw<InventoryRow[]>`
        SELECT
          COUNT(*)::int                                     AS product_count,
          COALESCE(SUM(p.stock_quantity), 0)::int           AS total_units,
          COUNT(*) FILTER (WHERE p.status <> 'ACTIVE')::int AS retired_product_count,
          COALESCE(SUM(p.stock_quantity) FILTER (WHERE p.status <> 'ACTIVE'), 0)::int
                                                            AS retired_units,
          COALESCE(l.costed_units, 0)::int                  AS costed_units,
          COALESCE(l.uncosted_units, 0)::int                AS uncosted_units,
          COALESCE(r.uncosted_units, 0)::int                AS retired_uncosted_units
        FROM products p
        CROSS JOIN (
          SELECT
            SUM(sl.quantity_remaining)
              FILTER (WHERE sl.unit_cost IS NOT NULL)          AS costed_units,
            SUM(sl.quantity_remaining)
              FILTER (WHERE sl.unit_cost IS NULL)              AS uncosted_units
          FROM stock_lots sl
          WHERE sl.quantity_remaining > 0
        ) l
        CROSS JOIN (
          SELECT
            SUM(sl.quantity_remaining)
              FILTER (WHERE sl.unit_cost IS NULL)              AS uncosted_units
          FROM stock_lots sl
          JOIN products rp ON rp.id = sl.product_id AND rp.status <> 'ACTIVE'
          WHERE sl.quantity_remaining > 0
        ) r
        GROUP BY l.costed_units, l.uncosted_units, r.uncosted_units
      `,
      /* The warehouse, valued once per currency it was bought in. */
      prisma.$queryRaw<MoneySqlRow[]>`
        SELECT
          sl.cost_currency                                 AS currency,
          SUM(sl.quantity_remaining * sl.unit_cost)::text  AS amount
        FROM stock_lots sl
        WHERE sl.quantity_remaining > 0 AND sl.unit_cost IS NOT NULL
        GROUP BY sl.cost_currency
      `,
      /* The same, narrowed to products no longer sellable. */
      prisma.$queryRaw<MoneySqlRow[]>`
        SELECT
          sl.cost_currency                                 AS currency,
          SUM(sl.quantity_remaining * sl.unit_cost)::text  AS amount
        FROM stock_lots sl
        JOIN products rp ON rp.id = sl.product_id AND rp.status <> 'ACTIVE'
        WHERE sl.quantity_remaining > 0 AND sl.unit_cost IS NOT NULL
        GROUP BY sl.cost_currency
      `,
    ]);

    const totals = rows[0] ?? {
      product_count: 0,
      total_units: 0,
      costed_units: 0,
      uncosted_units: 0,
      retired_product_count: 0,
      retired_units: 0,
      retired_uncosted_units: 0,
    };

    return {
      ok: true,
      data: {
        productCount: totals.product_count,
        totalUnits: totals.total_units,
        stockValueByCurrency: groupTotals(value),
        costedUnits: totals.costed_units,
        uncostedUnits: totals.uncosted_units,
        retired: {
          productCount: totals.retired_product_count,
          units: totals.retired_units,
          valueByCurrency: groupTotals(retiredValue),
          uncostedUnits: totals.retired_uncosted_units,
        },
      },
    };
  } catch (error) {
    return { ok: false, error: toSafeError(error, "loadInventory") };
  }
}

// ---------------------------------------------------------------------------
// Sales
// ---------------------------------------------------------------------------

interface SalesRow {
  draft: number;
  pending: number;
  confirmed: number;
  completed: number;
  cancelled: number;
}

/**
 * Order money on both bases, one row per currency.
 *
 * The counts guard the totals: a currency that produced no confirmed order
 * must not appear in `openOrderValue` as a zero, which would read as "nothing
 * outstanding in euros" when the truth is "no euro orders at all".
 */
interface SalesMoneyRow {
  currency: Currency | null;
  realised_n: number;
  realised_revenue: string;
  open_n: number;
  open_value: string;
}

export async function loadSales(): Promise<Result<SalesSnapshot>> {
  try {
    const [rows, money, recent] = await Promise.all([
      prisma.$queryRaw<SalesRow[]>`
        SELECT
          COUNT(*) FILTER (WHERE status = 'DRAFT')::int     AS draft,
          COUNT(*) FILTER (WHERE status = 'PENDING')::int   AS pending,
          COUNT(*) FILTER (WHERE status = 'CONFIRMED')::int AS confirmed,
          COUNT(*) FILTER (WHERE status = 'COMPLETED')::int AS completed,
          COUNT(*) FILTER (WHERE status = 'CANCELLED')::int AS cancelled
        FROM orders
      `,
      prisma.$queryRaw<SalesMoneyRow[]>`
        SELECT
          currency                                          AS currency,
          COUNT(*) FILTER (
            WHERE status IN ('CONFIRMED', 'COMPLETED')
          )::int                                            AS realised_n,
          COALESCE(SUM(total) FILTER (
            WHERE status IN ('CONFIRMED', 'COMPLETED')
          ), 0)::text                                       AS realised_revenue,
          COUNT(*) FILTER (WHERE status = 'CONFIRMED')::int  AS open_n,
          COALESCE(SUM(total) FILTER (WHERE status = 'CONFIRMED'), 0)::text
                                                            AS open_value
        FROM orders
        GROUP BY currency
      `,
      prisma.order.findMany({
        take: RECENT_LIMIT,
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          orderNumber: true,
          status: true,
          total: true,
          currency: true,
          createdAt: true,
          customer: { select: { name: true } },
        },
      }),
    ]);

    const totals = rows[0] ?? {
      draft: 0,
      pending: 0,
      confirmed: 0,
      completed: 0,
      cancelled: 0,
    };

    return {
      ok: true,
      data: {
        draftCount: totals.draft,
        pendingCount: totals.pending,
        confirmedCount: totals.confirmed,
        completedCount: totals.completed,
        cancelledCount: totals.cancelled,
        realisedRevenueByCurrency: groupTotals(
          money
            .filter((row) => row.realised_n > 0)
            .map((row) => ({
              currency: row.currency,
              amount: row.realised_revenue,
            })),
        ),
        openOrderValueByCurrency: groupTotals(
          money
            .filter((row) => row.open_n > 0)
            .map((row) => ({ currency: row.currency, amount: row.open_value })),
        ),
        recentOrders: recent.map((row) => ({
          id: row.id,
          orderNumber: row.orderNumber,
          status: row.status,
          customerName: row.customer.name,
          total: row.total.toString(),
          currency: row.currency,
          createdAt: row.createdAt,
        })),
      },
    };
  } catch (error) {
    return { ok: false, error: toSafeError(error, "loadSales") };
  }
}

// ---------------------------------------------------------------------------
// Procurement
// ---------------------------------------------------------------------------

interface ProcurementRow {
  draft: number;
  pending: number;
  received: number;
  cancelled: number;
}

/** Purchase money on both bases, one row per currency. See `SalesMoneyRow`. */
interface ProcurementMoneyRow {
  currency: Currency | null;
  received_n: number;
  received_spend: string;
  committed_n: number;
  committed_spend: string;
}

export async function loadProcurement(): Promise<Result<ProcurementSnapshot>> {
  try {
    const [rows, money, recent] = await Promise.all([
      prisma.$queryRaw<ProcurementRow[]>`
        SELECT
          COUNT(*) FILTER (WHERE status = 'DRAFT')::int     AS draft,
          COUNT(*) FILTER (WHERE status = 'PENDING')::int   AS pending,
          COUNT(*) FILTER (WHERE status = 'RECEIVED')::int  AS received,
          COUNT(*) FILTER (WHERE status = 'CANCELLED')::int AS cancelled
        FROM purchases
      `,
      prisma.$queryRaw<ProcurementMoneyRow[]>`
        SELECT
          currency                                           AS currency,
          COUNT(*) FILTER (WHERE status = 'RECEIVED')::int    AS received_n,
          COALESCE(SUM(total) FILTER (WHERE status = 'RECEIVED'), 0)::text
                                                             AS received_spend,
          COUNT(*) FILTER (WHERE status = 'PENDING')::int     AS committed_n,
          COALESCE(SUM(total) FILTER (WHERE status = 'PENDING'), 0)::text
                                                            AS committed_spend
        FROM purchases
        GROUP BY currency
      `,
      prisma.purchase.findMany({
        take: RECENT_LIMIT,
        orderBy: { purchaseDate: "desc" },
        select: {
          id: true,
          purchaseNumber: true,
          status: true,
          total: true,
          currency: true,
          purchaseDate: true,
          supplier: { select: { name: true } },
        },
      }),
    ]);

    const totals = rows[0] ?? {
      draft: 0,
      pending: 0,
      received: 0,
      cancelled: 0,
    };

    return {
      ok: true,
      data: {
        draftCount: totals.draft,
        pendingCount: totals.pending,
        receivedCount: totals.received,
        cancelledCount: totals.cancelled,
        receivedSpendByCurrency: groupTotals(
          money
            .filter((row) => row.received_n > 0)
            .map((row) => ({
              currency: row.currency,
              amount: row.received_spend,
            })),
        ),
        committedSpendByCurrency: groupTotals(
          money
            .filter((row) => row.committed_n > 0)
            .map((row) => ({
              currency: row.currency,
              amount: row.committed_spend,
            })),
        ),
        recentPurchases: recent.map((row) => ({
          id: row.id,
          purchaseNumber: row.purchaseNumber,
          status: row.status,
          supplierName: row.supplier.name,
          total: row.total.toString(),
          currency: row.currency,
          purchaseDate: row.purchaseDate,
        })),
      },
    };
  } catch (error) {
    return { ok: false, error: toSafeError(error, "loadProcurement") };
  }
}

// ---------------------------------------------------------------------------
// Costing and coverage
// ---------------------------------------------------------------------------

interface CostingRow {
  units_sold: number;
  fulfilled_units: number;
  costed_units: number;
  uncosted_stock_units: number;
}

/**
 * Sales money, grouped by the currency the **order** was raised in.
 *
 * `costed_n` guards `costed_revenue` the way the counts guard the totals
 * elsewhere: a currency whose lines are all uncosted must not contribute a
 * zero to the costed basis.
 */
interface CostingRevenueRow {
  currency: Currency | null;
  costed_n: number;
  costed_revenue: string;
  all_revenue: string;
}

export async function loadCosting(): Promise<Result<CostingSnapshot>> {
  try {
    /*
     * The one calculation on this page that is easy to get catastrophically
     * wrong.
     *
     * `costed_revenue` is `unit_price × costed_quantity` summed per line, not
     * `SUM(total)`. Setting a line's whole revenue against a cost that covers
     * only part of it is what produces a margin approaching one hundred per
     * cent on a business whose costs are simply unknown. Apportioning revenue
     * to the units the cost actually describes is the aggregate form of
     * `marginOf()` in src/lib/cost-coverage.ts, and it is the difference
     * between a defensible figure and a flattering one.
     *
     * `total_revenue` is carried alongside so the section can show what share
     * of the business the margin speaks for, rather than presenting a partial
     * figure as though it were the whole.
     */
    const [rows, cogs, revenue] = await Promise.all([
      prisma.$queryRaw<CostingRow[]>`
        SELECT
          COALESCE(SUM(oi.quantity), 0)::int                   AS units_sold,
          COALESCE(SUM(oi.fulfilled_quantity), 0)::int         AS fulfilled_units,
          COALESCE(SUM(oi.costed_quantity), 0)::int            AS costed_units,
          COALESCE((
            SELECT SUM(l.quantity_remaining)
            FROM stock_lots l
            WHERE l.quantity_remaining > 0 AND l.unit_cost IS NULL
          ), 0)::int                                           AS uncosted_stock_units
        FROM order_items oi
        JOIN orders o ON o.id = oi.order_id
        WHERE o.status = ANY(${revenueStatuses()}::"OrderStatus"[])
      `,
      /*
       * Cost of sale, grouped by the currency the stock was bought in — which
       * lives on the order item, not on the order. A line billed in dollars
       * can perfectly well have been filled from a lot bought in rupees.
       */
      prisma.$queryRaw<MoneySqlRow[]>`
        SELECT
          oi.cost_currency                      AS currency,
          COALESCE(SUM(oi.cost_total), 0)::text AS amount
        FROM order_items oi
        JOIN orders o ON o.id = oi.order_id
        WHERE o.status = ANY(${revenueStatuses()}::"OrderStatus"[])
          AND oi.cost_total IS NOT NULL
        GROUP BY oi.cost_currency
      `,
      prisma.$queryRaw<CostingRevenueRow[]>`
        SELECT
          o.currency                                        AS currency,
          COUNT(*) FILTER (WHERE oi.costed_quantity > 0)::int AS costed_n,
          COALESCE(SUM(oi.unit_price * oi.costed_quantity), 0)::text
                                                            AS costed_revenue,
          COALESCE(SUM(oi.total), 0)::text                  AS all_revenue
        FROM order_items oi
        JOIN orders o ON o.id = oi.order_id
        WHERE o.status = ANY(${revenueStatuses()}::"OrderStatus"[])
        GROUP BY o.currency
      `,
    ]);

    const totals = rows[0] ?? {
      units_sold: 0,
      fulfilled_units: 0,
      costed_units: 0,
      uncosted_stock_units: 0,
    };

    /*
     * No costed units, no margin. Not zero, not the revenue — nothing.
     *
     * This is the guarantee the whole section rests on: a caller cannot render
     * a profit figure for a business none of whose costs are known, because
     * there is no number here to render.
     */
    const costed = totals.costed_units > 0;

    const knownCogsByCurrency = costed ? groupTotals(cogs) : NO_MONEY;
    const costedRevenueByCurrency = costed
      ? groupTotals(
          revenue
            .filter((row) => row.costed_n > 0)
            .map((row) => ({
              currency: row.currency,
              amount: row.costed_revenue,
            })),
        )
      : NO_MONEY;

    /*
     * The margin exists only where the subtraction does.
     *
     * `soleAmount` yields a number solely when a total is in exactly one
     * *known* currency, so this is null the moment either side is mixed,
     * empty, or denominated in a currency that was never recorded. The final
     * equality is the one that matters most: both sides can be perfectly
     * unambiguous and still be different currencies.
     */
    const costedRevenueAmount = soleAmount(costedRevenueByCurrency);
    const knownCogsAmount = soleAmount(knownCogsByCurrency);
    const marginCurrency = soleCurrency(costedRevenueByCurrency);

    const comparable =
      costedRevenueAmount !== null &&
      knownCogsAmount !== null &&
      marginCurrency === soleCurrency(knownCogsByCurrency);

    const costedRevenue = Number(costedRevenueAmount);
    const margin = comparable ? costedRevenue - Number(knownCogsAmount) : null;

    return {
      ok: true,
      data: {
        unitsSold: totals.units_sold,
        fulfilledUnits: totals.fulfilled_units,
        costedUnits: totals.costed_units,
        outstandingUnits: Math.max(
          0,
          totals.units_sold - totals.fulfilled_units,
        ),
        knownCogsByCurrency,
        costedRevenueByCurrency,
        marginByCurrency:
          margin === null
            ? NO_MONEY
            : [{ currency: marginCurrency, amount: margin.toFixed(2) }],
        marginPercent:
          margin !== null && costedRevenue !== 0
            ? (margin / costedRevenue) * 100
            : null,
        allRevenueByCurrency: groupTotals(
          revenue.map((row) => ({
            currency: row.currency,
            amount: row.all_revenue,
          })),
        ),
        uncostedStockUnits: totals.uncosted_stock_units,
      },
    };
  } catch (error) {
    return { ok: false, error: toSafeError(error, "loadCosting") };
  }
}

// ---------------------------------------------------------------------------
// Recent activity
// ---------------------------------------------------------------------------

export async function loadRecentMovements(): Promise<Result<RecentMovement[]>> {
  try {
    const movements = await prisma.stockTransaction.findMany({
      take: RECENT_LIMIT,
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        type: true,
        previousStock: true,
        newStock: true,
        createdAt: true,
        product: { select: { name: true, sku: true } },
      },
    });

    return {
      ok: true,
      data: movements.map((movement) => ({
        id: movement.id,
        type: movement.type,
        change: movement.newStock - movement.previousStock,
        newStock: movement.newStock,
        createdAt: movement.createdAt,
        productName: movement.product.name,
        productSku: movement.product.sku,
      })),
    };
  } catch (error) {
    return { ok: false, error: toSafeError(error, "loadRecentMovements") };
  }
}
