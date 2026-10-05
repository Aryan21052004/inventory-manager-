import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { toolsFor } from "@/server/assistant/tools";

/**
 * The inventory assistant may read and must never write — checked by reading
 * the source.
 *
 * A behavioural test proves what the current tools do. It cannot catch the
 * next one: a write function imported "just to check something", or a tool
 * that quietly calls `prisma` directly. Those are imports, and the only thing
 * that sees an import that should not exist is a test that reads imports. So
 * every server function the assistant may call is listed here by name, and
 * anything else fails — adding one is meant to be a decision someone makes in
 * this file, not a side effect of a refactor.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return filesUnder(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

interface SourceFile {
  path: string;
  source: string;
}

function read(paths: string[]): SourceFile[] {
  return paths.map((path) => ({
    path: relative(ROOT, path).split(sep).join("/"),
    source: readFileSync(path, "utf8"),
  }));
}

const SERVER_FILES = read([
  ...filesUnder(join(ROOT, "src", "server", "assistant")),
  join(ROOT, "src", "app", "api", "assistant", "route.ts"),
]);

const CLIENT_FILE = read([
  join(ROOT, "src", "app", "(app)", "assistant", "assistant-chat.tsx"),
])[0]!;

interface Import {
  names: string[];
  from: string;
}

/** Every `import … from "…"` in a file, with the bindings it brings in. */
function importsOf(source: string): Import[] {
  const found: Import[] = [];
  const pattern = /import\s+(?:type\s+)?([\s\S]*?)\s+from\s+["']([^"']+)["']/g;

  for (const [, clause = "", from = ""] of source.matchAll(pattern)) {
    const braced = /\{([\s\S]*)\}/.exec(clause)?.[1] ?? "";
    const names = braced
      .split(",")
      .map((name) => name.replace(/^\s*type\s+/, "").split(/\s+as\s+/)[0]!.trim())
      .filter(Boolean);
    const defaultName = clause.replace(/\{[\s\S]*\}/, "").replace(/,/g, "").trim();
    found.push({ names: defaultName ? [...names, defaultName] : names, from });
  }

  return found;
}

/**
 * The server functions the assistant is allowed to call, by module. Every one
 * of them is a read. Type-only imports from these modules are allowed too.
 */
const ALLOWED_SERVER_IMPORTS: Record<string, readonly string[]> = {
  "@/server/auth": ["requireUser"],
  "@/server/customers": ["getCustomerDetail", "listCustomers"],
  "@/server/dashboard": ["loadAttention", "loadCosting", "loadInventory"],
  "@/server/lots": ["listQuarantinedLots"],
  "@/server/orders": ["getOrderDetail", "listOrders"],
  "@/server/products": [
    "getProductDetail",
    "listProducts",
    "listProductsWithoutAvailableStock",
    "loadStockAvailability",
  ],
  "@/server/purchases": ["getPurchaseDetail", "listPurchases"],
  "@/server/reports": ["loadPurchaseSpendReport", "loadSalesReport", "loadValuationReport"],
  "@/server/stock-movements": ["listMovements"],
  "@/server/suppliers": ["getSupplierDetail", "listSuppliers"],
  "@/server/supply-links": ["listSupplyLinksForOrder"],
};

/** The assistant's own modules, which import each other. */
const OWN_MODULE = /^(\.\/|@\/server\/assistant\/)/;

/** Modules that can write, lock, reach storage or bypass the domain layer. */
const FORBIDDEN_MODULES = [
  /^@\/lib\/prisma$/,
  /^@\/generated\/prisma\/client$/,
  /^@\/lib\/supabase\//,
  /^@\/server\/stock$/,
  /^@\/server\/storage/,
  /^@\/server\/settings$/,
  /^@\/server\/returns$/,
  /^@\/server\/certificates$/,
  /^@\/server\/order-item-images$/,
  /^node:(fs|child_process|net|http|https)/,
  /^(fs|child_process|net|http|https)$/,
];

