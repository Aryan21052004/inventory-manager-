import "server-only";

import type { FunctionDeclaration } from "@google/genai";
import { z } from "zod";

import type { UserRole } from "@/generated/prisma/enums";
import { coverageNote, marginOf } from "@/lib/cost-coverage";
import { sameKnownCurrency } from "@/lib/document-currency";
import { toIsoDay, type RawSearchParams } from "@/lib/date-range";
import { AppError, toSafeError, type SafeError } from "@/lib/errors";
import { QUARANTINED_LOT_STATUS, REJECTED_LOT_STATUS } from "@/lib/lot-status";
import { CUSTOMER_STATUSES, customersHref, parseCustomerListParams } from "@/lib/customer-query";
import { ordersHref, parseOrderListParams } from "@/lib/order-query";
import {
  allowedTransitions,
  canFulfilOutstanding,
  isEditable,
  ORDER_STATUSES,
  orderStatusLabel,
  transitionRefusal,
  type OrderStatus,
} from "@/lib/order-status";
import { PRODUCT_STATUSES, parseProductListParams, productsHref } from "@/lib/product-query";
import { parsePurchaseListParams, purchasesHref } from "@/lib/purchase-query";
import { PURCHASE_STATUSES } from "@/lib/purchase-status";
import {
  describeRange,
  REPORT_CONFIG,
  reportHref,
  reportParamsFor,
  type ReportDefaults,
  type ReportKey,
} from "@/lib/report-query";
import { MOVEMENT_TYPES, movementsHref, parseMovementListParams } from "@/lib/stock-movement-query";
import { parseSupplierListParams, SUPPLIER_STATUSES, suppliersHref } from "@/lib/supplier-query";
import { getCustomerDetail, listCustomers } from "@/server/customers";
import { loadAttention, loadCosting, loadInventory } from "@/server/dashboard";
import { listQuarantinedLots } from "@/server/lots";
import { getOrderDetail, listOrders } from "@/server/orders";
import {
  getProductDetail,
  listProducts,
  listProductsWithoutAvailableStock,
  loadStockAvailability,
} from "@/server/products";
import { getPurchaseDetail, listPurchases } from "@/server/purchases";
import {
  loadPurchaseSpendReport,
  loadSalesReport,
  loadValuationReport,
} from "@/server/reports";
import { listMovements } from "@/server/stock-movements";
import { getSupplierDetail, listSuppliers } from "@/server/suppliers";
import { listSupplyLinksForOrder } from "@/server/supply-links";

import { moneyView, recordMoney } from "./money";
import { PERIOD_DESCRIPTION, PERIODS, reportWindow } from "./periods";
import { toGeminiParameters } from "./schema";

/**
 * The inventory assistant's tools — the complete list of things the model can
 * ask the server to do.
 *
 * **Every tool is a read.** Each one calls an existing read-only loader in
 * `src/server/*` (or a pure rule in `src/lib/*`), the same functions the pages
 * render from. Nothing in this file writes, locks a row or imports a function
 * that does; `tests/assistant-boundaries.test.ts` holds that line by reading
 * this file's imports against an allowlist. The model never sees Prisma, SQL,
 * credentials or a generic "call a function" escape hatch — only the names
 * below, and the server decides what each one runs.
 *
 * **Arguments are untrusted.** They are produced by a model that has read
 * text out of the database, so each tool validates them with its own zod
 * schema before anything runs, and the declaration the model sees is derived
 * from that same schema (see ./schema.ts). Query-string-shaped arguments are
 * passed through the existing URL parsers — `parseOrderListParams`,
 * `reportParamsFor` and the rest — so sort keys, page sizes and date ranges
 * are whitelisted exactly as they are for a hand-edited URL, and the
 * assistant's figures are the figures the corresponding screen shows.
 *
 * **Results are trimmed on the way out.** Lists are capped, and customer and
 * supplier contact details (email, phone, address) are left out: they are not
 * needed to answer an inventory question and would otherwise be sent to a
 * third-party model on every lookup.
 *
 * **Money stays per currency.** Every amount goes through ./money.ts, which
 * passes `MoneyByCurrency` through unchanged plus the text the screens would
 * print. Nothing here adds across currencies.
 */

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** A link into the application, built here from ids the database returned. */
export interface AssistantSource {
  label: string;
  /** Always an in-app path beginning with `/`. */
  href: string;
}

/** Who is asking, resolved from the session by the route — never from the model. */
export interface ToolContext {
  role: UserRole;
  /** The request's clock, so periods such as "this month" are stable in a turn. */
  now: Date;
}

interface ToolOutcome {
  output: Record<string, unknown>;
  sources: AssistantSource[];
}

export type ToolInvocation =
  | { ok: true; output: Record<string, unknown>; sources: AssistantSource[] }
  | { ok: false; error: { code: string; message: string } };

export interface AssistantTool {
  name: string;
  /** A few words for the "looked up" list under an answer. */
  label: string;
  adminOnly: boolean;
  declaration: FunctionDeclaration;
  invoke(rawArgs: unknown, context: ToolContext): Promise<ToolInvocation>;
}

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

/**
 * The largest result handed back to the model, as JSON text. The row caps keep
 * real results well under it; this is the backstop that turns a pathological
 * one into an error the model can act on rather than a request that silently
 * grows past what the model can read.
 */
const MAX_RESULT_CHARACTERS = 24_000;

/** Rows per page for list tools. One of the sizes every list parser accepts. */
const LIST_SIZE = "25";
/** Rows per page for report tools. One of the report parser's sizes. */
const REPORT_SIZE = "25";

function defineTool<S extends z.ZodType>(definition: {
  name: string;
  label: string;
  description: string;
  args: S;
  adminOnly?: boolean;
  run: (args: z.output<S>, context: ToolContext) => Promise<ToolOutcome>;
}): AssistantTool {
  const parameters = toGeminiParameters(definition.args);

  return {
    name: definition.name,
    label: definition.label,
    adminOnly: definition.adminOnly ?? false,
    declaration: {
      name: definition.name,
      description: definition.description,
      ...(parameters ? { parameters } : {}),
    },
    async invoke(rawArgs, context) {
      const parsed = definition.args.safeParse(withoutNulls(rawArgs));

      if (!parsed.success) {
        return {
          ok: false,
          error: {
            code: "INVALID_ARGUMENTS",
            message: parsed.error.issues
              .map((issue) =>
                issue.path.length > 0
                  ? `${issue.path.join(".")}: ${issue.message}`
                  : issue.message,
              )
              .join("; "),
          },
        };
      }

      try {
        const outcome = await definition.run(parsed.data, context);

        if (JSON.stringify(outcome.output).length > MAX_RESULT_CHARACTERS) {
          return {
            ok: false,
            error: {
              code: "RESULT_TOO_LARGE",
              message: "That result is too large to read. Narrow the question (a filter, a shorter period) and try again.",
            },
          };
        }

        return { ok: true, ...outcome };
      } catch (error) {
        // Our own messages pass through; anything else is logged and replaced
        // with a generic line, so a database error cannot reach the model.
        const safe = toSafeError(error, `assistant tool ${definition.name}`);
        return { ok: false, error: { code: safe.code, message: safe.message } };
      }
    },
  };
}

/**
 * Optional arguments arrive as `null` as often as they arrive absent. Both
 * mean "not given", and treating them alike keeps every schema to plain
 * `.optional()`.
 */
