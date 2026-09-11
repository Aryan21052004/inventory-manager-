import { csvFilename, csvHeaders, toCsv } from "@/lib/csv";
import type { MoneyByCurrency } from "@/lib/money-by-currency";
import { AppError, toSafeError } from "@/lib/errors";
import {
  describeRange,
  isReportKey,
  reportParamsFor,
  reportRowLabel,
  REPORT_CONFIG,
  REPORT_TITLES,
  type ReportKey,
  type ReportParams,
} from "@/lib/report-query";
import {
  loadCertificateRegisterReport,
  loadMovementSummaryReport,
  loadPurchaseSpendReport,
  loadSalesReport,
  loadValuationReport,
} from "@/server/reports";
import { certificateStatusLabel } from "@/lib/certificate-status";

/**
 * CSV export for the reports.
 *
 * The rule that shapes this file: **it runs the same query the page ran.** The
 * route parses the identical query string with the identical parser and calls
 * the identical loader — there is no second aggregation here, and no
 * opportunity for the export to answer a slightly different question than the
 * screen it was downloaded from. A report and its CSV disagreeing is the
 * failure that would be hardest to notice and worst to act on.
 *
 * Authorisation is the loaders' own: each calls `requireUser()` before it
 * touches data, so an unauthenticated request gets a 401 without a row being
 * read and without learning whether the report exists. That is the same
 * arrangement the certificate download uses.
 *
 * Paging is deliberately ignored. A screen shows a page; an export is the whole
 * result, so the page size is raised to a bound high enough to cover any
 * plausible catalogue and the offset is discarded.
 */

export const dynamic = "force-dynamic";

/**
 * The cap on an export.
 *
 * High enough that no real result is truncated, low enough that a pathological
 * request cannot ask Postgres to materialise an unbounded set into memory.
 * Truncation is reported in the file rather than left silent — a short CSV that
 * does not say it is short is worse than a refusal.
 */
const EXPORT_LIMIT = 10_000;

/*
 * The report's groupings and sort keys are deliberately not restated here. They
 * come from REPORT_CONFIG through `reportParamsFor`, exactly as the page gets
 * them — this route once kept its own parallel copies, and two copies of a
 * report's definition is how an export comes to answer a differently grouped
 * question than the screen it was downloaded from.
 */
function paramsFor(report: ReportKey, url: URL): ReportParams {
  const raw = Object.fromEntries(url.searchParams.entries());
  const parsed = reportParamsFor(report, raw);

  // The whole result, not a page of it.
  return { ...parsed, page: 1, pageSize: EXPORT_LIMIT };
}

/**
 * How a monetary amount says what it is denominated in.
 *
 * Every money column now travels as a pair — the amount, and the currency
 * beside it — because a single header line naming one currency for the whole
 * file was a claim this application cannot make. It used to read the
 * installation default and assert that every figure below was in it, which
 * was wrong for any history recorded under a different setting and wrong for
 * any business that buys and sells in more than one currency.
 *
 * The amount itself stays a raw decimal. Putting `₹` in the cell would turn a
 * number column into a text column and break every sort, sum and formula
 * written against the export; the currency belongs in its own column, where a
 * spreadsheet can group by it.
 */
const UNKNOWN_CURRENCY = "unknown";
const MIXED_CURRENCY = "mixed";

/**
 * The amount cell and the currency cell for one monetary total.
 *
 * Three answers, kept distinct on purpose:
 *
 *   nothing to total  → both blank. Not a zero: no rows contributed at all.
 *   one currency      → the amount, and its code — or `unknown` where the
 *                       currency was never recorded, which is a fact about the
 *                       data and never the installation default standing in.
 *   several           → the amount is blank, because there is no single
 *                       defensible number, and the currency reads `mixed`. The
 *                       figures themselves follow on their own rows; see
 *                       `splitRows`.
 */
function moneyCells(total: MoneyByCurrency): [string | null, string | null] {
  if (total.length === 0) return [null, null];
  if (total.length > 1) return [null, MIXED_CURRENCY];

  const only = total[0]!;
  return [only.amount, only.currency ?? UNKNOWN_CURRENCY];
}

/**
 * The extra rows a mixed total needs — one per currency, under the same label.
 *
 * Only the label and the money cells are filled; every quantity cell is left
 * blank so a spreadsheet summing the units column still gets the right answer.
 * A total in one currency needs none of this and produces nothing.
 */
