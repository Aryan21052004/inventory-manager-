import "server-only";

import type { Prisma } from "@/generated/prisma/client";
import type { LotStatus } from "@/generated/prisma/enums";
import type { Currency } from "@/lib/currency";
import { AppError, NotFoundError } from "@/lib/errors";
import {
  LOT_STATUS_LABELS,
  QUARANTINED_LOT_STATUS,
  REJECTED_LOT_STATUS,
  SALEABLE_LOT_STATUS,
  lotTransitionRefusal,
  type LotInspectionOutcome,
} from "@/lib/lot-status";
import { prisma } from "@/lib/prisma";
import {
  lotInspectionSchema,
  lotWriteOffSchema,
  toLotActionFieldErrors,
  type LotActionFieldErrors,
} from "@/lib/validation/lot-action";
import { requireRole } from "@/server/auth";
import { applyStockMovement, drainLot, lockProduct } from "@/server/stock";

/**
 * What happens to a returned batch after somebody looks at it.
 *
 * Three decisions, in a strict order. A batch arrives quarantined; an
 * inspection either releases it to sale or condemns it; a condemned batch is
 * then destroyed against itself. Nothing here is reversible, and that is the
 * design — each action is the record of a judgement, and a record that can be
 * flipped back is not one.
 *
 * **Only returned batches.** Every function refuses a lot whose `sourceType` is
 * anything but SALES_RETURN. Purchase, opening and adjustment stock has never
 * been through a customer's hands, and a quality-control workflow for it is a
 * different feature with different rules — not something to fall into by
 * pointing these at another lot.
 *
 * Provenance is deliberately *not* read from `costSource`; see `loadReturnLot`
 * for why. A return of an uncosted shipment is an UNKNOWN-cost batch and is
 * still a return.
 *
 * **ADMIN throughout.** Releasing decides that stock may be sold; rejecting and
 * writing off destroy value. The existing policy reserves ADMIN for exactly
 * this — actions with no document compelling them — and the check is here at
 * the server boundary rather than in the screens that offer the buttons.
 *
 * Two things are deliberately *not* symmetrical, and both are worth stating:
 *
 *   Release and rejection move no stock at all. The units are already on the
 *   shelf and already inside `Product.stockQuantity`; what changes is whether
 *   FIFO may reach them. So neither writes a ledger row, and I-1 is untouched
 *   by construction.
 *
 *   A write-off does move stock, and it does so against one named batch rather
 *   than through FIFO — see `drainLot`.
 */

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface LotInspectionOutcomeResult {
  lotId: string;
  productId: string;
  productName: string;
  status: LotStatus;
  /** True when the batch was already in the target state and nothing changed. */
  alreadyInState: boolean;
}

export interface LotWriteOffOutcome {
  lotId: string;
  productId: string;
  productName: string;
  quantity: number;
  quantityRemaining: number;
  /** What the destroyed units cost, or null when the batch was uncosted. */
  writtenOffValue: string | null;
  previousStock: number;
  newStock: number;
  transactionId: string;
}

/** The lot fields every Phase 3 action needs before it may act. */
interface EligibleLot {
  id: string;
  productId: string;
  status: LotStatus;
  quantityRemaining: number;
}

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

/**
 * Loads a batch and refuses anything these actions have no business touching.
 *
 * The provenance check is the one that matters. Nothing structural stops a
 * purchase batch being marked rejected — the status column does not know where
 * a lot came from — so this is what confines inspection to returned stock. It
 * runs before the status check so a mis-aimed action says *why* it was refused
 * rather than complaining about the wrong thing.
 *
 * **Provenance is read from `sourceType`, not from `costSource`**, and the
 * distinction is not pedantic. A return of an uncosted shipment produces a lot
 * whose cost source is UNKNOWN rather than RETURN — unknown in, unknown out —
 * so testing the cost source would quietly exclude exactly those batches,
 * leaving them quarantined for ever with no way to release or destroy them.
 * `sourceType = SALES_RETURN` is what the sales-return workflow actually
 * stamps, and the check constraint `stock_lots_return_provenance` guarantees it
 * travels with the order line, so it identifies a returned batch whether or not
 * anybody could price it.
 */
