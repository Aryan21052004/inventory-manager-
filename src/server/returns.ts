import "server-only";

import type { Prisma } from "@/generated/prisma/client";
import type { Currency } from "@/lib/currency";
import { AppError, NotFoundError } from "@/lib/errors";
import { QUARANTINED_LOT_STATUS } from "@/lib/lot-status";
import { prisma } from "@/lib/prisma";
import {
  returnableQuantity,
  salesReturnSchema,
  toSalesReturnFieldErrors,
  type SalesReturnFieldErrors,
} from "@/lib/validation/return";
import { requireUser } from "@/server/auth";
import { applyStockMovement, createLot, lockProducts } from "@/server/stock";

/**
 * Recording goods a customer has sent back.
 *
 * **A return is not a cancellation.** A cancellation says the sale never
 * happened: the units never really left, so they go back into the batches they
 * came from at the prices those batches cost, and the order's revenue and cost
 * are erased. A return says the sale did happen and is being partly unwound —
 * the goods left, spent time in somebody else's custody, and have come back as
 * a new physical receipt whose condition nobody has yet vouched for.
 *
 * Everything in this module follows from that:
 *
 *   Returned units arrive as **new lots**, never restored into the originals.
 *   Restoring would make them indistinguishable from stock that never left,
 *   would let the original certificate silently cover units it cannot vouch
 *   for, and would give them a FIFO age they no longer have.
 *
 *   Each new lot carries **the cost the units left at**, read from the
 *   `StockLotConsumption` rows the original shipment wrote. A shipment drawn
 *   from two batches at two prices comes back as two batches at those same two
 *   prices — never one at the average, which would be a price no unit ever had.
 *
 *   Each new lot starts **QUARANTINED** and carries **no certificate**.
 *
 *   The ledger row is a **STOCK_IN** — the units genuinely arrive — referencing
 *   the return rather than the order. `cancelOrder` nets movements by
 *   `referenceType = 'ORDER'`, so a return carrying that reference would be
 *   swept into the netting and mis-restore the lots. Keeping the references
 *   apart makes the two documents disjoint by construction.
 *
 *   `fulfilledQuantity` is **never reduced**. It records a shipment that
 *   happened and that the ledger still carries; `returnedQuantity` is a second
 *   counter, and units still with the customer are the difference.
 */

/** Statuses whose stock has actually shipped and can therefore come back. */
const RETURNABLE_ORDER_STATUSES = new Set(["CONFIRMED", "COMPLETED"]);

export interface ReturnedLotSummary {
  lotId: string;
  quantity: number;
  unitCost: string | null;
  originLotId: string;
}

export interface ReturnOutcome {
  id: string;
  returnNumber: string;
  orderId: string;
  orderNumber: string;
  lines: {
    orderItemId: string;
    productName: string;
    quantity: number;
    lots: ReturnedLotSummary[];
  }[];
}

/**
 * One layer of a shipment: units drawn from one batch, at one frozen cost.
 *
 * `unitCostCents` is null when the original draw was uncosted, and stays null
 * all the way to the returned lot. Unknown in, unknown out.
 */
interface CostLayer {
  lotId: string;
  quantity: number;
  unitCostCents: number | null;
  /**
   * The currency the original draw was costed in, carried back untouched.
   * Null exactly when the cost is — a return can no more invent a currency
   * than it can invent a rate.
   */
  costCurrency: Currency | null;
}

function nextReturnNumber(tx: Prisma.TransactionClient): Promise<string> {
  const prefix = `RT-${new Date().getUTCFullYear()}-`;

  return tx.return
    .findFirst({
      where: { returnNumber: { startsWith: prefix } },
      orderBy: { returnNumber: "desc" },
      select: { returnNumber: true },
    })
    .then((last) => {
      const previous = last ? Number(last.returnNumber.slice(prefix.length)) : 0;
      const next = Number.isFinite(previous) ? previous + 1 : 1;

      return `${prefix}${String(next).padStart(4, "0")}`;
    });
}