function withoutNulls(value: unknown): unknown {
  if (value === null || value === undefined) return {};
  if (typeof value !== "object" || Array.isArray(value)) return value;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      ([, entry]) => entry !== null,
    ),
  );
}

/** A loader's failure, re-thrown with its code intact. */
function unwrap<T>(
  result: { ok: true; data: T } | { ok: false; error: SafeError },
): T {
  if (!result.ok) throw new AppError(result.error.code, result.error.message);
  return result.data;
}

/** A query string from loose values, the shape every parser here reads. */
function query(
  values: Record<string, string | number | boolean | null | undefined>,
): RawSearchParams {
  return Object.fromEntries(
    Object.entries(values)
      .filter(([, value]) => value !== undefined && value !== null && value !== "")
      .map(([key, value]) => [key, String(value)]),
  );
}

function day(value: Date | null): string | null {
  return value ? toIsoDay(value) : null;
}

function instant(value: Date): string {
  return value.toISOString();
}

function round1(value: number | null): number | null {
  return value === null ? null : Math.round(value * 10) / 10;
}

function paging(
  result: { total: number; page: number; pageCount: number },
  shown: number,
) {
  return {
    totalMatching: result.total,
    page: result.page,
    pageCount: result.pageCount,
    shown,
    moreAvailable: result.page < result.pageCount,
  };
}

const path = {
  product: (id: string) => `/products/${encodeURIComponent(id)}`,
  order: (id: string) => `/orders/${encodeURIComponent(id)}`,
  purchase: (id: string) => `/purchases/${encodeURIComponent(id)}`,
  customer: (id: string) => `/customers/${encodeURIComponent(id)}`,
  supplier: (id: string) => `/suppliers/${encodeURIComponent(id)}`,
};

/** The defaults a report's URL leaves out — exactly as the report page builds them. */
function reportDefaults(report: ReportKey): ReportDefaults {
  const config = REPORT_CONFIG[report];

  return {
    grouping: config.defaultGrouping,
    sort: config.defaultSort,
    direction: config.defaultDirection,
    productStatus:
      "defaultProductStatus" in config ? config.defaultProductStatus : null,
  };
}

function nothingFound(message: string, extra: Record<string, unknown> = {}): ToolOutcome {
  return { output: { found: false, message, ...extra }, sources: [] };
}

function ambiguous(
  what: string,
  candidates: Record<string, unknown>[],
): ToolOutcome {
  return {
    output: {
      found: false,
      ambiguous: true,
      message: `Several ${what} match. Ask the user which one they mean.`,
      candidates: candidates.slice(0, 10),
    },
    sources: [],
  };
}

type Resolved = { id: string } | { outcome: ToolOutcome };

// ---------------------------------------------------------------------------
// Shared argument schemas
// ---------------------------------------------------------------------------

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function isCalendarDay(value: string): boolean {
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && toIsoDay(date) === value;
}

const isoDay = (description: string) =>
  z
    .string()
    .regex(ISO_DAY, "Use the YYYY-MM-DD format.")
    .refine(isCalendarDay, "Not a real calendar date.")
    .describe(description)
    .optional();

const text = (description: string) =>
  z.string().trim().max(120).describe(description).optional();

const recordId = (description: string) =>
  z.string().trim().min(1).max(64).describe(description).optional();

const page = z
  .number()
  .int()
  .min(1)
  .max(50)
  .describe("Result page, starting at 1. Only needed when an earlier result said more rows are available.")
  .optional();

const period = z.enum(PERIODS).describe(PERIOD_DESCRIPTION).optional();
const fromDay = isoDay("Inclusive start date (YYYY-MM-DD, UTC) for a custom period.");
const toDay = isoDay("Inclusive end date (YYYY-MM-DD, UTC) for a custom period. Defaults to today.");

/** The movement types, as the tuple `z.enum` wants. */
const movementTypes = MOVEMENT_TYPES as [
  (typeof MOVEMENT_TYPES)[number],
  ...(typeof MOVEMENT_TYPES)[number][],
];

// ---------------------------------------------------------------------------
// Resolving human identifiers
// ---------------------------------------------------------------------------

/**
 * A product from an id or an exact part number.
 *
 * Through the catalogue search the products page uses (a partial match on
 * name or SKU), then narrowed to the exact SKU here: no second query shape,
 * and a near miss comes back as suggestions rather than as the wrong part.
 */
async function resolveProduct(args: {
  productId?: string;
  sku?: string;
}): Promise<Resolved> {
  if (args.productId) return { id: args.productId };

  const sku = (args.sku ?? "").trim();
  const result = unwrap(
    await listProducts(parseProductListParams(query({ q: sku, size: 100 }))),
  );

  const exact = result.items.filter((item) => item.sku === sku);
  const matches =
    exact.length > 0
      ? exact
      : result.items.filter((item) => item.sku.toLowerCase() === sku.toLowerCase());

  if (matches.length === 1) return { id: matches[0]!.id };

  if (matches.length > 1) {
    return {
      outcome: ambiguous(
        "products",
        matches.map((item) => ({ productId: item.id, sku: item.sku, name: item.name })),
      ),
    };
  }

  return {
    outcome: nothingFound(`No product has the part number "${sku}".`, {
      similar: result.items
        .slice(0, 5)
        .map((item) => ({ sku: item.sku, name: item.name })),
    }),
  };
}

async function resolveOrder(args: {
  orderId?: string;
  orderNumber?: string;
}): Promise<Resolved> {
  if (args.orderId) return { id: args.orderId };

  const wanted = (args.orderNumber ?? "").trim();
  const result = unwrap(
    await listOrders(parseOrderListParams(query({ q: wanted, size: LIST_SIZE }))),
  );
  const match = result.items.find(
    (item) => item.orderNumber.toLowerCase() === wanted.toLowerCase(),
  );

  if (match) return { id: match.id };

  return {
    outcome: nothingFound(`No order has the number "${wanted}".`, {
      similar: result.items.slice(0, 5).map((item) => item.orderNumber),
    }),
  };
}

async function resolvePurchase(args: {
  purchaseId?: string;
  purchaseNumber?: string;
}): Promise<Resolved> {
  if (args.purchaseId) return { id: args.purchaseId };

  const wanted = (args.purchaseNumber ?? "").trim();
  const result = unwrap(
    await listPurchases(parsePurchaseListParams(query({ q: wanted, size: LIST_SIZE }))),
  );
  const match = result.items.find(
    (item) => item.purchaseNumber.toLowerCase() === wanted.toLowerCase(),
  );

  if (match) return { id: match.id };

  return {
    outcome: nothingFound(`No purchase has the number "${wanted}".`, {
      similar: result.items.slice(0, 5).map((item) => item.purchaseNumber),
    }),
  };
}

/**
 * A counterparty by name: an exact (case-insensitive) name wins, a search with
 * a single result is taken as meant, and anything else is handed back to the
 * model to ask about rather than guessed.
 */
function pickByName<T extends { id: string; name: string }>(
  wanted: string,
  items: readonly T[],
): { id: string } | { many: T[] } | null {
  const exact = items.filter(
    (item) => item.name.toLowerCase() === wanted.toLowerCase(),
  );

  if (exact.length === 1) return { id: exact[0]!.id };
  if (exact.length === 0 && items.length === 1) return { id: items[0]!.id };
  if (items.length === 0) return null;
  return { many: exact.length > 1 ? exact : [...items] };
}

