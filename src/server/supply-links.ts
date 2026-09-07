import "server-only";

import type { Prisma } from "@/generated/prisma/client";
import type { OrderStatus, PurchaseStatus } from "@/generated/prisma/enums";
import { AppError, NotFoundError } from "@/lib/errors";
import { canFulfilOutstanding, orderStatusLabel } from "@/lib/order-status";
import { prisma } from "@/lib/prisma";
import {
  supplyLinkSchema,
  supplyLinkUpdateSchema,
  toSupplyLinkFieldErrors,
  type SupplyLinkFieldErrors,
} from "@/lib/validation/supply-link";
import { requireUser } from "@/server/auth";

/**
 * Which delivery is expected to clear which outstanding order line.
 *
 * The business sells parts it does not yet hold, so a confirmed order routinely
 * owes units nobody has shipped. Those units deliberately have no stock
 * movement, no lot and no consumption row — nothing has moved — which is
 * precisely why the ledger cannot answer "which purchase will cover this".
 * These functions are the only place that answer lives.
 *
 * **Everything here is advisory.** A link creates no stock, consumes none,
 * costs nothing, reaches no lot, writes no ledger row and changes no quantity
 * on either document. `receivePurchase` does not read it, so receiving a linked
 * delivery still fulfils nothing; `fulfilOrder` remains the only route from
 * outstanding to shipped. That is not an oversight to be tidied up later — it
 * is the decision recorded in HANDOVER §18: which of several waiting orders
 * gets a short delivery is a commercial judgement, and settling it by whoever's
 * page refreshed first would bury that decision in a race.
 *
 * **Four rules, and two of them are aggregates.** A link joins two lines for the
 * same product; its quantity is positive; the links against one order line may
 * not exceed that line's outstanding quantity; and the links against one
 * purchase line may not exceed what that line ordered. Only the first two can be
 * expressed row-locally — the schema carries `supply_links_quantity_positive`
 * and nothing else. The other two are sums, and a row-level CHECK cannot read a
 * sum, so they are enforced below under row locks. `costedQuantity` and
 * `returnedQuantity` are stored for the same reason and guarded the same way.
 *
 * **Only a committed order can be linked** — CONFIRMED or COMPLETED, which is
 * `canFulfilOutstanding`, called rather than restated. Two reasons, and the
 * second is the load-bearing one.
 *
 *   A draft has promised nobody anything. `quantity - fulfilledQuantity` is
 *   arithmetically non-zero on one, but that is not an obligation: the order
 *   page already declines to print it as "outstanding" because doing so would
 *   invent one. An expectation about an invented obligation is not worth
 *   recording.
 *
 *   DRAFT and PENDING are exactly the statuses `isEditable` admits, and
 *   `updateOrder` replaces an editable order's lines **wholesale** — a
 *   `deleteMany` followed by a `create`. `supply_links.order_item_id` cascades,
 *   so a link on a draft would be destroyed by any edit to that order,
 *   including one that only changed the customer, with no error and no trace.
 *   Linkable and editable being mutually exclusive is what keeps that from
 *   being a silent data loss nobody notices.
 *
 * CANCELLED falls out of the same predicate rather than needing its own check.
 */

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** A delivery expected to cover an order line, as the order page shows it. */
export interface SupplyLinkForOrderLine {
  id: string;
  quantity: number;
  purchaseItemId: string;
  purchaseId: string;
  purchaseNumber: string;
  purchaseStatus: PurchaseStatus;
  supplierName: string;
  /** When the purchase is dated — the nearest thing to an expected date. */
  purchaseDate: Date;
}

/** An order line a delivery is expected to cover, as the purchase page shows it. */
export interface SupplyLinkForPurchaseLine {
  id: string;
  quantity: number;
  orderItemId: string;
  orderId: string;
  orderNumber: string;
  orderStatus: OrderStatus;
  customerName: string;
  /** Still outstanding on that line right now, for context. */
  outstandingQuantity: number;
}

export interface SupplyLinkOutcome {
  id: string;
  orderItemId: string;
  orderId: string;
  purchaseItemId: string;
  purchaseId: string;
  quantity: number;
  productName: string;
}

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

