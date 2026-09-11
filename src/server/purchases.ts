import "server-only";

import { Prisma } from "@/generated/prisma/client";
import { certificateStatus, type CertificateStatus } from "@/lib/certificate-status";
import type { Currency } from "@/lib/currency";
import { AppError, NotFoundError, toSafeError, type SafeError } from "@/lib/errors";
import type { PurchaseListParams, PurchaseSortKey } from "@/lib/purchase-query";
import {
  holdsAddedStock,
  isEditable,
  transitionRefusal,
  type PurchaseStatus,
} from "@/lib/purchase-status";
import { groupTotals, type MoneyByCurrency } from "@/lib/money-by-currency";
import { prisma } from "@/lib/prisma";
import {
  calculatePurchaseTotal,
  centsToDecimalString,
  purchaseSchema,
  toCents,
  toPurchaseFieldErrors,
  type PurchaseFieldErrors,
} from "@/lib/validation/purchase";
import type { SupplierStatus } from "@/generated/prisma/enums";
import { requireUser } from "@/server/auth";
import { getLotCertificates } from "@/server/certificates";
import { getCurrency } from "@/server/settings";
import { getSupplierDetail } from "@/server/suppliers";
import {
  applyStockMovement,
  createLot,
  drainPurchaseLots,
  lockProducts,
} from "@/server/stock";
import { clearSupplyLinksForPurchase } from "@/server/supply-links";

/**
 * Everything the purchases module does to the database.
 *
 * The centre of this file is `receivePurchase`, and it is the mirror of
 * `confirmOrder`: the moment goods physically arrive and inventory goes up. It
 * holds the same three properties, for the same reasons:
 *
 *   **Atomic.** Every line is added or none is. A partially received purchase
 *   is inventory that is wrong in a way nobody notices until a stock count.
 *
 *   **Serialised.** The purchase row is locked before anything else, so the
 *   same delivery cannot be received twice by two simultaneous requests. The
 *   product rows are then locked in a consistent order, so two deliveries
 *   touching the same products queue instead of deadlocking.
 *
 *   **Attributed.** Every movement records the local user resolved from the
 *   Clerk session. `createdBy` is not a parameter anywhere in this file.
 *
 * It reuses the stock engine rather than reimplementing it — `lockProducts` and
 * `applyStockMovement` are the same functions the orders module and the manual
 * adjustment use. There is one ledger and one way to write to it.
 */

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface PurchaseListItem {
  id: string;
  purchaseNumber: string;
  supplierId: string;
  supplierName: string;
  status: PurchaseStatus;
  itemCount: number;
  unitCount: number;
  total: string;
  /**
   * What the total is denominated in, from the purchase's own row. Null on a
   * purchase raised before the column existed.
   */
  currency: Currency | null;
  purchaseDate: Date;
  createdAt: Date;
  createdByName: string | null;
}

