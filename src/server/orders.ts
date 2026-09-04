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
  canFulfilOutstanding,
  canTransition,
  isEditable,
  mayHoldDeductedStock,
  orderStatusLabel,
  transitionRefusal,
  type OrderStatus,
} from "@/lib/order-status";
import { prisma } from "@/lib/prisma";
import {
  calculateTotals,
  centsToDecimalString,
  fulfilmentSchema,
  orderSchema,
  toCents,
  toOrderFieldErrors,
  type OrderFieldErrors,
} from "@/lib/validation/order";
import { requireUser } from "@/server/auth";
import { getLotCertificates } from "@/server/certificates";
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
 *   **Atomic.** Whatever is deducted is deducted together, or not at all. A
 *   failure part-way through a multi-line order must leave inventory exactly
 *   as it found it — a half-applied deduction is stock that is wrong in a way
 *   nobody notices until a count months later.
 *
 *   Note what this no longer says. It used to read "every line is deducted or
 *   none is", because a short line failed the whole confirmation. It does not
 *   any more: this business sells parts it does not yet hold, so a line takes
 *   what is on the shelf and records the rest as outstanding. The transaction
 *   is still all-or-nothing; what changed is that a shortfall stopped being a
 *   failure.
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
  /**
   * Units sold on this order that have not shipped.
   *
   * Zero for every order the shelf could fill, which is most of them. Non-zero
   * says the sale is committed and something is still owed — a fact about the
   * lines, not a status, which is why there is no sixth OrderStatus for it.
   */
  outstandingUnits: number;
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
  /**
   * How many of `quantity` have physically shipped.
   *
   * Less than `quantity` when the order was confirmed against a shelf that
   * could not fill it. The difference is outstanding and is derived, never
   * stored — see the note on `OrderItem.fulfilledQuantity` in the schema.
   */
  fulfilledQuantity: number;
  /** Stock on hand now, for context — not what was deducted. */
  currentStock: number;
  /**
   * The paperwork covering the batches this line actually drew from.
   *
   * Read through `StockLotConsumption`, which records exactly which lots the
   * confirmation consumed — so this answers "what covered the units that
   * shipped" rather than "what covers this part number today". An order can
   * draw across several batches, and those batches can be in different
   * certification states; all of them are listed rather than one being picked.
   *
   * Empty before confirmation, because nothing has been drawn yet.
   */
  lotCertificates: ConsumedLotCertificate[];
}

/** One batch an order line drew from, and the paperwork covering it. */
export interface ConsumedLotCertificate {
  lotId: string;
  /** Net units this order took from the batch, after any cancellation returns. */
  quantity: number;
  /** The purchase the batch arrived on, when there was one. */
  purchaseNumber: string | null;
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
          items: { select: { quantity: true, fulfilledQuantity: true } },
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
          outstandingUnits: row.items.reduce(
            (sum, item) => sum + (item.quantity - item.fulfilledQuantity),
            0,
          ),
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
      },
    });

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      sku: row.sku,
      sellingPrice: row.sellingPrice.toString(),
      stockQuantity: row.stockQuantity,
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
        status: true,
      },
    });

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      sku: row.sku,
      sellingPrice: row.sellingPrice.toString(),
      stockQuantity: row.stockQuantity,
      isActive: row.status === "ACTIVE",
    }));
  } catch (error) {
    toSafeError(error, "loadOrderProducts");
    return [];
  }
}

/**
 * The batches an order actually drew from, and the paperwork covering them.
 *
 * `StockLotConsumption` records which lots a confirmation consumed, so this is
 * a fact about the units that shipped rather than a guess from the product's
 * catalogue entry. That distinction is the point: a product no longer has "a
 * certificate", its batches do, and an order that drew across three batches
 * drew across three sets of paperwork.
 *
 * Consumption quantities are signed — a cancellation writes negative rows
 * against the draws it undoes — so they are summed and a net of zero is
 * dropped. A fully cancelled order therefore lists nothing, which is correct:
 * it consumed nothing in the end.
 *
 * Read-only. Nothing here touches a lot, a consumption, a quantity or a cost.
 */