/**
 * Purchase statuses a link may point at: RECEIVED, and only RECEIVED.
 *
 * The units are on the shelf but the order they were bought for has not been
 * shipped, because fulfilment is an explicit operator action. "Arrived, and
 * earmarked for this customer" is the state a link records.
 *
 * **PENDING is refused, and this is the rule that changed.** An in-transit
 * delivery is the case the feature seems to want, but `isEditable` admits
 * DRAFT *and* PENDING for purchases, and `updatePurchase` replaces an editable
 * purchase's lines wholesale — a `deleteMany` followed by a `create`. Since
 * `supply_links.purchase_item_id` cascades, a link against a pending purchase
 * would be destroyed by any edit to it, including one that only changed the
 * supplier, with no error and no trace. Linkable and editable are therefore
 * kept mutually exclusive on this side exactly as they are on the order side,
 * where the same cascade drove the same decision.
 *
 * DRAFT is refused for the same reason and one more: it has not been placed
 * with anybody, so there is no delivery to expect at all.
 *
 * CANCELLED is refused because cancelling removes a purchase's links, and
 * allowing one to be recreated afterwards would make that cleanup pointless.
 *
 * The narrowing has a consequence worth stating: a link can no longer say
 * "this incoming delivery will cover you", only "these arrived units are meant
 * for you". Nothing here reserves stock or ships anything either way.
 */
const LINKABLE_PURCHASE_STATUSES: ReadonlySet<PurchaseStatus> = new Set([
  "RECEIVED",
]);

function parseOrThrow<T>(
  result:
    | { success: true; data: T }
    | { success: false; error: Parameters<typeof toSupplyLinkFieldErrors>[0] },
): T {
  if (result.success) return result.data;

  const errors = toSupplyLinkFieldErrors(result.error);
  const field = (Object.keys(errors)[0] ?? "form") as keyof SupplyLinkFieldErrors;

  throw new AppError("BAD_REQUEST", errors[field] ?? "Check the details.", {
    field,
  });
}

// ---------------------------------------------------------------------------
// Locking
// ---------------------------------------------------------------------------

/**
 * Locks the order document, then the purchase document, in that fixed order.
 *
 * **Orders before purchases, always.** A supply link is the first thing in this
 * system that touches both document types in one transaction — `cancelOrder`
 * locks an order and its products, `cancelPurchase` locks a purchase and its
 * products, and until now nothing needed both. Two link operations taking the
 * two locks in opposite orders would deadlock the moment they overlapped, so
 * the sequence is fixed here and every writer below goes through this function.
 *
 * Locking the *documents* rather than the two lines is deliberate and slightly
 * coarse: it serialises every link touching that order or that purchase, which
 * is what makes the two aggregate guards below trustworthy. A line-level lock
 * would leave the sums readable while another transaction changed a sibling
 * row. `lockProduct` makes the same trade for the same reason.
 */
async function lockDocuments(
  tx: Prisma.TransactionClient,
  params: { orderId: string; purchaseId: string },
): Promise<{ orderStatus: OrderStatus; purchaseStatus: PurchaseStatus }> {
  const orders = await tx.$queryRaw<{ status: OrderStatus }[]>`
    SELECT status FROM orders WHERE id = ${params.orderId} FOR UPDATE
  `;

  const order = orders[0];
  if (!order) throw new NotFoundError("Order");

  const purchases = await tx.$queryRaw<{ status: PurchaseStatus }[]>`
    SELECT status FROM purchases WHERE id = ${params.purchaseId} FOR UPDATE
  `;

  const purchase = purchases[0];
  if (!purchase) throw new NotFoundError("Purchase");

  return { orderStatus: order.status, purchaseStatus: purchase.status };
}

/** The two lines a link joins, with everything the guards need. */
async function loadLines(
  tx: Prisma.TransactionClient,
  params: { orderItemId: string; purchaseItemId: string },
) {
  const orderItem = await tx.orderItem.findUnique({
    where: { id: params.orderItemId },
    select: {
      id: true,
      orderId: true,
      productId: true,
      quantity: true,
      fulfilledQuantity: true,
      product: { select: { name: true } },
    },
  });

  if (!orderItem) throw new NotFoundError("Order line");

  const purchaseItem = await tx.purchaseItem.findUnique({
    where: { id: params.purchaseItemId },
    select: {
      id: true,
      purchaseId: true,
      productId: true,
      quantity: true,
    },
  });

  if (!purchaseItem) throw new NotFoundError("Purchase line");

  return { orderItem, purchaseItem };
}