export interface PurchaseListPage {
  items: PurchaseListItem[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

export interface PurchaseStats {
  total: number;
  draft: number;
  pending: number;
  /** Value of purchases placed but not yet arrived — money committed. */
  pendingValueByCurrency: MoneyByCurrency;
  receivedValueByCurrency: MoneyByCurrency;
}

export interface PurchaseDetailLine {
  id: string;
  productId: string;
  productName: string;
  sku: string;
  quantity: number;
  unitCost: string;
  total: string;
  /** Stock on hand now, for context — not what was added. */
  currentStock: number;
  /**
   * True when the product is no longer ACTIVE. The line stays visible — history
   * must remain readable — but it blocks receiving until someone resolves it.
   */
  productRetired: boolean;
  /**
   * The batch this line created when the delivery was received, if it has been.
   *
   * Null until receipt: a purchase that has not arrived has produced no lot,
   * and therefore has no paperwork to show. Inventing coverage for goods that
   * are not here yet would be the same mistake as costing them before they
   * arrive.
   */
  stockLotId: string | null;
  /**
   * The paperwork covering the batch this delivery created — not the product's,
   * which no longer exists as a concept. A purchase never owns certificate
   * data; this is a read of the lot's own paperwork.
   */
  certificateType: string | null;
  certificateNumber: string | null;
  certificateStatus: CertificateStatus;
}

/** One product's inventory movement caused by this purchase. */
export interface PurchaseImpactLine {
  productId: string;
  productName: string;
  sku: string;
  /** Positive: units added by receiving. */
  added: number;
  addedFrom: number | null;
  addedTo: number | null;
  /** Positive: units taken back by a cancellation. */
  reversed: number;
  reversedFrom: number | null;
  reversedTo: number | null;
}

export interface SupplierSummary {
  id: string;
  name: string;
  contactPerson: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  /** So the page can say when a supplier is no longer open for new business. */
  status: SupplierStatus;
  /** Live figures, counted across every purchase from this supplier. */
  purchaseCount: number;
  receivedCount: number;
  totalPurchasedByCurrency: MoneyByCurrency;
  recentPurchases: {
    id: string;
    purchaseNumber: string;
    status: PurchaseStatus;
    total: string;
    /** The currency that purchase was raised in. Null on a legacy row. */
    currency: Currency | null;
    purchaseDate: Date;
  }[];
}

export interface PurchaseDetail {
  id: string;
  purchaseNumber: string;
  status: PurchaseStatus;
  total: string;
  /**
   * What this purchase is denominated in. Null on a legacy row — read as
   * unknown, never as the installation default.
   */
  currency: Currency | null;
  purchaseDate: Date;
  createdAt: Date;
  updatedAt: Date;
  receivedAt: Date | null;
  cancelledAt: Date | null;
  createdByName: string | null;
  supplier: SupplierSummary;
  lines: PurchaseDetailLine[];
  impact: PurchaseImpactLine[];
  /** True when any line's product has been retired — blocks receiving. */
  hasRetiredProducts: boolean;
}

/** A product as the purchase builder's search results present it. */
export interface PurchaseProductOption {
  id: string;
  name: string;
  sku: string;
  /**
   * What this part actually cost the last time it was received, and when.
   *
   * A historical fact, read at query time from the most recent PURCHASE lot —
   * not a product attribute, not stored back on the catalogue row, and not an
   * average. It replaces the `standardCost` prefill, which was a figure
   * somebody typed once and which the same part being bought at three
   * different prices made meaningless.
   *
   * Both are null together, and null means this part has never been received
   * on a purchase. The line then starts blank: a prefill nobody can source is
   * worse than no prefill, because the operator would have no way to tell it
   * from a real one. What they type is what the lot ends up costing.
   */
  lastPaidUnitCost: string | null;
  /**
   * The currency that last payment was made in, from the batch it was read
   * from. Null exactly when the cost is.
   */
  lastPaidCurrency: Currency | null;
  lastPaidAt: Date | null;
  stockQuantity: number;
  isActive: boolean;
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: SafeError };

// ---------------------------------------------------------------------------
// Querying
// ---------------------------------------------------------------------------

const SORT_COLUMNS: Record<Exclude<PurchaseSortKey, "supplier">, string> = {
  purchaseNumber: "purchaseNumber",
  status: "status",
  total: "total",
  purchaseDate: "purchaseDate",
};

function buildWhere(params: PurchaseListParams): Prisma.PurchaseWhereInput {
  const filters: Prisma.PurchaseWhereInput[] = [];

  if (params.search) {
    filters.push({
      OR: [
        { purchaseNumber: { contains: params.search, mode: "insensitive" } },
        { supplier: { name: { contains: params.search, mode: "insensitive" } } },
      ],
    });
  }

  if (params.supplierId) filters.push({ supplierId: params.supplierId });
  if (params.status) filters.push({ status: params.status });

  if (params.from) {
    filters.push({
      purchaseDate: { gte: new Date(`${params.from}T00:00:00.000Z`) },
    });
  }

  if (params.to) {
    // Inclusive: "to the 26th" means the whole of the 26th.
    const end = new Date(`${params.to}T00:00:00.000Z`);
    end.setUTCDate(end.getUTCDate() + 1);
    filters.push({ purchaseDate: { lt: end } });
  }

  return filters.length > 0 ? { AND: filters } : {};
}

function buildOrderBy(
  params: PurchaseListParams,
): Prisma.PurchaseOrderByWithRelationInput[] {
  const direction = params.direction;

  const primary: Prisma.PurchaseOrderByWithRelationInput =
    params.sort === "supplier"
      ? { supplier: { name: direction } }
      : { [SORT_COLUMNS[params.sort]]: direction };

  // A stable tiebreak, so a row cannot appear on two pages or on neither.
  return params.sort === "purchaseNumber"
    ? [primary]
    : [primary, { purchaseNumber: "desc" }];
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listPurchases(
  params: PurchaseListParams,
): Promise<Result<PurchaseListPage>> {
  try {
    const where = buildWhere(params);

    const [total, rows] = await Promise.all([
      prisma.purchase.count({ where }),
      prisma.purchase.findMany({
        where,
        orderBy: buildOrderBy(params),
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
        select: {
          id: true,
          purchaseNumber: true,
          status: true,
          total: true,
          currency: true,
          purchaseDate: true,
          createdAt: true,
          supplierId: true,
          supplier: { select: { name: true } },
          createdByUser: { select: { name: true } },
          items: { select: { quantity: true } },
        },
      }),
    ]);

    return {
      ok: true,
      data: {
        items: rows.map((row) => ({
          id: row.id,
          purchaseNumber: row.purchaseNumber,
          supplierId: row.supplierId,
          supplierName: row.supplier.name,
          status: row.status,
          itemCount: row.items.length,
          unitCount: row.items.reduce((sum, item) => sum + item.quantity, 0),
          total: row.total.toString(),
          currency: row.currency,
          purchaseDate: row.purchaseDate,
          createdAt: row.createdAt,
          createdByName: row.createdByUser?.name ?? null,
        })),
        total,
        page: params.page,
        pageSize: params.pageSize,
        pageCount: Math.max(1, Math.ceil(total / params.pageSize)),
      },
    };
  } catch (error) {
    return { ok: false, error: toSafeError(error, "listPurchases") };
  }
}

interface PurchaseStatsRow {
  total: number;
  draft: number;
  pending: number;
}

/** Committed and received spend per currency. See `OrderStatsMoneyRow`. */
interface PurchaseStatsMoneyRow {
  currency: Currency | null;
  pending_n: number;
  pending_value: string;
  received_n: number;
  received_value: string;
}

export async function loadPurchaseStats(): Promise<Result<PurchaseStats>> {
  try {
    const [rows, money] = await Promise.all([
      prisma.$queryRaw<PurchaseStatsRow[]>`
        SELECT
          COUNT(*)::int                                     AS total,
          COUNT(*) FILTER (WHERE status = 'DRAFT')::int     AS draft,
          COUNT(*) FILTER (WHERE status = 'PENDING')::int   AS pending
        FROM purchases
      `,
      prisma.$queryRaw<PurchaseStatsMoneyRow[]>`
        SELECT
          currency,
          COUNT(*) FILTER (WHERE status = 'PENDING')::int   AS pending_n,
          COALESCE(SUM(total) FILTER (WHERE status = 'PENDING'), 0)::text
                                                            AS pending_value,
          COUNT(*) FILTER (WHERE status = 'RECEIVED')::int  AS received_n,
          COALESCE(SUM(total) FILTER (WHERE status = 'RECEIVED'), 0)::text
                                                            AS received_value
        FROM purchases
        GROUP BY currency
      `,
    ]);

    const totals = rows[0] ?? {
      total: 0,
      draft: 0,
      pending: 0,
    };

    return {
      ok: true,
      data: {
        total: totals.total,
        draft: totals.draft,
        pending: totals.pending,
        pendingValueByCurrency: groupTotals(
          money
            .filter((row) => row.pending_n > 0)
            .map((row) => ({
              currency: row.currency,
              amount: row.pending_value,
            })),
        ),
        receivedValueByCurrency: groupTotals(
          money
            .filter((row) => row.received_n > 0)
            .map((row) => ({
              currency: row.currency,
              amount: row.received_value,
            })),
        ),
      },
    };
  } catch (error) {
    return { ok: false, error: toSafeError(error, "loadPurchaseStats") };
  }
}

/*
 * Supplier options used to be loaded here, with a second copy in the products
 * module and no notion of a supplier being archived. Both are gone: there is
 * one loader, in src/server/suppliers.ts, and one rule about who may be picked.
 * The list filter needs a different rule — archived suppliers must stay
 * findable — so it uses `loadSupplierFilterOptions` instead. Import either from
 * the suppliers module directly.
 */

/**
 * What each of these products cost the last time it was actually received.
 *
 * The replacement for the catalogue's `standardCost` prefill, and deliberately
 * a *read* rather than a column. Nothing is written back to the product: the
 * moment such a figure is stored it becomes a second answer to "what does this
 * cost", one that drifts from the lots the instant the next delivery lands at
 * a different price. Reading it here means it cannot be stale, because it is
 * derived from the lots every time it is asked for.
 *
 * PURCHASE lots only. OPENING and ADJUSTMENT costs are operator assertions
 * about stock that arrived without a supplier invoice behind it; "last paid"
 * is a claim about what a supplier charged, and only a purchase can evidence
 * that. UNKNOWN lots carry no cost to report at all.
 *
 * `DISTINCT ON` picks one row per product — the newest receipt, with `id`
 * breaking ties so two lots received in the same millisecond still resolve to
 * a deterministic one. The ordering matches the `(product_id, received_at, id)`
 * index the FIFO scan already maintains.
 */
async function lastPaidByProduct(
  productIds: readonly string[],
): Promise<
  Map<
    string,
    { unitCost: string; currency: Currency | null; receivedAt: Date }
  >
> {
  if (productIds.length === 0) return new Map();

  const rows = await prisma.$queryRaw<
    {
      product_id: string;
      unit_cost: string;
      cost_currency: Currency | null;
      received_at: Date;
    }[]
  >`
    SELECT DISTINCT ON (l.product_id)
      l.product_id,
      l.unit_cost::text AS unit_cost,
      l.cost_currency,
      l.received_at
    FROM stock_lots l
    WHERE l.product_id IN (${Prisma.join([...productIds])})
      AND l.cost_source = 'PURCHASE'
      AND l.unit_cost IS NOT NULL
    ORDER BY l.product_id, l.received_at DESC, l.id DESC
  `;

  return new Map(
    rows.map((row) => [
      row.product_id,
      {
        unitCost: row.unit_cost,
        currency: row.cost_currency,
        receivedAt: row.received_at,
      },
    ]),
  );
}

/**
 * Products that can be added to a purchase.
 *
 * Only ACTIVE ones. A retired product must not be bought again — offering it in
 * the picker is how it ends up on a delivery — and the server refuses it at
 * validation time anyway, so showing it would produce a late error instead of
 * an early absence.
 */
export async function searchPurchaseProducts(
  search: string,
  limit = 20,
): Promise<PurchaseProductOption[]> {
  try {
    const term = search.trim();

    const rows = await prisma.product.findMany({
      where: {
        status: "ACTIVE",
        ...(term
          ? {
              OR: [
                { name: { contains: term, mode: "insensitive" } },
                { sku: { contains: term, mode: "insensitive" } },
              ],
            }
          : {}),
      },
      orderBy: { name: "asc" },
      take: limit,
      select: {
        id: true,
        name: true,
        sku: true,
        stockQuantity: true,
      },
    });

    // One extra query for the whole page of results, not one per row.
    const lastPaid = await lastPaidByProduct(rows.map((row) => row.id));

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      sku: row.sku,
      lastPaidUnitCost: lastPaid.get(row.id)?.unitCost ?? null,
      lastPaidCurrency: lastPaid.get(row.id)?.currency ?? null,
      lastPaidAt: lastPaid.get(row.id)?.receivedAt ?? null,
      stockQuantity: row.stockQuantity,
      isActive: true,
    }));
  } catch (error) {
    toSafeError(error, "searchPurchaseProducts");
    return [];
  }
}

