import "server-only";

import type { Prisma, StockTransaction } from "@/generated/prisma/client";
import type { StockTransactionType } from "@/generated/prisma/enums";
import { AppError, InsufficientStockError, NotFoundError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import {
  stockDelta,
  stockMovementSchema,
  type StockMovementInput,
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
    /*
     * FOR UPDATE, because read-then-write is a race otherwise: two concurrent
     * movements on one product would both read the same balance and the second
     * would write a `previousStock` that was already stale, breaking the chain
     * the ledger depends on. Locking the row makes them queue.
     */
    const locked = await tx.$queryRaw<
      { id: string; name: string; stock_quantity: number }[]
    >`
      SELECT id, name, stock_quantity
      FROM products
      WHERE id = ${movement.productId}
      FOR UPDATE
    `;

    const product = locked[0];
    if (!product) throw new NotFoundError("Product");

    const previousStock = product.stock_quantity;
    const newStock = previousStock + delta;

    if (newStock < 0) {
      throw new InsufficientStockError(
        product.name,
        Math.abs(delta),
        previousStock,
      );
    }

    const transaction = await tx.stockTransaction.create({
      data: {
        productId: product.id,
        type: movement.type,
        // The column stores the size of the move; `type` carries the direction.
        quantity: Math.abs(delta),
        previousStock,
        newStock,
        referenceType: movement.reference.type,
        referenceId:
          movement.reference.type === "MANUAL" ? null : movement.reference.id,
        note: movement.note ?? null,
        // The whole point: from the session, not from the caller.
        createdBy: user.id,
      },
    });

    await tx.product.update({
      where: { id: product.id },
      data: { stockQuantity: newStock },
    });

    return { transaction, previousStock, newStock };
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
