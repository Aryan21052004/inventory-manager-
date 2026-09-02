/**
 * Development seed — a small but *coherent* warehouse.
 *
 * The point of this data is not just to fill tables. It is to leave the
 * database in a state the app's screens can be built against: stock levels that
 * are actually explained by the ledger, orders whose totals add up, and a
 * spread of quantities, large and small, so every screen that reports one has
 * something real to report.
 *
 * Two rules keep it honest:
 *
 *   1. Money is arithmetic on integer cents. Doing it in floats and rounding at
 *      the end is how you end up with a 179.98000000000002 that the database's
 *      `total = quantity * unit_price` check refuses.
 *   2. Nothing writes Product.stockQuantity directly. Every unit that moves is
 *      planned, then written by `applyMoves()` in timestamp order, appending a
 *      StockTransaction and advancing the running balance — the same discipline
 *      the app itself has to follow. The final quantity written to each product
 *      is whatever the ledger says it is, so the two cannot disagree.
 */

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { PrismaPg } from "@prisma/adapter-pg";
import { config } from "dotenv";

import { PrismaClient } from "../src/generated/prisma/client";
import type {
  OrderStatus,
  ProductStatus,
  PurchaseStatus,
  StockReferenceType,
  StockTransactionType,
  SupplierStatus,
  UserRole,
} from "../src/generated/prisma/enums";

// The Prisma CLI loads these via prisma.config.ts, but the seed is also useful
// to run directly (`npx tsx prisma/seed.ts`), so load them here too. dotenv
// never overwrites an already-set variable, which preserves the precedence
// order: real environment > .env.local > .env.
config({ path: ".env.local", quiet: true });
config({ path: ".env", quiet: true });

const connectionString = process.env["DATABASE_URL"];

if (!connectionString) {
  throw new Error(
    "DATABASE_URL is not set. Copy .env.example to .env.local and fill it in.",
  );
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString }),
  log: ["warn", "error"],
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Cents to the string form Prisma wants for a Decimal column. */
const money = (cents: number): string => (cents / 100).toFixed(2);

/** Rounds half away from zero, the way an invoice does — not the way JS does. */
const roundCents = (value: number): number =>
  Math.sign(value) * Math.round(Math.abs(value));

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.now();

/** A timestamp `days` ago, at a plausible hour rather than exactly now-o'clock. */
const daysAgo = (days: number, hour = 10): Date => {
  const date = new Date(NOW - days * DAY_MS);
  date.setHours(hour, (days * 7) % 60, 0, 0);
  return date;
};

// ---------------------------------------------------------------------------
// Source data
// ---------------------------------------------------------------------------

/*
 * One supplier is seeded ARCHIVED on purpose.
 *
 * They have products and purchases behind them, which is exactly the state
 * worth having in development: it exercises the status filter, proves the
 * pickers leave them out, and shows that an archived supplier's history — and
 * the acquisition cost of the stock they delivered — survives untouched.
 */
const SUPPLIERS = [
  {
    key: "kestrel",
    name: "Kestrel Electronics Ltd",
    contactPerson: "Priya Raghunathan",
    phone: "+44 20 7946 0112",
    email: "orders@kestrel-electronics.co.uk",
    address: "Unit 14, Brightmoor Industrial Estate, Slough SL1 4XR",
    accountNumber: "KES-4471",
    typicalLeadTimeDays: 7,
    status: "ACTIVE",
  },
  {
    key: "northwind",
    name: "Northwind Components",
    contactPerson: "Tomas Lindqvist",
    phone: "+44 161 496 0233",
    email: "sales@northwindcomponents.com",
    address: "3 Ashfield Way, Trafford Park, Manchester M17 1AB",
    accountNumber: "NW-2200-B",
    typicalLeadTimeDays: 14,
    status: "ACTIVE",
  },
  {
    key: "meridian",
    name: "Meridian Office Supply",
    contactPerson: "Grace Adeyemi",
    phone: "+44 113 496 0781",
    email: "accounts@meridianoffice.co.uk",
    address: "Meridian House, 22 Kirkstall Road, Leeds LS3 1LX",
    accountNumber: null,
    typicalLeadTimeDays: 3,
    status: "ACTIVE",
  },
  {
    key: "harbour",
    name: "Harbour Packaging Co.",
    contactPerson: "Declan Moore",
    phone: "+353 1 903 4417",
    email: "hello@harbourpackaging.ie",
    address: "Pier 6, North Wall Quay, Dublin 1, D01 K5C9",
    accountNumber: "HP-0091",
    typicalLeadTimeDays: 21,
    status: "ACTIVE",
  },
  {
    key: "aldridge",
    name: "Aldridge Furniture Works",
    contactPerson: "Marta Kowalczyk",
    phone: "+44 121 496 0550",
    email: "trade@aldridgefurniture.co.uk",
    address: "Foundry Lane, Aldridge, Walsall WS9 8UZ",
    accountNumber: null,
    typicalLeadTimeDays: null,
    // Out of circulation, with history intact behind them.
    status: "INACTIVE",
  },
] as const;