async function loadConsumedLotCertificates(
  orderId: string,
): Promise<Map<string, ConsumedLotCertificate[]>> {
  const rows = await prisma.$queryRaw<
    {
      lot_id: string;
      product_id: string;
      quantity: number;
      source_type: string;
      source_id: string | null;
    }[]
  >`
    SELECT
      c.lot_id,
      l.product_id,
      SUM(c.quantity)::int AS quantity,
      l.source_type::text  AS source_type,
      l.source_id
    FROM stock_lot_consumptions c
    JOIN stock_transactions st ON st.id = c.stock_transaction_id
    JOIN stock_lots l          ON l.id = c.lot_id
    WHERE st.reference_type = 'ORDER'
      AND st.reference_id = ${orderId}
    GROUP BY c.lot_id, l.product_id, l.source_type, l.source_id
    HAVING SUM(c.quantity) <> 0
    ORDER BY l.product_id, c.lot_id
  `;

  if (rows.length === 0) return new Map();

  const [certificates, purchaseNumbers] = await Promise.all([
    getLotCertificates(rows.map((row) => row.lot_id)),
    (async () => {
      const ids = [
        ...new Set(
          rows
            .filter((row) => row.source_type === "PURCHASE" && row.source_id)
            .map((row) => row.source_id!),
        ),
      ];
      if (ids.length === 0) return new Map<string, string>();

      const purchases = await prisma.purchase.findMany({
        where: { id: { in: ids } },
        select: { id: true, purchaseNumber: true },
      });
      return new Map(purchases.map((p) => [p.id, p.purchaseNumber] as const));
    })(),
  ]);

  const byProduct = new Map<string, ConsumedLotCertificate[]>();

  for (const row of rows) {
    const certificate = certificates.get(row.lot_id) ?? null;
    const entry: ConsumedLotCertificate = {
      lotId: row.lot_id,
      quantity: row.quantity,
      purchaseNumber: row.source_id
        ? (purchaseNumbers.get(row.source_id) ?? null)
        : null,
      certificateType: certificate?.certificateType ?? null,
      certificateNumber: certificate?.certificateNumber ?? null,
      certificateStatus: certificateStatus(certificate),
    };

    const list = byProduct.get(row.product_id);
    if (list) list.push(entry);
    else byProduct.set(row.product_id, [entry]);
  }

  return byProduct;
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
              },
            },
          },
        },
      },
    });

    if (!order) return { ok: true, data: null };

    const [impact, consumedLots, customerHistory] = await Promise.all([
      loadInventoryImpact(id),
      loadConsumedLotCertificates(id),
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
        lines: order.items.map((item) => ({
          id: item.id,
          productId: item.product.id,
          productName: item.product.name,
          sku: item.product.sku,
          quantity: item.quantity,
          unitPrice: item.unitPrice.toString(),
          total: item.total.toString(),
          costTotal: item.costTotal?.toString() ?? null,
          costedQuantity: item.costedQuantity,
          fulfilledQuantity: item.fulfilledQuantity,
          currentStock: item.product.stockQuantity,
          lotCertificates: consumedLots.get(item.product.id) ?? [],
        })),
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
  /**
   * Units this order still owes the customer after the transition.
   *
   * Zero on an order the shelf could fill completely. Non-zero when stock ran
   * short: the sale is committed, the available units have left, and this is
   * what remains to be shipped once more arrives. Distinct from
   * `uncostedUnits` in kind, not just in degree — those units moved and their
   * price is unknown; these have not moved at all.
   */
  unfulfilledUnits?: number;
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
 * Confirms an order: the moment the sale is committed and whatever is on the
 * shelf leaves.
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
 *   6. For each line, take what the locked balance can actually give.
 *   7. Deduct and cost that, writing a STOCK_OUT per line that moved.
 *   8. Move the order to CONFIRMED, whatever remains outstanding.
 *
 * **Step 6 no longer refuses.** It used to check every line against its
 * balance and throw `InsufficientStockError` if any came up short, so an order
 * for one more unit than existed could not be confirmed at all. That was the
 * wrong model for this business, which routinely sells parts it does not yet
 * hold: a shortfall is a procurement fact, not an invalid document. So each
 * line now takes `min(quantity, stockQuantity)` and records the remainder as
 * outstanding on `fulfilledQuantity`.
 *
 * What that costs, and why it is affordable: the old code's guarantee was
 * "either the whole order deducts or none of it does". The new guarantee is
 * narrower but still total — *whatever is deducted is deducted atomically*.
 * One transaction still spans every line, so a failure anywhere rolls back
 * everything, and no line is ever half-written. What has gone is only the
 * refusal, not the atomicity.
 *
 * Three things this deliberately does not do:
 *
 *   It never writes a zero-quantity movement. A line that can take nothing
 *   gets no StockTransaction, no lot and no consumption row — the ledger says
 *   nothing moved because nothing did, and `stock_transactions_quantity_
 *   positive` would reject the row anyway.
 *
 *   It never drives stock negative. `take` is bounded by the locked balance,
 *   so `applyStockMovement`'s guard is never even approached. The outstanding
 *   units exist only as the arithmetic difference on the line.
 *
 *   It never invents a cost for the outstanding units. They have not been
 *   acquired against this sale, so there is nothing to know yet — see the note
 *   on `OrderItem.fulfilledQuantity`.
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

    const movements: OrderTransitionOutcome["movements"] = [];
    let uncostedUnits = 0;
    let unfulfilledUnits = 0;

    for (const item of items) {
      const product = locked.get(item.productId)!;

      /*
       * What the shelf can actually give, read from the locked balance.
       *
       * Bounded below by zero as well as above: `stockQuantity` cannot be
       * negative today and this does not rely on that staying true.
       */
      const take = Math.max(0, Math.min(item.quantity, product.stockQuantity));

      unfulfilledUnits += item.quantity - take;

      if (take === 0) {
        /*
         * Nothing on hand, so nothing happens — no ledger row, no lot, no
         * consumption, and the line keeps its default `fulfilledQuantity` of
         * zero. The sale is still committed; the units are simply owed.
         *
         * Writing a zero-quantity STOCK_OUT to mark the attempt would be the
         * tempting alternative and is exactly wrong: the ledger records what
         * moved, and nothing moved.
         */
        continue;
      }

      const { transaction, previousStock, newStock } = await applyStockMovement(
        tx,
        {
          product,
          type: "STOCK_OUT",
          delta: -take,
          reference: { type: "ORDER", id: orderId },
          note:
            take === item.quantity
              ? `Order ${order.orderNumber} confirmed`
              : `Order ${order.orderNumber} confirmed — ${take} of ${item.quantity} units fulfilled`,
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
       *
       * Only `take` units are drawn, so the lots demonstrably cover the
       * movement and `allocateFifo`'s "lots do not cover this" assertion keeps
       * its exact meaning as a detector of a broken invariant.
       */
      const allocation = await allocateFifo(tx, {
        productId: product.id,
        quantity: take,
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
          // What actually left. Never `item.quantity` — that is what was sold.
          fulfilledQuantity: take,
        },
      });

      movements.push({
        productId: product.id,
        productName: product.name,
        quantity: take,
        previousStock,
        newStock,
      });
    }

    /*
     * Confirmed either way, and `confirmedAt` set either way.
     *
     * This timestamp is load-bearing well beyond the order screen: the sales
     * report dates realised revenue by `confirmed_at`, so leaving it null on an
     * order that could not be filled would erase a real sale from every
     * financial report. The sale happened; only the shipping is outstanding.
     */
    const updated = await tx.order.update({
      where: { id: orderId },
      data: { status: "CONFIRMED", confirmedAt: new Date() },
      select: { id: true, orderNumber: true, status: true },
    });

    return {
      ...updated,
      movements,
      uncostedUnits,
      unfulfilledUnits,
      alreadyInState: false,
    };
  });
}