async function resolveSupplier(args: {
  supplierId?: string;
  name?: string;
}): Promise<Resolved> {
  if (args.supplierId) return { id: args.supplierId };

  const wanted = (args.name ?? "").trim();
  const result = unwrap(
    await listSuppliers(parseSupplierListParams(query({ q: wanted, size: LIST_SIZE }))),
  );
  const picked = pickByName(wanted, result.items);

  if (picked === null) return { outcome: nothingFound(`No supplier matches "${wanted}".`) };
  if ("id" in picked) return { id: picked.id };

  return {
    outcome: ambiguous(
      "suppliers",
      picked.many.map((item) => ({ supplierId: item.id, name: item.name, status: item.status })),
    ),
  };
}

async function resolveCustomer(args: {
  customerId?: string;
  name?: string;
}): Promise<Resolved> {
  if (args.customerId) return { id: args.customerId };

  const wanted = (args.name ?? "").trim();
  const result = unwrap(
    await listCustomers(parseCustomerListParams(query({ q: wanted, size: LIST_SIZE }))),
  );
  const picked = pickByName(wanted, result.items);

  if (picked === null) return { outcome: nothingFound(`No customer matches "${wanted}".`) };
  if ("id" in picked) return { id: picked.id };

  return {
    outcome: ambiguous(
      "customers",
      picked.many.map((item) => ({ customerId: item.id, name: item.name, status: item.status })),
    ),
  };
}

// ---------------------------------------------------------------------------
// Products and stock
// ---------------------------------------------------------------------------

const AVAILABILITY_DEFINITION =
  "onHand is physical stock. saleable (available) = onHand minus units in quarantined or rejected batches; only saleable units can be sold or shipped.";

const searchProducts = defineTool({
  name: "search_products",
  label: "Product search",
  description:
    "Search the product catalogue by part number (SKU) or name. Returns physical stock on hand for each match. " +
    "For one product's saleable stock, batches, value or recent activity, call get_product instead.",
  args: z.strictObject({
    query: text("Part number (SKU) or product name, or a fragment of either."),
    status: z.enum(PRODUCT_STATUSES).describe("Only products with this catalogue status.").optional(),
    category: text("Only products in this exact category."),
    page,
  }),
  async run(args) {
    const params = parseProductListParams(
      query({ q: args.query, status: args.status, category: args.category, size: LIST_SIZE, page: args.page }),
    );
    const result = unwrap(await listProducts(params));

    const wanted = args.query?.toLowerCase();
    const isExact = (sku: string) => wanted !== undefined && sku.toLowerCase() === wanted;
    // An exact part-number hit leads, wherever the name ordering put it.
    const items = [...result.items].sort(
      (a, b) => Number(isExact(b.sku)) - Number(isExact(a.sku)),
    );

    return {
      output: {
        ...paging(result, items.length),
        note: "stockOnHand is physical stock and includes quarantined or rejected units. Use get_product for saleable stock.",
        products: items.map((item) => ({
          productId: item.id,
          sku: item.sku,
          name: item.name,
          category: item.category,
          status: item.status,
          stockOnHand: item.stockQuantity,
          supplier: item.supplierName,
          referencePrice:
            item.sellingPrice === null
              ? null
              : recordMoney(item.sellingPrice, item.priceCurrency),
          exactSkuMatch: isExact(item.sku),
          link: path.product(item.id),
        })),
      },
      sources:
        items.length === 1
          ? [{ label: `Product ${items[0]!.sku}`, href: path.product(items[0]!.id) }]
          : [{ label: "Matching products", href: productsHref(params) }],
    };
  },
});

const getProduct = defineTool({
  name: "get_product",
  label: "Product details",
  description:
    "One product in full: physical and saleable stock, quarantined or rejected units, value at cost with coverage, " +
    "stock batches (oldest first), recent stock movements, and recent orders and purchases. " +
    "Identify it by productId from an earlier result, or by its exact part number (sku).",
  args: z
    .strictObject({
      productId: recordId("Internal product id from an earlier tool result."),
      sku: text("The product's exact part number (SKU)."),
    })
    .refine((args) => Boolean(args.productId || args.sku), "Provide productId or sku."),
  async run(args) {
    const resolved = await resolveProduct(args);
    if ("outcome" in resolved) return resolved.outcome;

    const [detailResult, availabilityResult] = await Promise.all([
      getProductDetail(resolved.id),
      loadStockAvailability([resolved.id]),
    ]);

    const detail = unwrap(detailResult);
    if (!detail) return nothingFound("That product could not be found.");

    const availability = unwrap(availabilityResult).get(detail.id);

    const blockedBy = (status: string) =>
      detail.lots
        .filter((lot) => lot.status === status)
        .reduce((sum, lot) => sum + lot.quantityRemaining, 0);

    const BATCH_LIMIT = 10;
    const MOVEMENT_LIMIT = 10;

    return {
      output: {
        found: true,
        product: {
          productId: detail.id,
          sku: detail.sku,
          name: detail.name,
          category: detail.category,
          status: detail.status,
          supplier: detail.supplierName,
          referencePrice:
            detail.sellingPrice === null
              ? null
              : recordMoney(detail.sellingPrice, detail.priceCurrency),
          stock: {
            onHand: detail.stockQuantity,
            saleable: availability?.saleableQuantity ?? null,
            blocked: availability?.blockedQuantity ?? null,
            quarantined: blockedBy(QUARANTINED_LOT_STATUS),
            rejected: blockedBy(REJECTED_LOT_STATUS),
            definition: AVAILABILITY_DEFINITION,
          },
          valueAtCost: {
            value: moneyView(detail.stockValueByCurrency),
            costedUnits: detail.costedUnits,
            uncostedUnits: detail.uncostedUnits,
            note:
              detail.uncostedUnits > 0
                ? `${detail.uncostedUnits} units on hand have no recorded acquisition cost and are excluded from the value.`
                : null,
          },
          batches: detail.lots.slice(0, BATCH_LIMIT).map((lot) => ({
            status: lot.status,
            unitsRemaining: lot.quantityRemaining,
            unitsReceived: lot.quantityReceived,
            unitCost:
              lot.unitCost === null ? null : recordMoney(lot.unitCost, lot.costCurrency),
            costSource: lot.costSource,
            receivedOn: day(lot.receivedAt),
            purchaseNumber: lot.purchaseNumber,
            customerReturn: lot.isReturn,
            certificate: lot.certificateStatus,
          })),
          batchesShown: Math.min(detail.lots.length, BATCH_LIMIT),
          batchesWithStock: detail.lots.length,
          batchOrder: "Oldest first: the order the next sales will draw from.",
          recentMovements: detail.movements.slice(0, MOVEMENT_LIMIT).map((movement) => ({
            at: instant(movement.createdAt),
            type: movement.type,
            change: movement.change,
            balanceAfter: movement.newStock,
            reference: movement.referenceType,
            note: movement.note,
          })),
          recentOrders: detail.recentOrders.map((line) => ({
            orderNumber: line.orderNumber,
            status: line.status,
            customer: line.customerName,
            quantity: line.quantity,
            unitPrice: recordMoney(line.unitPrice, line.currency),
            lineTotal: recordMoney(line.total, line.currency),
            orderedOn: day(line.createdAt),
          })),
          recentPurchases: detail.recentPurchases.map((line) => ({
            purchaseNumber: line.purchaseNumber,
            status: line.status,
            supplier: line.supplierName,
            quantity: line.quantity,
            unitCost: recordMoney(line.unitCost, line.currency),
            lineTotal: recordMoney(line.total, line.currency),
            purchasedOn: day(line.purchaseDate),
          })),
          link: path.product(detail.id),
        },
      },
      sources: [{ label: `Product ${detail.sku}`, href: path.product(detail.id) }],
    };
  },
});