type SupplierKey = (typeof SUPPLIERS)[number]["key"];

const PRODUCTS = [
  {
    key: "kb-87",
    sku: "KB-MECH-87",
    name: "Aurora 87-Key Mechanical Keyboard",
    description:
      "Tenkeyless mechanical keyboard, hot-swappable switches, USB-C detachable cable.",
    category: "Peripherals",
    standardCostCents: 4250,
    sellingPriceCents: 8999,
    status: "ACTIVE",
    supplier: "kestrel",
  },
  {
    key: "mouse-erg",
    sku: "MO-ERG-02",
    name: "Contour Ergonomic Wireless Mouse",
    description: "Vertical grip, six programmable buttons, 2.4GHz and Bluetooth.",
    category: "Peripherals",
    standardCostCents: 1875,
    sellingPriceCents: 4450,
    status: "ACTIVE",
    supplier: "kestrel",
  },
  {
    key: "mon-27",
    sku: "MN-4K-27",
    name: 'Lumen 27" 4K IPS Monitor',
    description: "3840x2160 IPS panel, 99% sRGB, height-adjustable stand.",
    category: "Displays",
    standardCostCents: 18900,
    sellingPriceCents: 32900,
    status: "ACTIVE",
    supplier: "kestrel",
  },
  {
    key: "dock-usbc",
    sku: "DK-USBC-11",
    name: "Meridian 11-Port USB-C Docking Station",
    description:
      "Dual 4K output, 100W power delivery, gigabit ethernet. Supply paused pending a firmware revision.",
    category: "Accessories",
    standardCostCents: 6400,
    sellingPriceCents: 12995,
    // Temporarily off sale while the firmware revision lands.
    status: "INACTIVE",
    supplier: "northwind",
  },
  {
    key: "cable-hdmi",
    sku: "CB-HDMI-2M",
    name: "HDMI 2.1 Cable, 2m Braided",
    description: "48Gbps, 8K60/4K120, braided jacket with moulded strain relief.",
    category: "Cables",
    standardCostCents: 420,
    sellingPriceCents: 1299,
    status: "ACTIVE",
    supplier: "northwind",
  },
  {
    key: "chair-erg",
    sku: "FN-CHR-ERG",
    name: "Aldridge Ergonomic Task Chair, Black",
    description: "Mesh back, four-way adjustable arms, synchronised tilt.",
    category: "Furniture",
    standardCostCents: 14800,
    sellingPriceCents: 29900,
    status: "ACTIVE",
    supplier: "aldridge",
  },
  {
    key: "desk-std",
    sku: "FN-DSK-140",
    name: "Standing Desk 140cm, Oak",
    description: "Electric height adjustment 62-128cm, dual motor, oak veneer top.",
    category: "Furniture",
    standardCostCents: 26250,
    sellingPriceCents: 54900,
    status: "ACTIVE",
    supplier: "aldridge",
  },
  {
    key: "paper-a4",
    sku: "ST-PPR-A4",
    name: "A4 Copy Paper 80gsm, 500 Sheets",
    description: "FSC-certified white copier paper, one ream.",
    category: "Stationery",
    standardCostCents: 310,
    sellingPriceCents: 749,
    status: "ACTIVE",
    supplier: "meridian",
  },
  {
    key: "box-ship",
    sku: "PK-BOX-M",
    name: "Shipping Carton, Medium 300x200x150mm",
    description: "Double-wall corrugated carton, sold singly.",
    category: "Packaging",
    standardCostCents: 62,
    sellingPriceCents: 185,
    status: "ACTIVE",
    supplier: "harbour",
  },
  {
    key: "label-therm",
    sku: "PK-LBL-46",
    name: 'Thermal Shipping Labels 4x6", 250/Roll',
    description:
      "Direct thermal, permanent adhesive. Superseded by the 500/roll line.",
    category: "Packaging",
    standardCostCents: 890,
    sellingPriceCents: 1950,
    // Run-out stock: still sellable history, superseded by the 500/roll line.
    status: "DISCONTINUED",
    supplier: "harbour",
  },
] as const;