/**
 * Marks a confirmed order complete. Moves no stock.
 *
 * Whatever left, left on confirmation. Deducting again here would take those
 * units twice — the single most plausible inventory bug in a module like this,
 * and the reason completion is its own function that touches no product rows
 * at all.
 *
 * Completion is permitted with quantity still outstanding, and that is not an
 * oversight. It is a commercial statement — this sale is done being negotiated
 * — while fulfilment is a physical one, and the two genuinely come apart in a
 * business that sells parts before it holds them. `fulfilOrder` therefore
 * stays available on a COMPLETED order; see `canFulfilOutstanding`.
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
 * Ships units an order already owes, once the stock exists.
 *
 * The other half of the model confirmation opened up. Confirming an order the
 * warehouse could not fill records what is owed; this is the act that pays it
 * down, and it is the only route by which outstanding quantity ever falls.
 *
 * **Not a status transition.** Nothing here touches `status`, `confirmedAt` or
 * `completedAt`. The order was already commercially settled; what changes is
 * how much of it has physically gone out, which lives on the lines.
 *
 * **Explicit quantities, not "fulfil whatever you can".** The operator states
 * what is going in the box, per line. Automatic allocation would look kinder
 * and be worse: when a short delivery lands against three waiting orders, the
 * question of which one gets it is a commercial decision — a customer is
 * waiting on each — and answering it by whoever's page refreshed first would
 * bury that decision in a race. The UI prefills what is available so the easy
 * case stays one click.
 *
 * **Short requests are refused, not trimmed**, and the asymmetry with
 * confirmation is deliberate. Confirming is a commitment to sell, so a
 * shortfall is the whole point and gets recorded. Fulfilling is an assertion
 * that units are physically being sent; if they are not there the assertion is
 * wrong, and silently shipping fewer than the operator said would put a number
 * in the ledger that nobody typed.
 *
 * Locking is the same discipline as everywhere else in this file: the order
 * row first, then the product rows sorted by id, then the lots underneath
 * them. No new lock order is introduced, so nothing here can deadlock against
 * a concurrent confirmation or cancellation.
 */