const listUnavailableProducts = defineTool({
  name: "list_products_without_available_stock",
  label: "Products without available stock",
  description:
    "Products with no saleable (available) stock right now, most-owed first. Also reports units already sold " +
    "on confirmed or completed orders that are still waiting to ship. Active products only unless includeInactive is true.",
  args: z.strictObject({
    includeInactive: z
      .boolean()
      .describe("Also include inactive and discontinued products.")
      .optional(),
    page,
  }),
  async run(args) {
    const result = unwrap(
      await listProductsWithoutAvailableStock({
        includeRetired: args.includeInactive ?? false,
        page: args.page ?? 1,
        pageSize: Number(LIST_SIZE),
      }),
    );

    return {
      output: {
        ...paging(result, result.items.length),
        scope: args.includeInactive ? "all products" : "active products only",
        definition: AVAILABILITY_DEFINITION,
        unitsOwedDefinition:
          "Units sold on confirmed or completed orders that have not shipped yet. They are not subtracted from stock.",
        products: result.items.map((item) => ({
          productId: item.productId,
          sku: item.sku,
          name: item.name,
          category: item.category,
          status: item.status,
          onHand: item.stockQuantity,
          blocked: item.blockedQuantity,
          saleable: item.saleableQuantity,
          unitsOwedToCustomers: item.unitsOwed,
          link: path.product(item.productId),
        })),
      },
      sources: [],
    };
  },
});

const listStockMovements = defineTool({
  name: "list_stock_movements",
  label: "Stock movements",
  description:
    "The stock ledger: every change to a product's quantity, newest first, with what caused it and what it cost. " +
    "Filter by productId, exact part number (sku), a product name/SKU fragment (query), movement type and dates.",
  args: z.strictObject({
    productId: recordId("Internal product id from an earlier tool result."),
    sku: text("A product's exact part number (SKU)."),
    query: text("A product name or SKU fragment."),
    type: z.enum(movementTypes).describe("Only movements of this type.").optional(),
    from: isoDay("Inclusive start date (YYYY-MM-DD, UTC) of when the movement was recorded."),
    to: isoDay("Inclusive end date (YYYY-MM-DD, UTC) of when the movement was recorded."),
    page,
  }),
  async run(args) {
    let productId = args.productId;

    if (!productId && args.sku) {
      const resolved = await resolveProduct({ sku: args.sku });
      if ("outcome" in resolved) return resolved.outcome;
      productId = resolved.id;
    }

    const params = parseMovementListParams(
      query({
        product: productId,
        q: args.query,
        type: args.type,
        from: args.from,
        to: args.to,
        size: LIST_SIZE,
        page: args.page,
      }),
    );
    const result = unwrap(await listMovements(params));

    return {
      output: {
        ...paging(result, result.items.length),
        dateBasis: "When each movement was recorded (UTC).",
        movements: result.items.map((movement) => ({
          at: instant(movement.createdAt),
          type: movement.type,
          sku: movement.productSku,
          product: movement.productName,
          change: movement.change,
          balanceBefore: movement.previousStock,
          balanceAfter: movement.newStock,
          reference: movement.referenceLabel ?? movement.referenceType,
          note: movement.note,
          recordedBy: movement.createdByName,
          cost: moneyView(movement.costTotalByCurrency),
          costedUnits: movement.costedQuantity,
        })),
      },
      sources: [{ label: "Stock movements", href: movementsHref(params) }],
    };
  },
});

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

const searchOrders = defineTool({
  name: "search_orders",
  label: "Order search",
  description:
    "Search sales orders, newest first by default. query matches the order number or the customer's name. " +
    "Dates filter on when the order was created (not when it was confirmed).",
  args: z.strictObject({
    query: text("An order number or a customer name, or a fragment of either."),
    customerId: recordId("Internal customer id from an earlier tool result."),
    status: z.enum(ORDER_STATUSES).describe("Only orders in this status.").optional(),
    from: isoDay("Inclusive start date (YYYY-MM-DD, UTC) of when the order was created."),
    to: isoDay("Inclusive end date (YYYY-MM-DD, UTC) of when the order was created."),
    oldestFirst: z.boolean().describe("List the oldest orders first.").optional(),
    page,
  }),
  async run(args) {
    const params = parseOrderListParams(
      query({
        q: args.query,
        customer: args.customerId,
        status: args.status,
        from: args.from,
        to: args.to,
        dir: args.oldestFirst ? "asc" : "desc",
        size: LIST_SIZE,
        page: args.page,
      }),
    );
    const result = unwrap(await listOrders(params));

    return {
      output: {
        ...paging(result, result.items.length),
        dateBasis: "When each order was created (UTC). Revenue reports use the confirmation date instead.",
        orders: result.items.map((order) => ({
          orderId: order.id,
          orderNumber: order.orderNumber,
          status: order.status,
          customer: order.customerName,
          createdOn: day(order.createdAt),
          total: recordMoney(order.total, order.currency),
          lines: order.itemCount,
          units: order.unitCount,
          unitsNotYetShipped: order.outstandingUnits,
          link: path.order(order.id),
        })),
      },
      sources: [{ label: "Matching orders", href: ordersHref(params) }],
    };
  },
});