type ProductKey = (typeof PRODUCTS)[number]["key"];

const CUSTOMERS = [
  {
    key: "brightline",
    name: "Brightline Studios",
    phone: "+44 20 7946 0388",
    email: "accounts@brightlinestudios.co.uk",
    address: "48 Rivington Street, London EC2A 3QP",
  },
  {
    key: "calder",
    name: "Calder & Voss Architects",
    phone: "+44 131 496 0910",
    email: "finance@caldervoss.com",
    address: "2 Rutland Square, Edinburgh EH1 2AS",
  },
  {
    key: "penrose",
    name: "Penrose Community Trust",
    phone: "+44 29 2010 4466",
    email: "office@penrosetrust.org",
    address: "The Old Library, Bute Street, Cardiff CF10 5LE",
  },
  {
    key: "quayside",
    name: "Quayside Logistics",
    phone: "+44 191 496 0027",
    email: "purchasing@quaysidelogistics.co.uk",
    address: "Baltic Chambers, Hanover Street, Newcastle NE1 3DW",
  },
  {
    key: "wren",
    name: "Wren Dental Practice",
    phone: "+44 117 496 0342",
    email: "reception@wrendental.co.uk",
    address: "119 Whiteladies Road, Bristol BS8 2PL",
  },
] as const;

type CustomerKey = (typeof CUSTOMERS)[number]["key"];

/** Purchase orders. Only RECEIVED ones put stock on the shelf. */
const PURCHASES = [
  {
    number: "PO-2026-0001",
    supplier: "kestrel",
    status: "RECEIVED",
    daysAgo: 62,
    lines: [
      { product: "kb-87", quantity: 60 },
      { product: "mouse-erg", quantity: 80 },
      { product: "mon-27", quantity: 20 },
    ],
  },
  {
    number: "PO-2026-0002",
    supplier: "northwind",
    status: "RECEIVED",
    daysAgo: 48,
    lines: [
      { product: "dock-usbc", quantity: 30 },
      { product: "cable-hdmi", quantity: 200 },
    ],
  },
  {
    number: "PO-2026-0003",
    supplier: "harbour",
    status: "RECEIVED",
    daysAgo: 34,
    lines: [
      { product: "box-ship", quantity: 500 },
      { product: "label-therm", quantity: 40 },
    ],
  },
  {
    number: "PO-2026-0004",
    supplier: "aldridge",
    status: "RECEIVED",
    daysAgo: 27,
    lines: [
      { product: "chair-erg", quantity: 12 },
      { product: "desk-std", quantity: 6 },
    ],
  },
  {
    number: "PO-2026-0005",
    supplier: "meridian",
    status: "RECEIVED",
    daysAgo: 19,
    lines: [{ product: "paper-a4", quantity: 400 }],
  },
  {
    // Placed but not delivered: stock must NOT move for this one. It exists so
    // the purchasing screens have an open order to render.
    number: "PO-2026-0006",
    supplier: "meridian",
    status: "PENDING",
    daysAgo: 3,
    lines: [{ product: "paper-a4", quantity: 200 }],
  },
] as const;

/**
 * Sales orders. Stock leaves on CONFIRMED and stays gone through FULFILLED;
 * DRAFT and CANCELLED move nothing.
 *
 * `discountPct` is applied to the subtotal and rounded to whole cents, so
 * `total = subtotal - discount` holds exactly. This system calculates no tax,
 * and the check constraint on `orders` would reject a total that implied one.
 */