function splitRows(
  label: string | null,
  total: MoneyByCurrency,
  width: number,
  amountAt: number,
): (string | number | null)[][] {
  if (total.length <= 1) return [];

  return total.map((entry) => {
    const cells: (string | number | null)[] = Array(width).fill(null);
    cells[0] = label;
    cells[amountAt] = entry.amount;
    cells[amountAt + 1] = entry.currency ?? UNKNOWN_CURRENCY;
    return cells;
  });
}

/** The notes every report carrying money owes its reader. */
const MONEY_NOTES = [
  "Monetary columns carry their own currency in the column beside them. Nothing here is converted between currencies and no exchange rate is applied.",
  `A figure spanning several currencies has no single value: its amount is blank, its currency reads "${MIXED_CURRENCY}", and one row per currency follows it.`,
  `"${UNKNOWN_CURRENCY}" means no currency was ever recorded against those rows. It is not an assumption that they are in any particular one.`,
];

/**
 * A per-currency total written into a preamble line, where a column pair will
 * not fit — `1200.00 INR; 40.00 unknown`, or `none` when there is nothing.
 */
function inlineMoney(total: MoneyByCurrency): string {
  if (total.length === 0) return "none";

  return total
    .map((entry) => `${entry.amount} ${entry.currency ?? UNKNOWN_CURRENCY}`)
    .join("; ");
}

/**
 * The filters an export was run under, written into the file itself.
 */
function preamble(report: ReportKey, params: ReportParams): string[] {
  const lines = [
    `${REPORT_TITLES[report]} — exported ${new Date().toISOString().slice(0, 10)}`,
    `Period: ${describeRange(params)}`,
  ];

  if (REPORT_CONFIG[report].groupings.length > 0) {
    lines.push(`Grouped by: ${params.grouping}`);
  }
  if (params.search) lines.push(`Search: ${params.search}`);
  if (params.category) lines.push(`Category: ${params.category}`);
  if (params.movementType) {
    lines.push(`Movement type: ${params.movementType}`);
  }
  if (params.certificateStatus) {
    lines.push(`Compliance: ${certificateStatusLabel(params.certificateStatus)}`);
  }
  if (params.certificateType) {
    lines.push(`Certificate type: ${params.certificateType}`);
  }
  if (params.lotStatus) lines.push(`Batch status: ${params.lotStatus}`);
  if (params.productStatus) lines.push(`Product status: ${params.productStatus}`);
  if (params.includeEmptied) lines.push("Includes emptied batches");

  return lines;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ report: string }> },
) {
  const { report } = await params;

  try {
    if (!isReportKey(report)) {
      return Response.json(
        { error: "No such report.", code: "NOT_FOUND" },
        { status: 404, headers: { "Cache-Control": "private, no-store" } },
      );
    }

    const url = new URL(request.url);
    const reportParams = paramsFor(report, url);

    const body = await render(report, reportParams);

    return new Response(body, {
      status: 200,
      headers: csvHeaders(csvFilename(report)),
    });
  } catch (error) {
    /*
     * `toSafeError` passes our own messages through and replaces anything else
     * with a generic line, so a database error cannot describe the server's
     * internals to whoever asked.
     */
    const safe = toSafeError(error, `GET /api/reports/${report}/csv`);

    return Response.json(
      { error: safe.message, code: safe.code },
      {
        status:
          safe.code === "UNAUTHORIZED"
            ? 401
            : safe.code === "FORBIDDEN"
              ? 403
              : safe.code === "NOT_FOUND"
                ? 404
                : 500,
        headers: { "Cache-Control": "private, no-store" },
      },
    );
  }
}

/**
 * Re-throws a loader's failure without flattening it.
 *
 * The loaders return a result rather than throwing, and that result carries the
 * code — UNAUTHORIZED, FORBIDDEN, whatever it was. Throwing a bare `Error` here
 * would lose it and every failure would leave as a 500, so an unauthenticated
 * download would report a server fault rather than asking the caller to sign
 * in.
 */
function rethrow(error: { code: AppError["code"]; message: string }): never {
  throw new AppError(error.code, error.message);
}

