import "server-only";

import type { Prisma, StockTransaction } from "@/generated/prisma/client";
import type {
  LotCostSource,
  StockTransactionType,
} from "@/generated/prisma/enums";
import { AppError, InsufficientStockError, NotFoundError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import {
  stockDelta,
  stockMovementSchema,
  type StockMovementInput,
  type StockReference,
} from "@/lib/validation/stock";
import { requireRole, requireUser } from "@/server/auth";

/**
 * The one way stock is allowed to change.
 *
 * Two things are enforced here rather than left to callers:
 *
 *   Attribution. `createdBy` is the signed-in user's *database* id, resolved
 *   from their Clerk session by `requireUser`. It is not an argument, so no
 *   caller — server action, route handler, or anything the browser can reach —
 *   is able to attribute a movement to somebody else.
 *
 *   Consistency. The product row is locked, the balance is read, and the
 *   quantity and the ledger row are written together in one transaction. A
 *   product's stock and the ledger explaining it cannot end up disagreeing,
 *   because there is no moment when one exists without the other.
 */

/**
 * Corrections are ADMIN-only. STOCK_IN and STOCK_OUT record something that
 * happened — goods arrived, an order shipped — and any member of staff doing
 * the work can record it. ADJUSTMENT and REVERSAL overwrite what the system
 * believes without a document behind it, which is exactly the operation
 * someone would reach for to hide a discrepancy.
 */
const ADMIN_ONLY_TYPES: ReadonlySet<StockTransactionType> = new Set([
  "ADJUSTMENT",
  "REVERSAL",
]);

export interface RecordedMovement {
  transaction: StockTransaction;
  previousStock: number;
  newStock: number;
}

export interface LockedProduct {
  id: string;
  name: string;
  stockQuantity: number;
}

/**
 * Takes a row lock on one product and reads its balance.
 *
 * `FOR UPDATE`, because read-then-write is a race otherwise: two concurrent
 * movements on one product would both read the same balance and the second
 * would write a `previousStock` that was already stale, breaking the chain the
 * ledger depends on. Locking makes them queue.
 *
 * One product per call, deliberately. Callers that need several — an order
 * with several lines — lock them one at a time **in a consistent order** (see
 * `lockProducts`), which is what stops two orders holding half of each other's
 * rows and deadlocking. A single `WHERE id = ANY(...) FOR UPDATE` would be one
 * round trip instead of several, but the order in which it takes the locks is a
 * property of the query plan rather than something the caller controls.
 */
export async function lockProduct(
  tx: Prisma.TransactionClient,
  productId: string,
): Promise<LockedProduct> {
  const rows = await tx.$queryRaw<
    { id: string; name: string; stock_quantity: number }[]
  >`
    SELECT id, name, stock_quantity
    FROM products
    WHERE id = ${productId}
    FOR UPDATE
  `;

  const product = rows[0];
  if (!product) throw new NotFoundError("Product");

  return {
    id: product.id,
    name: product.name,
    stockQuantity: product.stock_quantity,
  };
}

/**
 * Locks several products, in a fixed order.
 *
 * The order is what matters. Two orders touching products A and B, one locking
 * A then B and the other B then A, will deadlock the moment they overlap:
 * each holds what the other needs next. Sorting the ids first means every
 * transaction in the system reaches for the same rows in the same sequence, so
 * one simply waits for the other instead.
 *
 * Sorted by id rather than by anything meaningful, because the only requirement
 * is that the sequence is total and identical everywhere.
 */
export async function lockProducts(
  tx: Prisma.TransactionClient,
  productIds: readonly string[],
): Promise<Map<string, LockedProduct>> {
  const ordered = [...new Set(productIds)].sort();
  const locked = new Map<string, LockedProduct>();

  for (const productId of ordered) {
    locked.set(productId, await lockProduct(tx, productId));
  }

  return locked;
}

export interface StockWrite {
  product: LockedProduct;
  type: StockTransactionType;
  /** Signed. Negative takes stock away. */
  delta: number;
  reference: StockReference;
  note?: string | undefined;
  /** The local user id, always resolved from the session by the caller. */
  userId: string | null;
}

/**
 * Writes one movement: the ledger row and the new balance, together.
 *
 * Takes a transaction client rather than opening its own, so a caller that has
 * to move several products at once — confirming an order — can do all of it
 * inside a single transaction. That is the whole reason this is separate from
 * `recordStockMovement`: either every line of an order is deducted or none is,
 * and that is only true if one transaction spans them.
 *
 * The product must already be locked. This function does not lock, because the
 * caller has to take all its locks in a consistent order before writing any of
 * them; locking here would put the locks in whatever order the writes happened
 * to run.
 */
export async function applyStockMovement(
  tx: Prisma.TransactionClient,
  write: StockWrite,
): Promise<RecordedMovement> {
  const previousStock = write.product.stockQuantity;
  const newStock = previousStock + write.delta;

  if (newStock < 0) {
    throw new InsufficientStockError(
      write.product.name,
      Math.abs(write.delta),
      previousStock,
    );
  }

  const transaction = await tx.stockTransaction.create({
    data: {
      productId: write.product.id,
      type: write.type,
      // The column stores the size of the move; `type` carries the direction.
      quantity: Math.abs(write.delta),
      previousStock,
      newStock,
      referenceType: write.reference.type,
      referenceId:
        write.reference.type === "MANUAL" ? null : write.reference.id,
      note: write.note ?? null,
      createdBy: write.userId,
    },
  });

  await tx.product.update({
    where: { id: write.product.id },
    data: { stockQuantity: newStock },
  });

  return { transaction, previousStock, newStock };
}

export async function recordStockMovement(
  input: StockMovementInput,
  /**
   * What the incoming units cost, in cents, for a movement that adds stock.
   *
   * Optional, and ignored for outbound movements — those are costed from the
   * lots they draw against, not from anything a caller supplies. Omitting it on
   * an inbound movement creates an UNKNOWN lot: an operator counting extra
   * units onto a shelf usually cannot say what they cost, and recording that
   * honestly is better than attaching a number nobody can source.
   */
  unitCostCents?: number | null,
): Promise<RecordedMovement> {
  const parsed = stockMovementSchema.safeParse(input);

  if (!parsed.success) {
    throw new AppError("BAD_REQUEST", parsed.error.issues[0]!.message);
  }

  const movement = parsed.data;

  // Authorisation before anything else, and always against the role in our
  // database — never against anything supplied with the request.
  const user = ADMIN_ONLY_TYPES.has(movement.type)
    ? await requireRole("ADMIN")
    : await requireUser();

  const delta = stockDelta(movement);

  return prisma.$transaction(async (tx) => {
    const product = await lockProduct(tx, movement.productId);

    const recorded = await applyStockMovement(tx, {
      product,
      type: movement.type,
      delta,
      reference: movement.reference,
      note: movement.note,
      // The whole point: from the session, not from the caller.
      userId: user.id,
    });

    /*
     * Direction decides. Stock coming in becomes a lot; stock going out is
     * drawn from the lots already there, oldest first. A manual movement has no
     * document to consult, so there is nothing more subtle to do — and doing
     * nothing at all would break the invariant that a product's lots sum to its
     * quantity the moment anybody adjusted a count.
     */
    if (delta > 0) {
      const costed = unitCostCents !== null && unitCostCents !== undefined;

      await createLot(tx, {
        productId: product.id,
        stockTransactionId: recorded.transaction.id,
        quantity: delta,
        unitCostCents: costed ? unitCostCents! : null,
        costSource: costed ? "ADJUSTMENT" : "UNKNOWN",
        reference: movement.reference,
        receivedAt: recorded.transaction.createdAt,
        userId: user.id,
      });
    } else {
      await allocateFifo(tx, {
        productId: product.id,
        quantity: Math.abs(delta),
        stockTransactionId: recorded.transaction.id,
      });
    }

    return recorded;
  });
}

/**
 * The opening balance of a product that has just been created.
 *
 * This is the one stock write that does not lock the product row, and it is
 * safe for exactly one reason: the row was created earlier in `tx` and has not
 * been committed, so no other transaction can see it, let alone move stock
 * against it. There is no read-modify-write to protect — the previous balance
 * is zero by construction, because the row did not exist a moment ago.
 *
 * It exists so that a product created with stock on hand still gets a ledger
 * row explaining that stock, in the same transaction as the product itself.
 * A catalogue item whose quantity has no movement behind it is the one hole
 * the audit trail must not have.
 *
 * Do not reach for this anywhere else. For a product that already exists, the
 * balance has to be read under a lock, which is what `recordStockMovement`
 * does.
 */
export async function recordOpeningStock(
  tx: Prisma.TransactionClient,
  params: {
    productId: string;
    quantity: number;
    userId: string;
    /**
     * What the opening stock actually cost, in cents, if anybody knows.
     *
     * Optional and genuinely so. This is stock that arrived before the system
     * was watching, and the honest answer is often that nobody can say what it
     * cost. Leaving it out creates an UNKNOWN lot, which reports as uncosted
     * for as long as those units survive.
     *
     * It is emphatically *not* defaulted from `Product.standardCost`. That
     * field is a planning figure someone typed; using it here would turn a
     * guess into a recorded acquisition cost, and once written the two are
     * indistinguishable.
     */
    unitCostCents?: number | null;
  },
): Promise<void> {
  if (params.quantity <= 0) return;

  const transaction = await tx.stockTransaction.create({
    data: {
      productId: params.productId,
      type: "STOCK_IN",
      quantity: params.quantity,
      previousStock: 0,
      newStock: params.quantity,
      referenceType: "MANUAL",
      referenceId: null,
      note: "Opening stock recorded when the product was created",
      createdBy: params.userId,
    },
  });

  await tx.product.update({
    where: { id: params.productId },
    data: { stockQuantity: params.quantity },
  });

  const costed =
    params.unitCostCents !== null && params.unitCostCents !== undefined;

  await createLot(tx, {
    productId: params.productId,
    stockTransactionId: transaction.id,
    quantity: params.quantity,
    unitCostCents: costed ? params.unitCostCents! : null,
    costSource: costed ? "OPENING" : "UNKNOWN",
    reference: { type: "MANUAL" },
    receivedAt: transaction.createdAt,
    userId: params.userId,
  });
}

// ---------------------------------------------------------------------------
// Valuation: lots and what they cost
// ---------------------------------------------------------------------------

/**
 * The costing layer, and the line it does not cross.
 *
 * Everything below writes `StockLot` and `StockLotConsumption` rows. None of it
 * decides whether stock may move. That judgement belongs to
 * `applyStockMovement` above — which is unchanged, still the only writer of
 * quantities, and still the only thing that can refuse a movement. Costing runs
 * *after* the ledger has already accepted the move, and its failure modes are
 * "we do not know what this cost", never "this may not happen".
 *
 * That separation is the whole reason an order for 15 units confirms against 10
 * costed and 5 uncosted: quantity is available, so the sale proceeds, and the
 * cost simply comes back partial.
 */

/** Money in, money out: the ledger stores Decimal, the engine thinks in cents. */
function centsToDecimal(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const absolute = Math.abs(cents);
  return `${sign}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, "0")}`;
}

export interface LotSpec {
  productId: string;
  /** The STOCK_IN that brought these units in. One lot per movement. */
  stockTransactionId: string;
  quantity: number;
  /** Null when the cost is genuinely unknown. Never a guess. */
  unitCostCents: number | null;
  costSource: LotCostSource;
  reference: StockReference;
  /** When the goods arrived — the FIFO sort key, not necessarily now. */
  receivedAt: Date;
  userId: string | null;
}

/**
 * Records what a batch of arriving stock cost.
 *
 * One lot per receipt line, always. Never merged with an existing lot even when
 * the product and unit cost match exactly: two deliveries are two batches with
 * two sets of paperwork, and an aviation parts business needs to be able to say
 * which certificate covers which units. See the note on `Certificate` in the
 * schema.
 */
export async function createLot(
  tx: Prisma.TransactionClient,
  spec: LotSpec,
): Promise<{ id: string }> {
  if (spec.quantity <= 0) {
    throw new AppError(
      "INTERNAL",
      "A stock lot must record at least one unit received.",
    );
  }

  return tx.stockLot.create({
    data: {
      productId: spec.productId,
      stockTransactionId: spec.stockTransactionId,
      quantityReceived: spec.quantity,
      // Nothing has been drawn from it yet.
      quantityRemaining: spec.quantity,
      unitCost:
        spec.unitCostCents === null ? null : centsToDecimal(spec.unitCostCents),
      costSource: spec.costSource,
      sourceType: spec.reference.type,
      sourceId:
        spec.reference.type === "MANUAL" ? null : spec.reference.id,
      receivedAt: spec.receivedAt,
      createdBy: spec.userId,
    },
    select: { id: true },
  });
}

export interface Allocation {
  lotId: string;
  quantity: number;
  unitCostCents: number | null;
}

export interface AllocationResult {
  /** How many units were drawn from lots whose cost is known. */
  costedQuantity: number;
  /** What those units cost, in cents. Zero when nothing was costed. */
  costTotalCents: number;
  /** Units drawn from lots with no known cost. */
  uncostedQuantity: number;
  allocations: Allocation[];
}

/**
 * Draws `quantity` units from a product's lots, oldest first, and records what
 * they cost.
 *
 * FIFO by receipt date, with the lot id breaking ties so the order is total —
 * two lots booked in the same millisecond must still be consumed in a
 * deterministic sequence, or two concurrent orders could disagree about which
 * came first.
 *
 * The allocation order is **never** adjusted to prefer lots that happen to have
 * a known cost. Chasing a cost figure would break both FIFO and the
 * correspondence between a lot and the paperwork covering it. If the oldest
 * units are uncosted then an uncosted draw is the truthful answer, and it
 * travels back to the caller as `uncostedQuantity` rather than being smoothed
 * away.
 *
 * The product row must already be locked by the caller. That lock is what makes
 * the `FOR UPDATE` below sufficient: every route to a product's lots passes
 * through its product row first, so no second transaction can be part-way
 * through this loop on the same product, and no new lock ordering is
 * introduced.
 */
export async function allocateFifo(
  tx: Prisma.TransactionClient,
  params: {
    productId: string;
    quantity: number;
    /** The STOCK_OUT these units left on. */
    stockTransactionId: string;
  },
): Promise<AllocationResult> {
  const lots = await tx.$queryRaw<
    { id: string; quantity_remaining: number; unit_cost: string | null }[]
  >`
    SELECT id, quantity_remaining, unit_cost::text AS unit_cost
    FROM stock_lots
    WHERE product_id = ${params.productId}
      AND quantity_remaining > 0
    ORDER BY received_at ASC, id ASC
    FOR UPDATE
  `;

  const allocations: Allocation[] = [];
  let outstanding = params.quantity;

  for (const lot of lots) {
    if (outstanding <= 0) break;

    const take = Math.min(outstanding, lot.quantity_remaining);
    if (take <= 0) continue;

    const unitCostCents =
      lot.unit_cost === null ? null : Math.round(Number(lot.unit_cost) * 100);

    await tx.stockLot.update({
      where: { id: lot.id },
      data: { quantityRemaining: { decrement: take } },
    });

    await tx.stockLotConsumption.create({
      data: {
        lotId: lot.id,
        stockTransactionId: params.stockTransactionId,
        // Positive: units leaving the lot.
        quantity: take,
        unitCost: unitCostCents === null ? null : centsToDecimal(unitCostCents),
        totalCost:
          unitCostCents === null ? null : centsToDecimal(unitCostCents * take),
      },
    });

    allocations.push({ lotId: lot.id, quantity: take, unitCostCents });
    outstanding -= take;
  }

  /*
   * Lots that do not cover the movement mean the invariant
   * SUM(quantityRemaining) = stockQuantity has already been broken somewhere
   * upstream — the ledger let a movement through that the valuation layer
   * cannot account for. That is a bug in this system, not something the
   * operator did wrong, so it fails loudly rather than silently costing part
   * of a sale and calling it complete.
   */
  if (outstanding > 0) {
    throw new AppError(
      "INTERNAL",
      "Stock lots do not cover this movement. The valuation layer is out of step with the stock ledger.",
    );
  }

  let costedQuantity = 0;
  let costTotalCents = 0;
  let uncostedQuantity = 0;

  for (const allocation of allocations) {
    if (allocation.unitCostCents === null) {
      uncostedQuantity += allocation.quantity;
    } else {
      costedQuantity += allocation.quantity;
      costTotalCents += allocation.unitCostCents * allocation.quantity;
    }
  }

  return { costedQuantity, costTotalCents, uncostedQuantity, allocations };
}

/**
 * Puts units back where they came from.
 *
 * Reads the draws made against a set of movements — an order's STOCK_OUT rows,
 * a purchase's STOCK_IN — nets them (so an already-reversed portion is not
 * returned twice), and writes the negative consumption rows that restore the
 * balance.
 *
 * Units return to **their original lot at their original cost**, never into a
 * new lot at today's price. That is what keeps a cancellation from quietly
 * revaluing stock: cancel an order placed when the part cost ₹8,000 and the
 * units go back to the ₹8,000 batch, even if the most recent delivery was
 * ₹9,500.
 *
 * The netting mirrors what `cancelOrder` already does at the ledger level, for
 * the same reason: a partially reversed document must not be over-restored.
 */
export async function returnToLots(
  tx: Prisma.TransactionClient,
  params: {
    /** The movements whose draws are being undone. */
    sourceTransactionIds: readonly string[];
    /** The REVERSAL now putting the units back. */
    reversalTransactionId: string;
    /** The product being reversed. Required: the shortfall lot needs it. */
    productId: string;
    /**
     * How many units the REVERSAL actually restored.
     *
     * The reconciling number. Whatever the consumption rows cannot account
     * for becomes an uncosted lot rather than vanishing — see the note about
     * shortfall below.
     */
    expectedQuantity: number;
    /** Attribution for any lot this has to create. */
    userId: string | null;
  },
): Promise<{ returned: number; uncosted: number }> {
  if (params.sourceTransactionIds.length === 0) {
    return { returned: 0, uncosted: 0 };
  }

  const rows = await tx.stockLotConsumption.findMany({
    where: {
      stockTransactionId: { in: [...params.sourceTransactionIds] },
      ...(params.productId ? { lot: { productId: params.productId } } : {}),
    },
    select: { lotId: true, quantity: true, unitCost: true },
  });

  // Net per lot: draws minus anything already handed back.
  const outstanding = new Map<string, number>();
  const rates = new Map<string, string | null>();

  for (const row of rows) {
    outstanding.set(
      row.lotId,
      (outstanding.get(row.lotId) ?? 0) + row.quantity,
    );
    if (!rates.has(row.lotId)) {
      rates.set(row.lotId, row.unitCost === null ? null : row.unitCost.toString());
    }
  }

  let returned = 0;

  // Sorted, so a reversal touching several lots takes them in a fixed order.
  for (const lotId of [...outstanding.keys()].sort()) {
    const quantity = outstanding.get(lotId)!;
    if (quantity <= 0) continue;

    const rate = rates.get(lotId) ?? null;
    const unitCostCents = rate === null ? null : Math.round(Number(rate) * 100);

    await tx.stockLot.update({
      where: { id: lotId },
      data: { quantityRemaining: { increment: quantity } },
    });

    await tx.stockLotConsumption.create({
      data: {
        lotId,
        stockTransactionId: params.reversalTransactionId,
        // Negative: units coming back into the lot.
        quantity: -quantity,
        unitCost: unitCostCents === null ? null : centsToDecimal(unitCostCents),
        totalCost:
          unitCostCents === null
            ? null
            : centsToDecimal(-unitCostCents * quantity),
      },
    });

    returned += quantity;
  }

  /*
   * Whatever the consumption rows could not account for.
   *
   * Stock that left before this system existed has no consumption rows to
   * return it to — the backfill deliberately did not cost historical orders,
   * because FIFO was not the policy when they happened. Cancelling such an
   * order still legitimately puts units back on the shelf: `stockQuantity`
   * rises and the ledger records a REVERSAL. Without this, those units would
   * exist in the ledger and in no lot at all, and
   * `SUM(quantityRemaining) = stockQuantity` — the invariant the whole
   * valuation layer rests on — would quietly stop being true.
   *
   * They come back as an UNKNOWN lot, which is the honest description: the
   * units are real, and nobody can say what they cost. Dated to when they
   * originally left, so FIFO puts them back roughly where they were rather
   * than treating decade-old stock as the newest thing on the shelf — and so
   * they drain early, which is what should happen to uncosted stock.
   */
  const shortfall = params.expectedQuantity - returned;

  if (shortfall > 0) {
    const origin = await tx.stockTransaction.findFirst({
      where: {
        id: { in: [...params.sourceTransactionIds] },
        productId: params.productId,
      },
      orderBy: { createdAt: "asc" },
      select: { createdAt: true },
    });

    await tx.stockLot.create({
      data: {
        productId: params.productId,
        // The REVERSAL that brought them back is what explains this lot.
        stockTransactionId: params.reversalTransactionId,
        quantityReceived: shortfall,
        quantityRemaining: shortfall,
        unitCost: null,
        costSource: "UNKNOWN",
        sourceType: "MANUAL",
        sourceId: null,
        receivedAt: origin?.createdAt ?? new Date(),
        createdBy: params.userId,
      },
    });
  }

  return { returned, uncosted: Math.max(0, shortfall) };
}

/**
 * Empties the lots a purchase created, when that purchase is cancelled.
 *
 * Distinct from `returnToLots` because it moves the other way: a cancelled
 * delivery takes stock *off* the shelf, so its lots are drawn down to zero
 * rather than topped back up.
 *
 * The lot rows are never deleted. Zeroing them through a consumption row keeps
 * the provenance readable — the batch existed, arrived at a price, and was sent
 * back — and keeps the append-only shape the ledger has. Deleting would erase
 * the fact that it ever happened.
 *
 * Callers must have already established that every lot is intact; see
 * `assertPurchaseLotsIntact`.
 */
export async function drainPurchaseLots(
  tx: Prisma.TransactionClient,
  params: {
    purchaseId: string;
    reversalTransactionId: string;
    productId: string;
  },
): Promise<void> {
  const lots = await tx.stockLot.findMany({
    where: {
      sourceType: "PURCHASE",
      sourceId: params.purchaseId,
      productId: params.productId,
      quantityRemaining: { gt: 0 },
    },
    select: { id: true, quantityRemaining: true, unitCost: true },
    orderBy: { id: "asc" },
  });

  for (const lot of lots) {
    const unitCostCents =
      lot.unitCost === null ? null : Math.round(Number(lot.unitCost) * 100);

    await tx.stockLot.update({
      where: { id: lot.id },
      data: { quantityRemaining: 0 },
    });

    await tx.stockLotConsumption.create({
      data: {
        lotId: lot.id,
        stockTransactionId: params.reversalTransactionId,
        quantity: lot.quantityRemaining,
        unitCost: unitCostCents === null ? null : centsToDecimal(unitCostCents),
        totalCost:
          unitCostCents === null
            ? null
            : centsToDecimal(unitCostCents * lot.quantityRemaining),
      },
    });
  }
}