/**
 * The inventory a purchase actually moved, read from the ledger.
 *
 * Not derived from the status. The stock transactions are the record of what
 * happened; the status is a label on the document, and the ledger is what would
 * be telling the truth if they ever disagreed.
 */
async function loadInventoryImpact(
  purchaseId: string,
): Promise<PurchaseImpactLine[]> {
  const movements = await prisma.stockTransaction.findMany({
    where: { referenceType: "PURCHASE", referenceId: purchaseId },
    orderBy: { createdAt: "asc" },
    include: { product: { select: { id: true, name: true, sku: true } } },
  });

  const byProduct = new Map<string, PurchaseImpactLine>();

  for (const movement of movements) {
    const existing = byProduct.get(movement.productId) ?? {
      productId: movement.productId,
      productName: movement.product.name,
      sku: movement.product.sku,
      added: 0,
      addedFrom: null,
      addedTo: null,
      reversed: 0,
      reversedFrom: null,
      reversedTo: null,
    };

    if (movement.type === "STOCK_IN") {
      existing.added += movement.quantity;
      existing.addedFrom ??= movement.previousStock;
      existing.addedTo = movement.newStock;
    } else {
      // REVERSAL — the cancellation taking the units back off the shelf.
      existing.reversed += movement.quantity;
      existing.reversedFrom ??= movement.previousStock;
      existing.reversedTo = movement.newStock;
    }

    byProduct.set(movement.productId, existing);
  }

  return [...byProduct.values()];
}

/**
 * Live figures for a supplier, plus their recent purchases.
 *
 * Reads through `getSupplierDetail` rather than re-querying suppliers here.
 * This panel and the supplier detail page were computing the same aggregate two
 * different ways — same "received purchases only" rule written twice — and the
 * one that drifts is the one nobody is looking at. The suppliers module owns
 * that rule now; this trims the result to what the purchase page displays.
 */
async function loadSupplierSummary(supplierId: string): Promise<SupplierSummary> {
  const detail = await getSupplierDetail(supplierId);

  if (!detail.ok || !detail.data) throw new NotFoundError("Supplier");

  const supplier = detail.data;

  return {
    id: supplier.id,
    name: supplier.name,
    contactPerson: supplier.contactPerson,
    email: supplier.email,
    phone: supplier.phone,
    address: supplier.address,
    status: supplier.status,
    purchaseCount: supplier.purchaseCount,
    receivedCount: supplier.receivedCount,
    totalPurchasedByCurrency: supplier.totalPurchasedByCurrency,
    recentPurchases: supplier.purchases.slice(0, 5).map((row) => ({
      id: row.id,
      purchaseNumber: row.purchaseNumber,
      status: row.status,
      total: row.total,
      currency: row.currency,
      purchaseDate: row.purchaseDate,
    })),
  };
}