async function render(
  report: ReportKey,
  params: ReportParams,
): Promise<string> {
  const truncated = (count: number): string[] =>
    count >= EXPORT_LIMIT
      ? [`Truncated at ${EXPORT_LIMIT} rows — narrow the filters for the rest.`]
      : [];

  if (report === "valuation") {
    const result = await loadValuationReport(params);
    if (!result.ok) rethrow(result.error);

    const { rows, totals } = result.data;

    /*
     * Cost and retail each carry their own currency, and they are genuinely
     * allowed to differ: stock bought from one country and priced for sale in
     * another has a cost in one currency and a catalogue price in a second.
     * Two independent column pairs, never netted against each other and never
     * folded into a single figure.
     */
    const WIDTH = 13;
    const COST_AT = 8;
    const RETAIL_AT = 10;

    return toCsv(
      [
        "SKU",
        "Product",
        "Category",
        "Supplier",
        "Status",
        "Units on hand",
        "Costed units",
        "Uncosted units",
        "Value at cost",
        "Cost currency",
        "Value at retail",
        "Retail currency",
        "Cost coverage %",
      ],
      [
        ...rows.flatMap((row) => {
          const [cost, costCurrency] = moneyCells(row.valueAtCostByCurrency);
          const [retail, retailCurrency] = moneyCells(
            row.valueAtRetailByCurrency,
          );

          return [
            [
              row.sku,
              row.name,
              row.category,
              row.supplierName,
              row.productStatus,
              row.units,
              row.costedUnits,
              row.uncostedUnits,
              cost,
              costCurrency,
              retail,
              retailCurrency,
              row.coverage,
            ],
            ...splitRows(row.sku, row.valueAtCostByCurrency, WIDTH, COST_AT),
            ...splitRows(
              row.sku,
              row.valueAtRetailByCurrency,
              WIDTH,
              RETAIL_AT,
            ),
          ];
        }),
        // A totals row, so a spreadsheet that gets forwarded still carries the
        // coverage caveat rather than only the value.
        [
          "TOTAL",
          `${totals.products} products`,
          "",
          "",
          "",
          totals.units,
          totals.costedUnits,
          totals.uncostedUnits,
          ...moneyCells(totals.valueAtCostByCurrency),
          ...moneyCells(totals.valueAtRetailByCurrency),
          totals.coverage,
        ],
        ...splitRows(
          "TOTAL",
          totals.valueAtCostByCurrency,
          WIDTH,
          COST_AT,
        ),
        ...splitRows(
          "TOTAL",
          totals.valueAtRetailByCurrency,
          WIDTH,
          RETAIL_AT,
        ),
      ],
      [
        ...preamble(report, params),
        ...MONEY_NOTES,
        "Value at cost covers only units with a recorded acquisition cost. Uncosted units are excluded from it, never valued at zero.",
        "Value at retail is quantity x selling price — a different basis, not a second estimate of cost. It is not comparable with value at cost, and the two are not combined even when they share a currency.",
        `Retired stock, at cost: ${inlineMoney(totals.retiredValueAtCostByCurrency)} across ${totals.retiredUnits} units in ${totals.retiredProducts} products.`,
        ...truncated(rows.length),
      ],
    );
  }

  if (report === "certificates") {
    const result = await loadCertificateRegisterReport(params);
    if (!result.ok) rethrow(result.error);

    const { rows, totals } = result.data;

    /*
     * The columns the screen shows, in the screen's order, and nothing the
     * screen does not have. The file link is deliberately not exported as a
     * URL: certificates are served through an authenticated route, and a
     * spreadsheet that travels outside the application would carry a link
     * nobody can open and imply the document is fetchable. Yes/No answers the
     * only question the export can honestly answer — is a document on file.
     */
    return toCsv(
      [
        "SKU",
        "Product",
        "Category",
        "Product status",
        "Batch received",
        "Units remaining",
        "Batch status",
        "Provenance",
        "Purchase",
        "Supplier (lot provenance)",
        "Certificate type",
        "Certificate number",
        "Issue date",
        "Expiry date",
        "Days to expiry",
        "Compliance",
        "Document on file",
      ],
      [
        ...rows.map((row) => [
          row.sku,
          row.productName,
          row.category,
          row.productStatus,
          row.receivedAt.toISOString().slice(0, 10),
          row.quantityRemaining,
          row.lotStatus,
          row.provenance,
          row.purchaseNumber,
          row.supplierName,
          row.certificateType,
          row.certificateNumber,
          row.issueDate === null ? null : row.issueDate.toISOString().slice(0, 10),
          // "No expiry" rather than blank: a document that does not expire is a
          // fact, and an empty cell would read as information nobody recorded.
          row.certificateId === null
            ? null
            : row.expiryDate === null
              ? "No expiry"
              : row.expiryDate.toISOString().slice(0, 10),
          row.daysToExpiry,
          certificateStatusLabel(row.status),
          row.certificateId === null ? "No" : "Yes",
        ]),
        [
          "TOTAL",
          `${totals.batches} batches`,
          "",
          "",
          "",
          totals.units,
          "",
          "",
          "",
          "",
          "",
          "",
          "",
          "",
          "",
          `${totals.valid} valid, ${totals.expiringSoon} expiring, ${totals.expired} expired, ${totals.missing} missing`,
          "",
        ],
      ],
      [
        ...preamble(report, params),
        "One row per batch, not per product. Only the certificate currently in force is shown; superseded documents remain on the product as history.",
        "A certificate with no expiry date is valid — a Certificate of Conformity typically never expires.",
        "Supplier is lot provenance, not a statement about who issued the certificate. Batches not acquired by purchase have none.",
        "Batch status is not compliance: a quarantined or rejected batch can hold a valid certificate.",
        ...truncated(rows.length),
      ],
    );
  }

  if (report === "sales") {
    const result = await loadSalesReport(params);
    if (!result.ok) rethrow(result.error);

    const { rows, totals } = result.data;

    const WIDTH = 6;
    const REVENUE_AT = 4;

    return toCsv(
      ["Group", "Detail", "Orders", "Units", "Revenue", "Revenue currency"],
      [
        ...rows.flatMap((row) => [
          [
            row.label,
            row.sublabel,
            row.orders,
            row.units,
            ...moneyCells(row.revenueByCurrency),
          ],
          ...splitRows(row.label, row.revenueByCurrency, WIDTH, REVENUE_AT),
        ]),
        [
          "TOTAL",
          "",
          totals.orders,
          totals.units,
          ...moneyCells(totals.revenueByCurrency),
        ],
        ...splitRows("TOTAL", totals.revenueByCurrency, WIDTH, REVENUE_AT),
      ],
      [
        ...preamble(report, params),
        ...MONEY_NOTES,
        "Confirmed and completed orders only, dated by when each was confirmed.",
        "Revenue is denominated in the currency each order was raised in. A group whose orders were raised in more than one is reported once per currency.",
        ...truncated(rows.length),
      ],
    );
  }

  if (report === "movements") {
    const result = await loadMovementSummaryReport(params);
    if (!result.ok) rethrow(result.error);

    const { rows, totals } = result.data;

    return toCsv(
      [
        "Group",
        "Detail",
        "Movements",
        "Products",
        "Units in",
        "Units out",
        "Net change",
      ],
      [
        ...rows.map((row) => [
          reportRowLabel(params.grouping, row.label),
          row.sublabel,
          row.movements,
          row.products,
          row.unitsIn,
          row.unitsOut,
          row.netChange,
        ]),
        [
          "TOTAL",
          "",
          totals.movements,
          totals.products,
          totals.unitsIn,
          totals.unitsOut,
          totals.netChange,
        ],
      ],
      [
        ...preamble(report, params),
        "Dated by when each movement was recorded in the ledger — the moment the stock actually moved.",
        "Direction is read from the balance a movement left behind, not from its type, so a cancellation counts against the movement it undid.",
        "Units in minus units out equals net change. A confirmation and its later cancellation remain two movements.",
        "Opening stock and manual adjustments are included. Stock that predates the ledger has no movement and is not reported.",
        "Quantities only. Movement value and cost of sales are deliberately absent — per-movement cost is on the stock movements page.",
        ...truncated(rows.length),
      ],
    );
  }

  const result = await loadPurchaseSpendReport(params);
  if (!result.ok) rethrow(result.error);

  const { rows, totals } = result.data;

  const WIDTH = 6;
  const SPEND_AT = 4;

  return toCsv(
    ["Group", "Detail", "Purchases", "Units", "Received spend", "Spend currency"],
    [
      ...rows.flatMap((row) => [
        [
          row.label,
          row.sublabel,
          row.purchases,
          row.units,
          ...moneyCells(row.receivedSpendByCurrency),
        ],
        ...splitRows(row.label, row.receivedSpendByCurrency, WIDTH, SPEND_AT),
      ]),
      [
        "TOTAL",
        "",
        totals.purchases,
        totals.units,
        ...moneyCells(totals.receivedSpendByCurrency),
      ],
      ...splitRows("TOTAL", totals.receivedSpendByCurrency, WIDTH, SPEND_AT),
    ],
    [
      ...preamble(report, params),
      ...MONEY_NOTES,
      "Received purchases only, dated by when each delivery arrived. Drafts and cancellations are excluded.",
      `Committed (pending, not yet received): ${inlineMoney(totals.committedSpendByCurrency)} across ${totals.committedPurchases} purchases — not counted as spend.`,
      "Spend is not cost of sales. These are different events at different times.",
      ...truncated(rows.length),
    ],
  );
}
