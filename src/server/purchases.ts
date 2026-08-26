import "server-only";

import type { Prisma } from "@/generated/prisma/client";
import { certificateStatus, type CertificateStatus } from "@/lib/certificate-status";
import { AppError, NotFoundError, toSafeError, type SafeError } from "@/lib/errors";
import type { PurchaseListParams, PurchaseSortKey } from "@/lib/purchase-query";
import {
  holdsAddedStock,
  isEditable,
  transitionRefusal,
  type PurchaseStatus,
} from "@/lib/purchase-status";
import { prisma } from "@/lib/prisma";
import { stockStatus, type StockStatus } from "@/lib/stock-status";
import {
  calculatePurchaseTotal,
  centsToDecimalString,
  purchaseSchema,
  toCents,
  toPurchaseFieldErrors,
  type PurchaseFieldErrors,
} from "@/lib/validation/purchase";
import { requireUser } from "@/server/auth";
import { applyStockMovement, lockProducts } from "@/server/stock";

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
  pendingValue: string;
  receivedValue: string;
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
  stockStatus: StockStatus;
  /**
   * True when the product is no longer ACTIVE. The line stays visible — history
   * must remain readable — but it blocks receiving until someone resolves it.
   */
  productRetired: boolean;
  /**
   * The product's current certificate, referenced rather than copied. A
   * purchase never owns certificate data.
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
  /** Live figures, counted across every purchase from this supplier. */
  purchaseCount: number;
  receivedCount: number;
  totalPurchased: string;
  recentPurchases: {
    id: string;
    purchaseNumber: string;
    status: PurchaseStatus;
    total: string;
    purchaseDate: Date;
  }[];
}

export interface PurchaseDetail {
  id: string;
  purchaseNumber: string;
  status: PurchaseStatus;
  total: string;
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

export interface SupplierOption {
  id: string;
  name: string;
  email: string | null;
}

/** A product as the purchase builder's search results present it. */
export interface PurchaseProductOption {
  id: string;
  name: string;
  sku: string;
  /** The catalogue cost, offered as a default — the supplier's invoice wins. */
  costPrice: string;
  stockQuantity: number;
  minimumStock: number;
  stockStatus: StockStatus;
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
  pending_value: string;
  received_value: string;
}

export async function loadPurchaseStats(): Promise<Result<PurchaseStats>> {
  try {
    const rows = await prisma.$queryRaw<PurchaseStatsRow[]>`
      SELECT
        COUNT(*)::int                                     AS total,
        COUNT(*) FILTER (WHERE status = 'DRAFT')::int     AS draft,
        COUNT(*) FILTER (WHERE status = 'PENDING')::int   AS pending,
        COALESCE(SUM(total) FILTER (WHERE status = 'PENDING'), 0)::text
                                                          AS pending_value,
        COALESCE(SUM(total) FILTER (WHERE status = 'RECEIVED'), 0)::text
                                                          AS received_value
      FROM purchases
    `;

    const totals = rows[0] ?? {
      total: 0,
      draft: 0,
      pending: 0,
      pending_value: "0",
      received_value: "0",
    };

    return {
      ok: true,
      data: {
        total: totals.total,
        draft: totals.draft,
        pending: totals.pending,
        pendingValue: totals.pending_value,
        receivedValue: totals.received_value,
      },
    };
  } catch (error) {
    return { ok: false, error: toSafeError(error, "loadPurchaseStats") };
  }
}

export async function loadSupplierOptions(): Promise<SupplierOption[]> {
  try {
    return await prisma.supplier.findMany({
      orderBy: { name: "asc" },
      select: { id: true, name: true, email: true },
    });
  } catch (error) {
    toSafeError(error, "loadSupplierOptions");
    return [];
  }
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
        costPrice: true,
        stockQuantity: true,
        minimumStock: true,
      },
    });

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      sku: row.sku,
      costPrice: row.costPrice.toString(),
      stockQuantity: row.stockQuantity,
      minimumStock: row.minimumStock,
      stockStatus: stockStatus(row),
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