export async function getPurchaseDetail(
  id: string,
): Promise<Result<PurchaseDetail | null>> {
  try {
    const purchase = await prisma.purchase.findUnique({
      where: { id },
      include: {
        createdByUser: { select: { name: true } },
        items: {
          orderBy: { product: { name: "asc" } },
          include: {
            product: {
              select: {
                id: true,
                name: true,
                sku: true,
                status: true,
                stockQuantity: true,
              },
            },
          },
        },
      },
    });

    if (!purchase) return { ok: true, data: null };

    const [impact, supplier, receivedLots] = await Promise.all([
      loadInventoryImpact(id),
      loadSupplierSummary(purchase.supplierId),
      /*
       * The batches this delivery created, one per line. Receiving never
       * touches paperwork — it creates the lot the paperwork will later be
       * filed against — so a purchase that has not been received has none of
       * these and its lines show no certificate at all.
       */
      prisma.stockLot.findMany({
        where: { sourceType: "PURCHASE", sourceId: id },
        select: { id: true, productId: true },
      }),
    ]);

    const lotByProduct = new Map(
      receivedLots.map((lot) => [lot.productId, lot.id] as const),
    );
    const lotCertificates = await getLotCertificates(
      receivedLots.map((lot) => lot.id),
    );

    const lines = purchase.items.map((item) => {
      const stockLotId = lotByProduct.get(item.product.id) ?? null;
      const certificate = stockLotId
        ? (lotCertificates.get(stockLotId) ?? null)
        : null;

      return {
        id: item.id,
        productId: item.product.id,
        productName: item.product.name,
        sku: item.product.sku,
        quantity: item.quantity,
        unitCost: item.unitCost.toString(),
        total: item.total.toString(),
        currentStock: item.product.stockQuantity,
        productRetired: item.product.status !== "ACTIVE",
        stockLotId,
        certificateType: certificate?.certificateType ?? null,
        certificateNumber: certificate?.certificateNumber ?? null,
        certificateStatus: certificateStatus(certificate),
      };
    });

    return {
      ok: true,
      data: {
        id: purchase.id,
        purchaseNumber: purchase.purchaseNumber,
        status: purchase.status,
        total: purchase.total.toString(),
        currency: purchase.currency,
        purchaseDate: purchase.purchaseDate,
        createdAt: purchase.createdAt,
        updatedAt: purchase.updatedAt,
        receivedAt: purchase.receivedAt,
        cancelledAt: purchase.cancelledAt,
        createdByName: purchase.createdByUser?.name ?? null,
        supplier,
        lines,
        impact,
        hasRetiredProducts: lines.some((line) => line.productRetired),
      },
    };
  } catch (error) {
    return { ok: false, error: toSafeError(error, "getPurchaseDetail") };
  }
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

function badRequest(
  field: keyof PurchaseFieldErrors,
  message: string,
): AppError {
  return new AppError("BAD_REQUEST", message, { field });
}

/**
 * The next purchase number for the current year.
 *
 * Read-then-write, and racy on its own — two purchases raised in the same
 * instant compute the same number. That is not prevented; it is made harmless.
 * The unique index lets one commit and `createPurchase` retries, recomputing
 * against the row the winner wrote. Only the database can arbitrate the gap
 * between a read and a write.
 */
async function nextPurchaseNumber(
  tx: Prisma.TransactionClient,
): Promise<string> {
  const prefix = `PO-${new Date().getUTCFullYear()}-`;

  const last = await tx.purchase.findFirst({
    where: { purchaseNumber: { startsWith: prefix } },
    orderBy: { purchaseNumber: "desc" },
    select: { purchaseNumber: true },
  });

  const previous = last ? Number(last.purchaseNumber.slice(prefix.length)) : 0;
  const next = Number.isFinite(previous) ? previous + 1 : 1;

  return `${prefix}${String(next).padStart(4, "0")}`;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "P2002"
  );
}

export interface CreatedPurchase {
  id: string;
  purchaseNumber: string;
  total: string;
}

/**
 * Creates a purchase as a draft.
 *
 * Unit costs come from the client — they are the supplier's numbers, not ours,
 * and can differ from the catalogue cost on any delivery. Everything derived
 * from them does not: line totals and the grand total are computed here, in
 * integer cents, from the quantity and cost this function validated.
 *
 * Creating never moves stock, whatever the quantities. Inventory rises on
 * receipt and nowhere else.
 */
export async function createPurchase(
  input: unknown,
): Promise<CreatedPurchase> {
  // Any signed-in user may raise a purchase — both roles do this as part of the
  // job, matching the orders module and the existing role policy.
  const user = await requireUser();

  const parsed = purchaseSchema.safeParse(input);
  if (!parsed.success) {
    const errors = toPurchaseFieldErrors(parsed.error);
    const field = (Object.keys(errors)[0] ?? "form") as keyof PurchaseFieldErrors;
    throw new AppError("BAD_REQUEST", errors[field] ?? "Check the purchase.", {
      field,
    });
  }

  const purchase = parsed.data;

  /*
   * Read once, outside the retry loop and outside the transaction: the
   * currency a new document is proposed in should not change between two
   * attempts at allocating its number.
   */
  const defaultCurrency = await getCurrency();

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await prisma.$transaction(async (tx) => {
        const supplier = await tx.supplier.findUnique({
          where: { id: purchase.supplierId },
          select: { id: true, name: true, status: true },
        });

        if (!supplier) {
          throw badRequest(
            "supplierId",
            "That supplier no longer exists. Pick another.",
          );
        }

        /*
         * Archived suppliers are out of circulation for *new* business. The
         * picker already leaves them out, so reaching this means either a stale
         * form or a request that did not come from one — which is exactly why
         * the rule is enforced here rather than only in the dropdown.
         */
        if (supplier.status !== "ACTIVE") {
          throw badRequest(
            "supplierId",
            `"${supplier.name}" has been archived, so no new purchases can be raised with them. Pick another supplier, or make them active again first.`,
          );
        }

        const lines = await resolveLines(tx, purchase.items);
        const totalCents = calculatePurchaseTotal(lines);

        const created = await tx.purchase.create({
          data: {
            purchaseNumber: await nextPurchaseNumber(tx),
            status: "DRAFT",
            supplierId: purchase.supplierId,
            total: centsToDecimalString(totalCents),
            /*
             * The currency this purchase is agreed in, seeded from the
             * installation default because the purchase is being raised now.
             * That is the default's entire remit — it proposes a currency for
             * a new document and has no say over any that already exists.
             *
             * Authoritative for `total` and for every line: `PurchaseItem`
             * carries no currency of its own. Receiving stamps it onto the
             * lots, which is the point at which it stops being editable.
             *
             * Choosing a different one at entry is the rest of step F and is
             * not wired up yet, so today every new purchase takes the default.
             */
            /*
             * The explicit choice when there is one; the installation default
             * only when there is not.
             */
            currency: purchase.currency ?? defaultCurrency,
            purchaseDate: purchase.purchaseDate ?? new Date(),
            // From the session. Not a parameter, so no caller can raise a
            // purchase in somebody else's name.
            createdBy: user.id,
            items: {
              create: lines.map((line) => ({
                productId: line.productId,
                quantity: line.quantity,
                unitCost: centsToDecimalString(line.unitCostCents),
                total: centsToDecimalString(
                  line.unitCostCents * line.quantity,
                ),
              })),
            },
          },
          select: { id: true, purchaseNumber: true, total: true },
        });

        return {
          id: created.id,
          purchaseNumber: created.purchaseNumber,
          total: created.total.toString(),
        };
      });
    } catch (error) {
      if (isUniqueViolation(error) && attempt < 4) continue;

      if (isUniqueViolation(error)) {
        throw new AppError(
          "CONFLICT",
          "Several purchases were raised at the same moment and the numbering could not settle. Try again.",
        );
      }

      throw error;
    }
  }

  throw new AppError("CONFLICT", "Could not allocate a purchase number.");
}