async function loadReturnLot(
  tx: Prisma.TransactionClient,
  lotId: string,
): Promise<EligibleLot> {
  const lot = await tx.stockLot.findUnique({
    where: { id: lotId },
    select: {
      id: true,
      productId: true,
      status: true,
      sourceType: true,
      quantityRemaining: true,
    },
  });

  if (!lot) throw new NotFoundError("Stock lot");

  if (lot.sourceType !== "SALES_RETURN") {
    throw new AppError(
      "CONFLICT",
      "Only batches created by a customer return can be inspected, released, rejected or written off here. This batch arrived another way, and stock that has never left the building is corrected with a stock adjustment instead.",
    );
  }

  return {
    id: lot.id,
    productId: lot.productId,
    status: lot.status,
    quantityRemaining: lot.quantityRemaining,
  };
}

function parseOrThrow<T>(
  result: { success: true; data: T } | { success: false; error: Parameters<typeof toLotActionFieldErrors>[0] },
): T {
  if (result.success) return result.data;

  const errors = toLotActionFieldErrors(result.error);
  const field = (Object.keys(errors)[0] ?? "form") as keyof LotActionFieldErrors;

  throw new AppError("BAD_REQUEST", errors[field] ?? "Check the details.", {
    field,
  });
}

// ---------------------------------------------------------------------------
// Inspection: release and rejection
// ---------------------------------------------------------------------------

/**
 * Records an inspection's conclusion about a quarantined batch.
 *
 * Shared by both outcomes because they differ in exactly one value. Everything
 * else — who may do it, what is checked, what is written, how it serialises —
 * is identical, and writing it twice would be two places for the rules to drift.
 *
 * **No stock moves.** No ledger row, no consumption, no change to any quantity.
 * The units were already counted before the inspection and are still counted
 * after it; all that changed is whether a sale may reach them.
 *
 * The product row is locked even though no product column is written. That is
 * what serialises two admins deciding the same batch at once: every path that
 * touches a product's lots takes that lock first, and joining the same queue is
 * what makes the status re-read below trustworthy.
 */
async function inspectLot(
  input: unknown,
  outcome: LotInspectionOutcome,
): Promise<LotInspectionOutcomeResult> {
  const user = await requireRole("ADMIN");
  const request = parseOrThrow(lotInspectionSchema.safeParse(input));

  return prisma.$transaction(async (tx) => {
    const preliminary = await loadReturnLot(tx, request.lotId);
    const product = await lockProduct(tx, preliminary.productId);

    // Re-read under the lock. The status may have changed between the load
    // above and the lock being granted, and it is the value at *this* moment
    // the transition has to be legal from.
    const lot = await loadReturnLot(tx, request.lotId);

    if (lot.status === outcome) {
      /*
       * Already settled. Reported rather than raised, the same courtesy
       * `cancelOrder` extends to an already-cancelled order — and emphatically
       * without rewriting the audit fields, or the second admin to click would
       * be recorded as the inspector.
       */
      return {
        lotId: lot.id,
        productId: product.id,
        productName: product.name,
        status: lot.status,
        alreadyInState: true,
      };
    }

    const refusal = lotTransitionRefusal(lot.status, outcome);
    if (refusal) throw new AppError("CONFLICT", refusal);

    await tx.stockLot.update({
      where: { id: lot.id },
      data: {
        status: outcome,
        statusChangedBy: user.id,
        statusChangedAt: new Date(),
        statusNote: request.reason,
      },
    });

    return {
      lotId: lot.id,
      productId: product.id,
      productName: product.name,
      status: outcome,
      alreadyInState: false,
    };
  });
}

/**
 * Releases a quarantined batch to sale.
 *
 * Says one thing: these units passed inspection. It says nothing about
 * paperwork — no certificate is created, copied, or inherited from the batch
 * these units originally shipped on, and a released batch may sit saleable
 * reading MISSING. That is honest, and it is the state the certificate register
 * exists to surface. Attaching a document is a separate, deliberate act.
 */
export function releaseLot(input: unknown): Promise<LotInspectionOutcomeResult> {
  return inspectLot(input, SALEABLE_LOT_STATUS);
}

/**
 * Condemns a quarantined batch.
 *
 * The units stay exactly where they are, still counted and still carrying their
 * cost. Rejecting is a judgement, not a disposal: value leaves inventory when
 * the units do, which is `writeOffLot` and a separate decision.
 */