const ORDERS = [
  {
    number: "SO-2026-0001",
    customer: "brightline",
    status: "COMPLETED",
    daysAgo: 21,
    discountPct: 0,
    lines: [
      { product: "kb-87", quantity: 4 },
      { product: "mouse-erg", quantity: 4 },
    ],
  },
  {
    number: "SO-2026-0002",
    customer: "calder",
    status: "COMPLETED",
    daysAgo: 16,
    discountPct: 5,
    lines: [
      { product: "mon-27", quantity: 3 },
      { product: "dock-usbc", quantity: 3 },
      { product: "cable-hdmi", quantity: 6 },
    ],
  },
  {
    number: "SO-2026-0003",
    customer: "penrose",
    status: "COMPLETED",
    daysAgo: 12,
    discountPct: 10,
    lines: [
      { product: "chair-erg", quantity: 6 },
      { product: "desk-std", quantity: 2 },
    ],
  },
  {
    number: "SO-2026-0004",
    customer: "quayside",
    status: "PENDING",
    daysAgo: 6,
    discountPct: 0,
    lines: [
      { product: "box-ship", quantity: 300 },
      { product: "label-therm", quantity: 24 },
    ],
  },
  {
    number: "SO-2026-0005",
    customer: "wren",
    status: "CONFIRMED",
    daysAgo: 2,
    discountPct: 0,
    lines: [
      { product: "paper-a4", quantity: 120 },
      { product: "kb-87", quantity: 2 },
    ],
  },
  {
    // Still being written up — no stock committed.
    number: "SO-2026-0006",
    customer: "brightline",
    status: "DRAFT",
    daysAgo: 1,
    discountPct: 0,
    lines: [
      { product: "desk-std", quantity: 1 },
      { product: "chair-erg", quantity: 1 },
    ],
  },
  {
    // Cancelled before confirmation, so nothing was ever deducted.
    number: "SO-2026-0007",
    customer: "quayside",
    status: "CANCELLED",
    daysAgo: 9,
    discountPct: 0,
    lines: [{ product: "mouse-erg", quantity: 10 }],
  },
] as const;

/** An order's status decides whether its lines ever touched stock. */
const ORDER_MOVES_STOCK: Record<OrderStatus, boolean> = {
  DRAFT: false,
  // Finished but not committed — waiting on approval or payment. Nothing has
  // left the building yet.
  PENDING: false,
  // The one status that moves stock.
  CONFIRMED: true,
  // Already deducted on CONFIRMED, and not deducted again on the way here.
  COMPLETED: true,
  CANCELLED: false,
};

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Certificates
// ---------------------------------------------------------------------------

/**
 * Synthetic airworthiness paperwork, for development only.
 *
 * **None of this is a real aviation document, and none of it is meant to look
 * like one.** The types, numbers and file contents all say so in as many words.
 * A seed that produced plausible-looking 8130-3 or EASA Form 1 scans would be a
 * set of forgeries sitting in a repository, and somebody would eventually
 * mistake one for evidence.
 *
 * The point of seeding these at all is that certificates now belong to *lots*,
 * and the states worth exercising only exist across several batches of the same
 * part: one covered, one not, one expiring, one expired, one whose document was
 * replaced. Two products carry that spread deliberately.
 *
 * Files are written straight to the local storage directory rather than through
 * `fileStorage`, because that module is `server-only` and cannot be imported
 * from a plain script. The key format and layout mirror it exactly —
 * `certificates/<uuid>.pdf` under FILE_STORAGE_DIR — so the app reads them back
 * through its normal path.
 */

