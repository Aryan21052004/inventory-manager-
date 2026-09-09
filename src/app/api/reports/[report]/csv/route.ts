import type { Currency } from "@/lib/currency";
import { csvFilename, csvHeaders, toCsv } from "@/lib/csv";
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
import { getCurrency } from "@/server/settings";

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
 * The filters an export was run under, written into the file itself.
 *
 * The currency line is why this takes one: a spreadsheet of bare decimals is
 * ambiguous the moment it leaves the application, and a file that says 18104.96
 * without saying in what is a file somebody will guess at. Stating it in the
 * metadata is the whole of the fix.
 *
 * It is stated *here* and not in the cells. Money stays a raw decimal in every
 * numeric column — putting `₹` in front of it would turn a number column into a
 * text column, which breaks sorting, summing and every formula anybody writes
 * against the export. The header says the currency once; the cells stay
 * arithmetic.
 */
function preamble(
  report: ReportKey,
  params: ReportParams,
  currency: Currency,
): string[] {
  const lines = [
    `${REPORT_TITLES[report]} — exported ${new Date().toISOString().slice(0, 10)}`,
    `Period: ${describeRange(params)}`,
    `Currency: ${currency} — monetary columns are plain numbers in ${currency}, unconverted.`,
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

    const body = await render(report, reportParams, await getCurrency());

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
  currency: Currency,
): Promise<string> {
  const truncated = (count: number): string[] =>
    count >= EXPORT_LIMIT
      ? [`Truncated at ${EXPORT_LIMIT} rows — narrow the filters for the rest.`]
      : [];

  if (report === "valuation") {
    const result = await loadValuationReport(params);
    if (!result.ok) rethrow(result.error);

    const { rows, totals } = result.data;

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
        "Value at retail",
        "Cost coverage %",
      ],
      [
        ...rows.map((row) => [
          row.sku,
          row.name,
          row.category,
          row.supplierName,
          row.productStatus,
          row.units,
          row.costedUnits,
          row.uncostedUnits,
          row.valueAtCost,
          row.valueAtRetail,
          row.coverage,
        ]),
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
          totals.valueAtCost,
          totals.valueAtRetail,
          totals.coverage,
        ],
      ],
      [
        ...preamble(report, params, currency),
        "Value at cost covers only units with a recorded acquisition cost. Uncosted units are excluded from it, never valued at zero.",
        "Value at retail is quantity x selling price — a different basis, not a second estimate of cost.",
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
        ...preamble(report, params, currency),
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

    return toCsv(
      ["Group", "Detail", "Orders", "Units", "Revenue"],
      [
        ...rows.map((row) => [
          row.label,
          row.sublabel,
          row.orders,
          row.units,
          row.revenue,
        ]),
        ["TOTAL", "", totals.orders, totals.units, totals.revenue],
      ],
      [
        ...preamble(report, params, currency),
        "Confirmed and completed orders only, dated by when each was confirmed.",
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
        ...preamble(report, params, currency),
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

  return toCsv(
    ["Group", "Detail", "Purchases", "Units", "Received spend"],
    [
      ...rows.map((row) => [
        row.label,
        row.sublabel,
        row.purchases,
        row.units,
        row.receivedSpend,
      ]),
      ["TOTAL", "", totals.purchases, totals.units, totals.receivedSpend],
    ],
    [
      ...preamble(report, params, currency),
      "Received purchases only, dated by when each delivery arrived. Drafts and cancellations are excluded.",
      `Committed (pending, not yet received): ${totals.committedSpend} across ${totals.committedPurchases} purchases — not counted as spend.`,
      "Spend is not cost of sales. These are different events at different times.",
      ...truncated(rows.length),
    ],
  );
}