export function rejectLot(input: unknown): Promise<LotInspectionOutcomeResult> {
  return inspectLot(input, REJECTED_LOT_STATUS);
}

// ---------------------------------------------------------------------------
// Write-off
// ---------------------------------------------------------------------------

/**
 * Destroys units of a rejected batch, taking them from that batch and no other.
 *
 * **Why this does not go through `recordStockMovement`.** That function is the
 * general manual-movement entry point, and its outbound path does two things
 * this operation must not do: it refuses a draw larger than *saleable* stock,
 * and it allocates through FIFO. A rejected batch has a saleable quantity of
 * zero and is invisible to FIFO by design, so routing a disposal through it
 * would either be refused outright or — worse — satisfied from the saleable
 * batches sitting beside it, destroying good stock's cost basis while the
 * condemned units stayed on the books.
 *
 * So this composes the lower-level pieces directly, exactly as the order and
 * purchase modules do: `applyStockMovement` for the ledger and the balance,
 * `drainLot` for the one named batch.
 *
 * **The bypass is narrow on purpose.** This is not a general way to decrease
 * stock outside FIFO. It refuses any batch that is not a customer return, any
 * batch that is not rejected, and any quantity beyond what that batch holds —
 * all under the product lock, before anything is written. Widening any of those
 * three would turn a targeted disposal into an escape hatch, and the guards
 * exist to make that a deliberate act rather than an accident.
 *
 * Partial disposal is ordinary. Ten received, four destroyed, six left: the
 * batch keeps `quantityReceived = 10`, because ten did arrive, and stays
 * REJECTED, because the remaining six are still condemned. The four are
 * accounted for by the consumption row and the ledger entry.
 */
export async function writeOffLot(input: unknown): Promise<LotWriteOffOutcome> {
  const user = await requireRole("ADMIN");
  const request = parseOrThrow(lotWriteOffSchema.safeParse(input));

  return prisma.$transaction(async (tx) => {
    const preliminary = await loadReturnLot(tx, request.lotId);

    /*
     * The product first, then the batch re-read under it. Nothing else may be
     * changing this product's lots or balance while the checks below decide
     * whether the disposal is legal, which is what makes two concurrent
     * write-offs of the same batch serialise instead of both succeeding.
     */
    const product = await lockProduct(tx, preliminary.productId);
    const lot = await loadReturnLot(tx, request.lotId);

    if (lot.status !== REJECTED_LOT_STATUS) {
      throw new AppError(
        "CONFLICT",
        lot.status === QUARANTINED_LOT_STATUS
          ? "This batch is still awaiting inspection. Reject it first — a write-off records the disposal of stock somebody has already condemned."
          : `Only a rejected batch can be written off here, and this one is ${LOT_STATUS_LABELS[lot.status].toLowerCase()}. Saleable stock is removed with a stock adjustment.`,
      );
    }

    if (lot.quantityRemaining <= 0) {
      throw new AppError(
        "CONFLICT",
        "This batch has already been written off in full.",
      );
    }

    if (request.quantity > lot.quantityRemaining) {
      throw new AppError(
        "BAD_REQUEST",
        `This batch has ${lot.quantityRemaining} ${lot.quantityRemaining === 1 ? "unit" : "units"} left, so ${request.quantity} cannot be written off.`,
      );
    }

    /*
     * The ledger first, then the valuation layer — the order every other
     * movement in this system uses. ADJUSTMENT with no reference: a disposal is
     * not caused by an order, a purchase or a return, and inventing a reference
     * type for it would add an enum value that says nothing the note does not.
     * The batch is identified by the consumption row `drainLot` writes.
     */
    const { transaction, previousStock, newStock } = await applyStockMovement(
      tx,
      {
        product,
        type: "ADJUSTMENT",
        delta: -request.quantity,
        reference: { type: "MANUAL" },
        note: `Rejected stock written off — ${request.reason}`,
        userId: user.id,
      },
    );

    const { unitCostCents } = await drainLot(tx, {
      lotId: lot.id,
      stockTransactionId: transaction.id,
      quantity: request.quantity,
    });

    return {
      lotId: lot.id,
      productId: product.id,
      productName: product.name,
      quantity: request.quantity,
      quantityRemaining: lot.quantityRemaining - request.quantity,
      /*
       * What the destroyed units cost, or null when the batch never had a
       * known cost. Null stays null: an uncosted batch does not acquire a value
       * by being destroyed, and reporting one here would be inventing the
       * figure the whole costing layer refuses to invent.
       */
      writtenOffValue:
        unitCostCents === null
          ? null
          : ((unitCostCents * request.quantity) / 100).toFixed(2),
      previousStock,
      newStock,
      transactionId: transaction.id,
    };
  });
}