export async function fulfilOrder(
  orderId: string,
  input: unknown,
): Promise<OrderTransitionOutcome> {
  // Ordinary warehouse work backed by a document, exactly like confirming an
  // order or receiving a delivery. ADMIN stays reserved for movements with no
  // document behind them.
  const user = await requireUser();

  const parsed = fulfilmentSchema.safeParse(input);

  if (!parsed.success) {
    throw new AppError("BAD_REQUEST", parsed.error.issues[0]!.message);
  }

  const requested = new Map(
    parsed.data.lines.map((line) => [line.orderItemId, line.quantity] as const),
  );

  return prisma.$transaction(async (tx) => {
    const order = await lockOrder(tx, orderId);

    if (!canFulfilOutstanding(order.status)) {
      throw new AppError(
        "CONFLICT",
        `Order ${order.orderNumber} is ${orderStatusLabel(order.status).toLowerCase()}, so there is nothing to fulfil against it. Only a confirmed or completed order can still be shipped.`,
      );
    }

    const items = await tx.orderItem.findMany({
      where: { id: { in: [...requested.keys()] }, orderId },
      select: {
        id: true,
        productId: true,
        quantity: true,
        fulfilledQuantity: true,
        costTotal: true,
        costedQuantity: true,
        product: { select: { name: true } },
      },
    });

    if (items.length !== requested.size) {
      throw new NotFoundError("Order line");
    }

    /*
     * Every line checked against its outstanding quantity before anything is
     * written. This one *is* still all-or-nothing: unlike a shortfall at
     * confirmation, asking to ship more than is owed is a mistake in the
     * request rather than a fact about the warehouse, and settling the rest of
     * the form around it would hide the error.
     */
    for (const item of items) {
      const want = requested.get(item.id)!;
      const outstanding = item.quantity - item.fulfilledQuantity;

      if (outstanding <= 0) {
        throw new AppError(
          "CONFLICT",
          `${item.product.name} has already been fulfilled in full on this order.`,
        );
      }

      if (want > outstanding) {
        throw new AppError(
          "BAD_REQUEST",
          `${item.product.name} has only ${outstanding} ${outstanding === 1 ? "unit" : "units"} outstanding on this order, so ${want} cannot be fulfilled.`,
        );
      }
    }

    const locked = await lockProducts(
      tx,
      items.map((item) => item.productId),
    );

    // Stock checked for every line before any line moves, so a request that
    // cannot be met in full does not half-ship and then fail.
    for (const item of items) {
      const product = locked.get(item.productId)!;
      const want = requested.get(item.id)!;

      if (product.stockQuantity < want) {
        throw new InsufficientStockError(
          product.name,
          want,
          product.stockQuantity,
        );
      }
    }

    const movements: OrderTransitionOutcome["movements"] = [];
    let uncostedUnits = 0;

    // Sorted, so a fulfilment spanning several lines writes them in a fixed
    // sequence — the same reason `lockProducts` sorts.
    for (const item of [...items].sort((a, b) => a.id.localeCompare(b.id))) {
      const product = locked.get(item.productId)!;
      const want = requested.get(item.id)!;

      const { transaction, previousStock, newStock } = await applyStockMovement(
        tx,
        {
          product,
          type: "STOCK_OUT",
          delta: -want,
          reference: { type: "ORDER", id: orderId },
          note: `Order ${order.orderNumber} fulfilled — ${want} of ${item.quantity - item.fulfilledQuantity} outstanding units`,
          // From the session, resolved through clerkId. Never from the client.
          userId: user.id,
        },
      );

      /*
       * Costed from the lots that exist *now*, which is the point of doing
       * this later rather than guessing at confirmation. Units shipped from a
       * delivery that arrived last week carry that delivery's real price, and
       * if the oldest open lot happens to be uncosted the draw comes back
       * uncosted — unknown stays unknown, and nothing is filled in from the
       * catalogue.
       */
      const allocation = await allocateFifo(tx, {
        productId: product.id,
        quantity: want,
        stockTransactionId: transaction.id,
      });

      uncostedUnits += allocation.uncostedQuantity;

      /*
       * Cost accumulates across fulfilment events. A line shipped in two
       * batches at two prices carries the sum, which is exactly what
       * `costTotal` has always meant — a total, never a rate, because the
       * units behind it can come from several lots.
       *
       * The null handling is not defensive noise: `order_items_cost_pairing`
       * requires `(cost_total IS NULL) = (costed_quantity = 0)`, so a draw
       * that costs nothing must leave a null total rather than a zero.
       */
      const costedQuantity = item.costedQuantity + allocation.costedQuantity;
      const costTotalCents =
        toCents(Number(item.costTotal ?? 0)) + allocation.costTotalCents;

      await tx.orderItem.update({
        where: { id: item.id },
        data: {
          fulfilledQuantity: item.fulfilledQuantity + want,
          costedQuantity,
          costTotal:
            costedQuantity === 0 ? null : centsToDecimalString(costTotalCents),
        },
      });

      movements.push({
        productId: product.id,
        productName: product.name,
        quantity: want,
        previousStock,
        newStock,
      });
    }

    /*
     * What the order still owes after this, read back rather than computed
     * from the loop — the lines not named in this request are outstanding too,
     * and the operator needs the whole picture, not the part they just acted
     * on.
     */
    const remaining = await tx.orderItem.aggregate({
      where: { orderId },
      _sum: { quantity: true, fulfilledQuantity: true },
    });

    const unfulfilledUnits =
      (remaining._sum.quantity ?? 0) - (remaining._sum.fulfilledQuantity ?? 0);

    return {
      id: order.id,
      orderNumber: order.orderNumber,
      status: order.status,
      movements,
      uncostedUnits,
      unfulfilledUnits,
      alreadyInState: false,
    };
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
    if (mayHoldDeductedStock(order.status)) {
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

      /*
       * Every movement this order has written, not only the outbound ones.
       *
       * `returnToLots` nets the consumption rows across all of them, and a
       * prior REVERSAL's rows hang off that reversal's own transaction id.
       * Passing only the STOCK_OUTs would hide anything already given back and
       * over-restore the lots — see the note on `returnToLots`.
       */
      const documentTransactionIds = ledger.map((row) => row.id);

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
          documentTransactionIds,
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
       * The sale did not happen, so it has no cost of sale and nothing was
       * fulfilled. Cleared rather than left in place: a cancelled order
       * carrying COGS would be counted by any report that sums cost over line
       * items, and the stock it describes is back on the shelf waiting to be
       * sold to somebody else.
       *
       * `fulfilledQuantity` goes back to zero for the same reason and in the
       * same statement — the units it counted have just been returned to their
       * lots, so a line still claiming to have shipped them would contradict
       * the ledger. Setting both to zero in one update also keeps
       * `costedQuantity <= fulfilledQuantity` true at every instant, which a
       * two-statement version would briefly break.
       *
       * Outstanding quantity needs no undoing. It was never anything but the
       * difference between two numbers, and both are now zero.
       */
      await tx.orderItem.updateMany({
        where: { orderId },
        data: { costTotal: null, costedQuantity: 0, fulfilledQuantity: 0 },
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