const getOrder = defineTool({
  name: "get_order",
  label: "Order details",
  description:
    "One sales order in full: lines with shipped, outstanding and returned quantities, cost and margin with coverage, " +
    "saleable stock for unshipped lines, expected deliveries, and which status changes are possible now and why not. " +
    "Use it to answer why an order cannot be confirmed, completed, cancelled or fulfilled. " +
    "Identify it by orderId from an earlier result, or by its order number.",
  args: z
    .strictObject({
      orderId: recordId("Internal order id from an earlier tool result."),
      orderNumber: text("The order number, for example SO-2026-0001."),
    })
    .refine((args) => Boolean(args.orderId || args.orderNumber), "Provide orderId or orderNumber."),
  async run(args) {
    const resolved = await resolveOrder(args);
    if ("outcome" in resolved) return resolved.outcome;

    const detail = unwrap(await getOrderDetail(resolved.id));
    if (!detail) return nothingFound("That order could not be found.");

    const owing = detail.lines.filter((line) => line.quantity > line.fulfilledQuantity);
    const [availability, supplyLinks] = await Promise.all([
      owing.length > 0
        ? loadStockAvailability(owing.map((line) => line.productId)).then(unwrap)
        : Promise.resolve(new Map()),
      listSupplyLinksForOrder(detail.id),
    ]);

    const status = detail.status;
    const outstandingUnits = owing.reduce(
      (sum, line) => sum + (line.quantity - line.fulfilledQuantity),
      0,
    );

    const check = (to: OrderStatus) => {
      const refusal = transitionRefusal(status, to);
      return { allowed: refusal === null, reason: refusal };
    };

    const confirm =
      check("CONFIRMED").allowed && detail.lines.length === 0
        ? { allowed: false, reason: "This order has no items, so there is nothing to confirm." }
        : check("CONFIRMED");

    const fulfil = !canFulfilOutstanding(status)
      ? {
          allowed: false,
          reason: `Outstanding units can only be fulfilled on a Confirmed or Completed order; this one is ${orderStatusLabel(status)}.`,
        }
      : outstandingUnits === 0
        ? { allowed: false, reason: "Nothing is outstanding: every unit on this order has shipped." }
        : { allowed: true, reason: null };

    return {
      output: {
        found: true,
        order: {
          orderNumber: detail.orderNumber,
          status,
          currency: detail.currency,
          total: recordMoney(detail.total, detail.currency),
          customer: detail.customerName,
          createdBy: detail.createdByName,
          createdOn: day(detail.createdAt),
          confirmedOn: day(detail.confirmedAt),
          completedOn: day(detail.completedAt),
          cancelledOn: day(detail.cancelledAt),
          unitsNotYetShipped: outstandingUnits,
          lifecycle: {
            statusLabel: orderStatusLabel(status),
            possibleNextStatuses: allowedTransitions(status),
            confirm,
            complete: check("COMPLETED"),
            cancel: check("CANCELLED"),
            fulfilOutstanding: fulfil,
            linesEditable: isEditable(status),
            rules: [
              "Only a Confirmed order can be completed. Draft or Pending orders must be confirmed first; Completed and Cancelled orders are final.",
              "Unshipped (outstanding) units do not prevent completion, and can still be fulfilled after the order is completed.",
              "Outstanding units can only be fulfilled from saleable stock; quarantined or rejected batches cannot ship.",
              "A person performs these actions on the order page. The assistant cannot change orders.",
            ],
          },
          lines: detail.lines.map((line) => {
            const outstanding = line.quantity - line.fulfilledQuantity;
            const comparable =
              line.costTotal !== null && sameKnownCurrency(detail.currency, line.costCurrency);
            const margin = comparable
              ? marginOf({
                  quantity: line.quantity,
                  fulfilledQuantity: line.fulfilledQuantity,
                  unitPrice: Number(line.unitPrice),
                  costTotal: Number(line.costTotal),
                  costedQuantity: line.costedQuantity,
                })
              : null;
            const stock = availability.get(line.productId);

            return {
              sku: line.sku,
              product: line.productName,
              quantity: line.quantity,
              unitPrice: recordMoney(line.unitPrice, detail.currency),
              lineTotal: recordMoney(line.total, detail.currency),
              shipped: line.fulfilledQuantity,
              outstanding,
              returned: line.returnedQuantity,
              stillReturnable: line.returnableQuantity,
              costOfSale:
                line.costTotal === null ? null : recordMoney(line.costTotal, line.costCurrency),
              costedUnits: line.costedQuantity,
              margin:
                margin && margin.costedQuantity > 0
                  ? {
                      amount: recordMoney(margin.margin.toFixed(2), detail.currency),
                      percent: round1(margin.marginPercent),
                      coveredUnits: margin.costedQuantity,
                    }
                  : null,
              marginNote:
                line.costTotal !== null && !comparable
                  ? "The sale and its cost are in different (or unrecorded) currencies, so no margin can be stated."
                  : null,
              coverage: coverageNote({
                costedQuantity: line.costedQuantity,
                fulfilledQuantity: line.fulfilledQuantity,
                quantity: line.quantity,
              }),
              stockForOutstanding:
                outstanding > 0 && stock
                  ? {
                      onHand: stock.stockQuantity,
                      saleable: stock.saleableQuantity,
                      blocked: stock.blockedQuantity,
                      shippableNow: Math.min(outstanding, stock.saleableQuantity),
                    }
                  : null,
              expectedDeliveries: (supplyLinks.get(line.id) ?? []).map((link) => ({
                purchaseNumber: link.purchaseNumber,
                purchaseStatus: link.purchaseStatus,
                supplier: link.supplierName,
                units: link.quantity,
                purchasedOn: day(link.purchaseDate),
              })),
            };
          }),
          inventoryImpact: detail.impact.map((impact) => ({
            sku: impact.sku,
            product: impact.productName,
            unitsDeducted: impact.deducted,
            unitsRestored: impact.restored,
          })),
          link: path.order(detail.id),
        },
      },
      sources: [{ label: `Order ${detail.orderNumber}`, href: path.order(detail.id) }],
    };
  },
});

// ---------------------------------------------------------------------------
// Purchases
// ---------------------------------------------------------------------------

const searchPurchases = defineTool({
  name: "search_purchases",
  label: "Purchase search",
  description:
    "Search purchase orders placed with suppliers, newest first by default. query matches the purchase number or the supplier's name; " +
    "supplierName picks one supplier by name. Dates filter on the purchase date (when it was placed).",
  args: z.strictObject({
    query: text("A purchase number or a supplier name, or a fragment of either."),
    supplierId: recordId("Internal supplier id from an earlier tool result."),
    supplierName: text("A supplier's name, to list only that supplier's purchases."),
    status: z.enum(PURCHASE_STATUSES).describe("Only purchases in this status.").optional(),
    from: isoDay("Inclusive start date (YYYY-MM-DD, UTC) of the purchase date."),
    to: isoDay("Inclusive end date (YYYY-MM-DD, UTC) of the purchase date."),
    oldestFirst: z.boolean().describe("List the oldest purchases first.").optional(),
    page,
  }),
  async run(args) {
    let supplierId = args.supplierId;

    if (!supplierId && args.supplierName) {
      const resolved = await resolveSupplier({ name: args.supplierName });
      if ("outcome" in resolved) return resolved.outcome;
      supplierId = resolved.id;
    }

    const params = parsePurchaseListParams(
      query({
        q: args.query,
        supplier: supplierId,
        status: args.status,
        from: args.from,
        to: args.to,
        dir: args.oldestFirst ? "asc" : "desc",
        size: LIST_SIZE,
        page: args.page,
      }),
    );
    const result = unwrap(await listPurchases(params));

    return {
      output: {
        ...paging(result, result.items.length),
        dateBasis: "The purchase date (when it was placed with the supplier). Spend reports use the receipt date instead.",
        purchases: result.items.map((purchase) => ({
          purchaseId: purchase.id,
          purchaseNumber: purchase.purchaseNumber,
          status: purchase.status,
          supplier: purchase.supplierName,
          purchasedOn: day(purchase.purchaseDate),
          total: recordMoney(purchase.total, purchase.currency),
          lines: purchase.itemCount,
          units: purchase.unitCount,
          link: path.purchase(purchase.id),
        })),
      },
      sources: [{ label: "Matching purchases", href: purchasesHref(params) }],
    };
  },
});