// ---------------------------------------------------------------------------
// The guards
// ---------------------------------------------------------------------------

/**
 * Every rule a link has to satisfy, checked under the locks.
 *
 * `excludeLinkId` is what makes an update work: raising a link from 2 to 3 must
 * measure the other links against the two lines and not itself, or the row
 * being changed would be counted twice and a legal increase refused.
 */
async function assertLinkIsLegal(
  tx: Prisma.TransactionClient,
  params: {
    orderItem: {
      id: string;
      productId: string;
      quantity: number;
      fulfilledQuantity: number;
      product: { name: string };
    };
    purchaseItem: { id: string; productId: string; quantity: number };
    orderStatus: OrderStatus;
    purchaseStatus: PurchaseStatus;
    quantity: number;
    excludeLinkId?: string | undefined;
  },
): Promise<void> {
  /*
   * Same product. A cross-table invariant, so it cannot be a constraint: the
   * two lines live in different tables and neither knows the other's product.
   * Checked first because it is the mistake that would otherwise be caught by a
   * confusing quantity error further down.
   */
  if (params.orderItem.productId !== params.purchaseItem.productId) {
    throw new AppError(
      "BAD_REQUEST",
      "That delivery is for a different part. A supply link says which units will cover an order line, so both lines have to be for the same product.",
    );
  }

  if (!LINKABLE_PURCHASE_STATUSES.has(params.purchaseStatus)) {
    throw new AppError(
      "CONFLICT",
      params.purchaseStatus === "CANCELLED"
        ? "That purchase has been cancelled, so nothing is arriving from it."
        : "That delivery has not arrived yet. A batch can only be earmarked for an order once the purchase has been received — until then its lines can still be edited, and the expectation would be lost without a word.",
    );
  }

  /*
   * Only an order that has committed can be waiting on a delivery, and
   * `canFulfilOutstanding` is exactly that question — the same predicate
   * `fulfilOrder` enforces and the same one the order page reads to decide
   * whether to show an outstanding figure at all. Called rather than restated,
   * so this rule cannot drift from the one the rest of the system applies.
   */
  if (!canFulfilOutstanding(params.orderStatus)) {
    throw new AppError(
      "CONFLICT",
      `That order is ${orderStatusLabel(params.orderStatus).toLowerCase()}, so nothing is outstanding on it. Only a confirmed or completed order can be waiting on a delivery.`,
    );
  }

  /*
   * Outstanding is derived, never stored — `quantity - fulfilledQuantity`, the
   * same expression every other reader uses. A link is an expectation about
   * units that have not shipped, so expecting more than are still owed is a
   * statement about nothing.
   */
  const outstanding =
    params.orderItem.quantity - params.orderItem.fulfilledQuantity;

  if (outstanding <= 0) {
    throw new AppError(
      "CONFLICT",
      `Every unit of ${params.orderItem.product.name} on this order has already been fulfilled, so nothing is waiting on a delivery.`,
    );
  }

  const linkedToOrderLine = await tx.supplyLink.aggregate({
    where: {
      orderItemId: params.orderItem.id,
      ...(params.excludeLinkId ? { id: { not: params.excludeLinkId } } : {}),
    },
    _sum: { quantity: true },
  });

  const alreadyExpected = linkedToOrderLine._sum.quantity ?? 0;
  const unexpected = outstanding - alreadyExpected;

  if (params.quantity > unexpected) {
    throw new AppError(
      "BAD_REQUEST",
      alreadyExpected === 0
        ? `Only ${outstanding} ${outstanding === 1 ? "unit is" : "units are"} outstanding on this line, so ${params.quantity} cannot be expected against it.`
        : `${outstanding} outstanding, ${alreadyExpected} already expected from other deliveries — ${unexpected} ${unexpected === 1 ? "unit" : "units"} left to cover, so ${params.quantity} cannot be expected.`,
    );
  }

  /*
   * The other direction: a delivery cannot be promised to more orders than it
   * contains. This is the guard the document lock exists for — two operators
   * pointing the same ten units at two different orders must serialise, or both
   * would read the same free quantity and both would succeed.
   */
  const linkedToPurchaseLine = await tx.supplyLink.aggregate({
    where: {
      purchaseItemId: params.purchaseItem.id,
      ...(params.excludeLinkId ? { id: { not: params.excludeLinkId } } : {}),
    },
    _sum: { quantity: true },
  });

  const alreadyAllocated = linkedToPurchaseLine._sum.quantity ?? 0;
  const unallocated = params.purchaseItem.quantity - alreadyAllocated;

  if (params.quantity > unallocated) {
    throw new AppError(
      "BAD_REQUEST",
      alreadyAllocated === 0
        ? `That delivery is for ${params.purchaseItem.quantity} ${params.purchaseItem.quantity === 1 ? "unit" : "units"}, so ${params.quantity} cannot be expected from it.`
        : `That delivery is for ${params.purchaseItem.quantity}, with ${alreadyAllocated} already expected by other orders — ${unallocated} ${unallocated === 1 ? "unit" : "units"} left to promise, so ${params.quantity} cannot be expected.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Records that a delivery is expected to cover part of an outstanding line.
 *
 * Any signed-in user, which is the policy orders and purchases already use:
 * raising and managing both documents is ordinary commercial work, and ADMIN is
 * reserved in this codebase for movements with no document behind them. Nothing
 * here moves stock at all.
 */
export async function createSupplyLink(
  input: unknown,
): Promise<SupplyLinkOutcome> {
  await requireUser();
  const request = parseOrThrow(supplyLinkSchema.safeParse(input));

  return prisma.$transaction(async (tx) => {
    // Read the lines first, only to learn which two documents to lock.
    const preliminary = await loadLines(tx, request);

    const { orderStatus, purchaseStatus } = await lockDocuments(tx, {
      orderId: preliminary.orderItem.orderId,
      purchaseId: preliminary.purchaseItem.purchaseId,
    });

    // Re-read under the locks. Fulfilment or a status change may have landed
    // between the read above and the locks being granted, and it is the state
    // at *this* moment the guards have to hold against.
    const { orderItem, purchaseItem } = await loadLines(tx, request);

    await assertLinkIsLegal(tx, {
      orderItem,
      purchaseItem,
      orderStatus,
      purchaseStatus,
      quantity: request.quantity,
    });

    const existing = await tx.supplyLink.findUnique({
      where: {
        orderItemId_purchaseItemId: {
          orderItemId: orderItem.id,
          purchaseItemId: purchaseItem.id,
        },
      },
      select: { id: true },
    });

    if (existing) {
      throw new AppError(
        "CONFLICT",
        "That delivery is already expected to cover this line. Change how many units it covers instead of adding a second link.",
      );
    }

    const link = await tx.supplyLink.create({
      data: {
        orderItemId: orderItem.id,
        purchaseItemId: purchaseItem.id,
        quantity: request.quantity,
      },
      select: { id: true, quantity: true },
    });

    return {
      id: link.id,
      orderItemId: orderItem.id,
      orderId: orderItem.orderId,
      purchaseItemId: purchaseItem.id,
      purchaseId: purchaseItem.purchaseId,
      quantity: link.quantity,
      productName: orderItem.product.name,
    };
  });
}

/** Changes how many units of a delivery are expected to cover a line. */
export async function updateSupplyLinkQuantity(
  input: unknown,
): Promise<SupplyLinkOutcome> {
  await requireUser();
  const request = parseOrThrow(supplyLinkUpdateSchema.safeParse(input));

  return prisma.$transaction(async (tx) => {
    const link = await tx.supplyLink.findUnique({
      where: { id: request.supplyLinkId },
      select: { id: true, orderItemId: true, purchaseItemId: true },
    });

    if (!link) throw new NotFoundError("Supply link");

    const preliminary = await loadLines(tx, link);

    const { orderStatus, purchaseStatus } = await lockDocuments(tx, {
      orderId: preliminary.orderItem.orderId,
      purchaseId: preliminary.purchaseItem.purchaseId,
    });

    const { orderItem, purchaseItem } = await loadLines(tx, link);

    await assertLinkIsLegal(tx, {
      orderItem,
      purchaseItem,
      orderStatus,
      purchaseStatus,
      quantity: request.quantity,
      // Measured against the *other* links, or raising this one would be
      // refused for exceeding a total it is itself inside.
      excludeLinkId: link.id,
    });

    const updated = await tx.supplyLink.update({
      where: { id: link.id },
      data: { quantity: request.quantity },
      select: { id: true, quantity: true },
    });

    return {
      id: updated.id,
      orderItemId: orderItem.id,
      orderId: orderItem.orderId,
      purchaseItemId: purchaseItem.id,
      purchaseId: purchaseItem.purchaseId,
      quantity: updated.quantity,
      productName: orderItem.product.name,
    };
  });
}

/**
 * Removes an expectation.
 *
 * Deleted rather than marked closed. A link is not a financial record and not a
 * document: it says what somebody currently expects, and an expectation that no
 * longer applies has nothing to preserve. Giving it a status and a history would
 * be inventing the lifecycle this deliberately does not have.
 */
export async function removeSupplyLink(
  supplyLinkId: string,
): Promise<{ orderId: string; purchaseId: string; productName: string }> {
  await requireUser();

  if (!supplyLinkId.trim()) {
    throw new AppError("BAD_REQUEST", "A supply link is required.");
  }

  return prisma.$transaction(async (tx) => {
    const link = await tx.supplyLink.findUnique({
      where: { id: supplyLinkId },
      select: {
        id: true,
        orderItem: {
          select: { orderId: true, product: { select: { name: true } } },
        },
        purchaseItem: { select: { purchaseId: true } },
      },
    });

    if (!link) throw new NotFoundError("Supply link");

    /*
     * Locked in the same order as every other writer here, even though removal
     * relaxes both aggregates rather than testing them. Skipping the locks
     * would let a delete interleave with a create that had already measured the
     * free quantity, and the cheapest way to never think about that again is to
     * take the same two locks.
     */
    await lockDocuments(tx, {
      orderId: link.orderItem.orderId,
      purchaseId: link.purchaseItem.purchaseId,
    });

    await tx.supplyLink.delete({ where: { id: link.id } });

    return {
      orderId: link.orderItem.orderId,
      purchaseId: link.purchaseItem.purchaseId,
      productName: link.orderItem.product.name,
    };
  });
}

// ---------------------------------------------------------------------------
// Cancellation cleanup
// ---------------------------------------------------------------------------

/**
 * Drops every expectation a cancelled document was carrying.
 *
 * Called from inside `cancelOrder` and `cancelPurchase`, in their existing
 * transactions and under the document lock each already holds. A cancelled
 * order is waiting for nothing and a cancelled purchase is delivering nothing,
 * so links naming either are stale the instant the status changes.
 *
 * **The ids are read and sorted before the delete.** Both cancellation paths can
 * reach the same link row — one by its order, the other by its purchase — and a
 * bare `deleteMany` on each side would lock the matching rows in whatever order
 * the scan produced, which is how two cancellations running at once deadlock on
 * two shared rows. Taking them by sorted id gives both paths one sequence. It is
 * the same reasoning `returnToLots` uses when it sorts lot ids.
 *
 * Returns how many were removed, so the caller can say so if it wants to.
 */
export async function clearSupplyLinksForOrder(
  tx: Prisma.TransactionClient,
  orderId: string,
): Promise<number> {
  const links = await tx.supplyLink.findMany({
    where: { orderItem: { orderId } },
    select: { id: true },
    orderBy: { id: "asc" },
  });

  if (links.length === 0) return 0;

  const { count } = await tx.supplyLink.deleteMany({
    where: { id: { in: links.map((link) => link.id) } },
  });

  return count;
}

/** The purchase-side mirror of `clearSupplyLinksForOrder`. */
export async function clearSupplyLinksForPurchase(
  tx: Prisma.TransactionClient,
  purchaseId: string,
): Promise<number> {
  const links = await tx.supplyLink.findMany({
    where: { purchaseItem: { purchaseId } },
    select: { id: true },
    orderBy: { id: "asc" },
  });

  if (links.length === 0) return 0;

  const { count } = await tx.supplyLink.deleteMany({
    where: { id: { in: links.map((link) => link.id) } },
  });

  return count;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** What is expected to cover each line of one order, keyed by order line id. */
export async function listSupplyLinksForOrder(
  orderId: string,
): Promise<Map<string, SupplyLinkForOrderLine[]>> {
  const links = await prisma.supplyLink.findMany({
    where: { orderItem: { orderId } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      quantity: true,
      orderItemId: true,
      purchaseItem: {
        select: {
          id: true,
          purchase: {
            select: {
              id: true,
              purchaseNumber: true,
              status: true,
              purchaseDate: true,
              supplier: { select: { name: true } },
            },
          },
        },
      },
    },
  });

  const byLine = new Map<string, SupplyLinkForOrderLine[]>();

  for (const link of links) {
    const rows = byLine.get(link.orderItemId) ?? [];

    rows.push({
      id: link.id,
      quantity: link.quantity,
      purchaseItemId: link.purchaseItem.id,
      purchaseId: link.purchaseItem.purchase.id,
      purchaseNumber: link.purchaseItem.purchase.purchaseNumber,
      purchaseStatus: link.purchaseItem.purchase.status,
      supplierName: link.purchaseItem.purchase.supplier.name,
      purchaseDate: link.purchaseItem.purchase.purchaseDate,
    });

    byLine.set(link.orderItemId, rows);
  }

  return byLine;
}

/** Which order lines each line of one purchase is expected to cover. */
export async function listSupplyLinksForPurchase(
  purchaseId: string,
): Promise<Map<string, SupplyLinkForPurchaseLine[]>> {
  const links = await prisma.supplyLink.findMany({
    where: { purchaseItem: { purchaseId } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      quantity: true,
      purchaseItemId: true,
      orderItem: {
        select: {
          id: true,
          quantity: true,
          fulfilledQuantity: true,
          order: {
            select: {
              id: true,
              orderNumber: true,
              status: true,
              customer: { select: { name: true } },
            },
          },
        },
      },
    },
  });

  const byLine = new Map<string, SupplyLinkForPurchaseLine[]>();

  for (const link of links) {
    const rows = byLine.get(link.purchaseItemId) ?? [];

    rows.push({
      id: link.id,
      quantity: link.quantity,
      orderItemId: link.orderItem.id,
      orderId: link.orderItem.order.id,
      orderNumber: link.orderItem.order.orderNumber,
      orderStatus: link.orderItem.order.status,
      customerName: link.orderItem.order.customer.name,
      // Derived here as everywhere else. Never stored.
      outstandingQuantity: Math.max(
        0,
        link.orderItem.quantity - link.orderItem.fulfilledQuantity,
      ),
    });

    byLine.set(link.purchaseItemId, rows);
  }

  return byLine;
}

/**
 * Purchase lines that could still cover an outstanding order line.
 *
 * Feeds the picker on the order page: same product, a purchase that has been
 * received, and at least one unit nobody has promised elsewhere. Ordered
 * oldest first, since the earliest delivery is usually the one somebody has
 * been waiting on longest.
 *
 * Read outside a transaction and therefore advisory in the strict sense — what
 * it offers may have been promised elsewhere by the time somebody clicks. The
 * write path re-checks everything under the locks, so a stale option is refused
 * rather than accepted.
 */
export async function listLinkablePurchaseLines(
  orderItemId: string,
): Promise<
  {
    purchaseItemId: string;
    purchaseId: string;
    purchaseNumber: string;
    purchaseStatus: PurchaseStatus;
    supplierName: string;
    purchaseDate: Date;
    quantity: number;
    unallocatedQuantity: number;
  }[]
> {
  const orderItem = await prisma.orderItem.findUnique({
    where: { id: orderItemId },
    select: { productId: true },
  });

  if (!orderItem) throw new NotFoundError("Order line");

  const candidates = await prisma.purchaseItem.findMany({
    where: {
      productId: orderItem.productId,
      purchase: { status: "RECEIVED" },
    },
    orderBy: [{ purchase: { purchaseDate: "asc" } }, { id: "asc" }],
    select: {
      id: true,
      quantity: true,
      purchase: {
        select: {
          id: true,
          purchaseNumber: true,
          status: true,
          purchaseDate: true,
          supplier: { select: { name: true } },
        },
      },
      supplyLinks: { select: { quantity: true } },
    },
  });

  return candidates
    .map((candidate) => {
      const allocated = candidate.supplyLinks.reduce(
        (sum, link) => sum + link.quantity,
        0,
      );

      return {
        purchaseItemId: candidate.id,
        purchaseId: candidate.purchase.id,
        purchaseNumber: candidate.purchase.purchaseNumber,
        purchaseStatus: candidate.purchase.status,
        supplierName: candidate.purchase.supplier.name,
        purchaseDate: candidate.purchase.purchaseDate,
        quantity: candidate.quantity,
        unallocatedQuantity: candidate.quantity - allocated,
      };
    })
    .filter((candidate) => candidate.unallocatedQuantity > 0);
}
