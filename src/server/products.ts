import "server-only";

import type { Prisma } from "@/generated/prisma/client";
import type {
  LotCostSource,
  LotStatus,
  ProductStatus,
} from "@/generated/prisma/enums";
import { AppError, NotFoundError, toSafeError, type SafeError } from "@/lib/errors";
import { certificateStatus, type CertificateStatus } from "@/lib/certificate-status";
import type { Currency } from "@/lib/currency";
import {
  groupTotals,
  sumByCurrency,
  type MoneyByCurrency,
} from "@/lib/money-by-currency";
import { prisma } from "@/lib/prisma";
import type { ProductListParams, ProductSortKey } from "@/lib/product-query";
import {
  adjustmentDelta,
  adjustmentCost,
  adjustmentNote,
  stockAdjustmentSchema,
  type StockAdjustmentInput,
} from "@/lib/validation/adjustment";
import {
  createProductSchema,
  firstIssueMessage,
  openingStockCost,
  toFieldErrors,
  updateProductSchema,
  type ProductFieldErrors,
} from "@/lib/validation/product";
import { getCurrency } from "@/server/settings";
import { requireRole } from "@/server/auth";
import {
  certificateKeysForProduct,
  deleteStoredFiles,
  getCertificateHistory,
  getLotCertificates,
  type CertificateView,
} from "@/server/certificates";
import { recordOpeningStock, recordStockMovement } from "@/server/stock";

/**
 * Everything the products module does to the database.
 *
 * Deliberately free of any `next/*` import. The server actions in
 * src/app/(app)/products/actions.ts are thin wrappers that call into here and
 * then revalidate; keeping the logic separate means the rules that matter —
 * who may write, what a duplicate SKU does, that stock never moves without a
 * ledger row — are testable directly, without a request context to fake.
 *
 * Reads return a result object rather than throwing: a page that cannot reach
 * the database renders a state, it does not crash. Writes throw `AppError`,
 * which the action wrapper turns into something the form can display.
 *
 * Decimal columns come back as strings. Prisma's `Decimal` is a class instance,
 * and passing one from a server component into a client component is not
 * serialisable — converting once, here, is better than every caller
 * remembering to.
 */

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface ProductListItem {
  id: string;
  name: string;
  sku: string;
  /** Carried so the edit dialog can prefill without a second round trip. */
  description: string | null;
  category: string;
  /** A reference price only — never what any order sold for. Null when unset. */
  sellingPrice: string | null;
  /**
   * What that price is quoted in, as recorded on the product.
   *
   * Carried so a screen never has to reach for the installation default to
   * label it. Null on a product priced before the column existed — a fact to
   * state, not a gap to fill in.
   */
  priceCurrency: Currency | null;
  stockQuantity: number;
  status: ProductStatus;
  supplierId: string | null;
  supplierName: string | null;
  createdAt: Date;
}

export interface ProductListPage {
  items: ProductListItem[];
  /** Rows matching the filters, which is what the pagination counts. */
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

export interface ProductStats {
  total: number;
  /**
   * Stock at actual acquisition cost, summed over the lots still holding units.
   *
   * Covers only the units whose cost is known. It is not the value of all stock
   * on hand, and presenting it as though it were would understate inventory —
   * so it always travels with `uncostedUnits` below, and the UI is obliged to
   * show the two together.
   */
  stockValueByCurrency: MoneyByCurrency;
  /**
   * Units on hand whose acquisition cost was never established — stock that
   * predates lot costing, or was adjusted in without one. Not valued at zero,
   * not valued at a guess: excluded from `stockValue` and counted here.
   */
  uncostedUnits: number;
}

export interface ProductMovement {
  id: string;
  type: string;
  /** Signed effect on stock, derived from the two balances. */
  change: number;
  previousStock: number;
  newStock: number;
  note: string | null;
  referenceType: string;
  referenceId: string | null;
  createdAt: Date;
  createdByName: string | null;
}

export interface ProductOrderLine {
  id: string;
  orderNumber: string;
  status: string;
  customerName: string;
  quantity: number;
  unitPrice: string;
  total: string;
  /** The currency the order was raised in. Null on a legacy order. */
  currency: Currency | null;
  createdAt: Date;
}

export interface ProductPurchaseLine {
  id: string;
  purchaseNumber: string;
  status: string;
  supplierName: string;
  quantity: number;
  unitCost: string;
  total: string;
  /** The currency the purchase was raised in. Null on a legacy purchase. */
  currency: Currency | null;
  purchaseDate: Date;
}

/**
 * A batch of stock on hand, with what it cost and where it came from.
 *
 * Listed oldest-first because that is the order FIFO will consume them, which
 * makes the table on the product page a straight answer to "what will the next
 * sale cost us" rather than a reference list.
 */
export interface ProductLot {
  id: string;
  /** Null when the acquisition cost was never established. */
  unitCost: string | null;
  /**
   * What that cost is denominated in, from the batch's own row.
   *
   * Paired with `unitCost` — both null together on a batch that predates cost
   * tracking. Two batches of one part can disagree, which is exactly why this
   * belongs on the lot rather than on the product.
   */
  costCurrency: Currency | null;
  costSource: LotCostSource;
  quantityReceived: number;
  quantityRemaining: number;
  receivedAt: Date;
  /** The purchase this batch arrived on, when there was one. */
  sourceType: string;
  sourceId: string | null;
  purchaseNumber: string | null;
  /**
   * The paperwork covering *these* units, or null if none has been filed.
   *
   * Per lot rather than per product, which is the whole point: two batches of
   * one part can arrive under different releases, and one can be covered while
   * the other is not.
   */
  certificate: CertificateView | null;
  /** Derived from that certificate's expiry date; never stored. */
  certificateStatus: CertificateStatus;

