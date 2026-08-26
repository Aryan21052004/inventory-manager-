import "server-only";

import type { Prisma, StockTransaction } from "@/generated/prisma/client";
import type { StockTransactionType } from "@/generated/prisma/enums";
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

    return applyStockMovement(tx, {
      product,
      type: movement.type,
      delta,
      reference: movement.reference,
      note: movement.note,
      // The whole point: from the session, not from the caller.
      userId: user.id,
    });
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
  params: { productId: string; quantity: number; userId: string },
): Promise<void> {
  if (params.quantity <= 0) return;

  await tx.stockTransaction.create({
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
}
