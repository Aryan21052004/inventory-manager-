import "server-only";

import type { Prisma } from "@/generated/prisma/client";
import type { CustomerStatus } from "@/generated/prisma/enums";
import { certificateStatus, type CertificateStatus } from "@/lib/certificate-status";
import {
  AppError,
  InsufficientStockError,
  NotFoundError,
  toSafeError,
  type SafeError,
} from "@/lib/errors";
import type { OrderListParams, OrderSortKey } from "@/lib/order-query";
import {
  canTransition,
  holdsDeductedStock,
  isEditable,
  transitionRefusal,
  type OrderStatus,
} from "@/lib/order-status";
import { prisma } from "@/lib/prisma";
import { stockStatus, type StockStatus } from "@/lib/stock-status";
import {
  calculateTotals,
  centsToDecimalString,
  orderSchema,
  toCents,
  toOrderFieldErrors,
  type OrderFieldErrors,
} from "@/lib/validation/order";
import { requireUser } from "@/server/auth";
import {
  allocateFifo,
  applyStockMovement,
  lockProducts,
  returnToLots,
} from "@/server/stock";

/**
 * Everything the orders module does to the database.
 *
 * The centre of this file is `confirmOrder`, and everything around it exists to
 * keep that function honest. Confirming an order is the moment stock actually
 * leaves the building, and it has to hold three properties at once:
 *
 *   **Atomic.** Every line is deducted or none is. An order for two products
 *   where the second is short must leave the first untouched — a partial
 *   deduction is inventory that is wrong in a way nobody will notice until a
 *   stock count months later.
 *
 *   **Serialised.** Two orders for the same product, submitted together, must
 *   not both read the same balance. The product rows are locked `FOR UPDATE`,
 *   in a consistent order, before any balance is read.
 *
 *   **Attributed.** Every movement records the local user resolved from the
 *   Clerk session. `createdBy` is not a parameter anywhere in this file.
 *
 * As with products, there are no `next/*` imports here: the actions in
 * src/app/(app)/orders/actions.ts are thin wrappers, so these rules hold
 * however the operation is invoked and can be tested without faking a request.
 */

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface OrderListItem {
  id: string;
  orderNumber: string;
  customerId: string;
  customerName: string;
  status: OrderStatus;
  itemCount: number;
  unitCount: number;
  subtotal: string;
  discount: string;
  total: string;
  createdAt: Date;
  createdByName: string | null;
}