  /**
   * Whether this batch may be sold.
   *
   * Physical stock counts every status; only SALEABLE batches are reachable by
   * FIFO. Per batch because a product routinely holds several at once in
   * different states, and a product-level figure would have to lie about one.
   */
  status: LotStatus;
  /** When an inspection released or condemned it, and what was found. */
  statusChangedAt: Date | null;
  statusNote: string | null;
  /**
   * True when a customer sent this batch back — the only kind an inspection
   * may act on. Read from `sourceType`, not from the cost source: a return of
   * an uncosted shipment is an UNKNOWN-cost batch and is still a return.
   */
  isReturn: boolean;
}

export interface ProductDetail {
  id: string;
  name: string;
  sku: string;
  description: string | null;
  category: string;
  /** A reference price only — never what any order sold for. Null when unset. */
  sellingPrice: string | null;
  /** What that price is quoted in. See `ProductListItem.priceCurrency`. */
  priceCurrency: Currency | null;
  stockQuantity: number;
  status: ProductStatus;
  supplierId: string | null;
  supplierName: string | null;
  createdAt: Date;
  updatedAt: Date;
  movements: ProductMovement[];
  recentOrders: ProductOrderLine[];
  recentPurchases: ProductPurchaseLine[];
  /** The batches still holding stock, oldest first — FIFO consumption order. */
  lots: ProductLot[];
  /** Value of the units on hand whose cost is known. */
  stockValueByCurrency: MoneyByCurrency;
  /** Units on hand whose cost is known — the coverage of `stockValue`. */
  costedUnits: number;
  /** Units on hand with no established cost. Never valued, always disclosed. */
  uncostedUnits: number;

