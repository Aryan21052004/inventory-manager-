import "server-only";

import { EXPIRING_SOON_DAYS } from "@/lib/certificate-status";
import { toSafeError, type SafeError } from "@/lib/errors";
import {
  actionableOrderStatuses,
  outstandingPurchaseStatuses,
  revenueStatuses,
} from "@/lib/money-basis";
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
  stockValue: string;
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
  value: string;
  uncostedUnits: number;
}

export interface SalesSnapshot {
  draftCount: number;
  pendingCount: number;
  confirmedCount: number;
  completedCount: number;
  cancelledCount: number;
  /** CONFIRMED + COMPLETED. Draft and cancelled are not revenue. */
  realisedRevenue: string;
  /** CONFIRMED only — committed but not yet shipped. */
  openOrderValue: string;
  recentOrders: RecentOrder[];
}

export interface RecentOrder {
  id: string;
  orderNumber: string;
  status: string;
  customerName: string;
  total: string;
  createdAt: Date;
}

export interface ProcurementSnapshot {
  draftCount: number;
  pendingCount: number;
  receivedCount: number;
  cancelledCount: number;
  /** RECEIVED only. */
  receivedSpend: string;
  /** PENDING only — placed with a supplier, not yet arrived. */
  committedSpend: string;
  recentPurchases: RecentPurchase[];
}

export interface RecentPurchase {
  id: string;
  purchaseNumber: string;
  status: string;
  supplierName: string;
  total: string;
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
  /** How many of those have a recorded acquisition cost. */
  costedUnits: number;
  /** Cost of the costed units. Null when none are costed. */
  knownCogs: string | null;
  /**
   * Costed sales at list price — `unitPrice × costedQuantity` summed per line,
   * covering only the units whose cost is known.
   *
   * Two things about this figure, and both are why it is not called revenue.
   *
   * It is *apportioned*: setting a line's whole value against a cost that
   * covers only part of it is what produces a margin approaching one hundred
   * per cent on a business whose costs are unknown.
   *
   * And it is a *list-price* basis — line prices, before the order-level
   * discount. That is deliberate and it is why this does not reconcile with the
   * Sales section's realised revenue: an order-level discount applies to the
   * order as a whole, and splitting it across individual FIFO-costed units
   * would mean inventing an allocation rule. Margin here is therefore measured
   * against the same line prices the cost was drawn from, and the dashboard
   * says so rather than leaving two figures to be reconciled by the reader.
   */
  costedSalesAtListPrice: string | null;
  /** `costedSalesAtListPrice - knownCogs`. Null when nothing is costed. */
  margin: string | null;
  /** Percentage of costed sales at list price. Null when nothing is costed. */
  marginPercent: number | null;
  /**
   * All sales at list price — every unit sold on a realised order, costed or
   * not, at its line price.
   *
   * The denominator the coverage figures are read against, and on the same
   * list-price basis as `costedSalesAtListPrice` above so the two are
   * comparable. Deliberately **not** named revenue: it is the sum of
   * `order_items.total`, before order-level discounts, and it will not equal
   * the Sales section's realised revenue whenever any order carried one.
   */
  allSalesAtListPrice: string;
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
  stock_value: string;
  costed_units: number;
  uncosted_units: number;
  retired_product_count: number;
  retired_units: number;
  retired_value: string;
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
    const rows = await prisma.$queryRaw<InventoryRow[]>`
      SELECT
        COUNT(*)::int                                     AS product_count,
        COALESCE(SUM(p.stock_quantity), 0)::int           AS total_units,
        COUNT(*) FILTER (WHERE p.status <> 'ACTIVE')::int AS retired_product_count,
        COALESCE(SUM(p.stock_quantity) FILTER (WHERE p.status <> 'ACTIVE'), 0)::int
                                                          AS retired_units,
        COALESCE(l.value, 0)::text                        AS stock_value,
        COALESCE(l.costed_units, 0)::int                  AS costed_units,
        COALESCE(l.uncosted_units, 0)::int                AS uncosted_units,
        COALESCE(r.value, 0)::text                        AS retired_value,
        COALESCE(r.uncosted_units, 0)::int                AS retired_uncosted_units
      FROM products p
      CROSS JOIN (
        SELECT
          SUM(sl.quantity_remaining * sl.unit_cost)
            FILTER (WHERE sl.unit_cost IS NOT NULL)          AS value,
          SUM(sl.quantity_remaining)
            FILTER (WHERE sl.unit_cost IS NOT NULL)          AS costed_units,
          SUM(sl.quantity_remaining)
            FILTER (WHERE sl.unit_cost IS NULL)              AS uncosted_units
        FROM stock_lots sl
        WHERE sl.quantity_remaining > 0
      ) l
      CROSS JOIN (
        SELECT
          SUM(sl.quantity_remaining * sl.unit_cost)
            FILTER (WHERE sl.unit_cost IS NOT NULL)          AS value,
          SUM(sl.quantity_remaining)
            FILTER (WHERE sl.unit_cost IS NULL)              AS uncosted_units
        FROM stock_lots sl
        JOIN products rp ON rp.id = sl.product_id AND rp.status <> 'ACTIVE'
        WHERE sl.quantity_remaining > 0
      ) r
      GROUP BY l.value, l.costed_units, l.uncosted_units,
               r.value, r.uncosted_units
    `;

    const totals = rows[0] ?? {
      product_count: 0,
      total_units: 0,
      stock_value: "0",
      costed_units: 0,
      uncosted_units: 0,
      retired_product_count: 0,
      retired_units: 0,
      retired_value: "0",
      retired_uncosted_units: 0,
    };