/** Live figures for a supplier, plus their recent purchases. */
async function loadSupplierSummary(supplierId: string): Promise<SupplierSummary> {
  const [supplier, aggregate, received, recent] = await Promise.all([
    prisma.supplier.findUniqueOrThrow({ where: { id: supplierId } }),
    prisma.purchase.aggregate({
      where: { supplierId },
      _count: { _all: true },
    }),
    // Only received purchases count as money actually spent — a draft is a
    // plan, and a cancelled purchase is one that did not happen.
    prisma.purchase.aggregate({
      where: { supplierId, status: "RECEIVED" },
      _count: { _all: true },
      _sum: { total: true },
    }),
    prisma.purchase.findMany({
      where: { supplierId },
      orderBy: { purchaseDate: "desc" },
      take: 5,
      select: {
        id: true,
        purchaseNumber: true,
        status: true,
        total: true,
        purchaseDate: true,
      },
    }),
  ]);

  return {
    id: supplier.id,
    name: supplier.name,
    contactPerson: supplier.contactPerson,
    email: supplier.email,
    phone: supplier.phone,
    address: supplier.address,
    purchaseCount: aggregate._count._all,
    receivedCount: received._count._all,
    totalPurchased: (received._sum.total ?? 0).toString(),
    recentPurchases: recent.map((row) => ({
      id: row.id,
      purchaseNumber: row.purchaseNumber,
      status: row.status,
      total: row.total.toString(),
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
                minimumStock: true,
                /*
                 * The product's current certificate, read through the relation.
                 * Nothing is copied onto the purchase: a purchase references
                 * its products, and a product owns its paperwork. Receiving a
                 * delivery never creates or changes a certificate.
                 */
                certificates: {
                  where: { supersededAt: null },
                  select: {
                    certificateType: true,
                    certificateNumber: true,
                    expiryDate: true,
                  },
                  take: 1,
                },
              },
            },
          },
        },
      },
    });

    if (!purchase) return { ok: true, data: null };

    const [impact, supplier] = await Promise.all([
      loadInventoryImpact(id),
      loadSupplierSummary(purchase.supplierId),
    ]);

    const lines = purchase.items.map((item) => {
      const certificate = item.product.certificates[0] ?? null;

      return {
        id: item.id,
        productId: item.product.id,
        productName: item.product.name,
        sku: item.product.sku,
        quantity: item.quantity,
        unitCost: item.unitCost.toString(),
        total: item.total.toString(),
        currentStock: item.product.stockQuantity,
        stockStatus: stockStatus(item.product),
        productRetired: item.product.status !== "ACTIVE",
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

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await prisma.$transaction(async (tx) => {
        const supplier = await tx.supplier.findUnique({
          where: { id: purchase.supplierId },
          select: { id: true },
        });

        if (!supplier) {
          throw badRequest(
            "supplierId",
            "That supplier no longer exists. Pick another.",
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
): Promise<{ id: string; purchaseNumber: string; status: PurchaseStatus }> {
  const rows = await tx.$queryRaw<
    { id: string; purchase_number: string; status: PurchaseStatus }[]
  >`
    SELECT id, purchase_number, status
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
  };
}

function assertTransition(from: PurchaseStatus, to: PurchaseStatus): void {
  const refusal = transitionRefusal(from, to);
  if (refusal) throw new AppError("CONFLICT", refusal);
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

    for (const item of items) {
      const product = locked.get(item.productId)!;

      const { previousStock, newStock } = await applyStockMovement(tx, {
        product,
        type: "STOCK_IN",
        // Positive: goods coming in.
        delta: item.quantity,
        reference: { type: "PURCHASE", id: purchaseId },
        note: `Purchase ${purchase.purchaseNumber} received`,
        // From the session, resolved through clerkId. Never from the client.
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
      data: { status: "RECEIVED", receivedAt: new Date() },
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
 * One failure mode is worth knowing about: if the goods have since been sold,
 * taking them back would drive stock negative, and `applyStockMovement` refuses
 * it. That is the correct answer — the units are gone, and a cancellation
 * cannot un-sell them — and the whole cancellation rolls back rather than
 * leaving inventory half-reversed.
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

      for (const productId of [...productIds].sort()) {
        const quantity = outstanding.get(productId)!;
        const product = locked.get(productId)!;

        const { previousStock, newStock } = await applyStockMovement(tx, {
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

        movements.push({
          productId: product.id,
          productName: product.name,
          quantity,
          previousStock,
          newStock,
        });
      }
    }

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
      select: { id: true },
    });

    if (!supplier) {
      throw badRequest(
        "supplierId",
        "That supplier no longer exists. Pick another.",
      );
    }

    const lines = await resolveLines(tx, purchase.items);
    const totalCents = calculatePurchaseTotal(lines);

    // Replaced wholesale rather than diffed. The lines are a small set with no
    // identity of their own, and a delete-then-insert inside the transaction is
    // simpler to reason about than a three-way merge.
    await tx.purchaseItem.deleteMany({ where: { purchaseId } });

    const updated = await tx.purchase.update({
      where: { id: purchaseId },
      data: {
        supplierId: purchase.supplierId,
        total: centsToDecimalString(totalCents),
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
        costPrice: true,
        stockQuantity: true,
        minimumStock: true,
        status: true,
      },
    });

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      sku: row.sku,
      costPrice: row.costPrice.toString(),
      stockQuantity: row.stockQuantity,
      minimumStock: row.minimumStock,
      stockStatus: stockStatus(row),
      isActive: row.status === "ACTIVE",
    }));
  } catch (error) {
    toSafeError(error, "loadPurchaseProducts");
    return [];
  }
}

export { isEditable };