const getPurchase = defineTool({
  name: "get_purchase",
  label: "Purchase details",
  description:
    "One purchase order in full: its lines and unit costs, receipt and cancellation dates, the stock it moved, " +
    "and the supplier's received-spend totals. Identify it by purchaseId from an earlier result, or by its purchase number.",
  args: z
    .strictObject({
      purchaseId: recordId("Internal purchase id from an earlier tool result."),
      purchaseNumber: text("The purchase number, for example PO-2026-0001."),
    })
    .refine((args) => Boolean(args.purchaseId || args.purchaseNumber), "Provide purchaseId or purchaseNumber."),
  async run(args) {
    const resolved = await resolvePurchase(args);
    if ("outcome" in resolved) return resolved.outcome;

    const detail = unwrap(await getPurchaseDetail(resolved.id));
    if (!detail) return nothingFound("That purchase could not be found.");

    return {
      output: {
        found: true,
        purchase: {
          purchaseNumber: detail.purchaseNumber,
          status: detail.status,
          currency: detail.currency,
          total: recordMoney(detail.total, detail.currency),
          purchasedOn: day(detail.purchaseDate),
          receivedOn: day(detail.receivedAt),
          cancelledOn: day(detail.cancelledAt),
          createdBy: detail.createdByName,
          supplier: {
            supplierId: detail.supplier.id,
            name: detail.supplier.name,
            status: detail.supplier.status,
            purchases: detail.supplier.purchaseCount,
            receivedPurchases: detail.supplier.receivedCount,
            totalReceivedSpend: moneyView(detail.supplier.totalPurchasedByCurrency),
          },
          lines: detail.lines.map((line) => ({
            sku: line.sku,
            product: line.productName,
            quantity: line.quantity,
            unitCost: recordMoney(line.unitCost, detail.currency),
            lineTotal: recordMoney(line.total, detail.currency),
            productRetired: line.productRetired,
            batchCertificate: line.stockLotId ? line.certificateStatus : null,
          })),
          inventoryImpact: detail.impact.map((impact) => ({
            sku: impact.sku,
            product: impact.productName,
            unitsAdded: impact.added,
            unitsReversed: impact.reversed,
          })),
          link: path.purchase(detail.id),
        },
      },
      sources: [{ label: `Purchase ${detail.purchaseNumber}`, href: path.purchase(detail.id) }],
    };
  },
});

// ---------------------------------------------------------------------------
// Customers and suppliers
// ---------------------------------------------------------------------------

const searchCustomers = defineTool({
  name: "search_customers",
  label: "Customer search",
  description:
    "Search customers by name. lifetimeValue is the total of their confirmed and completed orders, per currency.",
  args: z.strictObject({
    query: text("A customer name or fragment."),
    status: z.enum(CUSTOMER_STATUSES).describe("Only customers with this status.").optional(),
    page,
  }),
  async run(args) {
    const params = parseCustomerListParams(
      query({ q: args.query, status: args.status, size: LIST_SIZE, page: args.page }),
    );
    const result = unwrap(await listCustomers(params));

    return {
      output: {
        ...paging(result, result.items.length),
        customers: result.items.map((customer) => ({
          customerId: customer.id,
          name: customer.name,
          status: customer.status,
          orders: customer.orderCount,
          lifetimeValue: moneyView(customer.lifetimeValueByCurrency),
          link: path.customer(customer.id),
        })),
      },
      sources: [{ label: "Matching customers", href: customersHref(params) }],
    };
  },
});

const getCustomer = defineTool({
  name: "get_customer",
  label: "Customer details",
  description:
    "One customer: order counts by status, lifetime value (confirmed and completed orders), uncommitted value " +
    "(draft and pending orders) and recent orders. Identify by customerId from an earlier result, or by name.",
  args: z
    .strictObject({
      customerId: recordId("Internal customer id from an earlier tool result."),
      name: text("The customer's name."),
    })
    .refine((args) => Boolean(args.customerId || args.name), "Provide customerId or name."),
  async run(args) {
    const resolved = await resolveCustomer(args);
    if ("outcome" in resolved) return resolved.outcome;

    const detail = unwrap(await getCustomerDetail(resolved.id));
    if (!detail) return nothingFound("That customer could not be found.");

    return {
      output: {
        found: true,
        customer: {
          name: detail.name,
          status: detail.status,
          orders: detail.orderCount,
          ordersByStatus: detail.statusCounts,
          lifetimeValue: moneyView(detail.lifetimeValueByCurrency),
          uncommittedValue: moneyView(detail.openValueByCurrency),
          definitions: {
            lifetimeValue: "Confirmed and completed orders.",
            uncommittedValue: "Draft and pending orders: raised but not yet committed.",
          },
          lastOrderOn: day(detail.lastOrderAt),
          recentOrders: detail.orders.slice(0, 10).map((order) => ({
            orderNumber: order.orderNumber,
            status: order.status,
            total: recordMoney(order.total, order.currency),
            orderedOn: day(order.createdAt),
          })),
          link: path.customer(detail.id),
        },
      },
      sources: [{ label: `Customer ${detail.name}`, href: path.customer(detail.id) }],
    };
  },
});

const searchSuppliers = defineTool({
  name: "search_suppliers",
  label: "Supplier search",
  description:
    "Search suppliers by name. totalReceivedSpend is what was spent on their received purchases, per currency.",
  args: z.strictObject({
    query: text("A supplier name or fragment."),
    status: z.enum(SUPPLIER_STATUSES).describe("Only suppliers with this status.").optional(),
    page,
  }),
  async run(args) {
    const params = parseSupplierListParams(
      query({ q: args.query, status: args.status, size: LIST_SIZE, page: args.page }),
    );
    const result = unwrap(await listSuppliers(params));

    return {
      output: {
        ...paging(result, result.items.length),
        suppliers: result.items.map((supplier) => ({
          supplierId: supplier.id,
          name: supplier.name,
          status: supplier.status,
          productsSourced: supplier.productCount,
          purchases: supplier.purchaseCount,
          totalReceivedSpend: moneyView(supplier.totalPurchasedByCurrency),
          typicalLeadTimeDays: supplier.typicalLeadTimeDays,
          link: path.supplier(supplier.id),
        })),
      },
      sources: [{ label: "Matching suppliers", href: suppliersHref(params) }],
    };
  },
});

const getSupplier = defineTool({
  name: "get_supplier",
  label: "Supplier details",
  description:
    "One supplier: purchase counts, received spend, recent purchases, products sourced from them, and stock still " +
    "on hand that came from them with its value at cost. Identify by supplierId from an earlier result, or by name.",
  args: z
    .strictObject({
      supplierId: recordId("Internal supplier id from an earlier tool result."),
      name: text("The supplier's name."),
    })
    .refine((args) => Boolean(args.supplierId || args.name), "Provide supplierId or name."),
  async run(args) {
    const resolved = await resolveSupplier(args);
    if ("outcome" in resolved) return resolved.outcome;

    const detail = unwrap(await getSupplierDetail(resolved.id));
    if (!detail) return nothingFound("That supplier could not be found.");

    return {
      output: {
        found: true,
        supplier: {
          supplierId: detail.id,
          name: detail.name,
          status: detail.status,
          typicalLeadTimeDays: detail.typicalLeadTimeDays,
          purchases: detail.purchaseCount,
          receivedPurchases: detail.receivedCount,
          totalReceivedSpend: moneyView(detail.totalPurchasedByCurrency),
          firstPurchaseOn: day(detail.firstPurchaseAt),
          lastPurchaseOn: day(detail.lastPurchaseAt),
          recentPurchases: detail.purchases.slice(0, 10).map((purchase) => ({
            purchaseNumber: purchase.purchaseNumber,
            status: purchase.status,
            total: recordMoney(purchase.total, purchase.currency),
            purchasedOn: day(purchase.purchaseDate),
            receivedOn: day(purchase.receivedAt),
          })),
          productsSourced: detail.productCount,
          products: detail.products.slice(0, 15).map((product) => ({
            sku: product.sku,
            name: product.name,
            stockOnHand: product.stockQuantity,
            status: product.status,
          })),
          stockOnHandFromThisSupplier: {
            units: detail.stockOnHand.units,
            valueAtCost: moneyView(detail.stockOnHand.valueByCurrency),
            costedUnits: detail.stockOnHand.costedUnits,
            uncostedUnits: detail.stockOnHand.uncostedUnits,
            products: detail.stockOnHand.productCount,
          },
          link: path.supplier(detail.id),
        },
      },
      sources: [{ label: `Supplier ${detail.name}`, href: path.supplier(detail.id) }],
    };
  },
});