export interface OrderListPage {
  items: OrderListItem[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

export interface OrderStats {
  total: number;
  draft: number;
  pending: number;
  confirmed: number;
  /** Value of orders that are live commitments — confirmed but not completed. */
  openValue: string;
}

export interface OrderDetailLine {
  id: string;
  productId: string;
  productName: string;
  sku: string;
  quantity: number;
  unitPrice: string;
  total: string;
  /**
   * What these units cost us, frozen at confirmation. Null before the order is
   * confirmed, and null again once it is cancelled.
   *
   * Covers `costedQuantity` units, which is not always all of them — see the
   * note on `OrderItem.costedQuantity` in the schema.
   */
  costTotal: string | null;
  costedQuantity: number;
  /** Stock on hand now, for context — not what was deducted. */
  currentStock: number;
  stockStatus: StockStatus;
  /**
   * The product's current certificate, referenced rather than copied. Orders
   * never own certificate data; this is a read of the product's own paperwork
   * at the moment the page is rendered.
   */
  certificateType: string | null;
  certificateNumber: string | null;
  certificateStatus: CertificateStatus;
}

/** One product's inventory movement caused by this order. */
export interface InventoryImpactLine {
  productId: string;
  productName: string;
  sku: string;
  /** Positive: units taken out. */
  deducted: number;
  deductedFrom: number | null;
  deductedTo: number | null;
  /** Positive: units put back by a cancellation. */
  restored: number;
  restoredFrom: number | null;
  restoredTo: number | null;
}

export interface OrderDetail {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  subtotal: string;
  discount: string;
  total: string;
  createdAt: Date;
  updatedAt: Date;
  confirmedAt: Date | null;
  completedAt: Date | null;
  cancelledAt: Date | null;
  customerId: string;
  customerName: string;
  customerEmail: string | null;
  customerPhone: string | null;
  customerAddress: string | null;
  createdByName: string | null;
  lines: OrderDetailLine[];
  impact: InventoryImpactLine[];
  /** Other orders from the same customer, for context. */
  customerHistory: {
    id: string;
    orderNumber: string;
    status: OrderStatus;
    total: string;
    createdAt: Date;
  }[];
}

export interface CustomerOption {
  id: string;
  name: string;
  email: string | null;
  /**
   * Almost always ACTIVE — the picker asks for active customers. It can be
   * INACTIVE for exactly one entry: the customer already on the order being
   * edited, who is kept in the list so an old draft still shows who it is for.
   */
  status: CustomerStatus;
}

/** A product as the order builder's search results present it. */
export interface OrderProductOption {
  id: string;
  name: string;
  sku: string;
  /**
   * The product's price *now*. The order builder previews with this because
   * `updateOrder` recalculates from it — showing the price stored on an
   * existing line would preview a total the save would not produce.
   */
  sellingPrice: string;
  stockQuantity: number;
  minimumStock: number;
  stockStatus: StockStatus;
  /**
   * Always true for search results, which only return ACTIVE products. It can
   * be false for a line already on an order whose product was retired since —
   * the builder flags it, and the server refuses to save it.
   */
  isActive: boolean;
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: SafeError };

// ---------------------------------------------------------------------------
// Querying
// ---------------------------------------------------------------------------

const SORT_COLUMNS: Record<Exclude<OrderSortKey, "customer">, string> = {
  orderNumber: "orderNumber",
  status: "status",
  total: "total",
  createdAt: "createdAt",
};

function buildWhere(params: OrderListParams): Prisma.OrderWhereInput {
  const filters: Prisma.OrderWhereInput[] = [];

  if (params.search) {
    // One box, two columns. People look for an order by its number or by who
    // it is for, and do not want to pick which first.
    filters.push({
      OR: [
        { orderNumber: { contains: params.search, mode: "insensitive" } },
        { customer: { name: { contains: params.search, mode: "insensitive" } } },
      ],
    });
  }

  if (params.customerId) filters.push({ customerId: params.customerId });
  if (params.status) filters.push({ status: params.status });

  if (params.from) {
    filters.push({ createdAt: { gte: new Date(`${params.from}T00:00:00.000Z`) } });
  }

  if (params.to) {
    // Inclusive: "to 2026-08-26" means the whole of the 26th, so the bound is
    // the start of the following day rather than its midnight.
    const end = new Date(`${params.to}T00:00:00.000Z`);
    end.setUTCDate(end.getUTCDate() + 1);
    filters.push({ createdAt: { lt: end } });
  }

  return filters.length > 0 ? { AND: filters } : {};
}

function buildOrderBy(
  params: OrderListParams,
): Prisma.OrderOrderByWithRelationInput[] {
  const direction = params.direction;

  const primary: Prisma.OrderOrderByWithRelationInput =
    params.sort === "customer"
      ? { customer: { name: direction } }
      : { [SORT_COLUMNS[params.sort]]: direction };

  // A stable tiebreak, so a row cannot appear on two pages or on neither.
  return params.sort === "orderNumber"
    ? [primary]
    : [primary, { orderNumber: "desc" }];
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listOrders(
  params: OrderListParams,
): Promise<Result<OrderListPage>> {
  try {
    const where = buildWhere(params);

    const [total, rows] = await Promise.all([
      prisma.order.count({ where }),
      prisma.order.findMany({
        where,
        orderBy: buildOrderBy(params),
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
        select: {
          id: true,
          orderNumber: true,
          status: true,
          subtotal: true,
          discount: true,
          total: true,
          createdAt: true,
          customerId: true,
          customer: { select: { name: true } },
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
          orderNumber: row.orderNumber,
          customerId: row.customerId,
          customerName: row.customer.name,
          status: row.status,
          itemCount: row.items.length,
          unitCount: row.items.reduce((sum, item) => sum + item.quantity, 0),
          subtotal: row.subtotal.toString(),
          discount: row.discount.toString(),
          total: row.total.toString(),
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
    return { ok: false, error: toSafeError(error, "listOrders") };
  }
}

interface OrderStatsRow {
  total: number;
  draft: number;
  pending: number;
  confirmed: number;
  open_value: string;
}

export async function loadOrderStats(): Promise<Result<OrderStats>> {
  try {
    const rows = await prisma.$queryRaw<OrderStatsRow[]>`
      SELECT
        COUNT(*)::int                                          AS total,
        COUNT(*) FILTER (WHERE status = 'DRAFT')::int          AS draft,
        COUNT(*) FILTER (WHERE status = 'PENDING')::int        AS pending,
        COUNT(*) FILTER (WHERE status = 'CONFIRMED')::int      AS confirmed,
        COALESCE(SUM(total) FILTER (WHERE status = 'CONFIRMED'), 0)::text
                                                               AS open_value
      FROM orders
    `;

    const totals = rows[0] ?? {
      total: 0,
      draft: 0,
      pending: 0,
      confirmed: 0,
      open_value: "0",
    };

    return {
      ok: true,
      data: {
        total: totals.total,
        draft: totals.draft,
        pending: totals.pending,
        confirmed: totals.confirmed,
        openValue: totals.open_value,
      },
    };
  } catch (error) {
    return { ok: false, error: toSafeError(error, "loadOrderStats") };
  }
}

/**
 * Customers that can be picked for an order.
 *
 * Only ACTIVE ones, for the same reason the product picker only offers active
 * products: an archived customer has been taken out of circulation deliberately
 * and offering them is how they end up sold to again.
 *
 * `includeId` is the exception, and it exists for editing. An order that was
 * raised before its customer was archived still belongs to that customer, and
 * the edit form has to be able to display them — dropping them from the list
 * would leave the form showing no customer at all and quietly reassign the
 * order on save. Their status comes back with them so the builder can say what
 * it is looking at.
 *
 * Note what this does *not* do: nothing here decides whether an order may be
 * saved. `createOrder` and `updateOrder` check the customer themselves, and
 * they check that the customer exists rather than that they are active —
 * archiving must not make an existing draft unsaveable.
 */
export async function loadCustomers(
  includeId?: string | null,
): Promise<CustomerOption[]> {
  try {
    return await prisma.customer.findMany({
      where: includeId
        ? { OR: [{ status: "ACTIVE" }, { id: includeId }] }
        : { status: "ACTIVE" },
      orderBy: { name: "asc" },
      select: { id: true, name: true, email: true, status: true },
    });
  } catch (error) {
    toSafeError(error, "loadCustomers");
    return [];
  }
}

/**
 * Products that can be added to an order.
 *
 * Only ACTIVE ones. An inactive or discontinued product is out of circulation,
 * and offering it in a picker is how it ends up sold — the server refuses it at
 * validation time anyway, so showing it would only produce a confusing error
 * late instead of an absence early.
 */
export async function searchOrderProducts(
  search: string,
  limit = 20,
): Promise<OrderProductOption[]> {
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
        sellingPrice: true,
        stockQuantity: true,
        minimumStock: true,
      },
    });

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      sku: row.sku,
      sellingPrice: row.sellingPrice.toString(),
      stockQuantity: row.stockQuantity,
      minimumStock: row.minimumStock,
      stockStatus: stockStatus(row),
      isActive: true,
    }));
  } catch (error) {
    toSafeError(error, "searchOrderProducts");
    return [];
  }
}

/**
 * Products by id, whatever their status.
 *
 * The edit page needs these for the lines already on an order, and one of them
 * may have been retired since the order was raised. Filtering it out here would
 * make the line silently vanish from the form and the save would quietly drop
 * it; loading it with `isActive: false` lets the builder show it, flag it, and
 * make the person decide.
 */
export async function loadOrderProducts(
  ids: readonly string[],
): Promise<OrderProductOption[]> {
  if (ids.length === 0) return [];

  try {
    const rows = await prisma.product.findMany({
      where: { id: { in: [...ids] } },
      select: {
        id: true,
        name: true,
        sku: true,
        sellingPrice: true,
        stockQuantity: true,
        minimumStock: true,
        status: true,
      },
    });

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      sku: row.sku,
      sellingPrice: row.sellingPrice.toString(),
      stockQuantity: row.stockQuantity,
      minimumStock: row.minimumStock,
      stockStatus: stockStatus(row),
      isActive: row.status === "ACTIVE",
    }));
  } catch (error) {
    toSafeError(error, "loadOrderProducts");
    return [];
  }
}