/**
 * Checks every line's product and returns the figures to write.
 *
 * A retired product is refused rather than dropped. Silently removing the line
 * would change what the person submitted without telling them, and they would
 * discover it when the delivery did not add up.
 */
async function resolveLines(
  tx: Prisma.TransactionClient,
  items: readonly { productId: string; quantity: number; unitCost: number }[],
): Promise<{ productId: string; quantity: number; unitCostCents: number }[]> {
  const products = await tx.product.findMany({
    where: { id: { in: items.map((item) => item.productId) } },
    select: { id: true, name: true, status: true },
  });

  const byId = new Map(products.map((product) => [product.id, product]));

  return items.map((item) => {
    const product = byId.get(item.productId);

    if (!product) {
      throw badRequest(
        "items",
        "One of the products on this purchase no longer exists. Remove it and try again.",
      );
    }

    if (product.status !== "ACTIVE") {
      throw badRequest(
        "items",
        `"${product.name}" has been retired and cannot be purchased. Remove it from the purchase, or make the product active again.`,
      );
    }

    return {
      productId: product.id,
      quantity: item.quantity,
      unitCostCents: toCents(item.unitCost),
    };
  });
}

export interface PurchaseTransitionOutcome {
  id: string;
  purchaseNumber: string;
  status: PurchaseStatus;
  /** What moved, so the UI can report it without re-querying. */
  movements: {
    productId: string;
    productName: string;
    quantity: number;
    previousStock: number;
    newStock: number;
  }[];
  /** True when the call found the work already done and changed nothing. */
  alreadyInState: boolean;
}

/**
 * Locks a purchase row and returns its current state.
 *
 * This is what makes receiving safe against itself. Two receipts of the same
 * delivery arriving together would otherwise both read PENDING and both add
 * stock; locking the row makes the second wait, see RECEIVED, and be refused.
 * The purchase row is locked *before* any product row, on every path here, so
 * the lock hierarchy is consistent.
 */
async function lockPurchase(
  tx: Prisma.TransactionClient,
  purchaseId: string,
): Promise<{
  id: string;
  purchaseNumber: string;
  status: PurchaseStatus;
  supplierId: string;
  currency: Currency | null;
}> {
  const rows = await tx.$queryRaw<
    {
      id: string;
      purchase_number: string;
      status: PurchaseStatus;
      supplier_id: string;
      currency: Currency | null;
    }[]
  >`
    SELECT id, purchase_number, status, supplier_id, currency
    FROM purchases
    WHERE id = ${purchaseId}
    FOR UPDATE
  `;

  const purchase = rows[0];
  if (!purchase) throw new NotFoundError("Purchase");

  return {
    id: purchase.id,
    purchaseNumber: purchase.purchase_number,
    status: purchase.status,
    // Read under the same lock, so the "is this already our supplier" test in
    // `updatePurchase` cannot race a concurrent edit that moved it.
    supplierId: purchase.supplier_id,
    /*
     * Read under the same lock as the status, which is what makes the freeze
     * safe: a concurrent edit cannot move the currency between the transition
     * check and the lots this receipt is about to stamp with it.
     */
    currency: purchase.currency,
  };
}

function assertTransition(from: PurchaseStatus, to: PurchaseStatus): void {
  const refusal = transitionRefusal(from, to);
  if (refusal) throw new AppError("CONFLICT", refusal);
}

/**
 * Refuses to cancel a delivery whose goods have already moved on.
 *
 * A lot with fewer units left than it received has been drawn from: sold on an
 * order, or adjusted away. Those units cannot come back — the order shipped —
 * and the only ways to make the reversal balance would be to take the shortfall
 * out of some other batch, corrupting the cost history of a delivery that had
 * nothing to do with this one, or to leave the valuation layer disagreeing with
 * the ledger. Refusing is the honest third option.
 *
 * The message names the products and the quantities, because "this cannot be
 * cancelled" without saying what moved is not something an operator can act on.
 * Called with the product rows already locked, which is what makes the check
 * and the reversal atomic together.
 */