// ---------------------------------------------------------------------------
// The quarantine queue
// ---------------------------------------------------------------------------

export interface QuarantinedLotRow {
  lotId: string;
  productId: string;
  productName: string;
  sku: string;
  quantityRemaining: number;
  unitCost: string | null;
  /** What that cost is in, from the batch’s own row. Null when the cost is. */
  costCurrency: Currency | null;
  receivedAt: Date;

  /**
   * The batch's actual status and provenance, read from the row rather than
   * assumed from the query's filters.
   *
   * Every row this function returns is quarantined and every one is a return —
   * that is what the `where` clause below asks for. Carrying the real values
   * anyway means the screen states what the batch *is* instead of restating
   * what the query happened to ask for, so widening the queue later cannot
   * leave the rows asserting something that has stopped being true.
   */
  status: LotStatus;
  isReturn: boolean;
  /** Whole days the batch has been waiting, for the ageing column. */
  daysHeld: number;
  returnNumber: string | null;
  orderNumber: string | null;
  customerName: string | null;
}

/**
 * Returned batches still waiting for somebody to look at them, oldest first.
 *
 * There is deliberately no quarantine expiry — different parts warrant
 * different inspections, and nothing in this system computes when one is due.
 * That decision only holds up if the waiting batches are *visible*, though:
 * without a list, a batch nobody inspected would sit out of sale indefinitely
 * with no screen ever mentioning it. This is that list, and it is the reason
 * "no automatic release" is a safe policy rather than a slow leak.
 *
 * Ordered by age rather than by product, because the question it answers is
 * "what has been waiting longest", not "what is this part doing".
 */
export async function listQuarantinedLots(): Promise<QuarantinedLotRow[]> {
  await requireRole("ADMIN");

  const lots = await prisma.stockLot.findMany({
    where: {
      status: QUARANTINED_LOT_STATUS,
      sourceType: "SALES_RETURN",
      quantityRemaining: { gt: 0 },
    },
    orderBy: [{ receivedAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      productId: true,
      quantityRemaining: true,
      unitCost: true,
      costCurrency: true,
      receivedAt: true,
      status: true,
      sourceType: true,
      sourceId: true,
      product: { select: { name: true, sku: true } },
      orderItem: {
        select: {
          order: {
            select: { orderNumber: true, customer: { select: { name: true } } },
          },
        },
      },
    },
  });

  /*
   * The return numbers in one query rather than one per row. `sourceId` is the
   * polymorphic pointer the lot already carries, so there is no relation to
   * traverse — the same shape `drainPurchaseLots` uses to find a purchase's
   * batches.
   */
  const returnIds = [
    ...new Set(lots.map((lot) => lot.sourceId).filter((id): id is string => id !== null)),
  ];

  const returns = await prisma.return.findMany({
    where: { id: { in: returnIds } },
    select: { id: true, returnNumber: true },
  });

  const returnNumbers = new Map(returns.map((row) => [row.id, row.returnNumber]));

  const now = Date.now();

  return lots.map((lot) => ({
    lotId: lot.id,
    productId: lot.productId,
    productName: lot.product.name,
    sku: lot.product.sku,
    quantityRemaining: lot.quantityRemaining,
    unitCost: lot.unitCost?.toString() ?? null,
    costCurrency: lot.costCurrency,
    receivedAt: lot.receivedAt,
    status: lot.status,
    isReturn: lot.sourceType === "SALES_RETURN",
    daysHeld: Math.max(
      0,
      Math.floor((now - lot.receivedAt.getTime()) / 86_400_000),
    ),
    returnNumber: lot.sourceId ? (returnNumbers.get(lot.sourceId) ?? null) : null,
    orderNumber: lot.orderItem?.order.orderNumber ?? null,
    customerName: lot.orderItem?.order.customer.name ?? null,
  }));
}