/**
 * The inventory an order actually moved, read from the ledger.
 *
 * Deliberately not derived from the order's status. The stock transactions are
 * the record of what happened; the status is a label on the document. If the
 * two ever disagreed, the ledger would be the one telling the truth, so the
 * panel that claims "150 units deducted, 200 → 50" reads from it.
 */
async function loadInventoryImpact(
  orderId: string,
): Promise<InventoryImpactLine[]> {
  const movements = await prisma.stockTransaction.findMany({
    where: { referenceType: "ORDER", referenceId: orderId },
    orderBy: { createdAt: "asc" },
    include: { product: { select: { id: true, name: true, sku: true } } },
  });

  const byProduct = new Map<string, InventoryImpactLine>();

  for (const movement of movements) {
    const existing = byProduct.get(movement.productId) ?? {
      productId: movement.productId,
      productName: movement.product.name,
      sku: movement.product.sku,
      deducted: 0,
      deductedFrom: null,
      deductedTo: null,
      restored: 0,
      restoredFrom: null,
      restoredTo: null,
    };

    if (movement.type === "STOCK_OUT") {
      existing.deducted += movement.quantity;
      existing.deductedFrom ??= movement.previousStock;
      existing.deductedTo = movement.newStock;
    } else {
      // REVERSAL — the cancellation putting the units back.
      existing.restored += movement.quantity;
      existing.restoredFrom ??= movement.previousStock;
      existing.restoredTo = movement.newStock;
    }

    byProduct.set(movement.productId, existing);
  }

  return [...byProduct.values()];
}