// ---------------------------------------------------------------------------
// Summaries and reports
// ---------------------------------------------------------------------------

const getInventorySummary = defineTool({
  name: "get_inventory_summary",
  label: "Inventory summary",
  description:
    "Current inventory at a glance: products and units on hand, value at cost with coverage, retired stock, " +
    "and what needs attention (orders awaiting action, outstanding purchases, certificate problems).",
  args: z.strictObject({}),
  async run() {
    const [inventoryResult, attentionResult] = await Promise.all([
      loadInventory(),
      loadAttention(),
    ]);
    const inventory = unwrap(inventoryResult);
    const attention = unwrap(attentionResult);

    return {
      output: {
        scope: "Current state, every product holding stock.",
        products: inventory.productCount,
        unitsOnHand: inventory.totalUnits,
        valueAtCost: moneyView(inventory.stockValueByCurrency),
        costedUnits: inventory.costedUnits,
        uncostedUnits: inventory.uncostedUnits,
        valueNote: "Value at cost covers only units with a recorded acquisition cost; uncosted units are excluded, never valued at zero.",
        retiredStock: {
          products: inventory.retired.productCount,
          units: inventory.retired.units,
          valueAtCost: moneyView(inventory.retired.valueByCurrency),
          uncostedUnits: inventory.retired.uncostedUnits,
        },
        needsAttention: {
          ordersAwaitingAction: attention.actionableOrderCount,
          purchasesNotYetReceived: attention.outstandingPurchaseCount,
          uncostedUnits: attention.uncostedUnits,
          certificates: {
            expired: attention.certificates.expiredCount,
            expiringSoon: attention.certificates.expiringSoonCount,
            missing: attention.certificates.missingCount,
          },
        },
      },
      sources: [{ label: "Dashboard", href: "/dashboard" }],
    };
  },
});

const getInventoryValuation = defineTool({
  name: "get_inventory_valuation",
  label: "Stock valuation report",
  description:
    "The stock valuation report: value at cost (what was actually paid, costed units only) and value at retail " +
    "(reference selling prices — a different basis), per currency, with coverage, plus the top products. Current state only.",
  args: z.strictObject({
    query: text("A product name or SKU fragment."),
    category: text("Only products in this exact category."),
    supplierId: recordId("Internal supplier id from an earlier tool result."),
    sortBy: z
      .enum(["value", "units", "uncosted", "coverage", "name", "sku"])
      .describe("Row order. value sorts by value at cost, highest first.")
      .optional(),
    page,
  }),
  async run(args, context) {
    const params = reportParamsFor(
      "valuation",
      query({
        q: args.query,
        category: args.category,
        supplier: args.supplierId,
        sort: args.sortBy,
        dir: args.sortBy === "name" || args.sortBy === "sku" ? "asc" : undefined,
        size: REPORT_SIZE,
        page: args.page,
      }),
      context.now,
    );
    const result = unwrap(await loadValuationReport(params));
    const { totals } = result;

    return {
      output: {
        ...paging(result, result.rows.length),
        scope: "Current state; products holding stock.",
        totals: {
          products: totals.products,
          units: totals.units,
          costedUnits: totals.costedUnits,
          uncostedUnits: totals.uncostedUnits,
          costCoveragePercent: totals.coverage,
          valueAtCost: moneyView(totals.valueAtCostByCurrency),
          valueAtRetail: moneyView(totals.valueAtRetailByCurrency),
          unitsWithoutReferencePrice: totals.unpricedUnits,
          retired: {
            products: totals.retiredProducts,
            units: totals.retiredUnits,
            valueAtCost: moneyView(totals.retiredValueAtCostByCurrency),
          },
        },
        notes: [
          "Value at cost covers only units with a recorded acquisition cost. Uncosted units are excluded, never valued at zero.",
          "Value at retail is stock times reference selling price: a different basis, never combined with cost.",
        ],
        rows: result.rows.map((row) => ({
          sku: row.sku,
          name: row.name,
          units: row.units,
          costedUnits: row.costedUnits,
          uncostedUnits: row.uncostedUnits,
          valueAtCost: moneyView(row.valueAtCostByCurrency),
          valueAtRetail: moneyView(row.valueAtRetailByCurrency),
          costCoveragePercent: row.coverage,
          link: path.product(row.productId),
        })),
      },
      sources: [
        {
          label: "Stock valuation report",
          href: reportHref("valuation", params, reportDefaults("valuation")),
        },
      ],
    };
  },
});

const GROUPING_FOR: Record<string, string> = {
  month: "period",
  product: "product",
  category: "category",
  customer: "customer",
  supplier: "supplier",
};

const getSalesReport = defineTool({
  name: "get_sales_report",
  label: "Sales report",
  description:
    "Revenue and units sold for a period, per currency, from confirmed and completed orders dated by when each was confirmed. " +
    "Optionally grouped by month, product, category or customer. Figures are gross: returns are not deducted.",
  args: z.strictObject({
    period,
    from: fromDay,
    to: toDay,
    groupBy: z
      .enum(["month", "product", "category", "customer"])
      .describe("How to break the totals down. Defaults to month.")
      .optional(),
    customerId: recordId("Internal customer id from an earlier tool result."),
    category: text("Only products in this exact category."),
    query: text("A product name/SKU or customer name fragment."),
    sortBy: z
      .enum(["revenue", "units", "orders", "label"])
      .describe("Row order, highest first except label.")
      .optional(),
    page,
  }),
  async run(args, context) {
    const window = reportWindow(args, context.now);
    const params = reportParamsFor(
      "sales",
      query({
        ...window,
        group: args.groupBy ? GROUPING_FOR[args.groupBy] : undefined,
        customer: args.customerId,
        category: args.category,
        q: args.query,
        sort: args.sortBy,
        size: REPORT_SIZE,
        page: args.page,
      }),
      context.now,
    );
    const result = unwrap(await loadSalesReport(params));

    return {
      output: {
        ...paging(result, result.rows.length),
        period: {
          description: describeRange(params),
          from: params.from,
          to: params.to,
          calendar: "UTC",
        },
        groupedBy: params.grouping === "period" ? "month" : params.grouping,
        totals: {
          orders: result.totals.orders,
          unitsSold: result.totals.units,
          revenue: moneyView(result.totals.revenueByCurrency),
        },
        definitions: [
          "Revenue: line totals of confirmed and completed orders, dated by confirmation date, in each order's own currency.",
          "unitsSold: quantity on those orders, including units not yet shipped. Returns are not deducted (gross).",
        ],
        rows: result.rows.map((row) => ({
          label: row.label,
          detail: row.sublabel,
          orders: row.orders,
          units: row.units,
          revenue: moneyView(row.revenueByCurrency),
        })),
      },
      sources: [
        { label: "Sales report", href: reportHref("sales", params, reportDefaults("sales")) },
      ],
    };
  },
});