describe("the assistant's server code", () => {
  it("is all server-only", () => {
    const missing = SERVER_FILES.filter(
      (file) =>
        file.path.startsWith("src/server/") && !/^import "server-only";/m.test(file.source),
    ).map((file) => file.path);

    expect(missing).toEqual([]);
  });

  it("calls only the allowlisted read functions from src/server", () => {
    const offenders: string[] = [];

    for (const file of SERVER_FILES) {
      for (const { names, from } of importsOf(file.source)) {
        if (!from.startsWith("@/server/") || OWN_MODULE.test(from)) continue;

        const allowed = ALLOWED_SERVER_IMPORTS[from];
        const typeOnlyLine = new RegExp(`import\\s+type\\s+[^;]*["']${from}["']`).test(file.source);

        for (const name of names) {
          const isType = /^[A-Z]/.test(name) || typeOnlyLine;
          if (isType) continue;
          if (!allowed?.includes(name)) offenders.push(`${file.path}: ${name} from ${from}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("imports nothing that can write, lock rows, or reach the database or storage directly", () => {
    const offenders = SERVER_FILES.flatMap((file) =>
      importsOf(file.source)
        .filter(({ from }) => FORBIDDEN_MODULES.some((pattern) => pattern.test(from)))
        // Prisma's generated *types* (enums, User) are not the client.
        .filter(({ from }) => !(from === "@/generated/prisma/client" && /import\s+type/.test(file.source)))
        .map(({ from }) => `${file.path}: ${from}`),
    );

    expect(offenders).toEqual([]);
  });

  it("never names the Prisma client", () => {
    const offenders = SERVER_FILES.filter((file) => /\bprisma\./.test(file.source)).map(
      (file) => file.path,
    );

    expect(offenders).toEqual([]);
  });

  it("reads secrets only in the Gemini adapter", () => {
    const offenders = SERVER_FILES.filter(
      (file) =>
        /GEMINI_API_KEY|SERVICE_ROLE|DATABASE_URL/.test(
          file.source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ""),
        ) && !file.path.endsWith("src/server/assistant/gemini.ts"),
    ).map((file) => file.path);

    expect(offenders).toEqual([]);
  });
});

describe("the chat component", () => {
  it("reaches the server only through /api/assistant", () => {
    const imports = importsOf(CLIENT_FILE.source).map(({ from }) => from);

    expect(/^\s*"use client"/.test(CLIENT_FILE.source)).toBe(true);
    expect(imports.filter((from) => /^@\/server\/|^@\/lib\/env$|^@google\/genai$|^@\/lib\/prisma$/.test(from))).toEqual([]);
  });

  it("renders no HTML from the answer", () => {
    expect(CLIENT_FILE.source).not.toContain("dangerouslySetInnerHTML");
  });
});

describe("the tools", () => {
  /*
   * Pinned. A new tool is a new thing the model can make the server do, and it
   * should arrive with this list changing in the same commit.
   */
  const READ_TOOLS = [
    "search_products",
    "get_product",
    "list_products_without_available_stock",
    "list_stock_movements",
    "search_orders",
    "get_order",
    "search_purchases",
    "get_purchase",
    "search_customers",
    "get_customer",
    "search_suppliers",
    "get_supplier",
    "get_inventory_summary",
    "get_inventory_valuation",
    "get_sales_report",
    "get_purchase_spend_report",
    "get_costing_snapshot",
    "list_quarantined_stock",
  ];

  it("are exactly the reviewed read-only set", () => {
    expect(toolsFor("ADMIN").map((tool) => tool.name)).toEqual(READ_TOOLS);
  });

  it("include nothing named like a write", () => {
    const writeVerbs =
      /^(create|update|delete|remove|set|confirm|complete|fulfil|fulfill|cancel|receive|adjust|record|release|reject|write|attach|archive|edit|add|post|send|run|execute|query_sql|sql)/;

    expect(toolsFor("ADMIN").filter((tool) => writeVerbs.test(tool.name))).toEqual([]);
  });
});
