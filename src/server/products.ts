import "server-only";

import type { Prisma } from "@/generated/prisma/client";
import type { ProductStatus } from "@/generated/prisma/enums";
import { AppError, NotFoundError, toSafeError, type SafeError } from "@/lib/errors";
import { certificateStatus, type CertificateStatus } from "@/lib/certificate-status";
import { prisma } from "@/lib/prisma";
import type { ProductListParams, ProductSortKey } from "@/lib/product-query";
import { stockStatus, type StockStatus } from "@/lib/stock-status";
import {
  adjustmentDelta,
  stockAdjustmentSchema,
  type StockAdjustmentInput,
} from "@/lib/validation/adjustment";
import {
  createProductSchema,
  firstIssueMessage,
  toFieldErrors,
  updateProductSchema,
  type ProductFieldErrors,
} from "@/lib/validation/product";
import { requireRole } from "@/server/auth";
import {
  certificateKeysForProduct,
  deleteStoredFiles,
  getCertificateHistory,
  getCurrentCertificate,
  prepareCertificate,
  type CertificateView,
} from "@/server/certificates";
import { fileStorage } from "@/server/storage";
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
  costPrice: string;
  sellingPrice: string;
  stockQuantity: number;
  minimumStock: number;
  status: ProductStatus;
  supplierId: string | null;
  supplierName: string | null;
  /** Derived from the two quantities above — never read from a column. */
  stockStatus: StockStatus;
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
  lowStock: number;
  outOfStock: number;
  /** Stock at cost, as a string — see the note about Decimal above. */
  stockValue: string;
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
  purchaseDate: Date;
}

export interface ProductDetail {
  id: string;
  name: string;
  sku: string;
  description: string | null;
  category: string;
  costPrice: string;
  sellingPrice: string;
  stockQuantity: number;
  minimumStock: number;
  status: ProductStatus;
  stockStatus: StockStatus;
  supplierId: string | null;
  supplierName: string | null;
  createdAt: Date;
  updatedAt: Date;
  movements: ProductMovement[];
  recentOrders: ProductOrderLine[];
  recentPurchases: ProductPurchaseLine[];

  /** The product's current certificate, or null if it has none. */
  certificate: CertificateView | null;
  /** Retired certificates, newest first — the paperwork's audit trail. */
  certificateHistory: CertificateView[];
  /** Derived from the certificate's expiry date; never stored. */
  certificateStatus: CertificateStatus;
  /**
   * Whether a hard delete is possible. False once the product has appeared on
   * an order or a purchase — see `deleteProduct`.
   */
  deletable: boolean;
}

export interface SupplierOption {
  id: string;
  name: string;
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
  costPrice: "costPrice",
  sellingPrice: "sellingPrice",
  stockQuantity: "stockQuantity",
  minimumStock: "minimumStock",
  createdAt: "createdAt",
};

/**
 * The three stock-status rules, as a database filter.
 *
 * These have to match `stockStatus()` in src/lib/stock-status.ts exactly. They
 * cannot share an implementation — one is a comparison on two numbers, the
 * other is SQL — so the boundaries are written out here in the same order, and
 * the tests check the two agree rather than trusting that they do.
 *
 * `prisma.product.fields.minimumStock` is a column reference: it compares
 * `stock_quantity` against `minimum_stock` row by row, which is the whole point
 * — a literal would only ever filter against one threshold for every product.
 */
function stockStatusWhere(status: StockStatus): Prisma.ProductWhereInput {
  switch (status) {
    case "OUT_OF_STOCK":
      return { stockQuantity: { lte: 0 } };
    case "LOW_STOCK":
      return {
        stockQuantity: { gt: 0, lte: prisma.product.fields.minimumStock },
      };
    case "NORMAL":
      return { stockQuantity: { gt: prisma.product.fields.minimumStock } };
  }
}

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
  if (params.stockStatus) filters.push(stockStatusWhere(params.stockStatus));

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
          costPrice: true,
          sellingPrice: true,
          stockQuantity: true,
          minimumStock: true,
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
          costPrice: row.costPrice.toString(),
          sellingPrice: row.sellingPrice.toString(),
          stockQuantity: row.stockQuantity,
          minimumStock: row.minimumStock,
          status: row.status,
          supplierId: row.supplierId,
          supplierName: row.supplier?.name ?? null,
          stockStatus: stockStatus(row),
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
 * One pass rather than four counts, and the low/out-of-stock figures use the
 * same boundaries as `stockStatus()`. Counted across the whole catalogue, not
 * the current filter — these describe the warehouse, not the page.
 */
interface StatsRow {
  total: number;
  low_stock: number;
  out_of_stock: number;
  stock_value: string;
}