async function assertPurchaseLotsIntact(
  tx: Prisma.TransactionClient,
  purchaseId: string,
  purchaseNumber: string,
  /** Units the reversal is about to take back, per product. */
  outstanding: ReadonlyMap<string, number>,
): Promise<void> {
  const lots = await tx.stockLot.findMany({
    where: { sourceType: "PURCHASE", sourceId: purchaseId },
    select: {
      productId: true,
      quantityReceived: true,
      quantityRemaining: true,
      product: { select: { name: true } },
    },
    orderBy: { id: "asc" },
  });

  /*
   * The mirror of the shortfall `returnToLots` handles, and the opposite
   * answer.
   *
   * A delivery received before costing existed has no lots behind it. Reversing
   * it would take stock off the shelf while no lot shrank, leaving the ledger
   * and the valuation layer disagreeing — the same invariant break, in the
   * other direction. There is no honest repair available here: an outbound
   * shortfall cannot become an uncosted lot, and making up the difference from
   * some other batch is exactly what taking stock from a delivery it did not
   * come from would mean, corrupting that batch's cost history.
   *
   * So it is refused. In practice the backfill created lots for every received
   * purchase, so this is a guard against a state that should not arise rather
   * than one operators will meet.
   */
  const covered = new Map<string, number>();

  for (const lot of lots) {
    covered.set(
      lot.productId,
      (covered.get(lot.productId) ?? 0) + lot.quantityRemaining,
    );
  }

  const uncovered = [...outstanding.entries()].filter(
    ([productId, quantity]) => quantity > (covered.get(productId) ?? 0),
  );

  if (uncovered.length > 0 && lots.length === 0) {
    throw new AppError(
      "CONFLICT",
      `Purchase ${purchaseNumber} predates cost tracking, so the stock it delivered cannot be identified and the delivery cannot be reversed. Record a stock adjustment instead — nothing has been changed.`,
    );
  }

  const consumed = lots.filter(
    (lot) => lot.quantityRemaining < lot.quantityReceived,
  );

  if (consumed.length === 0 && uncovered.length === 0) return;

  if (consumed.length === 0) {
    throw new AppError(
      "CONFLICT",
      `Purchase ${purchaseNumber} cannot be cancelled: the stock it delivered can no longer be fully accounted for. Record a stock adjustment instead — nothing has been changed.`,
    );
  }

  const detail = consumed
    .map((lot) => {
      const gone = lot.quantityReceived - lot.quantityRemaining;
      return `${lot.product.name} (${gone} of ${lot.quantityReceived})`;
    })
    .join(", ");

  throw new AppError(
    "CONFLICT",
    `Purchase ${purchaseNumber} cannot be cancelled because some of the stock it delivered has already been used: ${detail}. Those units have left on an order or been adjusted away, and taking them back from a different delivery would misstate what that stock cost. Reverse the orders that consumed them first, or record a stock adjustment instead — nothing has been changed.`,
  );
}

/**
 * Receives a purchase: the moment goods land and stock rises.
 *
 * One database transaction, in this order:
 *
 *   1. Resolve the Clerk session to a local user — outside the transaction,
 *      because it may have to talk to Clerk and must not hold locks while it
 *      does.
 *   2. Lock the purchase row and read its status.
 *   3. Refuse the transition if it is not legal from that status.
 *   4. Load the lines and check every product is still active.
 *   5. Lock every product row, sorted by id — a consistent order, so two
 *      deliveries touching the same products queue instead of deadlocking.
 *   6. Add, writing a STOCK_IN for each line.
 *   7. Move the purchase to RECEIVED.
 *
 * Step 4 is checked over the whole purchase before anything is written. Unlike
 * an order there is no stock level that can refuse a line — adding cannot go
 * negative — but a retired product can, and finding out halfway through would
 * mean half a delivery booked in and rolled back. Validating first makes the
 * all-or-nothing guarantee visible rather than incidental.
 */
export async function receivePurchase(
  purchaseId: string,
): Promise<PurchaseTransitionOutcome> {
  // Both roles may receive — booking in a delivery is ordinary work, and the
  // movement is backed by this purchase. ADMIN is reserved for corrections
  // that have no document behind them.
  const user = await requireUser();

  return prisma.$transaction(async (tx) => {
    const purchase = await lockPurchase(tx, purchaseId);
    assertTransition(purchase.status, "RECEIVED");

    const items = await tx.purchaseItem.findMany({
      where: { purchaseId },
      select: {
        productId: true,
        quantity: true,
        // What was actually paid. This is the figure that becomes the lot's
        // cost, and the reason the same part bought three times at three
        // prices stays three distinguishable batches.
        unitCost: true,
        product: { select: { name: true, status: true } },
      },
    });

    if (items.length === 0) {
      throw new AppError(
        "BAD_REQUEST",
        "This purchase has no items, so there is nothing to receive.",
      );
    }

    // Every line checked before any line is written.
    const retired = items.filter((item) => item.product.status !== "ACTIVE");

    if (retired.length > 0) {
      const names = retired.map((item) => `"${item.product.name}"`).join(", ");
      throw new AppError(
        "CONFLICT",
        `${names} ${retired.length === 1 ? "has" : "have"} been retired, so this delivery cannot be booked in. Make the product active again, or remove the line — nothing has been added to stock.`,
      );
    }

    const locked = await lockProducts(
      tx,
      items.map((item) => item.productId),
    );

    const movements: PurchaseTransitionOutcome["movements"] = [];
    const receivedAt = new Date();

    for (const item of items) {
      const product = locked.get(item.productId)!;

      const { transaction, previousStock, newStock } = await applyStockMovement(
        tx,
        {
          product,
          type: "STOCK_IN",
          // Positive: goods coming in.
          delta: item.quantity,
          reference: { type: "PURCHASE", id: purchaseId },
          note: `Purchase ${purchase.purchaseNumber} received`,
          // From the session, resolved through clerkId. Never from the client.
          userId: user.id,
        },
      );

      /*
       * The cost of this delivery, frozen against the units it brought in.
       *
       * One lot per line, never merged with an existing batch even when the
       * product and price match — two deliveries are two batches with two sets
       * of paperwork. `receivedAt` is shared across the lines so a single
       * delivery sorts as one arrival in the FIFO queue.
       */
      await createLot(tx, {
        productId: product.id,
        stockTransactionId: transaction.id,
        quantity: item.quantity,
        unitCostCents: toCents(Number(item.unitCost)),
        /*
         * The currency the supplier was paid in, taken from the document that
         * proves it and frozen onto the batch here. This is the moment the
         * purchase's currency stops being editable: from now on lots reference
         * it, and changing it would orphan them from the invoice behind them.
         *
         * A legacy purchase with no recorded currency yields a lot with a cost
         * and no currency. That is the honest outcome — the delivery is real
         * and must be receivable — and it reads as "currency unknown" rather
         * than borrowing the installation default.
         */
        costCurrency: purchase.currency,
        costSource: "PURCHASE",
        reference: { type: "PURCHASE", id: purchaseId },
        receivedAt,
        userId: user.id,
      });

      movements.push({
        productId: product.id,
        productName: product.name,
        quantity: item.quantity,
        previousStock,
        newStock,
      });
    }

    const updated = await tx.purchase.update({
      where: { id: purchaseId },
      data: { status: "RECEIVED", receivedAt },
      select: { id: true, purchaseNumber: true, status: true },
    });

    return { ...updated, movements, alreadyInState: false };
  });
}