    return {
      ok: true,
      data: {
        productCount: totals.product_count,
        totalUnits: totals.total_units,
        stockValue: totals.stock_value,
        costedUnits: totals.costed_units,
        uncostedUnits: totals.uncosted_units,
        retired: {
          productCount: totals.retired_product_count,
          units: totals.retired_units,
          value: totals.retired_value,
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
  realised_revenue: string;
  open_value: string;
}

export async function loadSales(): Promise<Result<SalesSnapshot>> {
  try {
    const [rows, recent] = await Promise.all([
      prisma.$queryRaw<SalesRow[]>`
        SELECT
          COUNT(*) FILTER (WHERE status = 'DRAFT')::int     AS draft,
          COUNT(*) FILTER (WHERE status = 'PENDING')::int   AS pending,
          COUNT(*) FILTER (WHERE status = 'CONFIRMED')::int AS confirmed,
          COUNT(*) FILTER (WHERE status = 'COMPLETED')::int AS completed,
          COUNT(*) FILTER (WHERE status = 'CANCELLED')::int AS cancelled,
          COALESCE(SUM(total) FILTER (
            WHERE status IN ('CONFIRMED', 'COMPLETED')
          ), 0)::text                                       AS realised_revenue,
          COALESCE(SUM(total) FILTER (WHERE status = 'CONFIRMED'), 0)::text
                                                            AS open_value
        FROM orders
      `,
      prisma.order.findMany({
        take: RECENT_LIMIT,
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          orderNumber: true,
          status: true,
          total: true,
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
      realised_revenue: "0",
      open_value: "0",
    };

    return {
      ok: true,
      data: {
        draftCount: totals.draft,
        pendingCount: totals.pending,
        confirmedCount: totals.confirmed,
        completedCount: totals.completed,
        cancelledCount: totals.cancelled,
        realisedRevenue: totals.realised_revenue,
        openOrderValue: totals.open_value,
        recentOrders: recent.map((row) => ({
          id: row.id,
          orderNumber: row.orderNumber,
          status: row.status,
          customerName: row.customer.name,
          total: row.total.toString(),
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
  received_spend: string;
  committed_spend: string;
}

export async function loadProcurement(): Promise<Result<ProcurementSnapshot>> {
  try {
    const [rows, recent] = await Promise.all([
      prisma.$queryRaw<ProcurementRow[]>`
        SELECT
          COUNT(*) FILTER (WHERE status = 'DRAFT')::int     AS draft,
          COUNT(*) FILTER (WHERE status = 'PENDING')::int   AS pending,
          COUNT(*) FILTER (WHERE status = 'RECEIVED')::int  AS received,
          COUNT(*) FILTER (WHERE status = 'CANCELLED')::int AS cancelled,
          COALESCE(SUM(total) FILTER (WHERE status = 'RECEIVED'), 0)::text
                                                            AS received_spend,
          COALESCE(SUM(total) FILTER (WHERE status = 'PENDING'), 0)::text
                                                            AS committed_spend
        FROM purchases
      `,
      prisma.purchase.findMany({
        take: RECENT_LIMIT,
        orderBy: { purchaseDate: "desc" },
        select: {
          id: true,
          purchaseNumber: true,
          status: true,
          total: true,
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
      received_spend: "0",
      committed_spend: "0",
    };

    return {
      ok: true,
      data: {
        draftCount: totals.draft,
        pendingCount: totals.pending,
        receivedCount: totals.received,
        cancelledCount: totals.cancelled,
        receivedSpend: totals.received_spend,
        committedSpend: totals.committed_spend,
        recentPurchases: recent.map((row) => ({
          id: row.id,
          purchaseNumber: row.purchaseNumber,
          status: row.status,
          supplierName: row.supplier.name,
          total: row.total.toString(),
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
  costed_units: number;
  known_cogs: string;
  costed_revenue: string;
  total_revenue: string;
  uncosted_stock_units: number;
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
    const rows = await prisma.$queryRaw<CostingRow[]>`
      SELECT
        COALESCE(SUM(oi.quantity), 0)::int                   AS units_sold,
        COALESCE(SUM(oi.costed_quantity), 0)::int            AS costed_units,
        COALESCE(SUM(oi.cost_total), 0)::text                AS known_cogs,
        COALESCE(SUM(oi.unit_price * oi.costed_quantity), 0)::text
                                                             AS costed_revenue,
        COALESCE(SUM(oi.total), 0)::text                     AS total_revenue,
        COALESCE((
          SELECT SUM(l.quantity_remaining)
          FROM stock_lots l
          WHERE l.quantity_remaining > 0 AND l.unit_cost IS NULL
        ), 0)::int                                           AS uncosted_stock_units
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      WHERE o.status = ANY(${revenueStatuses()}::"OrderStatus"[])
    `;

    const totals = rows[0] ?? {
      units_sold: 0,
      costed_units: 0,
      known_cogs: "0",
      costed_revenue: "0",
      total_revenue: "0",
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

    const costedRevenue = Number(totals.costed_revenue);
    const knownCogs = Number(totals.known_cogs);
    const margin = costedRevenue - knownCogs;

    return {
      ok: true,
      data: {
        unitsSold: totals.units_sold,
        costedUnits: totals.costed_units,
        knownCogs: costed ? totals.known_cogs : null,
        costedSalesAtListPrice: costed ? totals.costed_revenue : null,
        margin: costed ? margin.toFixed(2) : null,
        marginPercent:
          costed && costedRevenue !== 0 ? (margin / costedRevenue) * 100 : null,
        allSalesAtListPrice: totals.total_revenue,
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