export async function loadProductStats(): Promise<Result<ProductStats>> {
  try {
    const rows = await prisma.$queryRaw<StatsRow[]>`
      SELECT
        COUNT(*)::int                                       AS total,
        COUNT(*) FILTER (
          WHERE stock_quantity > 0 AND stock_quantity <= minimum_stock
        )::int                                              AS low_stock,
        COUNT(*) FILTER (WHERE stock_quantity <= 0)::int    AS out_of_stock,
        COALESCE(SUM(stock_quantity * cost_price), 0)::text AS stock_value
      FROM products
    `;

    const totals = rows[0] ?? {
      total: 0,
      low_stock: 0,
      out_of_stock: 0,
      stock_value: "0",
    };

    return {
      ok: true,
      data: {
        total: totals.total,
        lowStock: totals.low_stock,
        outOfStock: totals.out_of_stock,
        stockValue: totals.stock_value,
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

export async function loadSuppliers(): Promise<SupplierOption[]> {
  try {
    return await prisma.supplier.findMany({
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    });
  } catch (error) {
    toSafeError(error, "loadSuppliers");
    return [];
  }
}

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
      certificate,
      certificateHistory,
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
        getCurrentCertificate(id),
        getCertificateHistory(id),
      ]);

    return {
      ok: true,
      data: {
        id: product.id,
        name: product.name,
        sku: product.sku,
        description: product.description,
        category: product.category,
        costPrice: product.costPrice.toString(),
        sellingPrice: product.sellingPrice.toString(),
        stockQuantity: product.stockQuantity,
        minimumStock: product.minimumStock,
        status: product.status,
        stockStatus: stockStatus(product),
        supplierId: product.supplier?.id ?? null,
        supplierName: product.supplier?.name ?? null,
        createdAt: product.createdAt,
        updatedAt: product.updatedAt,
        deletable: tradedCount === 0,
        certificate,
        certificateHistory,
        // Derived here rather than stored, for the reason in
        // src/lib/certificate-status.ts: this value changes on its own as
        // dates pass, so a column would be wrong every morning.
        certificateStatus: certificateStatus(certificate),
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
          purchaseDate: line.purchase.purchaseDate,
        })),
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
 */
export interface CertificateUpload {
  metadata: unknown;
  file: unknown;
}

export async function createProduct(
  input: unknown,
  /**
   * A certificate to attach at the same time. Optional, deliberately: a product
   * can exist before its paperwork arrives, and requiring one here would make
   * the common case of "receive the part now, file the 8130 when it turns up"
   * impossible to record.
   */
  certificate?: CertificateUpload | null,
): Promise<{ id: string; name: string; sku: string }> {
  const user = await requireRole("ADMIN");

  const parsed = createProductSchema.safeParse(input);
  if (!parsed.success) {
    const errors = toFieldErrors(parsed.error);
    const field = Object.keys(errors)[0] as
      | keyof ProductFieldErrors
      | undefined;

    throw new AppError("BAD_REQUEST", firstIssueMessage(parsed.error), {
      field,
    });
  }

  const data = parsed.data;

  /*
   * Validated and stored before the transaction opens, so the certificate row
   * can be written in the *same* transaction as the product. Creating the
   * product first and attaching afterwards would leave an unwanted product
   * behind whenever the upload was rejected, and need a compensating delete
   * that can itself fail. See `prepareCertificate`.
   */
  const prepared = certificate ? await prepareCertificate(certificate) : null;

  try {
    return await prisma.$transaction(async (tx) => {
      const product = await tx.product.create({
        data: {
          sku: data.sku,
          name: data.name,
          description: data.description,
          category: data.category,
          costPrice: data.costPrice.toFixed(2),
          sellingPrice: data.sellingPrice.toFixed(2),
          // Zero, then moved by the ledger — never written straight from input.
          stockQuantity: 0,
          minimumStock: data.minimumStock,
          status: data.status,
          supplierId: data.supplierId,
          certificates: prepared
            ? { create: [{ ...prepared.data, uploadedBy: user.id }] }
            : undefined,
        },
        select: { id: true, name: true, sku: true },
      });

      await recordOpeningStock(tx, {
        productId: product.id,
        quantity: data.stockQuantity,
        userId: user.id,
      });

      return product;
    });
  } catch (error) {
    // The row was never written, so the file it would have pointed at is
    // unreferenced. Best-effort: a failed cleanup leaves a harmless orphan and
    // must not replace the real error with a second one.
    if (prepared) {
      await fileStorage.delete(prepared.storageKey).catch(() => {});
    }

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
      | keyof ProductFieldErrors
      | undefined;

    throw new AppError("BAD_REQUEST", firstIssueMessage(parsed.error), {
      field,
    });
  }

  const data = parsed.data;

  try {
    return await prisma.product.update({
      where: { id },
      data: {
        sku: data.sku,
        name: data.name,
        description: data.description,
        category: data.category,
        costPrice: data.costPrice.toFixed(2),
        sellingPrice: data.sellingPrice.toFixed(2),
        minimumStock: data.minimumStock,
        status: data.status,
        supplierId: data.supplierId,
      },
      select: { id: true, name: true, sku: true },
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

    await tx.stockTransaction.deleteMany({ where: { productId: id } });
    // The certificates go with it through `onDelete: Cascade` — a certificate
    // describes one product and has no meaning without it.
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
 * check, resolving the Clerk session to a local user, the row lock, the
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
      | keyof StockAdjustmentInput
      | undefined;

    throw new AppError("BAD_REQUEST", firstIssueMessage(parsed.error), {
      field,
    });
  }

  const adjustment = parsed.data;

  const { transaction, previousStock, newStock } = await recordStockMovement({
    productId: adjustment.productId,
    type: "ADJUSTMENT",
    quantity: adjustmentDelta(adjustment),
    reference: { type: "MANUAL" },
    note: adjustment.reason,
  });

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