/** A day offset from today, as a UTC calendar date. */
function daysFromNow(days: number): Date {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

/**
 * A minimal, valid PDF whose visible text says what it is.
 *
 * Begins with `%PDF-1.7` because that is the signature the upload path sniffs
 * for, so a seeded file behaves like an uploaded one everywhere downstream.
 */
function syntheticPdf(label: string): Buffer {
  const text = `SYNTHETIC DEVELOPMENT SAMPLE - NOT A REAL CERTIFICATE - ${label}`;
  return Buffer.from(
    `%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n% ${text}\n%%EOF\n`,
    "utf8",
  );
}

interface CertificateSpec {
  /** Which product's batch this covers, and which batch of it. */
  product: ProductKey;
  /** 0 is the oldest surviving lot for that product. */
  lotIndex: number;
  certificateType: string;
  certificateNumber: string;
  issueDate: Date;
  /** Null means it does not expire — a valid and common state. */
  expiryDate: Date | null;
  /** True for a document that was replaced; it stays as history. */
  superseded?: boolean;
}

async function seedCertificates(
  productIds: Map<ProductKey, string>,
  uploadedBy: string,
): Promise<void> {
  const storageRoot = resolve(process.env["FILE_STORAGE_DIR"] ?? ".storage");

  const specs: CertificateSpec[] = [
    // KB-MECH-87 — one batch covered and current, another left with nothing.
    {
      product: "kb-87",
      lotIndex: 0,
      certificateType: "SAMPLE Conformity Record",
      certificateNumber: "DEV-SAMPLE-0001",
      issueDate: daysFromNow(-400),
      // No expiry at all: a valid, complete answer, not a missing one.
      expiryDate: null,
    },
    // MN-4K-27 — a replaced document plus its replacement, and an expiry
    // close enough to read as EXPIRING_SOON.
    {
      product: "mon-27",
      lotIndex: 0,
      certificateType: "SAMPLE Release Record",
      certificateNumber: "DEV-SAMPLE-0002-SUPERSEDED",
      issueDate: daysFromNow(-500),
      expiryDate: daysFromNow(-120),
      superseded: true,
    },
    {
      product: "mon-27",
      lotIndex: 0,
      certificateType: "SAMPLE Release Record",
      certificateNumber: "DEV-SAMPLE-0003",
      issueDate: daysFromNow(-90),
      expiryDate: daysFromNow(14),
    },
    // MO-ERG-02 — expired, so the dashboard has something to flag.
    {
      product: "mouse-erg",
      lotIndex: 0,
      certificateType: "SAMPLE Conformity Record",
      certificateNumber: "DEV-SAMPLE-0004",
      issueDate: daysFromNow(-800),
      expiryDate: daysFromNow(-30),
    },
  ];

  let written = 0;

  for (const spec of specs) {
    const productId = productIds.get(spec.product)!;

    const lots = await prisma.stockLot.findMany({
      where: { productId },
      orderBy: [{ receivedAt: "asc" }, { id: "asc" }],
      select: { id: true },
    });

    const lot = lots[spec.lotIndex];
    // A product may legitimately have fewer batches than the spec expects if
    // the movement plan changes. Skipping is better than inventing a lot.
    if (!lot) continue;

    const key = `certificates/${randomUUID()}.pdf`;
    const path = join(storageRoot, key);
    await mkdir(dirname(path), { recursive: true });
    const body = syntheticPdf(spec.certificateNumber);
    await writeFile(path, body);

    await prisma.certificate.create({
      data: {
        productId,
        stockLotId: lot.id,
        certificateType: spec.certificateType,
        certificateNumber: spec.certificateNumber,
        issueDate: spec.issueDate,
        expiryDate: spec.expiryDate,
        fileName: `SYNTHETIC-${spec.certificateNumber}.pdf`,
        storageKey: key,
        contentType: "application/pdf",
        fileSize: body.byteLength,
        uploadedBy,
        supersededAt: spec.superseded ? daysFromNow(-90) : null,
      },
    });

    written += 1;
  }

  console.log(`  ${written} synthetic certificates (development samples only)`);
}

async function main(): Promise<void> {
  console.log("Seeding inventory_manager…\n");

  // Wipe first so the seed is re-runnable. Children before parents: the
  // foreign keys are Restrict, and that is the point — they would rather fail
  // than let a delete strand a row.
  await prisma.stockTransaction.deleteMany();
  await prisma.orderItem.deleteMany();
  await prisma.order.deleteMany();
  await prisma.purchaseItem.deleteMany();
  await prisma.purchase.deleteMany();
  await prisma.product.deleteMany();
  await prisma.customer.deleteMany();
  await prisma.supplier.deleteMany();
  await prisma.user.deleteMany();
  console.log("  cleared existing rows");

  // --- Users -------------------------------------------------------------
  // Seeded users predate any Clerk account, so they carry `unlinked_`
  // placeholders instead of real Clerk ids. Signing in with a matching email
  // claims the row and swaps in the real `user_...` id, which is how the admin
  // keeps their ADMIN role instead of arriving as a brand-new STAFF account.
  // See `resolveUser` in src/server/auth.ts.
  const users = await Promise.all(
    (
      [
        {
          clerkId: "unlinked_seed_admin",
          name: "Aryan Verma",
          email: "admin@inventory.local",
          role: "ADMIN",
        },
        {
          clerkId: "unlinked_seed_staff",
          name: "Sana Qureshi",
          email: "staff@inventory.local",
          role: "STAFF",
        },
      ] as const
    ).map((user) =>
      prisma.user.create({ data: { ...user, role: user.role as UserRole } }),
    ),
  );

  const admin = users[0]!;
  const staff = users[1]!;
  console.log(`  ${users.length} users`);

  // --- Suppliers ---------------------------------------------------------
  const supplierIds = new Map<SupplierKey, string>();

  for (const { key, ...supplier } of SUPPLIERS) {
    const row = await prisma.supplier.create({
      data: { ...supplier, status: supplier.status as SupplierStatus },
    });
    supplierIds.set(key, row.id);
  }
  console.log(`  ${supplierIds.size} suppliers`);

  // --- Products ----------------------------------------------------------
  // Created at zero stock on purpose. Everything they hold arrives below, as
  // received purchase orders, so the ledger explains every unit.
  const productIds = new Map<ProductKey, string>();
  const productCost = new Map<ProductKey, number>();
  const productPrice = new Map<ProductKey, number>();

  for (const {
    key,
    standardCostCents,
    sellingPriceCents,
    status,
    supplier,
    ...product
  } of PRODUCTS) {
    const row = await prisma.product.create({
      data: {
        ...product,
        standardCost: money(standardCostCents),
        sellingPrice: money(sellingPriceCents),
        status: status as ProductStatus,
        stockQuantity: 0,
        supplierId: supplierIds.get(supplier)!,
      },
    });

    productIds.set(key, row.id);
    productCost.set(key, standardCostCents);
    productPrice.set(key, sellingPriceCents);
  }
  console.log(`  ${productIds.size} products`);

  // --- Customers ---------------------------------------------------------
  const customerIds = new Map<CustomerKey, string>();

  for (const { key, ...customer } of CUSTOMERS) {
    const row = await prisma.customer.create({ data: customer });
    customerIds.set(key, row.id);
  }
  console.log(`  ${customerIds.size} customers`);

  // --- The stock ledger --------------------------------------------------
  // Moves are planned here and written afterwards, sorted by timestamp.
  //
  // The ordering is the whole point. previousStock/newStock chain a product's
  // rows to each other, so the chain has to be built in the order the events
  // happened — not in the order this file happens to create the documents that
  // caused them. Write a stock count dated last week after an order dated
  // yesterday and the ledger reads as corrupt the moment anyone sorts it by
  // date, which is the only way anyone ever reads a ledger.
  type PendingMove = {
    /** Lets a later move point back at this one — see the REVERSAL below. */
    key?: string;
    product: ProductKey;
    type: StockTransactionType;
    /** Signed: positive adds to stock, negative removes. */
    delta: number;
    referenceType: StockReferenceType;
    referenceId?: string;
    /** Resolved to the id of the already-written move carrying this key. */
    reverses?: string;
    createdBy: string;
    at: Date;
  };

  const pending: PendingMove[] = [];
  const plan = (move: PendingMove): void => {
    pending.push(move);
  };

  const onHand = new Map<ProductKey, number>(
    PRODUCTS.map(({ key }): [ProductKey, number] => [key, 0]),
  );

  const applyMoves = async (): Promise<number> => {
    // Stable sort, so two moves sharing a timestamp keep the order they were
    // planned in.
    const ordered = [...pending].sort((a, b) => a.at.getTime() - b.at.getTime());
    const writtenIds = new Map<string, string>();

    for (const move of ordered) {
      const previousStock = onHand.get(move.product)!;
      const newStock = previousStock + move.delta;

      if (newStock < 0) {
        throw new Error(
          `Seed would drive ${move.product} to ${newStock} on ${move.at.toISOString()}. Fix the quantities, not the ledger.`,
        );
      }

      const row = await prisma.stockTransaction.create({
        data: {
          type: move.type,
          // The column holds the size of the move; `type` carries the direction.
          quantity: Math.abs(move.delta),
          previousStock,
          newStock,
          referenceType: move.referenceType,
          referenceId: move.reverses
            ? writtenIds.get(move.reverses)!
            : (move.referenceId ?? null),
          productId: productIds.get(move.product)!,
          createdBy: move.createdBy,
          createdAt: move.at,
        },
      });

      if (move.key) writtenIds.set(move.key, row.id);
      onHand.set(move.product, newStock);
    }

    return ordered.length;
  };

  // --- Purchases ---------------------------------------------------------
  for (const purchase of PURCHASES) {
    const placedAt = daysAgo(purchase.daysAgo, 9);

    const lines = purchase.lines.map((line) => {
      const unitCost = productCost.get(line.product)!;
      return {
        ...line,
        unitCostCents: unitCost,
        totalCents: unitCost * line.quantity,
      };
    });

    const totalCents = lines.reduce((sum, line) => sum + line.totalCents, 0);

    const row = await prisma.purchase.create({
      data: {
        purchaseNumber: purchase.number,
        status: purchase.status as PurchaseStatus,
        total: money(totalCents),
        purchaseDate: placedAt,
        createdAt: placedAt,
        supplierId: supplierIds.get(purchase.supplier)!,
        items: {
          create: lines.map((line) => ({
            quantity: line.quantity,
            unitCost: money(line.unitCostCents),
            total: money(line.totalCents),
            productId: productIds.get(line.product)!,
          })),
        },
      },
    });

    if (purchase.status !== "RECEIVED") continue;

    // Goods in. Booked a few hours after the order, which is fiction, but it
    // keeps the ledger ordered the way a real one would be.
    for (const line of lines) {
      plan({
        product: line.product,
        type: "STOCK_IN",
        delta: line.quantity,
        referenceType: "PURCHASE",
        referenceId: row.id,
        createdBy: admin.id,
        at: new Date(placedAt.getTime() + 6 * 60 * 60 * 1000),
      });
    }
  }
  console.log(`  ${PURCHASES.length} purchases`);

  // --- Orders ------------------------------------------------------------
  for (const order of ORDERS) {
    const placedAt = daysAgo(order.daysAgo, 14);

    const lines = order.lines.map((line) => {
      const unitPrice = productPrice.get(line.product)!;
      return {
        ...line,
        unitPriceCents: unitPrice,
        totalCents: unitPrice * line.quantity,
      };
    });

    const subtotalCents = lines.reduce((sum, line) => sum + line.totalCents, 0);
    const discountCents = roundCents((subtotalCents * order.discountPct) / 100);
    const totalCents = subtotalCents - discountCents;

    const row = await prisma.order.create({
      data: {
        orderNumber: order.number,
        status: order.status as OrderStatus,
        subtotal: money(subtotalCents),
        discount: money(discountCents),
        total: money(totalCents),
        createdAt: placedAt,
        customerId: customerIds.get(order.customer)!,
        items: {
          create: lines.map((line) => ({
            quantity: line.quantity,
            unitPrice: money(line.unitPriceCents),
            total: money(line.totalCents),
            productId: productIds.get(line.product)!,
          })),
        },
      },
    });

    if (!ORDER_MOVES_STOCK[order.status as OrderStatus]) continue;

    for (const line of lines) {
      plan({
        product: line.product,
        type: "STOCK_OUT",
        delta: -line.quantity,
        referenceType: "ORDER",
        referenceId: row.id,
        createdBy: staff.id,
        at: new Date(placedAt.getTime() + 2 * 60 * 60 * 1000),
      });
    }
  }
  console.log(`  ${ORDERS.length} orders`);

  // --- Corrections -------------------------------------------------------
  // The rows that make the ledger look like a real one: a stock count that
  // disagreed with the system, breakage, and a mistake put right by a REVERSAL
  // rather than by deleting anything.

  // A stock count that disagreed with the system.
  plan({
    product: "paper-a4",
    type: "ADJUSTMENT",
    delta: -3,
    referenceType: "MANUAL",
    createdBy: staff.id,
    at: daysAgo(11, 16),
  });

  // Breakage, written off.
  plan({
    product: "box-ship",
    type: "ADJUSTMENT",
    delta: -12,
    referenceType: "MANUAL",
    createdBy: staff.id,
    at: daysAgo(8, 11),
  });

  // Counted in error…
  plan({
    key: "mouse-miscount",
    product: "mouse-erg",
    type: "ADJUSTMENT",
    delta: 25,
    referenceType: "MANUAL",
    createdBy: staff.id,
    at: daysAgo(5, 15),
  });

  // …and put right two hours later by a REVERSAL that points at the row it
  // undoes, rather than by editing history.
  plan({
    product: "mouse-erg",
    type: "REVERSAL",
    delta: -25,
    referenceType: "STOCK_TRANSACTION",
    reverses: "mouse-miscount",
    createdBy: admin.id,
    at: daysAgo(5, 17),
  });

  // One monitor damaged in the stockroom.
  plan({
    product: "mon-27",
    type: "ADJUSTMENT",
    delta: -1,
    referenceType: "MANUAL",
    createdBy: admin.id,
    at: daysAgo(4, 12),
  });

  const transactionCount = await applyMoves();
  console.log(`  ${transactionCount} stock transactions`);

  // --- Settle the balances ----------------------------------------------
  // The ledger is the authority; the product row is a cache of its last value.
  for (const [key, quantity] of onHand) {
    await prisma.product.update({
      where: { id: productIds.get(key)! },
      data: { stockQuantity: quantity },
    });
  }

  // --- Costed lots -------------------------------------------------------
  /*
   * What the stock on hand cost, batch by batch.
   *
   * Built by the same rule the backfill migration uses on a real database:
   * attribute the closing balance to received purchases newest-first, because
   * FIFO consumes the oldest units and what remains is therefore what arrived
   * last. Anything the purchase history cannot account for — stock adjusted in
   * by hand — becomes an uncosted lot rather than being valued at a figure
   * nobody paid.
   *
   * That leaves the seeded database with a genuine mix of costed and uncosted
   * inventory, which is the state a real one is in after the migration, and
   * exercises the "margin known for some units only" paths that would otherwise
   * never be seen in development.
   */
  let costedLots = 0;
  let uncostedLots = 0;

  for (const product of PRODUCTS) {
    const productId = productIds.get(product.key)!;
    let remaining = onHand.get(product.key)!;
    if (remaining <= 0) continue;

    const receipts = await prisma.purchaseItem.findMany({
      where: { productId, purchase: { status: "RECEIVED" } },
      orderBy: [{ purchase: { purchaseDate: "desc" } }, { id: "desc" }],
      select: {
        quantity: true,
        unitCost: true,
        purchase: { select: { id: true, purchaseDate: true } },
      },
    });

    for (const receipt of receipts) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, receipt.quantity);

      const stockIn = await prisma.stockTransaction.findFirst({
        where: {
          productId,
          type: "STOCK_IN",
          referenceType: "PURCHASE",
          referenceId: receipt.purchase.id,
        },
        select: { id: true },
      });

      await prisma.stockLot.create({
        data: {
          productId,
          unitCost: receipt.unitCost,
          costSource: "PURCHASE",
          quantityReceived: take,
          quantityRemaining: take,
          sourceType: "PURCHASE",
          sourceId: receipt.purchase.id,
          receivedAt: receipt.purchase.purchaseDate,
          stockTransactionId: stockIn?.id ?? null,
        },
      });

      remaining -= take;
      costedLots += 1;
    }

    if (remaining > 0) {
      await prisma.stockLot.create({
        data: {
          productId,
          unitCost: null,
          costSource: "UNKNOWN",
          quantityReceived: remaining,
          quantityRemaining: remaining,
          sourceType: "MANUAL",
          sourceId: null,
          receivedAt: daysAgo(30, 8),
          stockTransactionId: null,
        },
      });
      uncostedLots += 1;
    }
  }

  console.log(`  ${costedLots} costed lots, ${uncostedLots} uncosted`);

  // After the lots exist, because paperwork attaches to a batch.
  await seedCertificates(productIds, admin.id);

  console.log("\nStock on hand:");
  for (const product of PRODUCTS) {
    const quantity = onHand.get(product.key)!;
    console.log(`  ${product.sku.padEnd(12)} ${String(quantity).padStart(4)}`);
  }
}

main()
  .then(async () => {
    await prisma.$disconnect();
    console.log("\nSeed complete.");
  })
  .catch(async (error: unknown) => {
    await prisma.$disconnect();
    console.error("\nSeed failed:", error);
    process.exit(1);
  });