/**
 * Cancels a purchase, taking back exactly the stock it added.
 *
 * Idempotent by design. Cancelling an already-cancelled purchase does nothing
 * and says so, rather than reversing a second time — the purchase row is locked
 * first, so a second call cannot slip past the status check even when it
 * arrives simultaneously.
 *
 * What gets reversed is read from the ledger, not from the purchase lines. They
 * are the same today, but the ledger is the record of what actually arrived,
 * and if the two ever disagreed the ledger would be right. The reversal
 * quantities are the STOCK_IN rows netted against any REVERSAL already written.
 *
 * Cancellation is refused outright once any of the delivered units have been
 * consumed — sold on an order, or adjusted away. The quantity check alone would
 * not catch this: a later delivery can top the balance back up, so there would
 * be enough stock on the shelf to reverse against while the units that actually
 * arrived on *this* purchase are long gone. Taking the difference from another
 * batch would work arithmetically and be a lie — it would consume a lot bought
 * at a different price and silently corrupt the cost history of a delivery that
 * has nothing to do with this one. So the lots this purchase created are
 * checked first, and an untouched delivery is the only kind that can be undone.
 */
export async function cancelPurchase(
  purchaseId: string,
  reason?: string,
): Promise<PurchaseTransitionOutcome> {
  const user = await requireUser();

  return prisma.$transaction(async (tx) => {
    const purchase = await lockPurchase(tx, purchaseId);

    if (purchase.status === "CANCELLED") {
      // Already done. Not an error, and emphatically not a second reversal.
      return {
        id: purchase.id,
        purchaseNumber: purchase.purchaseNumber,
        status: purchase.status,
        movements: [],
        alreadyInState: true,
      };
    }

    assertTransition(purchase.status, "CANCELLED");

    const movements: PurchaseTransitionOutcome["movements"] = [];

    // Only a purchase that actually arrived has anything to take back. A draft
    // being abandoned never touched inventory.
    if (holdsAddedStock(purchase.status)) {
      const ledger = await tx.stockTransaction.findMany({
        where: { referenceType: "PURCHASE", referenceId: purchaseId },
        select: { productId: true, type: true, quantity: true },
      });

      // Net what arrived against anything already taken back, so a partially
      // reversed purchase cannot be over-reversed.
      const outstanding = new Map<string, number>();

      for (const row of ledger) {
        const delta = row.type === "STOCK_IN" ? row.quantity : -row.quantity;
        outstanding.set(
          row.productId,
          (outstanding.get(row.productId) ?? 0) + delta,
        );
      }

      const productIds = [...outstanding.entries()]
        .filter(([, quantity]) => quantity > 0)
        .map(([productId]) => productId);

      const locked = await lockProducts(tx, productIds);

      /*
       * Every line checked before any line is written, in the same shape as
       * `receivePurchase` validates before adding. The check sits *after*
       * `lockProducts` on purpose: any transaction that could consume these
       * lots must take the product row lock first, so holding it is what makes
       * the check and the reversal that follows a single atomic decision rather
       * than a race.
       */
      await assertPurchaseLotsIntact(
        tx,
        purchaseId,
        purchase.purchaseNumber,
        outstanding,
      );

      for (const productId of [...productIds].sort()) {
        const quantity = outstanding.get(productId)!;
        const product = locked.get(productId)!;

        const { transaction, previousStock, newStock } = await applyStockMovement(tx, {
          product,
          type: "REVERSAL",
          // Negative: taking back what was added.
          delta: -quantity,
          reference: { type: "PURCHASE", id: purchaseId },
          note: reason?.trim()
            ? `Purchase ${purchase.purchaseNumber} cancelled — ${reason.trim()}`
            : `Purchase ${purchase.purchaseNumber} cancelled`,
          userId: user.id,
        });

        // The batch goes with the stock. Drawn to zero rather than deleted, so
        // the record that this delivery arrived and was sent back survives.
        await drainPurchaseLots(tx, {
          purchaseId,
          reversalTransactionId: transaction.id,
          productId: product.id,
        });

        movements.push({
          productId: product.id,
          productName: product.name,
          quantity,
          previousStock,
          newStock,
        });
      }
    }

    /*
     * A cancelled purchase is delivering nothing, so any order line waiting on
     * it is waiting on something that will never arrive. Leaving the links
     * would show an order queued against a delivery that has been called off,
     * which is worse than showing it uncovered.
     *
     * Outside the `holdsAddedStock` branch above for the same reason the order
     * side is: a pending purchase never added stock but is exactly the kind
     * somebody links against, since it is the delivery in transit.
     *
     * Deleted, not closed — see `clearSupplyLinksForPurchase`. No status, no
     * quantity and no stock changes here.
     */
    await clearSupplyLinksForPurchase(tx, purchaseId);

    const updated = await tx.purchase.update({
      where: { id: purchaseId },
      data: { status: "CANCELLED", cancelledAt: new Date() },
      select: { id: true, purchaseNumber: true, status: true },
    });

    return { ...updated, movements, alreadyInState: false };
  });
}

/**
 * Moves a draft to pending, or a pending purchase back to draft. No stock
 * either way — neither status has anything on the shelf.
 */
export async function setPurchaseStatus(
  purchaseId: string,
  target: PurchaseStatus,
): Promise<PurchaseTransitionOutcome> {
  await requireUser();

  if (target === "RECEIVED" || target === "CANCELLED") {
    // These move stock. They have their own functions, with their own locking
    // and their own guarantees; routing them through a generic setter would be
    // a second way to change inventory.
    throw new AppError(
      "BAD_REQUEST",
      "That status change has to go through its own action.",
    );
  }

  return prisma.$transaction(async (tx) => {
    const purchase = await lockPurchase(tx, purchaseId);
    assertTransition(purchase.status, target);

    const updated = await tx.purchase.update({
      where: { id: purchaseId },
      data: { status: target },
      select: { id: true, purchaseNumber: true, status: true },
    });

    return { ...updated, movements: [], alreadyInState: false };
  });
}

