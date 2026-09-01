/**
 * CSV serialisation, and the small number of ways it goes wrong.
 *
 * Written by hand rather than pulled from a package. The format is four rules
 * and a byte-order mark, and a dependency would be more surface than the
 * problem — but the four rules do have to be right, because the failure mode is
 * a spreadsheet that opens without complaint and has its columns shifted by one
 * from the first product name containing a comma.
 */

/**
 * One field, escaped.
 *
 * A field is quoted whenever it contains a comma, a quote, a newline or leading
 * or trailing whitespace, and an embedded quote is doubled. Aviation part names
 * and addresses contain all of these; "Bracket, 4x6\", Rev.B" is not a contrived
 * example.
 *
 * Null and undefined become empty rather than the strings "null" and
 * "undefined" — an absent value in a spreadsheet is a blank cell, and a report
 * that writes the word null into a column of money is one somebody has to clean
 * before they can use it.
 */
export function csvField(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";

  const text = String(value);
  if (text === "") return "";

  const needsQuoting =
    text.includes(",") ||
    text.includes('"') ||
    text.includes("\n") ||
    text.includes("\r") ||
    text !== text.trim();

  return needsQuoting ? `"${text.replace(/"/g, '""')}"` : text;
}

export function csvRow(
  values: readonly (string | number | null | undefined)[],
): string {
  return values.map(csvField).join(",");
}

/**
 * A complete document.
 *
 * `\r\n` line endings, which is what RFC 4180 specifies and what Excel expects;
 * every other tool copes with them.
 *
 * The leading byte-order mark is the difference between a supplier called
 * "Kestrel Aeroespaço" opening correctly and opening as mojibake: Excel assumes
 * the system's legacy codepage for a .csv unless a UTF-8 BOM tells it
 * otherwise. It is invisible to everything else.
 */
export function toCsv(
  header: readonly string[],
  rows: readonly (readonly (string | number | null | undefined)[])[],
  /** Lines placed above the header — the filters the export was run under. */
  preamble: readonly string[] = [],
): string {
  const lines = [
    ...preamble.map((line) => csvRow([line])),
    ...(preamble.length > 0 ? [""] : []),
    csvRow(header),
    ...rows.map(csvRow),
  ];

  return `﻿${lines.join("\r\n")}\r\n`;
}

/**
 * Headers for an authenticated CSV download.
 *
 * The same shape the certificate route uses, and for the same reasons.
 * `nosniff` stops a browser deciding a text file is something more interesting;
 * `private, no-store` keeps a commercial report out of shared caches and off
 * the disk of a machine somebody walks away from.
 */
export function csvHeaders(filename: string): HeadersInit {
  return {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${filename.replace(/"/g, "")}"`,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, no-store",
  };
}

/** `stock-valuation-2026-08-28.csv` — sortable, and safe on every filesystem. */
export function csvFilename(report: string, now: Date = new Date()): string {
  return `${report}-${now.toISOString().slice(0, 10)}.csv`;
}