/**
 * Which batches a return draws from, and what those units cost.
 *
 * Read from the shipment's own consumption rows, never from the product's lots
 * as they stand today. Those rows froze the rate at the moment of the draw,
 * which is the whole reason they store one — the lot may since have been
 * emptied, and today's oldest batch has nothing to do with what shipped
 * eighteen months ago.
 *
 * **Order matters and is the decided policy.** Layers are consumed in the order
 * the original allocation created them — the shipment's own FIFO order, across
 * however many fulfilment events it took. Returning four units of a five-unit
 * shipment drawn 2 from one batch and 3 from another takes both from the first
 * batch and two from the second, deterministically and reproducibly.
 *
 * Earlier returns against the same line are subtracted first, so a second
 * return resumes where the first stopped rather than drawing the same layers
 * again. That is what makes repeated partial returns add up to the shipment
 * instead of exceeding it.
 */
async function resolveReturnLayers(
  tx: Prisma.TransactionClient,
  params: {
    orderId: string;
    orderItemId: string;
    productId: string;
    quantity: number;
    productName: string;
  },
): Promise<CostLayer[]> {
  /*
   * The shipment's draws, oldest first.
   *
   * Scoped to this order *and* this product, which together identify the line:
   * `OrderItem` is unique on (orderId, productId), so the movements this order
   * wrote for this product are exactly this line's.
   */
  const rows = await tx.stockLotConsumption.findMany({
    where: {
      stockTransaction: {
        referenceType: "ORDER",
        referenceId: params.orderId,
        productId: params.productId,
      },
    },
    orderBy: [{ stockTransaction: { createdAt: "asc" } }, { id: "asc" }],
    select: {
      lotId: true,
      quantity: true,
      unitCost: true,
      costCurrency: true,
    },
  });

  /*
   * Net any negative rows per lot before allocating.
   *
   * A negative row is stock a REVERSAL gave back, and an order carrying one has
   * been cancelled — which the caller already refuses to return against. The
   * netting is here anyway because reading only the positive rows is exactly
   * the bug `returnToLots` documents: it makes a draw look larger than it was.
   */
  const givenBack = new Map<string, number>();

  for (const row of rows) {
    if (row.quantity < 0) {
      givenBack.set(row.lotId, (givenBack.get(row.lotId) ?? 0) - row.quantity);
    }
  }

  /* Units of each lot already returned by an earlier return on this line. */
  const previous = await tx.stockLot.groupBy({
    by: ["originLotId"],
    where: { orderItemId: params.orderItemId, originLotId: { not: null } },
    _sum: { quantityReceived: true },
  });

  const alreadyReturned = new Map<string, number>(
    previous.flatMap((row) =>
      row.originLotId === null
        ? []
        : [[row.originLotId, row._sum.quantityReceived ?? 0] as const],
    ),
  );

  const layers: CostLayer[] = [];
  let outstanding = params.quantity;

  for (const row of rows) {
    if (outstanding <= 0) break;
    if (row.quantity <= 0) continue;

    let available = row.quantity;

    // Drain the reversed and already-returned counters against the earliest
    // rows of their lot, so a resumed return continues rather than restarts.
    for (const counter of [givenBack, alreadyReturned]) {
      const outstandingCounter = counter.get(row.lotId) ?? 0;

      if (outstandingCounter > 0) {
        const used = Math.min(outstandingCounter, available);
        counter.set(row.lotId, outstandingCounter - used);
        available -= used;
      }
    }

    if (available <= 0) continue;

    const take = Math.min(available, outstanding);

    layers.push({
      lotId: row.lotId,
      quantity: take,
      unitCostCents:
        row.unitCost === null ? null : Math.round(Number(row.unitCost) * 100),
      costCurrency: row.costCurrency,
    });

    outstanding -= take;
  }

  /*
   * The line said these units shipped and the consumption rows disagree.
   *
   * Reachable only if `returnedQuantity`/`fulfilledQuantity` and the ledger
   * have come apart, which is a broken invariant rather than anything an
   * operator did — so it fails loudly instead of returning fewer units than
   * asked for and calling the return complete.
   */
  if (outstanding > 0) {
    throw new AppError(
      "INTERNAL",
      `The shipment history for ${params.productName} does not account for ${outstanding} of the units being returned. The order lines and the stock ledger are out of step.`,
    );
  }

  /*
   * One lot per source batch, not per consumption row.
   *
   * A line fulfilled across three events from the same batch drew at one
   * frozen cost, so those rows are one cost layer and come back as one lot.
   * Splitting them would multiply lots without recording anything the lineage
   * pointer does not already say.
   */
  const merged = new Map<string, CostLayer>();

  for (const layer of layers) {
    const existing = merged.get(layer.lotId);

    if (existing) existing.quantity += layer.quantity;
    else merged.set(layer.lotId, { ...layer });
  }

  return [...merged.values()];
}

