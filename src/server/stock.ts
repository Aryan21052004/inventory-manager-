import "server-only";

import { Prisma, type StockTransaction } from "@/generated/prisma/client";
import type {
  LotCostSource,
  LotStatus,
  StockTransactionType,
} from "@/generated/prisma/enums";
import type { Currency } from "@/lib/currency";
import { AppError, InsufficientStockError, NotFoundError } from "@/lib/errors";
import {
  SALEABLE_LOT_SQL,
  SALEABLE_LOT_STATUS,
  blockedStockHint,
} from "@/lib/lot-status";
import { prisma } from "@/lib/prisma";
import {
  declaredCostCurrency,
  declaredCostError,
  declaredCostUnitCents,
  withUnknownCostReason,
  type DeclaredCost,
} from "@/lib/validation/cost-basis";
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

  /**
   * Total physical stock on hand, including anything blocked.
   *
   * Unchanged in meaning, and the only figure physical accounting may use:
   * `applyStockMovement` reads it for `previousStock`/`newStock`, so the ledger
   * keeps describing the shelf rather than the saleable subset of it.
   */
  stockQuantity: number;

  /**
   * Units sitting in lots that may not be sold — quarantined or rejected.
   *
   * Derived under the same row lock, never stored. A stored figure would be a
   * third number that must agree with the other two, maintained by every path
   * that creates, consumes or re-statuses a lot; this codebase already declines
   * that trade for `OrderItem`'s outstanding quantity, and for the same reason.
   */
  blockedQuantity: number;

  /**
   * What an order may actually draw: `stockQuantity - blockedQuantity`.
   *
   * Computed once here so no call site has to remember the subtraction, and so
   * the two figures cannot be mixed up at the point of use. Every guard that
   * decides whether stock can be *sold* reads this; everything that records
   * what physically *moved* reads `stockQuantity`.
   */
  saleableQuantity: number;
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

  /*
   * Blocked stock, read as a second statement rather than a subquery.
   *
   * `FOR UPDATE` and aggregation do not combine in Postgres, and there is no
   * need to force them together: the row lock taken above is what serialises
   * this product's lots, so by the time this runs no other transaction can be
   * changing them. One indexed aggregate on a path that already performs
   * several writes.
   *
   * Every lot is saleable until the return workflow exists, so this is zero on
   * every product today and the subtraction below changes nothing.
   *
   * The predicate is the negation of the same rule the FIFO scan applies, built
   * from the same string rather than spelled again — "blocked" is defined as
   * "not saleable" and must stay that way, or a status could end up excluded
   * from sale while still counting as available.
   */
  const blocked = await tx.$queryRaw<{ blocked: bigint | number | null }[]>`
    SELECT COALESCE(SUM(quantity_remaining), 0) AS blocked
    FROM stock_lots
    WHERE product_id = ${productId}
      AND NOT (${Prisma.raw(SALEABLE_LOT_SQL)})
  `;

  const blockedQuantity = Number(blocked[0]?.blocked ?? 0);

  return {
    id: product.id,
    name: product.name,
    stockQuantity: product.stock_quantity,
    blockedQuantity,
    saleableQuantity: product.stock_quantity - blockedQuantity,
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
   * What the operator declared about the cost of the units this movement
   * brings in. Required for a movement that adds stock, and refused on one
   * that removes it.
   *
   * This used to be a nullable number, and omitting it created an UNKNOWN lot.
   * That made "unknown" the answer a caller gave by saying nothing, which is
   * the same defect the two forms had before they were fixed — an uncosted
   * batch that nobody chose and that no reason explains. Absence is no longer
   * an answer here: an inbound movement states a cost or states why there
   * isn't one, and `DeclaredCost` is the only way to say either.
   *
   * Outbound movements must pass nothing. They are costed from the lots they
   * draw against, so a cost supplied here could only be a caller misreading
   * what this parameter is for — previously ignored in silence, now refused.
   *
   * Nothing is ever defaulted from the catalogue row, which holds no cost at
   * all since `standardCost` was removed.
   */
  cost?: DeclaredCost,
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

  /*
   * The declaration is checked before anything is written, so a malformed one
   * fails without a ledger row to roll back.
   *
   * Both directions are checked, because both have an illegal state. An
   * inbound movement creates a batch, and a batch whose cost nobody declared
   * is the uncosted-batch-nobody-chose defect this parameter exists to
   * prevent. An outbound movement creates none, so a cost handed to it was
   * never going to be stored anywhere — saying so is more useful than
   * discarding it quietly.
   */
  if (delta > 0) {
    if (cost === undefined) {
      throw new AppError(
        "BAD_REQUEST",
        "A stock movement that adds stock must declare whether the acquisition cost of those units is known. Leaving it unsaid is what used to record a cost as unknown by accident.",
      );
    }

    const problem = declaredCostError(cost, "An inbound stock movement");
    if (problem) throw new AppError("BAD_REQUEST", problem);
  } else if (cost !== undefined) {
    throw new AppError(
      "BAD_REQUEST",
      "A stock movement that removes stock cannot declare an acquisition cost — those units are costed from the lots they draw against.",
    );
  }

  return prisma.$transaction(async (tx) => {
    const product = await lockProduct(tx, movement.productId);

    /*
     * An outflow draws from saleable lots, so it has to be checked against
     * saleable stock rather than physical stock.
     *
     * Every outbound movement reaches `allocateFifo` — a negative ADJUSTMENT
     * exactly as much as a STOCK_OUT — while the non-negative check inside
     * `applyStockMovement` looks at the physical balance. Without this, a
     * product holding ten quarantined units and nothing else would pass that
     * check and then fail inside the scan with "Stock lots do not cover this
     * movement": an assertion whose whole job is to detect a broken invariant,
     * fired by an ordinary warehouse situation.
     *
     * So the refusal happens here, before anything is written, and says what is
     * actually wrong. `blockedStockHint` returns null when nothing is blocked,
     * which is every product until the return workflow exists — so today this
     * is the same InsufficientStockError, with the same message, as before.
     */
    if (delta < 0) {
      const wanted = Math.abs(delta);

      if (product.saleableQuantity < wanted) {
        const hint = blockedStockHint(
          product.stockQuantity,
          product.blockedQuantity,
        );

        if (hint) {
          throw new AppError(
            "INSUFFICIENT_STOCK",
            `Not enough saleable stock for ${product.name}: ${wanted} requested. ${hint}`,
            {
              productName: product.name,
              requested: wanted,
              available: product.saleableQuantity,
              blocked: product.blockedQuantity,
            },
          );
        }

        throw new InsufficientStockError(
          product.name,
          wanted,
          product.saleableQuantity,
        );
      }
    }

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
      /*
       * Guarded above, and narrowed here for the compiler's benefit.
       *
       * Both columns come from what was declared rather than from whether a
       * number happened to arrive, which is the difference this pass exists to
       * make. The database asserts the same pairing from the other side:
       * `stock_lots_adjustment_cost_known` refuses an ADJUSTMENT lot with no
       * cost, and `stock_lots_unknown_cost_is_null` refuses an UNKNOWN lot
       * that carries one.
       */
      const declared = cost!;

      await createLot(tx, {
        productId: product.id,
        stockTransactionId: recorded.transaction.id,
        quantity: delta,
        unitCostCents: declaredCostUnitCents(declared),
        // From the declaration, never from the installation default: the
        // operator said what these units cost, so they also said in what.
        costCurrency: declaredCostCurrency(declared),
        costSource: declared.basis === "KNOWN" ? "ADJUSTMENT" : "UNKNOWN",
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
 * What an operator declared about what the opening stock cost.
 *
 * Kept as a name this module can read itself by, but no longer a type of its
 * own: an opening balance and an upward adjustment ask one question and now
 * answer it in one shape. Two structurally identical unions would be two
 * places for the same rule to drift.
 */
export type OpeningStockCost = DeclaredCost;

/** What the ledger says about an opening movement before any explanation. */
const OPENING_STOCK_NOTE = "Opening stock recorded when the product was created";

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
     * What the operator declared about the acquisition cost.
     *
     * A union rather than a nullable number and a loose note, because the two
     * illegal combinations were previously expressible and one of them was the
     * exact bug this workstream exists to close: `{ unitCostCents: null }` with
     * a note that explains nothing produces an uncosted batch nobody chose.
     * There is now no way to spell that. KNOWN carries a cost and cannot carry
     * a reason; UNKNOWN carries a reason and cannot carry a cost.
     *
     * Neither branch is defaulted from anything on the catalogue row — which
     * holds no cost at all since `standardCost` was removed. A guess written
     * here would be indistinguishable from a real acquisition cost afterwards.
     */
    cost: OpeningStockCost;
  },
): Promise<void> {
  if (params.quantity <= 0) return;

  /*
   * The union is the guarantee for TypeScript callers; this is the guarantee
   * for everyone else, and it is the same check the adjustment path runs.
   *
   * A `JSON.parse`, an `as any`, or a future caller compiled against an older
   * signature can still hand this function `{ basis: "UNKNOWN" }` with no
   * reason, or a KNOWN with no number — which is exactly the uncosted-batch
   * -nobody-chose defect the type is here to prevent. Failing loudly costs one
   * comparison and keeps the invariant true at runtime as well as at build
   * time.
   */
  const problem = declaredCostError(params.cost, "Opening stock");
  if (problem) throw new AppError("BAD_REQUEST", problem);

  const cost = params.cost;

  const transaction = await tx.stockTransaction.create({
    data: {
      productId: params.productId,
      type: "STOCK_IN",
      quantity: params.quantity,
      previousStock: 0,
      newStock: params.quantity,
      referenceType: "MANUAL",
      referenceId: null,
      /*
       * An unknown cost takes its reason into the ledger, which is the only
       * place it can outlive the form. It is the sole explanation the uncosted
       * sales this batch goes on to produce will ever have.
       */
      note:
        cost.basis === "KNOWN"
          ? OPENING_STOCK_NOTE
          : withUnknownCostReason(OPENING_STOCK_NOTE, cost.reason),
      createdBy: params.userId,
    },
  });

  await tx.product.update({
    where: { id: params.productId },
    data: { stockQuantity: params.quantity },
  });

  await createLot(tx, {
    productId: params.productId,
    stockTransactionId: transaction.id,
    quantity: params.quantity,
    /*
     * Derived from what was declared, not from whether a number happened to
     * arrive. The database enforces the same pairing from the other side:
     * `stock_lots_opening_cost_known` refuses an OPENING lot without a cost,
     * and `stock_lots_unknown_cost_is_null` refuses an UNKNOWN lot with one.
     */
    unitCostCents: declaredCostUnitCents(cost),
    costCurrency: declaredCostCurrency(cost),
    costSource: cost.basis === "KNOWN" ? "OPENING" : "UNKNOWN",
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

  /**
   * What `unitCostCents` is denominated in. Null exactly when the cost is.
   *
   * Supplied by whoever knows: a purchase receipt passes the purchase's
   * currency, a declared cost passes the one on its KNOWN arm, and a return
   * passes the currency of the consumption layer it is reversing. There is
   * deliberately no default — the installation setting is the currency for
   * *new entry*, and reaching for it here would label a batch with whatever
   * the setting happened to say on the day.
   */
  costCurrency: Currency | null;

  costSource: LotCostSource;
  reference: StockReference;
  /** When the goods arrived — the FIFO sort key, not necessarily now. */
  receivedAt: Date;
  userId: string | null;

  /**
   * Whether the batch may be sold. Omitted for everything that arrives by
   * purchase, opening balance or adjustment, which is saleable on arrival.
   *
   * A customer return passes QUARANTINED, because goods that have been in
   * somebody else's custody are not saleable until an inspection says so.
   */
  status?: LotStatus | undefined;

  /**
   * The order line these units were sold on, before they came back.
   *
   * Return lots only. Paired with the reference by
   * `stock_lots_return_provenance`, so a SALES_RETURN lot must carry one and
   * nothing else may.
   */
  orderItemId?: string | null | undefined;

  /**
   * The batch these units originally shipped from.
   *
   * Return lots only. Carries lineage to the original cost, certificate and
   * supplier as *history* — nothing is copied across it.
   */
  originLotId?: string | null | undefined;
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

  /*
   * There is deliberately no runtime guard here refusing a cost that arrives
   * without a currency.
   *
   * Omitting one is already impossible: `costCurrency` is required on
   * `LotSpec`, so a caller that forgets it does not compile. What remains is a
   * caller that passes an explicit null alongside a real cost, and that is not
   * a mistake — it is a receipt against a legacy purchase whose own currency
   * was never recorded. Refusing it would block a physical delivery over a
   * bookkeeping gap, and the goods still arrived.
   *
   * Such a lot reads as "currency unknown" rather than borrowing the
   * installation default. It is also the one case that will need attention
   * before the Phase 3 paired-null constraint can be validated.
   */

  return tx.stockLot.create({
    data: {
      productId: spec.productId,
      stockTransactionId: spec.stockTransactionId,
      quantityReceived: spec.quantity,
      // Nothing has been drawn from it yet.
      quantityRemaining: spec.quantity,
      unitCost:
        spec.unitCostCents === null ? null : centsToDecimal(spec.unitCostCents),
      /*
       * Paired with the cost, and refused if the caller sends one without the
       * other. The database will assert the same thing from its side in Phase
       * 3; until then this is the guarantee, and it is the one that produces a
       * message naming the batch rather than a constraint violation.
       */
      costCurrency: spec.unitCostCents === null ? null : spec.costCurrency,
      costSource: spec.costSource,
      sourceType: spec.reference.type,
      sourceId:
        spec.reference.type === "MANUAL" ? null : spec.reference.id,
      receivedAt: spec.receivedAt,
      createdBy: spec.userId,
      // Saleable unless the caller says otherwise; only a return says otherwise.
      status: spec.status ?? SALEABLE_LOT_STATUS,
      orderItemId: spec.orderItemId ?? null,
      originLotId: spec.originLotId ?? null,
    },
    select: { id: true },
  });
}

export interface Allocation {
  lotId: string;
  quantity: number;
  unitCostCents: number | null;
  /**
   * The currency of this layer's cost, copied from the lot at the draw. Null
   * when the cost is unknown, and null on a legacy lot that carries a cost
   * whose currency was never recorded — those are different facts, and the
   * second is why a costed layer can still fail to name a currency.
   */
  costCurrency: Currency | null;
}

export interface AllocationResult {
  /**
   * How many units were drawn from lots whose cost is known **and which agree
   * on one currency**. Zero when they do not — see `costCurrencyIndeterminate`.
   */
  costedQuantity: number;
  /** What those units cost, in cents. Zero when nothing can be costed. */
  costTotalCents: number;
  /**
   * Units this draw cannot state a cost for: those from uncosted lots, plus —
   * when the currencies disagree — every costed unit as well, because a total
   * spanning two currencies is not a number.
   */
  uncostedQuantity: number;
  /** The single currency every costed layer shares, or null when there is none. */
  costCurrency: Currency | null;
  /**
   * True when costed layers exist but cannot agree on one known currency —
   * either they span several, or one of them has no currency at all.
   *
   * This is what separates "nothing here was costed" from "several things were
   * costed and no single figure can describe them". Both report a zero costed
   * quantity, and only the caller that knows which is which can explain it.
   */
  costCurrencyIndeterminate: boolean;
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
  /*
   * Only saleable batches, and the ordering is untouched.
   *
   * Quarantined and rejected units are physically present and counted
   * everywhere else — in `stockQuantity`, in I-1, in the valuation — but they
   * are not available to sell, so they are invisible to this scan alone.
   *
   * The clause comes from `SALEABLE_LOT_SQL` rather than being typed here, so
   * this scan and the blocked-quantity aggregate above cannot come to disagree
   * about what "saleable" means. It is also the literal the partial index
   * `stock_lots_fifo_saleable_idx` is defined on, which is what lets Postgres
   * match it.
   *
   * The callers are what keep the assertion below meaningful: each one checks
   * *saleable* stock before asking for units, so lots that fail to cover a draw
   * still mean the invariant is broken rather than that somebody tried to sell
   * quarantined stock.
   */
  const lots = await tx.$queryRaw<
    {
      id: string;
      quantity_remaining: number;
      unit_cost: string | null;
      cost_currency: Currency | null;
    }[]
  >`
    SELECT id, quantity_remaining, unit_cost::text AS unit_cost, cost_currency
    FROM stock_lots
    WHERE product_id = ${params.productId}
      AND quantity_remaining > 0
      AND ${Prisma.raw(SALEABLE_LOT_SQL)}
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
        /*
         * Frozen here, from the lot, for the same reason the rate is: this row
         * is the historical record of what these units cost, and it must stay
         * true even when the order line above it can no longer state a single
         * figure. When a draw spans two currencies these rows are where the
         * real cost of sale survives.
         */
        costCurrency: unitCostCents === null ? null : lot.cost_currency,
      },
    });

    allocations.push({
      lotId: lot.id,
      quantity: take,
      unitCostCents,
      costCurrency: unitCostCents === null ? null : lot.cost_currency,
    });
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

  return summariseAllocations(allocations);
}

/**
 * What a set of drawn layers adds up to — or the refusal to add them up.
 *
 * Split out from the loop above so the same verdict is reachable from a test
 * and from any future caller that assembles allocations another way.
 *
 * **Currencies are never blended and never converted.** A draw whose costed
 * layers disagree — two currencies, or one layer whose currency was never
 * recorded — has no single cost, and the honest answer is to report none
 * rather than a plausible sum of incompatible amounts. Those units then count
 * as uncosted, which is what keeps every downstream coverage figure and margin
 * truthful: they fall out of the cost *and* out of the revenue measured
 * against it, so nothing can be inflated by them.
 *
 * The individual `StockLotConsumption` rows are untouched by this. Each keeps
 * its own rate and its own currency, and they remain the record of what the
 * sale actually cost.
 */
function summariseAllocations(allocations: Allocation[]): AllocationResult {
  let costedQuantity = 0;
  let costTotalCents = 0;
  let uncostedQuantity = 0;

  // The distinct currencies across *costed* layers only. A null in here is a
  // costed layer whose currency is unrecorded, which is as disqualifying as a
  // second currency would be — it just cannot be named.
  const currencies = new Set<Currency | null>();

  for (const allocation of allocations) {
    if (allocation.unitCostCents === null) {
      uncostedQuantity += allocation.quantity;
      continue;
    }

    currencies.add(allocation.costCurrency);
    costedQuantity += allocation.quantity;
    costTotalCents += allocation.unitCostCents * allocation.quantity;
  }

  const only = currencies.size === 1 ? [...currencies][0] : null;
  const indeterminate = currencies.size > 1 || (currencies.size === 1 && only === null);

  if (indeterminate) {
    return {
      costedQuantity: 0,
      costTotalCents: 0,
      // The costed units join the uncosted ones: none of them can be priced
      // into a single figure, and coverage must say so.
      uncostedQuantity: uncostedQuantity + costedQuantity,
      costCurrency: null,
      costCurrencyIndeterminate: true,
      allocations,
    };
  }

  return {
    costedQuantity,
    costTotalCents,
    uncostedQuantity,
    costCurrency: only,
    costCurrencyIndeterminate: false,
    allocations,
  };
}

/**
 * Puts units back where they came from.
 *
 * Reads every draw and every prior return recorded against a document's
 * movements, nets them per lot, and writes the negative consumption rows that
 * restore the balance.
 *
 * Units return to **their original lot at their original cost**, never into a
 * new lot at today's price. That is what keeps a cancellation from quietly
 * revaluing stock: cancel an order placed when the part cost ₹8,000 and the
 * units go back to the ₹8,000 batch, even if the most recent delivery was
 * ₹9,500.
 *
 * **The netting spans the whole document, in both directions.** This used to
 * take only the outbound movements, which meant a prior REVERSAL's negative
 * consumption rows — written against the *reversal's* transaction id, not the
 * STOCK_OUT's — were invisible to it. The draw then looked larger than it was
 * and the lots were over-restored. Two shapes came out of that, and only one of
 * them announced itself:
 *
 *   A lot this document was the sole consumer of exceeded its own
 *   `quantityReceived`, and `stock_lots_quantity_remaining_within_received`
 *   refused the write. Loud, and harmless.
 *
 *   A lot another document had since drawn from had room to absorb the excess,
 *   so nothing was refused. `SUM(quantityRemaining)` quietly exceeded
 *   `Product.stockQuantity` and I-1 was broken with no error raised.
 *
 * The second is the reason the netting reads the whole document rather than
 * half of it, and the reason the shortfall below refuses to be negative.
 */
export async function returnToLots(
  tx: Prisma.TransactionClient,
  params: {
    /**
     * Every movement this document has written, inbound and outbound alike —
     * not just the ones that took stock out.
     *
     * Passing only the outbound half is the bug described above. The caller
     * reads the ledger for the document and passes all of it; the reversal
     * being written *now* is not among them, because its consumption rows are
     * what this function is about to create.
     */
    documentTransactionIds: readonly string[];
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
  if (params.documentTransactionIds.length === 0) {
    return { returned: 0, uncosted: 0 };
  }

  const rows = await tx.stockLotConsumption.findMany({
    where: {
      stockTransactionId: { in: [...params.documentTransactionIds] },
      lot: { productId: params.productId },
    },
    select: { lotId: true, quantity: true },
  });

  /*
   * Net per lot. The rows are signed — a draw is positive, a return negative —
   * so a plain sum over the whole document is what is still outstanding
   * against each batch. A lot netting to zero or below has already been given
   * back in full and is skipped below.
   */
  const outstanding = new Map<string, number>();

  for (const row of rows) {
    outstanding.set(
      row.lotId,
      (outstanding.get(row.lotId) ?? 0) + row.quantity,
    );
  }

  // Sorted, so a reversal touching several lots takes them in a fixed order.
  const lotIds = [...outstanding.keys()]
    .filter((lotId) => outstanding.get(lotId)! > 0)
    .sort();

  /*
   * The rate comes from the lot, not from whichever consumption row happened
   * to be read first.
   *
   * Every row against a lot carries the same cost today, so the two agree —
   * but "the first row we saw" is a property of query order, and with returns
   * in the set it could be a negative row. Reading the batch is reading the
   * source, and it costs one query for the whole reversal.
   */
  const lots = await tx.stockLot.findMany({
    where: { id: { in: lotIds } },
    select: { id: true, unitCost: true, costCurrency: true },
  });

  /*
   * The currency each layer was costed in, kept beside the rate and applied
   * to the negative rows below. A reversal restores what left; it does not
   * re-price it and does not re-denominate it.
   */
  const layerCurrencies = new Map(
    lots.map((lot) => [lot.id, lot.costCurrency] as const),
  );

  const rates = new Map(
    lots.map((lot) => [lot.id, lot.unitCost] as const),
  );

  let returned = 0;

  for (const lotId of lotIds) {
    const quantity = outstanding.get(lotId)!;

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
        // The layer's own currency, so a plain SUM over these rows nets a
        // return against its draw within one currency rather than across two.
        costCurrency:
          unitCostCents === null ? null : (layerCurrencies.get(lotId) ?? null),
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

  /*
   * More returned than the reversal restored, which cannot happen if the
   * netting above is right.
   *
   * This used to be clamped with `Math.max(0, shortfall)`, which is exactly
   * how the over-restore described at the top of this function stayed silent:
   * the lots had already been incremented by then, so swallowing the negative
   * left `SUM(quantityRemaining)` above `Product.stockQuantity` with nothing
   * to show for it. It is the same condition `allocateFifo` refuses in the
   * other direction, and it gets the same treatment — the transaction rolls
   * back and the invariant survives.
   */
  if (shortfall < 0) {
    throw new AppError(
      "INTERNAL",
      "This reversal returned more units to stock lots than it restored to the ledger. The valuation layer is out of step with the stock ledger.",
    );
  }

  if (shortfall > 0) {
    const origin = await tx.stockTransaction.findFirst({
      where: {
        id: { in: [...params.documentTransactionIds] },
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
        // Explicit rather than relying on the column default. These units came
        // back without a cost layer to attribute them to, so there is nothing
        // to denominate — and stating the null is how that stays deliberate.
        costCurrency: null,
        costSource: "UNKNOWN",
        sourceType: "MANUAL",
        sourceId: null,
        receivedAt: origin?.createdAt ?? new Date(),
        createdBy: params.userId,
      },
    });
  }

  // Non-negative by the guard above, so no clamp is needed to say so.
  return { returned, uncosted: shortfall };
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
    select: { id: true, quantityRemaining: true, unitCost: true, costCurrency: true },
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
        costCurrency: unitCostCents === null ? null : lot.costCurrency,
      },
    });
  }
}

/**
 * Takes a stated number of units out of one named batch.
 *
 * The counterpart to `allocateFifo`, and deliberately not a variant of it.
 * FIFO answers "which batches should this draw come from" — a question with a
 * policy behind it. This answers nothing: the caller has already decided which
 * batch, and the only correct behaviour is to take the units from that one and
 * no other.
 *
 * That distinction is the whole reason this exists. A rejected batch is
 * invisible to FIFO by design, so a generic decrease against a product holding
 * one would consume *saleable* stock instead — destroying good units' cost
 * basis while the condemned ones stayed on the books, with every invariant
 * still reconciling and nothing to show anything had gone wrong.
 *
 * The shape is `drainPurchaseLots`': decrement the batch, write a positive
 * consumption row against the movement that explains it, and never delete
 * anything. The row freezes the rate at disposal, so what the destroyed units
 * cost survives even after the batch reaches zero and drops out of valuation.
 *
 * **This function does not decide whether the draw is allowed.** It does not
 * look at status, cost source or authorisation — callers establish all of that
 * first, under the product lock. Keeping the eligibility rules out of here is
 * what stops it becoming a way to take units out of any batch at all.
 *
 * The product row must already be locked by the caller, and the ledger row must
 * already be written: this updates the valuation layer to match a movement that
 * has happened, never the other way round.
 */
export async function drainLot(
  tx: Prisma.TransactionClient,
  params: {
    /** The batch to take units from. Never resolved by a policy. */
    lotId: string;
    /** The movement these units left on. */
    stockTransactionId: string;
    quantity: number;
  },
): Promise<{ unitCostCents: number | null; costCurrency: Currency | null }> {
  if (params.quantity <= 0) {
    throw new AppError(
      "INTERNAL",
      "A lot drain must remove at least one unit.",
    );
  }

  const lot = await tx.stockLot.findUnique({
    where: { id: params.lotId },
    select: { id: true, quantityRemaining: true, unitCost: true, costCurrency: true },
  });

  if (!lot) throw new NotFoundError("Stock lot");

  /*
   * Re-checked here as well as by the caller. `quantity_remaining >= 0` is a
   * check constraint, so an over-draw would be refused by the database anyway —
   * but it would arrive as a constraint violation rather than as a sentence
   * naming the batch, and the two readers of that failure are an operator and
   * a future maintainer.
   */
  if (params.quantity > lot.quantityRemaining) {
    throw new AppError(
      "CONFLICT",
      `This batch has ${lot.quantityRemaining} ${lot.quantityRemaining === 1 ? "unit" : "units"} left, so ${params.quantity} cannot be taken from it.`,
    );
  }

  const unitCostCents =
    lot.unitCost === null ? null : Math.round(Number(lot.unitCost) * 100);

  await tx.stockLot.update({
    where: { id: lot.id },
    data: { quantityRemaining: { decrement: params.quantity } },
  });

  await tx.stockLotConsumption.create({
    data: {
      lotId: lot.id,
      stockTransactionId: params.stockTransactionId,
      // Positive: units leaving the batch, exactly as a sale records them.
      quantity: params.quantity,
      unitCost: unitCostCents === null ? null : centsToDecimal(unitCostCents),
      totalCost:
        unitCostCents === null
          ? null
          : centsToDecimal(unitCostCents * params.quantity),
      costCurrency: unitCostCents === null ? null : lot.costCurrency,
    },
  });

  /*
   * The currency leaves with the rate, so a caller writing off a batch can say
   * what it destroyed without reaching for the installation default. Null
   * together, always.
   */
  return {
    unitCostCents,
    costCurrency: unitCostCents === null ? null : lot.costCurrency,
  };
}