  /**
   * Retired certificates across every batch of this product, newest first.
   *
   * Deliberately product-wide rather than per lot, because it is also the only
   * place the legacy rows surface — documents filed before certificates moved
   * to batches carry no lot and would otherwise be invisible.
   *
   * There is no product-level *current* certificate. A product does not have
   * one; its lots do, and `lots[].certificate` is where they live.
   */
  certificateHistory: CertificateView[];
  /**
   * Whether a hard delete is possible. False once the product has appeared on
   * an order or a purchase — see `deleteProduct`.
   */
  deletable: boolean;
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: SafeError };

// ---------------------------------------------------------------------------
// Querying
// ---------------------------------------------------------------------------

/**
 * How each sortable column maps to an `orderBy`.
 *
 * The keys are whitelisted in src/lib/product-query.ts, where the query string
 * is parsed, so nothing arbitrary reaches the query builder. This table is the
 * other half of that: it exists because "supplier" is a relation rather than a
 * column and cannot be passed straight through.
 */
const SORT_COLUMNS: Record<Exclude<ProductSortKey, "supplier">, string> = {
  name: "name",
  sku: "sku",
  category: "category",
  sellingPrice: "sellingPrice",
  stockQuantity: "stockQuantity",
  createdAt: "createdAt",
};

function buildWhere(params: ProductListParams): Prisma.ProductWhereInput {
  const filters: Prisma.ProductWhereInput[] = [];

  if (params.search) {
    // One box, both columns. Someone looking for a product types either its
    // name or the code off the shelf label, and does not want to pick which
    // first.
    filters.push({
      OR: [
        { name: { contains: params.search, mode: "insensitive" } },
        { sku: { contains: params.search, mode: "insensitive" } },
      ],
    });
  }

  if (params.category) filters.push({ category: params.category });
  if (params.status) filters.push({ status: params.status });
  if (params.supplierId) filters.push({ supplierId: params.supplierId });

  return filters.length > 0 ? { AND: filters } : {};
}

function buildOrderBy(
  params: ProductListParams,
): Prisma.ProductOrderByWithRelationInput[] {
  const direction = params.direction;

  const primary: Prisma.ProductOrderByWithRelationInput =
    params.sort === "supplier"
      ? // Nulls sort last either way, so an unassigned supplier does not take
        // over the top of the page.
        { supplier: { name: direction } }
      : { [SORT_COLUMNS[params.sort]]: direction };

  // A stable tiebreak. Without one, two products with the same category come
  // back in whatever order Postgres feels like, which means a row can appear on
  // two different pages — or on neither.
  return params.sort === "sku" ? [primary] : [primary, { sku: "asc" }];
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listProducts(
  params: ProductListParams,
): Promise<Result<ProductListPage>> {
  try {
    const where = buildWhere(params);
    const pageSize = params.pageSize;

    const [total, rows] = await Promise.all([
      prisma.product.count({ where }),
      prisma.product.findMany({
        where,
        orderBy: buildOrderBy(params),
        skip: (params.page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          name: true,
          sku: true,
          description: true,
          category: true,
          sellingPrice: true,
          priceCurrency: true,
          stockQuantity: true,
          status: true,
          supplierId: true,
          createdAt: true,
          supplier: { select: { name: true } },
        },
      }),
    ]);

    return {
      ok: true,
      data: {
        items: rows.map((row) => ({
          id: row.id,
          name: row.name,
          sku: row.sku,
          description: row.description,
          category: row.category,
          sellingPrice: row.sellingPrice?.toString() ?? null,
          priceCurrency: row.priceCurrency,
          stockQuantity: row.stockQuantity,
          status: row.status,
          supplierId: row.supplierId,
          supplierName: row.supplier?.name ?? null,
          createdAt: row.createdAt,
        })),
        total,
        page: params.page,
        pageSize,
        pageCount: Math.max(1, Math.ceil(total / pageSize)),
      },
    };
  } catch (error) {
    return { ok: false, error: toSafeError(error, "listProducts") };
  }
}

/**
 * Catalogue totals for the tiles above the table.
 *
 * One pass rather than three queries. Counted across the whole catalogue, not
 * the current filter — these describe the warehouse, not the page.
 */
interface StatsRow {
  total: number;
  uncosted_units: number;
}

/** One row per currency the costed lots were bought in. */
interface StatsValueRow {
  currency: Currency | null;
  stock_value: string;
}

export async function loadProductStats(): Promise<Result<ProductStats>> {
  try {
    /*
     * Valuation comes from the lots, not from a column on the product.
     *
     * The old form of this query was `SUM(stock_quantity * cost_price)`, which
     * asserted that every unit on hand was bought at the same price — the
     * assumption this whole change set exists to remove. A part bought at
     * ₹8,000, then ₹9,500, then ₹7,800 has no single cost, and multiplying the
     * balance by whichever figure was last typed into the catalogue produced a
     * number that was wrong in a way nobody could see.
     *
     * The two lot subqueries are uncorrelated, so Postgres evaluates each once
     * rather than per product row. Units with no known cost are deliberately
     * absent from the value and counted separately: excluding them understates
     * the total, which is why the count travels alongside and the tile shows
     * both. Valuing them at zero, or at a guess, would misstate it instead —
     * and invisibly.
     */
    const [rows, values] = await Promise.all([
      prisma.$queryRaw<StatsRow[]>`
        SELECT
          COUNT(*)::int                                    AS total,
          COALESCE((
            SELECT SUM(l.quantity_remaining)
            FROM stock_lots l
            WHERE l.quantity_remaining > 0 AND l.unit_cost IS NULL
          ), 0)::int                                       AS uncosted_units
        FROM products
      `,
      /*
       * The value, split by the currency the lot was bought in. A warehouse
       * stocked from two countries holds two valuations, and there is no rate
       * here to collapse them into one.
       */
      prisma.$queryRaw<StatsValueRow[]>`
        SELECT
          l.cost_currency                               AS currency,
          SUM(l.quantity_remaining * l.unit_cost)::text  AS stock_value
        FROM stock_lots l
        WHERE l.quantity_remaining > 0 AND l.unit_cost IS NOT NULL
        GROUP BY l.cost_currency
      `,
    ]);

    const totals = rows[0] ?? {
      total: 0,
      uncosted_units: 0,
    };

    return {
      ok: true,
      data: {
        total: totals.total,
        stockValueByCurrency: groupTotals(
          values.map((row) => ({
            currency: row.currency,
            amount: row.stock_value,
          })),
        ),
        uncostedUnits: totals.uncosted_units,
      },
    };
  } catch (error) {
    return { ok: false, error: toSafeError(error, "loadProductStats") };
  }
}

/**
 * The distinct categories in use, for the filter dropdown.
 *
 * Read from the products themselves because that is where a category lives —
 * it is a label on the row, not a table of its own. Never throws: a filter that
 * cannot be populated should degrade to an empty dropdown, not take the page
 * down with it.
 */
export async function loadCategories(): Promise<string[]> {
  try {
    const rows = await prisma.product.findMany({
      distinct: ["category"],
      orderBy: { category: "asc" },
      select: { category: true },
    });

    return rows.map((row) => row.category);
  } catch (error) {
    toSafeError(error, "loadCategories");
    return [];
  }
}

/*
 * Supplier options used to be loaded here, with a second copy in the purchases
 * module and no notion of a supplier being archived. Both are gone: there is
 * one loader, in src/server/suppliers.ts, and one rule about who may be picked.
 * Import it from there — this module deliberately no longer re-exports it.
 */

/**
 * Everything the detail page shows, in one round trip.
 *
 * The history lists are capped — a product that has moved thousands of times
 * should not send thousands of rows to render a "recent activity" panel.
 */
export async function getProductDetail(
  id: string,
): Promise<Result<ProductDetail | null>> {
  try {
    const product = await prisma.product.findUnique({
      where: { id },
      include: { supplier: { select: { id: true, name: true } } },
    });

    if (!product) return { ok: true, data: null };

    const [
      movements,
      orderLines,
      purchaseLines,
      tradedCount,
      certificateHistory,
      lots,
    ] = await Promise.all([
      prisma.stockTransaction.findMany({
        where: { productId: id },
        orderBy: { createdAt: "desc" },
        take: 20,
        include: { createdByUser: { select: { name: true } } },
      }),
      prisma.orderItem.findMany({
        where: { productId: id },
        orderBy: { order: { createdAt: "desc" } },
        take: 5,
        include: {
          order: {
            select: {
              orderNumber: true,
              status: true,
              currency: true,
              createdAt: true,
              customer: { select: { name: true } },
            },
          },
        },
      }),
      prisma.purchaseItem.findMany({
        where: { productId: id },
        orderBy: { purchase: { purchaseDate: "desc" } },
        take: 5,
        include: {
          purchase: {
            select: {
              purchaseNumber: true,
              status: true,
              currency: true,
              purchaseDate: true,
              supplier: { select: { name: true } },
            },
          },
        },
      }),
      // Whether the product has ever traded, which is what decides if it can
      // be deleted. A count of both sides in one number — the page only needs
      // the yes/no.
      prisma.orderItem
        .count({ where: { productId: id } })
        .then(async (orders) =>
          orders > 0
            ? orders
            : prisma.purchaseItem.count({ where: { productId: id } }),
        ),
      getCertificateHistory(id),
      /*
       * The batches still holding stock, in the order FIFO will take them.
       * Oldest first, which for a product carrying pre-costing stock means
       * the uncosted units appear at the top — they are genuinely the oldest,
       * and they are what the next sale will draw against.
       */
      prisma.stockLot.findMany({
        where: { productId: id, quantityRemaining: { gt: 0 } },
        orderBy: [{ receivedAt: "asc" }, { id: "asc" }],
        select: {
          id: true,
          unitCost: true,
          costCurrency: true,
          costSource: true,
          quantityReceived: true,
          quantityRemaining: true,
          receivedAt: true,
          sourceType: true,
          sourceId: true,
          status: true,
          statusChangedAt: true,
          statusNote: true,
        },
      }),
    ]);

    /*
     * Value what is known and count what is not. Deliberately two figures: a
     * single "stock value" covering only some of the units would understate
     * the shelf while looking authoritative, and valuing the unknown units at
     * zero or at some catalogue figure would misstate it invisibly.
     */
    const lotValues: { currency: Currency | null; amount: string }[] = [];
    let costedUnits = 0;
    let uncostedUnits = 0;

    for (const lot of lots) {
      if (lot.unitCost === null) {
        uncostedUnits += lot.quantityRemaining;
      } else {
        costedUnits += lot.quantityRemaining;
        /*
         * Each lot contributes to the bucket for the currency it was bought
         * in. A product restocked from two countries is worth two figures,
         * and `sumByCurrency` adds only the ones that agree.
         */
        const cents =
          Math.round(Number(lot.unitCost) * 100) * lot.quantityRemaining;
        lotValues.push({
          currency: lot.costCurrency,
          amount: (cents / 100).toFixed(2),
        });
      }
    }

    // Purchase numbers for the lots that came from a delivery, in one query
    // rather than one per lot.
    const purchaseIds = [
      ...new Set(
        lots
          .filter((lot) => lot.sourceType === "PURCHASE" && lot.sourceId)
          .map((lot) => lot.sourceId!),
      ),
    ];

    const purchaseNumbers = new Map<string, string>();

    if (purchaseIds.length > 0) {
      const rows = await prisma.purchase.findMany({
        where: { id: { in: purchaseIds } },
        select: { id: true, purchaseNumber: true },
      });
      for (const row of rows) purchaseNumbers.set(row.id, row.purchaseNumber);
    }

    /*
     * The paperwork for every batch on the page, in one query rather than one
     * per lot. A lot absent from the map simply has none, which is MISSING.
     */
    const lotCertificates = await getLotCertificates(lots.map((lot) => lot.id));

    return {
      ok: true,
      data: {
        id: product.id,
        name: product.name,
        sku: product.sku,
        description: product.description,
        category: product.category,
        sellingPrice: product.sellingPrice?.toString() ?? null,
        priceCurrency: product.priceCurrency,
        stockQuantity: product.stockQuantity,
        status: product.status,
        supplierId: product.supplier?.id ?? null,
        supplierName: product.supplier?.name ?? null,
        createdAt: product.createdAt,
        updatedAt: product.updatedAt,
        deletable: tradedCount === 0,
        certificateHistory,
        movements: movements.map((movement) => ({
          id: movement.id,
          type: movement.type,
          change: movement.newStock - movement.previousStock,
          previousStock: movement.previousStock,
          newStock: movement.newStock,
          note: movement.note,
          referenceType: movement.referenceType,
          referenceId: movement.referenceId,
          createdAt: movement.createdAt,
          createdByName: movement.createdByUser?.name ?? null,
        })),
        recentOrders: orderLines.map((line) => ({
          id: line.id,
          orderNumber: line.order.orderNumber,
          status: line.order.status,
          customerName: line.order.customer.name,
          quantity: line.quantity,
          unitPrice: line.unitPrice.toString(),
          total: line.total.toString(),
          currency: line.order.currency,
          createdAt: line.order.createdAt,
        })),
        recentPurchases: purchaseLines.map((line) => ({
          id: line.id,
          purchaseNumber: line.purchase.purchaseNumber,
          status: line.purchase.status,
          supplierName: line.purchase.supplier.name,
          quantity: line.quantity,
          unitCost: line.unitCost.toString(),
          total: line.total.toString(),
          currency: line.purchase.currency,
          purchaseDate: line.purchase.purchaseDate,
        })),
        lots: lots.map((lot) => {
          const certificate = lotCertificates.get(lot.id) ?? null;

          return {
            id: lot.id,
            unitCost: lot.unitCost?.toString() ?? null,
            costCurrency: lot.costCurrency,
            costSource: lot.costSource,
            status: lot.status,
            statusChangedAt: lot.statusChangedAt,
            statusNote: lot.statusNote,
            isReturn: lot.sourceType === "SALES_RETURN",
            quantityReceived: lot.quantityReceived,
            quantityRemaining: lot.quantityRemaining,
            receivedAt: lot.receivedAt,
            sourceType: lot.sourceType,
            sourceId: lot.sourceId,
            purchaseNumber: lot.sourceId
              ? (purchaseNumbers.get(lot.sourceId) ?? null)
              : null,
            certificate,
            // Derived here rather than stored, for the reason in
            // src/lib/certificate-status.ts: this value changes on its own as
            // dates pass, so a column would be wrong every morning.
            certificateStatus: certificateStatus(certificate),
          };
        }),
        stockValueByCurrency: sumByCurrency(lotValues),
        costedUnits,
        uncostedUnits,
      },
    };
  } catch (error) {
    return { ok: false, error: toSafeError(error, "getProductDetail") };
  }
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * A validation failure the form can attribute to a field. Thrown rather than
 * returned so every write path fails the same way; the action wrapper turns it
 * back into `fieldErrors` for the form.
 */
function fieldError(
  code: "BAD_REQUEST" | "CONFLICT" | "NOT_FOUND",
  field: keyof ProductFieldErrors,
  message: string,
): AppError {
  return new AppError(code, message, { field });
}

/** Prisma's unique-constraint code, matched structurally — see server/auth.ts. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "P2002"
  );
}

/** Prisma's foreign-key violation code. */
function isForeignKeyViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "P2003"
  );
}

const DUPLICATE_SKU = (sku: string) =>
  fieldError(
    "CONFLICT",
    "sku",
    `SKU "${sku}" is already used by another product. SKUs must be unique.`,
  );

const MISSING_SUPPLIER = fieldError(
  "BAD_REQUEST",
  "supplierId",
  "That supplier no longer exists. Pick another, or leave it unassigned.",
);

const ARCHIVED_SUPPLIER = (name: string) =>
  fieldError(
    "BAD_REQUEST",
    "supplierId",
    `"${name}" has been archived, so new products cannot be sourced from them. Pick an active supplier, leave it unassigned, or make them active again first.`,
  );

/**
 * Creates a product, and its opening stock along with it.
 *
 * Both halves are one database transaction. A product row whose quantity has no
 * movement behind it would be the single exception to the rule the whole ledger
 * rests on — that every unit on hand is explained by a transaction — and an
 * exception created at the exact moment a product enters the catalogue is the
 * worst place to have one.
 *
 * SKU uniqueness is enforced by the unique index, not by looking first. A check
 * followed by an insert has a gap between them, and two admins adding the same
 * code at once would both find nothing and both proceed; the index is the only
 * thing that can actually arbitrate.
 *
 * No certificate is accepted here, and the omission is the point. Paperwork
 * covers the batch that arrived, so it cannot be filed before a batch exists:
 * the workflow is create the product, receive or record stock, then attach the
 * certificate to the lot that produced it. A product with no stock has no lot
 * and therefore nothing to certify, which is why the create form offers no
 * certificate field at all rather than one that sometimes works.
 */
export async function createProduct(
  input: unknown,
): Promise<{ id: string; name: string; sku: string }> {
  const user = await requireRole("ADMIN");

  const parsed = createProductSchema.safeParse(input);
  if (!parsed.success) {
    const errors = toFieldErrors(parsed.error);
    const field = Object.keys(errors)[0] as
      keyof ProductFieldErrors | undefined;

    throw new AppError("BAD_REQUEST", firstIssueMessage(parsed.error), {
      field,
    });
  }

  const data = parsed.data;

  /*
   * The currency this product's price and opening stock are recorded in.
   *
   * Read once, outside the transaction, and used only to seed a record being
   * created right now — which is the whole and only remit of the installation
   * default. Nothing already stored is read through it.
   */
  const defaultCurrency = await getCurrency();

  try {
    return await prisma.$transaction(async (tx) => {
      /*
       * An archived supplier cannot be given new business, and a new catalogue
       * item sourced from them is new business.
       *
       * The product form already leaves archived suppliers out of its picker,
       * but a picker is a convenience, not the rule — this is a server action
       * reachable with any `supplierId` somebody cares to send, and a stale
       * form would send one in good faith. The rule lives here, where it cannot
       * be edited on the way in.
       *
       * Only on create. An existing product that already names an archived
       * supplier keeps that link and stays editable: `updateProduct` does not
       * make this check, because taking a supplier out of circulation must not
       * strand the catalogue rows already pointing at them.
       */
      if (data.supplierId) {
        const supplier = await tx.supplier.findUnique({
          where: { id: data.supplierId },
          select: { name: true, status: true },
        });

        if (!supplier) throw MISSING_SUPPLIER;
        if (supplier.status !== "ACTIVE") {
          throw ARCHIVED_SUPPLIER(supplier.name);
        }
      }

      const product = await tx.product.create({
        data: {
          sku: data.sku,
          name: data.name,
          description: data.description,
          category: data.category,
          sellingPrice: data.sellingPrice?.toFixed(2) ?? null,
          /*
           * Paired with the price, and derived from it rather than set
           * independently: a part that is only ever quoted carries no price
           * and therefore nothing to denominate. A price gets the default
           * because it is being entered now.
           */
          priceCurrency:
            data.sellingPrice === null || data.sellingPrice === undefined
              ? null
              : defaultCurrency,
          // Zero, then moved by the ledger — never written straight from input.
          stockQuantity: 0,
          status: data.status,
          supplierId: data.supplierId,
        },
        select: { id: true, name: true, sku: true },
      });

      /*
       * Only what the operator declared, and they had to declare something:
       * the schema refuses an opening quantity that does not say whether its
       * cost is known. An UNKNOWN declaration carries its reason into the
       * ledger note, so the resulting uncosted lot is a decision somebody made
       * rather than a field somebody skipped.
       *
       * Guarded on quantity because a product that opens holding nothing has no
       * batch to cost, and therefore nothing to declare — `openingStockCost`
       * would have no legal shape to return.
       */
      if (data.stockQuantity > 0) {
        await recordOpeningStock(tx, {
          productId: product.id,
          quantity: data.stockQuantity,
          userId: user.id,
          cost: openingStockCost(data, defaultCurrency),
        });
      }

      return product;
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw DUPLICATE_SKU(data.sku);
    if (isForeignKeyViolation(error)) throw MISSING_SUPPLIER;
    throw error;
  }
}

/**
 * Updates a product's catalogue details.
 *
 * `stockQuantity` is not in the update schema and is not written here. That is
 * the point of this function's existence in this shape: editing a product is a
 * catalogue operation, and letting it set a quantity would put a second,
 * unaudited path next to the stock engine — one where a number changes and the
 * ledger never hears about it. Corrections go through `adjustStock`.
 *
 * The supplier rule it does enforce: an archived supplier can be kept but not
 * newly chosen. See the comment inside.
 */
export async function updateProduct(
  id: string,
  input: unknown,
): Promise<{ id: string; name: string; sku: string }> {
  await requireRole("ADMIN");

  const parsed = updateProductSchema.safeParse(input);
  if (!parsed.success) {
    const errors = toFieldErrors(parsed.error);
    const field = Object.keys(errors)[0] as
      keyof ProductFieldErrors | undefined;

    throw new AppError("BAD_REQUEST", firstIssueMessage(parsed.error), {
      field,
    });
  }

  const data = parsed.data;

  /*
   * Only ever used for a product that has no price currency yet. An existing
   * one is preserved above, so changing the setting cannot re-denominate a
   * price that is already recorded.
   */
  const defaultCurrency = await getCurrency();

  try {
    return await prisma.$transaction(async (tx) => {
      /*
       * An archived supplier may be *kept*, but never newly *chosen*.
       *
       * The distinction is the whole rule. Archiving takes a supplier out of
       * circulation for new business; it does not reach back into the catalogue
       * and strand the products already sourced from them. So a product that
       * already names an archived supplier stays editable with that supplier
       * intact — renaming it, repricing it, retiring it all still work — while
       * moving a *different* product onto that supplier is refused.
       *
       * Comparing against the product's current `supplierId` is what separates
       * the two, and it is read inside this transaction so a concurrent edit
       * cannot slip between the check and the write.
       */
      const existing = await tx.product.findUnique({
        where: { id },
        select: { supplierId: true, priceCurrency: true },
      });

      if (!existing) throw new NotFoundError("Product");

      const changingSupplier = data.supplierId !== existing.supplierId;

      if (data.supplierId && changingSupplier) {
        const supplier = await tx.supplier.findUnique({
          where: { id: data.supplierId },
          select: { name: true, status: true },
        });

        if (!supplier) throw MISSING_SUPPLIER;
        if (supplier.status !== "ACTIVE") {
          throw ARCHIVED_SUPPLIER(supplier.name);
        }
      }

      return await tx.product.update({
        where: { id },
        data: {
          sku: data.sku,
          name: data.name,
          description: data.description,
          category: data.category,
          sellingPrice: data.sellingPrice?.toFixed(2) ?? null,
          /*
           * Clearing the price clears the currency with it; setting one keeps
           * whatever this product was already priced in.
           *
           * Keeping it is the load-bearing half. Falling back to the
           * installation default here would mean that editing a product's
           * name, months after its price was set, silently re-denominated
           * that price to whatever the setting says today — the precise fault
           * this whole change exists to remove, reintroduced through an
           * unrelated edit. Only a product with no currency at all gets the
           * default, and then only because it is being priced now.
           *
           * Re-pricing a part in a *different* currency is a deliberate act
           * and needs the form to say so; it has no way to express that yet,
           * so it is not silently inferred here.
           */
          priceCurrency:
            data.sellingPrice === null || data.sellingPrice === undefined
              ? null
              : (existing.priceCurrency ?? defaultCurrency),
          status: data.status,
          supplierId: data.supplierId,
        },
        select: { id: true, name: true, sku: true },
      });
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw DUPLICATE_SKU(data.sku);
    if (isForeignKeyViolation(error)) throw MISSING_SUPPLIER;
    if (
      typeof error === "object" &&
      error !== null &&
      (error as { code?: unknown }).code === "P2025"
    ) {
      throw new NotFoundError("Product");
    }
    throw error;
  }
}

/**
 * Deletes a product — but only one that has never traded.
 *
 * The moment a product appears on an order or a purchase it is part of somebody
 * else's history: a document that has to keep meaning what it said, with a line
 * pointing at this row. Deleting it then is not tidying up, it is editing the
 * past, and the `Restrict` foreign keys would refuse anyway. Those products get
 * retired instead — set the status to DISCONTINUED, which the edit form does.
 *
 * A product that has never traded is a different thing: a typo, a duplicate, an
 * item added by mistake. Its stock transactions describe nothing but its own
 * balance, and with the product gone there is no balance left to explain, so
 * they go with it — explicitly, in the same transaction, rather than by leaving
 * a cascade in place that could one day take real history with it.
 */
export async function deleteProduct(id: string): Promise<{ name: string }> {
  await requireRole("ADMIN");

  /*
   * Collected before the delete, because afterwards there is nothing left to
   * ask. The foreign key cascade removes the certificate rows; nothing but this
   * removes the files they pointed at, since a database constraint cannot reach
   * into a filesystem or a bucket.
   */
  const storageKeys = await certificateKeysForProduct(id);

  const result = await prisma.$transaction(async (tx) => {
    const product = await tx.product.findUnique({
      where: { id },
      select: { id: true, name: true },
    });

    if (!product) throw new NotFoundError("Product");

    const [orderLines, purchaseLines] = await Promise.all([
      tx.orderItem.count({ where: { productId: id } }),
      tx.purchaseItem.count({ where: { productId: id } }),
    ]);

    if (orderLines > 0 || purchaseLines > 0) {
      throw new AppError(
        "CONFLICT",
        `"${product.name}" appears on existing orders or purchases, so it cannot be deleted. Set its status to Discontinued instead — that keeps the history intact and takes it out of circulation.`,
      );
    }

    /*
     * Paperwork first, then the valuation layer, then the ledger it hangs off,
     * then the product. Every foreign key involved is Restrict, so this order
     * is not a preference — a certificate pointing at a deleted lot, a lot
     * pointing at a deleted STOCK_IN, or a consumption pointing at a deleted
     * lot is a state the database will not allow to exist, and doing this in
     * the wrong order fails loudly rather than silently orphaning anything.
     *
     * Certificates are deleted explicitly rather than left to a cascade. They
     * used to go with the product through `onDelete: Cascade`, which was
     * enough when they pointed only at products; now that they also point at
     * lots with `onDelete: Restrict`, the cascade would let the lot delete
     * below fail on any product carrying paperwork.
     *
     * Safe only because of the check above: a product that has never appeared
     * on an order or a purchase has no history worth keeping, and its lots
     * describe opening stock that is about to stop existing. Anything that has
     * traded is refused before reaching here and gets discontinued instead.
     */
    await tx.certificate.deleteMany({ where: { productId: id } });
    await tx.stockLotConsumption.deleteMany({ where: { lot: { productId: id } } });
    await tx.stockLot.deleteMany({ where: { productId: id } });
    await tx.stockTransaction.deleteMany({ where: { productId: id } });
    await tx.product.delete({ where: { id } });

    return { name: product.name };
  });

  /*
   * Files last, and only once the transaction has committed. Deleting them
   * first would destroy documents that a rolled-back delete was supposed to
   * keep; deleting them after means the worst case is an orphan file, which
   * costs disk and nothing else.
   */
  await deleteStoredFiles(storageKeys);

  return result;
}

export interface AdjustmentOutcome {
  productId: string;
  productName: string;
  previousStock: number;
  newStock: number;
  transactionId: string;
}

/**
 * A manual stock correction.
 *
 * This function is a translation and nothing more: it turns "decrease 20" into
 * the signed movement the stock engine takes, and hands it over. Everything
 * that makes the operation safe lives in `recordStockMovement` — the ADMIN
 * check, resolving the session to a local user, the row lock, the
 * non-negative check, and writing the quantity and the ledger row in one
 * transaction. Reimplementing any of that here would be a second version of it
 * to keep in step.
 *
 * The one thing worth noticing is what is *not* passed through: no `createdBy`.
 * The caller cannot supply one, because the parameter does not exist.
 */
export async function adjustStock(
  input: unknown,
): Promise<AdjustmentOutcome> {
  const parsed = stockAdjustmentSchema.safeParse(input);

  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path[0] as
      keyof StockAdjustmentInput | undefined;

    throw new AppError("BAD_REQUEST", firstIssueMessage(parsed.error), {
      field,
    });
  }

  const adjustment = parsed.data;

  /*
   * An increase creates a batch, so it has to say what that batch cost.
   *
   * The value is whatever the operator stated and nothing else: a declared
   * cost becomes an ADJUSTMENT lot at that price, a declared unknown becomes
   * an UNKNOWN lot at no price, and a decrease supplies nothing because it
   * draws from lots that already carry their own. Nothing is defaulted from
   * the catalogue row or from anywhere else — see `adjustmentCost`.
   */
  const { transaction, previousStock, newStock } = await recordStockMovement(
    {
      productId: adjustment.productId,
      type: "ADJUSTMENT",
      quantity: adjustmentDelta(adjustment),
      reference: { type: "MANUAL" },
      note: adjustmentNote(adjustment),
    },
    // The installation default, used the one way it legitimately can be: to
    // seed a brand-new entry. It never labels anything already stored.
    adjustmentCost(adjustment, await getCurrency()),
  );

  const product = await prisma.product.findUnique({
    where: { id: adjustment.productId },
    select: { name: true },
  });

  return {
    productId: adjustment.productId,
    productName: product?.name ?? "Product",
    previousStock,
    newStock,
    transactionId: transaction.id,
  };
}