const getPurchaseSpendReport = defineTool({
  name: "get_purchase_spend_report",
  label: "Purchase spend report",
  description:
    "What was bought and spent for a period, per currency: received purchases only, dated by when each delivery arrived. " +
    "Pending purchases are reported separately as committed spend. Optionally grouped by month, supplier, product or category, " +
    "or narrowed to one supplier (supplierId or supplierName).",
  args: z.strictObject({
    period,
    from: fromDay,
    to: toDay,
    groupBy: z
      .enum(["month", "supplier", "product", "category"])
      .describe("How to break the totals down. Defaults to month.")
      .optional(),
    supplierId: recordId("Internal supplier id from an earlier tool result."),
    supplierName: text("A supplier's name, to report only that supplier."),
    category: text("Only products in this exact category."),
    query: text("A product name/SKU or supplier name fragment."),
    page,
  }),
  async run(args, context) {
    let supplierId = args.supplierId;

    if (!supplierId && args.supplierName) {
      const resolved = await resolveSupplier({ name: args.supplierName });
      if ("outcome" in resolved) return resolved.outcome;
      supplierId = resolved.id;
    }

    const window = reportWindow(args, context.now);
    const params = reportParamsFor(
      "purchases",
      query({
        ...window,
        group: args.groupBy ? GROUPING_FOR[args.groupBy] : undefined,
        supplier: supplierId,
        category: args.category,
        q: args.query,
        size: REPORT_SIZE,
        page: args.page,
      }),
      context.now,
    );
    const result = unwrap(await loadPurchaseSpendReport(params));

    return {
      output: {
        ...paging(result, result.rows.length),
        period: {
          description: describeRange(params),
          from: params.from,
          to: params.to,
          calendar: "UTC",
        },
        groupedBy: params.grouping === "period" ? "month" : params.grouping,
        totals: {
          receivedPurchases: result.totals.purchases,
          unitsReceived: result.totals.units,
          receivedSpend: moneyView(result.totals.receivedSpendByCurrency),
          committedSpend: moneyView(result.totals.committedSpendByCurrency),
          committedPurchases: result.totals.committedPurchases,
        },
        definitions: [
          "Received spend: received purchases only, dated by receipt date, in each purchase's own currency.",
          "Committed spend: pending purchases (placed, not yet received). Never added to received spend.",
          "Purchase spend is not cost of goods sold.",
        ],
        rows: result.rows.map((row) => ({
          label: row.label,
          detail: row.sublabel,
          purchases: row.purchases,
          units: row.units,
          receivedSpend: moneyView(row.receivedSpendByCurrency),
        })),
      },
      sources: [
        {
          label: "Purchase spend report",
          href: reportHref("purchases", params, reportDefaults("purchases")),
        },
      ],
    };
  },
});

const getCostingSnapshot = defineTool({
  name: "get_costing_snapshot",
  label: "Costing snapshot",
  description:
    "The costing situation across all confirmed and completed orders (all time, not a period): revenue, known cost of goods sold, " +
    "margin where it can honestly be stated, and how many units have unknown cost or have not shipped.",
  args: z.strictObject({}),
  async run() {
    const costing = unwrap(await loadCosting());

    const marginAvailable = costing.marginByCurrency.length > 0;

    return {
      output: {
        scope: "All time: confirmed and completed orders.",
        unitsSold: costing.unitsSold,
        unitsShipped: costing.fulfilledUnits,
        unitsShippedWithKnownCost: costing.costedUnits,
        unitsShippedWithUnknownCost: Math.max(0, costing.fulfilledUnits - costing.costedUnits),
        unitsNotYetShipped: costing.outstandingUnits,
        revenueAllUnits: moneyView(costing.allRevenueByCurrency),
        revenueOnCostedUnits: moneyView(costing.costedRevenueByCurrency),
        knownCostOfGoodsSold: moneyView(costing.knownCogsByCurrency),
        margin: marginAvailable ? moneyView(costing.marginByCurrency) : null,
        marginPercent: marginAvailable ? round1(costing.marginPercent) : null,
        marginUnavailableReason: marginAvailable
          ? null
          : costing.costedUnits === 0
            ? "No shipped units have a recorded acquisition cost, so no margin can be calculated."
            : "Revenue on costed units and their cost are not both in one shared currency, so they cannot be subtracted.",
        coverage: coverageNote({
          costedQuantity: costing.costedUnits,
          fulfilledQuantity: costing.fulfilledUnits,
          quantity: costing.unitsSold,
        }),
        uncostedStockOnHand: costing.uncostedStockUnits,
        notes: [
          "Margin covers only shipped units whose acquisition cost is known; revenue is apportioned to those units.",
          "Cost of goods sold is in the currency the stock was bought in, which can differ from the sale currency.",
        ],
      },
      sources: [{ label: "Dashboard", href: "/dashboard" }],
    };
  },
});

const listQuarantinedStock = defineTool({
  name: "list_quarantined_stock",
  label: "Quarantined stock",
  description:
    "Batches customers returned that are awaiting inspection, oldest first. They count as stock on hand but cannot be sold until released.",
  adminOnly: true,
  args: z.strictObject({}),
  async run() {
    // `listQuarantinedLots` checks the ADMIN role itself; the tool is also
    // never offered to anybody else.
    const lots = await listQuarantinedLots();
    const LIMIT = 25;

    return {
      output: {
        batches: lots.length,
        unitsAwaitingInspection: lots.reduce((sum, lot) => sum + lot.quantityRemaining, 0),
        shown: Math.min(lots.length, LIMIT),
        note: "Quarantined units are counted in stock on hand but cannot be sold until an administrator releases them.",
        rows: lots.slice(0, LIMIT).map((lot) => ({
          sku: lot.sku,
          product: lot.productName,
          units: lot.quantityRemaining,
          unitCost: lot.unitCost === null ? null : recordMoney(lot.unitCost, lot.costCurrency),
          receivedOn: day(lot.receivedAt),
          daysWaiting: lot.daysHeld,
          returnNumber: lot.returnNumber,
          orderNumber: lot.orderNumber,
          customer: lot.customerName,
        })),
      },
      sources: [{ label: "Returned stock", href: "/returns" }],
    };
  },
});

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Every tool, in a fixed order. The order is part of the request the model
 * sees, and keeping it stable keeps that request stable from one question to
 * the next.
 */
const TOOLS: readonly AssistantTool[] = [
  searchProducts,
  getProduct,
  listUnavailableProducts,
  listStockMovements,
  searchOrders,
  getOrder,
  searchPurchases,
  getPurchase,
  searchCustomers,
  getCustomer,
  searchSuppliers,
  getSupplier,
  getInventorySummary,
  getInventoryValuation,
  getSalesReport,
  getPurchaseSpendReport,
  getCostingSnapshot,
  listQuarantinedStock,
];

/**
 * The tools a user of this role may use. ADMIN-only tools are not merely
 * refused for everyone else — they are never declared, so the model cannot
 * ask for them.
 */
export function toolsFor(role: UserRole): AssistantTool[] {
  return TOOLS.filter((tool) => !tool.adminOnly || role === "ADMIN");
}