/**
 * Records a customer return against an order.
 *
 * Everything happens in one transaction under the order's row lock, so two
 * clerks returning the same units serialise: the second reads the incremented
 * `returnedQuantity` and is refused. The check constraint
 * `order_items_return_bounds` is the backstop if a future path forgets the lock.
 */
export async function recordSalesReturn(
  input: unknown,
): Promise<ReturnOutcome> {
  /*
   * Any signed-in user. Booking in goods that arrived against a document is
   * ordinary warehouse work, exactly like fulfilling an order — the existing
   * policy reserves ADMIN for movements with no document behind them. Releasing
   * quarantined stock is the judgement that will need ADMIN, and it is not here.
   */
  const user = await requireUser();

  const parsed = salesReturnSchema.safeParse(input);

  if (!parsed.success) {
    const errors = toSalesReturnFieldErrors(parsed.error);
    const field = (Object.keys(errors)[0] ?? "form") as keyof SalesReturnFieldErrors;

    throw new AppError("BAD_REQUEST", errors[field] ?? "Check the return.", {
      field,
    });
  }

  const request = parsed.data;

  return prisma.$transaction(async (tx) => {
    const orderRows = await tx.$queryRaw<
      { id: string; order_number: string; status: string }[]
    >`
      SELECT id, order_number, status
      FROM orders
      WHERE id = ${request.orderId}
      FOR UPDATE
    `;

    const order = orderRows[0];
    if (!order) throw new NotFoundError("Order");

    if (!RETURNABLE_ORDER_STATUSES.has(order.status)) {
      throw new AppError(
        "CONFLICT",
        `Order ${order.order_number} has no shipped units to return. Only a confirmed or completed order can accept a return.`,
      );
    }

    const requested = new Map(
      request.lines.map((line) => [line.orderItemId, line.quantity] as const),
    );

    const items = await tx.orderItem.findMany({
      where: { id: { in: [...requested.keys()] }, orderId: order.id },
      select: {
        id: true,
        productId: true,
        quantity: true,
        fulfilledQuantity: true,
        returnedQuantity: true,
        product: { select: { name: true } },
      },
    });

    if (items.length !== requested.size) throw new NotFoundError("Order line");

    /*
     * Every line checked before anything is written. Asking to return more than
     * shipped is a mistake in the request rather than a fact about the
     * warehouse, so settling the rest of the form around it would hide the
     * error — the same reasoning fulfilment uses.
     */
    for (const item of items) {
      const want = requested.get(item.id)!;
      const remaining = returnableQuantity(item);

      if (remaining <= 0) {
        throw new AppError(
          "CONFLICT",
          `Every shipped unit of ${item.product.name} on this order has already been returned.`,
        );
      }

      if (want > remaining) {
        throw new AppError(
          "BAD_REQUEST",
          `Only ${remaining} ${remaining === 1 ? "unit" : "units"} of ${item.product.name} can still be returned on this order, so ${want} cannot be accepted.`,
        );
      }
    }

    const locked = await lockProducts(
      tx,
      items.map((item) => item.productId),
    );

    const salesReturn = await tx.return.create({
      data: {
        returnNumber: await nextReturnNumber(tx),
        orderId: order.id,
        receivedAt: new Date(),
        note: request.reason,
        createdBy: user.id,
      },
      select: { id: true, returnNumber: true },
    });

    const lines: ReturnOutcome["lines"] = [];

    // Sorted, so a return spanning several lines writes them in a fixed
    // sequence — the same reason `lockProducts` sorts.
    for (const item of [...items].sort((a, b) => a.id.localeCompare(b.id))) {
      const want = requested.get(item.id)!;
      const product = locked.get(item.productId)!;

      const layers = await resolveReturnLayers(tx, {
        orderId: order.id,
        orderItemId: item.id,
        productId: item.productId,
        quantity: want,
        productName: item.product.name,
      });

      const lots: ReturnedLotSummary[] = [];

      /*
       * One movement per cost layer, because `StockLot.stockTransactionId` is
       * unique: a lot is created by exactly one STOCK_IN and no batch shares a
       * receipt with another. A two-layer return therefore books two arrivals,
       * which is also the honest description — two batches at two prices came
       * through the door, and the ledger says so.
       *
       * The balance chains correctly across them because each movement re-reads
       * the product it just updated.
       */
      for (const layer of layers) {
        const beforeThisLayer = await tx.product.findUniqueOrThrow({
          where: { id: product.id },
          select: { stockQuantity: true },
        });

        const { transaction } = await applyStockMovement(tx, {
          product: { ...product, stockQuantity: beforeThisLayer.stockQuantity },
          type: "STOCK_IN",
          delta: layer.quantity,
          reference: { type: "SALES_RETURN", id: salesReturn.id },
          note: `Return ${salesReturn.returnNumber} against order ${order.order_number} — ${request.reason}`,
          userId: user.id,
        });

        const lot = await createLot(tx, {
          productId: product.id,
          stockTransactionId: transaction.id,
          quantity: layer.quantity,
          /*
           * The cost the units left at, frozen by the original draw. Never
           * today's price, never an average, and never a catalogue figure —
           * which no longer exists. An uncosted draw returns uncosted.
           */
          unitCostCents: layer.unitCostCents,
          /*
           * The currency those units left at, frozen by the original draw and
           * coming back with them. Never today's setting, and never a fresh
           * judgement — the same rule the rate above already follows. Because
           * returns already split one lot per cost layer, a return spanning
           * two currencies produces two lots, each correct, with nothing
           * averaged across them.
           */
          costCurrency: layer.costCurrency,
          costSource: layer.unitCostCents === null ? "UNKNOWN" : "RETURN",
          reference: { type: "SALES_RETURN", id: salesReturn.id },
          // Dated by arrival, so returned stock sits in FIFO where it actually
          // re-entered the building rather than where the original batch did.
          receivedAt: new Date(),
          userId: user.id,
          // Not saleable until somebody inspects it. No certificate is copied.
          status: QUARANTINED_LOT_STATUS,
          orderItemId: item.id,
          originLotId: layer.lotId,
        });

        lots.push({
          lotId: lot.id,
          quantity: layer.quantity,
          unitCost:
            layer.unitCostCents === null
              ? null
              : (layer.unitCostCents / 100).toFixed(2),
          originLotId: layer.lotId,
        });
      }

      /*
       * `fulfilledQuantity` is deliberately untouched. The units did ship, the
       * ledger still says so, and reducing it would report a return as a
       * costing gap once `costedQuantity` was dragged down to follow it.
       */
      await tx.orderItem.update({
        where: { id: item.id },
        data: { returnedQuantity: { increment: want } },
      });

      lines.push({
        orderItemId: item.id,
        productName: item.product.name,
        quantity: want,
        lots,
      });
    }

    return {
      id: salesReturn.id,
      returnNumber: salesReturn.returnNumber,
      orderId: order.id,
      orderNumber: order.order_number,
      lines,
    };
  });
}