export async function getOrderDetail(
  id: string,
): Promise<Result<OrderDetail | null>> {
  try {
    const order = await prisma.order.findUnique({
      where: { id },
      include: {
        customer: true,
        createdByUser: { select: { name: true } },
        items: {
          orderBy: { product: { name: "asc" } },
          include: {
            product: {
              select: {
                id: true,
                name: true,
                sku: true,
                stockQuantity: true,
                minimumStock: true,
                /*
                 * The product's *current* certificate, read through the
                 * relation. Nothing is copied onto the order: an order
                 * references its products, and a product owns its paperwork.
                 * Duplicating it here would mean two records of one document
                 * that drift the moment the certificate is replaced.
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

    if (!order) return { ok: true, data: null };

    const [impact, customerHistory] = await Promise.all([
      loadInventoryImpact(id),
      prisma.order.findMany({
        where: { customerId: order.customerId, id: { not: id } },
        orderBy: { createdAt: "desc" },
        take: 5,
        select: {
          id: true,
          orderNumber: true,
          status: true,
          total: true,
          createdAt: true,
        },
      }),
    ]);

    return {
      ok: true,
      data: {
        id: order.id,
        orderNumber: order.orderNumber,
        status: order.status,
        subtotal: order.subtotal.toString(),
        discount: order.discount.toString(),
        total: order.total.toString(),
        createdAt: order.createdAt,
        updatedAt: order.updatedAt,
        confirmedAt: order.confirmedAt,
        completedAt: order.completedAt,
        cancelledAt: order.cancelledAt,
        customerId: order.customerId,
        customerName: order.customer.name,
        customerEmail: order.customer.email,
        customerPhone: order.customer.phone,
        customerAddress: order.customer.address,
        createdByName: order.createdByUser?.name ?? null,
        lines: order.items.map((item) => {
          const certificate = item.product.certificates[0] ?? null;

          return {
            id: item.id,
            productId: item.product.id,
            productName: item.product.name,
            sku: item.product.sku,
            quantity: item.quantity,
            unitPrice: item.unitPrice.toString(),
            total: item.total.toString(),
            costTotal: item.costTotal?.toString() ?? null,
            costedQuantity: item.costedQuantity,
            currentStock: item.product.stockQuantity,
            stockStatus: stockStatus(item.product),
            certificateType: certificate?.certificateType ?? null,
            certificateNumber: certificate?.certificateNumber ?? null,
            certificateStatus: certificateStatus(certificate),
          };
        }),
        impact,
        customerHistory: customerHistory.map((row) => ({
          id: row.id,
          orderNumber: row.orderNumber,
          status: row.status,
          total: row.total.toString(),
          createdAt: row.createdAt,
        })),
      },
    };
  } catch (error) {
    return { ok: false, error: toSafeError(error, "getOrderDetail") };
  }
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

function badRequest(
  field: keyof OrderFieldErrors,
  message: string,
): AppError {
  return new AppError("BAD_REQUEST", message, { field });
}

/**
 * The next order number for the current year.
 *
 * Read-then-write, and therefore racy on its own — two orders raised in the
 * same instant will compute the same number. That is not prevented here; it is
 * made harmless. The unique index on `order_number` lets exactly one of them
 * commit, and `createOrder` retries, which recomputes against the row the
 * winner has now written. Checking harder cannot close the gap between the read
 * and the write; only the database can arbitrate.
 */
async function nextOrderNumber(tx: Prisma.TransactionClient): Promise<string> {
  const prefix = `SO-${new Date().getUTCFullYear()}-`;

  const last = await tx.order.findFirst({
    where: { orderNumber: { startsWith: prefix } },
    orderBy: { orderNumber: "desc" },
    select: { orderNumber: true },
  });

  const previous = last ? Number(last.orderNumber.slice(prefix.length)) : 0;
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

export interface CreatedOrder {
  id: string;
  orderNumber: string;
  total: string;
}

/**
 * Creates an order as a draft.
 *
 * Every figure is computed here, from prices read out of the database in this
 * transaction. The client sends a customer, some product ids and quantities,
 * and a discount; it does not send unit prices, line totals, a subtotal or a
 * grand total, and none of those would be believed if it did. An order is a
 * financial document, and a total the browser calculated is a total the browser
 * chose.
 *
 * Creating never moves stock, whatever the quantities. Deduction happens on
 * confirmation and nowhere else.
 */
export async function createOrder(input: unknown): Promise<CreatedOrder> {
  // Any signed-in user may raise an order — both roles do this as part of the
  // job. The role check that matters is on confirmation, which moves stock.
  const user = await requireUser();

  const parsed = orderSchema.safeParse(input);
  if (!parsed.success) {
    const errors = toOrderFieldErrors(parsed.error);
    const field = (Object.keys(errors)[0] ?? "form") as keyof OrderFieldErrors;
    throw new AppError("BAD_REQUEST", errors[field] ?? "Check the order.", {
      field,
    });
  }

  const order = parsed.data;
  const discountCents = toCents(order.discount);

  // Retried because the order number is computed by reading the highest one
  // that exists; see `nextOrderNumber`.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await prisma.$transaction(async (tx) => {
        const customer = await tx.customer.findUnique({
          where: { id: order.customerId },
          select: { id: true },
        });

        if (!customer) {
          throw badRequest(
            "customerId",
            "That customer no longer exists. Pick another.",
          );
        }

        const products = await tx.product.findMany({
          where: { id: { in: order.items.map((item) => item.productId) } },
          select: {
            id: true,
            name: true,
            sellingPrice: true,
            status: true,
          },
        });

        const byId = new Map(products.map((product) => [product.id, product]));

        const lines = order.items.map((item) => {
          const product = byId.get(item.productId);

          if (!product) {
            throw badRequest(
              "items",
              "One of the products on this order no longer exists. Remove it and try again.",
            );
          }

          if (product.status !== "ACTIVE") {
            throw badRequest(
              "items",
              `"${product.name}" is not active and cannot be sold. Remove it from the order.`,
            );
          }

          // Copied from the product now, so the order does not change
          // retrospectively when someone edits the price list — and so the
          // client cannot name its own price.
          const unitPriceCents = toCents(Number(product.sellingPrice));

          return {
            productId: product.id,
            quantity: item.quantity,
            unitPriceCents,
          };
        });

        const totals = calculateTotals(lines, discountCents);

        if (totals.discountCents > totals.subtotalCents) {
          throw badRequest(
            "discount",
            "The discount is larger than the order total.",
          );
        }

        const created = await tx.order.create({
          data: {
            orderNumber: await nextOrderNumber(tx),
            status: "DRAFT",
            customerId: order.customerId,
            subtotal: centsToDecimalString(totals.subtotalCents),
            discount: centsToDecimalString(totals.discountCents),
            total: centsToDecimalString(totals.totalCents),
            // From the session. Not a parameter, so no caller can raise an
            // order in somebody else's name.
            createdBy: user.id,
            items: {
              create: lines.map((line) => ({
                productId: line.productId,
                quantity: line.quantity,
                unitPrice: centsToDecimalString(line.unitPriceCents),
                total: centsToDecimalString(
                  line.unitPriceCents * line.quantity,
                ),
              })),
            },
          },
          select: { id: true, orderNumber: true, total: true },
        });

        return {
          id: created.id,
          orderNumber: created.orderNumber,
          total: created.total.toString(),
        };
      });
    } catch (error) {
      // Only an order-number clash is worth retrying. A duplicate line hits the
      // same Prisma code but retrying would fail identically, so it is left to
      // the schema's own message.
      if (isUniqueViolation(error) && attempt < 4) continue;

      if (isUniqueViolation(error)) {
        throw new AppError(
          "CONFLICT",
          "Several orders were raised at the same moment and the numbering could not settle. Try again.",
        );
      }

      throw error;
    }
  }

  throw new AppError("CONFLICT", "Could not allocate an order number.");
}

export interface OrderTransitionOutcome {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  /** What moved, so the UI can say "150 units deducted" without re-querying. */
  movements: {
    productId: string;
    productName: string;
    quantity: number;
    previousStock: number;
    newStock: number;
  }[];
  /**
   * Units this transition drew from stock whose acquisition cost is unknown.
   *
   * Present so a confirmation can say so at the moment it happens — "5 units
   * drawn from uncosted stock" — rather than leaving somebody to discover a
   * partial margin in a report weeks later. Informational only: it never
   * blocks, because quantity was available and the sale is legitimate.
   */
  uncostedUnits?: number;
  /** True when the call found the work already done and changed nothing. */
  alreadyInState: boolean;
}

/**
 * Locks an order row and returns its current state.
 *
 * The lock is what makes every transition below safe against itself. Two
 * confirmations of the same order arriving together would otherwise both read
 * DRAFT and both deduct; locking the row makes the second wait, see CONFIRMED,
 * and be refused. The order row is locked *before* any product row, and every
 * path here does it in that order, so the lock hierarchy is consistent.
 */
async function lockOrder(
  tx: Prisma.TransactionClient,
  orderId: string,
): Promise<{ id: string; orderNumber: string; status: OrderStatus }> {
  const rows = await tx.$queryRaw<
    { id: string; order_number: string; status: OrderStatus }[]
  >`
    SELECT id, order_number, status
    FROM orders
    WHERE id = ${orderId}
    FOR UPDATE
  `;

  const order = rows[0];
  if (!order) throw new NotFoundError("Order");

  return {
    id: order.id,
    orderNumber: order.order_number,
    status: order.status,
  };
}

function assertTransition(from: OrderStatus, to: OrderStatus): void {
  const refusal = transitionRefusal(from, to);
  if (refusal) throw new AppError("CONFLICT", refusal);
}

/**
 * Confirms an order: the moment stock leaves.
 *
 * The whole operation is one database transaction, in this order:
 *
 *   1. Resolve the Clerk session to a local user. Outside the transaction,
 *      because it may have to talk to Clerk and must not hold locks while it
 *      does.
 *   2. Lock the order row and read its status.
 *   3. Refuse the transition if it is not legal from that status.
 *   4. Load the lines.
 *   5. Lock every product row, sorted by id — a consistent order, so two
 *      overlapping orders queue instead of deadlocking.
 *   6. Check *every* line against its locked balance before writing anything.
 *   7. Deduct, writing a STOCK_OUT for each line.
 *   8. Move the order to CONFIRMED.
 *
 * Step 6 is the one worth spelling out. Checking each line as it is written
 * would deduct the first product and then fail on the second, leaving inventory
 * half-moved — and although the rollback would undo it, the check-then-write
 * loop reads as if partial deduction were acceptable. Validating the whole
 * order against the locked balances first makes the guarantee visible rather
 * than incidental.
 */
export async function confirmOrder(
  orderId: string,
): Promise<OrderTransitionOutcome> {
  // Both roles may confirm — it is ordinary work, and the existing policy
  // reserves ADMIN for corrections that have no document behind them. The
  // movements written below are backed by this order.
  const user = await requireUser();

  return prisma.$transaction(async (tx) => {
    const order = await lockOrder(tx, orderId);
    assertTransition(order.status, "CONFIRMED");

    const items = await tx.orderItem.findMany({
      where: { orderId },
      // `id` so the resolved cost can be written back to the line.
      select: { id: true, productId: true, quantity: true },
    });

    if (items.length === 0) {
      throw new AppError(
        "BAD_REQUEST",
        "This order has no items, so there is nothing to confirm.",
      );
    }

    const locked = await lockProducts(
      tx,
      items.map((item) => item.productId),
    );

    // Every line checked before any line is written.
    for (const item of items) {
      const product = locked.get(item.productId)!;

      if (product.stockQuantity < item.quantity) {
        throw new InsufficientStockError(
          product.name,
          item.quantity,
          product.stockQuantity,
        );
      }
    }

    const movements: OrderTransitionOutcome["movements"] = [];
    let uncostedUnits = 0;

    for (const item of items) {
      const product = locked.get(item.productId)!;

      const { transaction, previousStock, newStock } = await applyStockMovement(
        tx,
        {
          product,
          type: "STOCK_OUT",
          delta: -item.quantity,
          reference: { type: "ORDER", id: orderId },
          note: `Order ${order.orderNumber} confirmed`,
          // From the session, resolved through clerkId. Never from the client.
          userId: user.id,
        },
      );

      /*
       * What these units cost us, resolved now and frozen.
       *
       * Costing runs after the movement, never before it, and cannot refuse
       * one: the stock has already legitimately left. FIFO draws the oldest
       * batches first, and if some of those predate this system the draw comes
       * back partially costed — 10 of 15 units, say — which is recorded as
       * exactly that rather than being averaged into a whole-line figure that
       * would read as complete.
       */
      const allocation = await allocateFifo(tx, {
        productId: product.id,
        quantity: item.quantity,
        stockTransactionId: transaction.id,
      });

      uncostedUnits += allocation.uncostedQuantity;

      await tx.orderItem.update({
        where: { id: item.id },
        data: {
          costTotal:
            allocation.costedQuantity === 0
              ? null
              : centsToDecimalString(allocation.costTotalCents),
          costedQuantity: allocation.costedQuantity,
        },
      });

      movements.push({
        productId: product.id,
        productName: product.name,
        quantity: item.quantity,
        previousStock,
        newStock,
      });
    }

    const updated = await tx.order.update({
      where: { id: orderId },
      data: { status: "CONFIRMED", confirmedAt: new Date() },
      select: { id: true, orderNumber: true, status: true },
    });

    return { ...updated, movements, uncostedUnits, alreadyInState: false };
  });
}

/**
 * Marks a confirmed order complete. Moves no stock.
 *
 * The units left on confirmation. Deducting again here would take them twice —
 * the single most plausible inventory bug in a module like this, and the reason
 * completion is its own function that touches no product rows at all.
 */
export async function completeOrder(
  orderId: string,
): Promise<OrderTransitionOutcome> {
  await requireUser();

  return prisma.$transaction(async (tx) => {
    const order = await lockOrder(tx, orderId);
    assertTransition(order.status, "COMPLETED");

    const updated = await tx.order.update({
      where: { id: orderId },
      data: { status: "COMPLETED", completedAt: new Date() },
      select: { id: true, orderNumber: true, status: true },
    });

    return { ...updated, movements: [], alreadyInState: false };
  });
}

/**
 * Cancels an order, returning exactly the stock it took.
 *
 * Idempotent by design. Cancelling an order that is already cancelled does
 * nothing and says so, rather than restoring a second time — the order row is
 * locked first, so a second call cannot slip past the status check even if it
 * arrives simultaneously.
 *
 * What gets restored is read from the ledger, not from the order lines. Those
 * are the same today, but the ledger is the record of what actually left, and
 * if the two ever disagreed the ledger would be the one telling the truth. The
 * reversal quantities are therefore whatever the STOCK_OUT rows say, netted
 * against any REVERSAL already written.
 */
export async function cancelOrder(
  orderId: string,
  reason?: string,
): Promise<OrderTransitionOutcome> {
  const user = await requireUser();

  return prisma.$transaction(async (tx) => {
    const order = await lockOrder(tx, orderId);

    if (order.status === "CANCELLED") {
      // Already done. Not an error, and emphatically not a second restore.
      return {
        id: order.id,
        orderNumber: order.orderNumber,
        status: order.status,
        movements: [],
        alreadyInState: true,
      };
    }

    assertTransition(order.status, "CANCELLED");

    const movements: OrderTransitionOutcome["movements"] = [];

    // Only an order that actually deducted has anything to give back. A draft
    // being abandoned never touched inventory.
    if (holdsDeductedStock(order.status)) {
      const ledger = await tx.stockTransaction.findMany({
        where: { referenceType: "ORDER", referenceId: orderId },
        select: { id: true, productId: true, type: true, quantity: true },
      });

      // Net what left against anything already returned, so a partially
      // reversed order cannot be over-restored.
      const outstanding = new Map<string, number>();

      for (const row of ledger) {
        const delta = row.type === "STOCK_OUT" ? row.quantity : -row.quantity;
        outstanding.set(
          row.productId,
          (outstanding.get(row.productId) ?? 0) + delta,
        );
      }

      // The movements whose lot draws are being undone.
      const outboundIds = ledger
        .filter((row) => row.type === "STOCK_OUT")
        .map((row) => row.id);

      const productIds = [...outstanding.entries()]
        .filter(([, quantity]) => quantity > 0)
        .map(([productId]) => productId);

      const locked = await lockProducts(tx, productIds);

      for (const productId of [...productIds].sort()) {
        const quantity = outstanding.get(productId)!;
        const product = locked.get(productId)!;

        const { transaction, previousStock, newStock } =
          await applyStockMovement(tx, {
            product,
            type: "REVERSAL",
            // Positive: putting units back.
            delta: quantity,
            reference: { type: "ORDER", id: orderId },
            note: reason?.trim()
              ? `Order ${order.orderNumber} cancelled — ${reason.trim()}`
              : `Order ${order.orderNumber} cancelled`,
            userId: user.id,
          });

        /*
         * Back to the batches they came out of, at the price those batches
         * cost. Never into a new lot at today's price: cancel an order placed
         * when the part cost ₹8,000 and the units belong to the ₹8,000 batch
         * again, whatever the most recent delivery was priced at.
         */
        await returnToLots(tx, {
          sourceTransactionIds: outboundIds,
          reversalTransactionId: transaction.id,
          productId: product.id,
          /*
           * What the reversal actually restored. Anything the consumption
           * rows cannot account for — an order confirmed before costing
           * existed has none — comes back as an uncosted lot rather than
           * being lost, which is what keeps the lots and the ledger agreeing.
           */
          expectedQuantity: quantity,
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

      /*
       * The sale did not happen, so it has no cost of sale. Cleared rather than
       * left in place: a cancelled order carrying COGS would be counted by any
       * report that sums cost over line items, and the stock it describes is
       * back on the shelf waiting to be sold to somebody else.
       */
      await tx.orderItem.updateMany({
        where: { orderId },
        data: { costTotal: null, costedQuantity: 0 },
      });
    }

    const updated = await tx.order.update({
      where: { id: orderId },
      data: { status: "CANCELLED", cancelledAt: new Date() },
      select: { id: true, orderNumber: true, status: true },
    });

    return { ...updated, movements, alreadyInState: false };
  });
}

/**
 * Moves a draft to pending, or a pending order back to draft. No stock either
 * way — neither status has committed anything.
 */
export async function setOrderStatus(
  orderId: string,
  target: OrderStatus,
): Promise<OrderTransitionOutcome> {
  await requireUser();

  if (target === "CONFIRMED" || target === "CANCELLED" || target === "COMPLETED") {
    // These move stock, or must not. They have their own functions, with their
    // own locking and their own guarantees; routing them through a generic
    // setter would be a second way to change stock.
    throw new AppError(
      "BAD_REQUEST",
      "That status change has to go through its own action.",
    );
  }

  return prisma.$transaction(async (tx) => {
    const order = await lockOrder(tx, orderId);
    assertTransition(order.status, target);

    const updated = await tx.order.update({
      where: { id: orderId },
      data: { status: target },
      select: { id: true, orderNumber: true, status: true },
    });

    return { ...updated, movements: [], alreadyInState: false };
  });
}

/**
 * Replaces the lines and discount on an order that has not yet committed.
 *
 * Only DRAFT and PENDING orders can be edited, and neither has moved stock, so
 * this never touches inventory. Editing a confirmed order would mean the
 * document and the deduction behind it no longer matched.
 */
export async function updateOrder(
  orderId: string,
  input: unknown,
): Promise<CreatedOrder> {
  await requireUser();

  const parsed = orderSchema.safeParse(input);
  if (!parsed.success) {
    const errors = toOrderFieldErrors(parsed.error);
    const field = (Object.keys(errors)[0] ?? "form") as keyof OrderFieldErrors;
    throw new AppError("BAD_REQUEST", errors[field] ?? "Check the order.", {
      field,
    });
  }

  const order = parsed.data;
  const discountCents = toCents(order.discount);

  return prisma.$transaction(async (tx) => {
    const existing = await lockOrder(tx, orderId);

    if (!isEditable(existing.status)) {
      throw new AppError(
        "CONFLICT",
        `A ${existing.status.toLowerCase()} order cannot be edited. Its stock has already been committed.`,
      );
    }

    // Checked rather than trusted, exactly as on create. The column is a
    // foreign key, so a bad id would be caught either way — but as a constraint
    // violation the user cannot read, instead of a message naming the field.
    const customer = await tx.customer.findUnique({
      where: { id: order.customerId },
      select: { id: true },
    });

    if (!customer) {
      throw badRequest(
        "customerId",
        "That customer no longer exists. Pick another.",
      );
    }

    const products = await tx.product.findMany({
      where: { id: { in: order.items.map((item) => item.productId) } },
      select: { id: true, name: true, sellingPrice: true, status: true },
    });

    const byId = new Map(products.map((product) => [product.id, product]));

    const lines = order.items.map((item) => {
      const product = byId.get(item.productId);

      if (!product) {
        throw badRequest(
          "items",
          "One of the products on this order no longer exists. Remove it and try again.",
        );
      }

      if (product.status !== "ACTIVE") {
        throw badRequest(
          "items",
          `"${product.name}" is not active and cannot be sold. Remove it from the order.`,
        );
      }

      return {
        productId: product.id,
        quantity: item.quantity,
        unitPriceCents: toCents(Number(product.sellingPrice)),
      };
    });

    const totals = calculateTotals(lines, discountCents);

    if (totals.discountCents > totals.subtotalCents) {
      throw badRequest("discount", "The discount is larger than the order total.");
    }

    // Replaced wholesale rather than diffed. The lines are a small set with no
    // identity of their own, and a delete-then-insert inside the transaction is
    // simpler to reason about than a three-way merge.
    await tx.orderItem.deleteMany({ where: { orderId } });

    const updated = await tx.order.update({
      where: { id: orderId },
      data: {
        customerId: order.customerId,
        subtotal: centsToDecimalString(totals.subtotalCents),
        discount: centsToDecimalString(totals.discountCents),
        total: centsToDecimalString(totals.totalCents),
        items: {
          create: lines.map((line) => ({
            productId: line.productId,
            quantity: line.quantity,
            unitPrice: centsToDecimalString(line.unitPriceCents),
            total: centsToDecimalString(line.unitPriceCents * line.quantity),
          })),
        },
      },
      select: { id: true, orderNumber: true, total: true },
    });

    return {
      id: updated.id,
      orderNumber: updated.orderNumber,
      total: updated.total.toString(),
    };
  });
}

/** Re-exported so callers can ask what an order may do next. */
export { canTransition, isEditable };