/**
 * Replaces the lines on a purchase that has not yet arrived.
 *
 * Only DRAFT and PENDING purchases can be edited, and neither has moved stock,
 * so this never touches inventory. Editing a received purchase would mean the
 * document and the delivery behind it no longer matched.
 */
export async function updatePurchase(
  purchaseId: string,
  input: unknown,
): Promise<CreatedPurchase> {
  await requireUser();

  const parsed = purchaseSchema.safeParse(input);
  if (!parsed.success) {
    const errors = toPurchaseFieldErrors(parsed.error);
    const field = (Object.keys(errors)[0] ?? "form") as keyof PurchaseFieldErrors;
    throw new AppError("BAD_REQUEST", errors[field] ?? "Check the purchase.", {
      field,
    });
  }

  const purchase = parsed.data;

  /*
   * Only used for a purchase that has no currency at all — a legacy row being
   * given one for the first time.
   */
  const defaultCurrency = await getCurrency();

  return prisma.$transaction(async (tx) => {
    const existing = await lockPurchase(tx, purchaseId);

    if (!isEditable(existing.status)) {
      throw new AppError(
        "CONFLICT",
        `A ${existing.status.toLowerCase()} purchase cannot be edited. Its goods have already been booked in.`,
      );
    }

    const supplier = await tx.supplier.findUnique({
      where: { id: purchase.supplierId },
      select: { id: true, name: true, status: true },
    });

    if (!supplier) {
      throw badRequest(
        "supplierId",
        "That supplier no longer exists. Pick another.",
      );
    }

    /*
     * An archived supplier is allowed here on one condition: they are already
     * the supplier on this purchase.
     *
     * Archiving stops new business, it does not invalidate a document already
     * raised. A draft placed with somebody who has since been archived must
     * stay editable — otherwise archiving a supplier would strand every open
     * order with them, and the only way to fix a line item would be to abandon
     * the purchase. Moving a purchase *to* a different archived supplier is a
     * new assignment, and is refused like any other.
     */
    if (supplier.status !== "ACTIVE" && supplier.id !== existing.supplierId) {
      throw badRequest(
        "supplierId",
        `"${supplier.name}" has been archived, so this purchase cannot be moved to them. Pick an active supplier, or make them active again first.`,
      );
    }

    const lines = await resolveLines(tx, purchase.items);
    const totalCents = calculatePurchaseTotal(lines);

    /*
     * The currency this edit leaves behind. Absent means "leave it alone",
     * never a reset to today's default; only a purchase with none takes the
     * default, and then because it is being given one for the first time.
     */
    const nextCurrency =
      purchase.currency ?? existing.currency ?? defaultCurrency;
    const currencyChanged =
      existing.currency !== null && nextCurrency !== existing.currency;

    /*
     * A unit cost that did not move while the currency did — the same refusal
     * `updateOrder` makes about prices, and for the same reason. What the
     * supplier invoiced in euros is not that figure in rupees, and nothing in
     * this system converts it.
     */
    if (currencyChanged) {
      const before = await tx.purchaseItem.findMany({
        where: { purchaseId },
        select: { productId: true, unitCost: true },
      });

      const previousCost = new Map(
        before.map((line) => [line.productId, line.unitCost.toString()]),
      );

      const carried = lines.filter((line) => {
        const previous = previousCost.get(line.productId);
        return (
          previous !== undefined &&
          toCents(Number(previous)) === line.unitCostCents
        );
      });

      if (
        carried.length > 0 &&
        purchase.costsConfirmedForCurrencyChange !== true
      ) {
        throw new AppError(
          "CONFLICT",
          `${carried.length === 1 ? "One line keeps" : `${carried.length} lines keep`} the same unit cost after changing this purchase from ` +
            `${existing.currency} to ${nextCurrency}. There are no exchange rates in this system, so a cost is not converted by ` +
            `re-labelling it — re-enter it in ${nextCurrency}, or confirm that the figure is the same in both currencies.`,
        );
      }
    }

    // Replaced wholesale rather than diffed. The lines are a small set with no
    // identity of their own, and a delete-then-insert inside the transaction is
    // simpler to reason about than a three-way merge.
    await tx.purchaseItem.deleteMany({ where: { purchaseId } });

    const updated = await tx.purchase.update({
      where: { id: purchaseId },
      data: {
        supplierId: purchase.supplierId,
        total: centsToDecimalString(totalCents),
        // Only reachable while the purchase is editable — the guard above
        // refuses RECEIVED and CANCELLED — so this is the freeze, enforced on
        // the server rather than by hiding a control.
        currency: nextCurrency,
        ...(purchase.purchaseDate ? { purchaseDate: purchase.purchaseDate } : {}),
        items: {
          create: lines.map((line) => ({
            productId: line.productId,
            quantity: line.quantity,
            unitCost: centsToDecimalString(line.unitCostCents),
            total: centsToDecimalString(line.unitCostCents * line.quantity),
          })),
        },
      },
      select: { id: true, purchaseNumber: true, total: true },
    });

    return {
      id: updated.id,
      purchaseNumber: updated.purchaseNumber,
      total: updated.total.toString(),
    };
  });
}

/** Products by id, whatever their status — for editing a purchase's lines. */
export async function loadPurchaseProducts(
  ids: readonly string[],
): Promise<PurchaseProductOption[]> {
  if (ids.length === 0) return [];

  try {
    const rows = await prisma.product.findMany({
      where: { id: { in: [...ids] } },
      select: {
        id: true,
        name: true,
        sku: true,
        stockQuantity: true,
        status: true,
      },
    });

    const lastPaid = await lastPaidByProduct(rows.map((row) => row.id));

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      sku: row.sku,
      lastPaidUnitCost: lastPaid.get(row.id)?.unitCost ?? null,
      lastPaidCurrency: lastPaid.get(row.id)?.currency ?? null,
      lastPaidAt: lastPaid.get(row.id)?.receivedAt ?? null,
      stockQuantity: row.stockQuantity,
      isActive: row.status === "ACTIVE",
    }));
  } catch (error) {
    toSafeError(error, "loadPurchaseProducts");
    return [];
  }
}

export { isEditable };
