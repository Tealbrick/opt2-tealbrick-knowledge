// CSV of a `kind:table` document (documents/1: "CSV of rows with a header line") → rows for foundry's ingest.
// RFC 4180: comma separator, double-quoted fields with "" escapes, CRLF or LF. A column whose every non-empty value is a
// number becomes numbers (and true/false booleans), so foundry profiles amounts as numbers; anything else stays text.

export class CsvError extends Error {
  readonly code = "deep_table_invalid";
}

export const MAX_TABLE_ROWS = 10_000;
export const MAX_COLUMNS = 200;

export interface Table {
  columns: string[];
  rows: Record<string, string | number | boolean | null>[];
  /** the page (index into the texts) each row came from */
  pages: number[];
}

/** Splits CSV text into records (arrays of raw field strings). */
function records(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;
  const src = text.replace(/^﻿/u, "");
  while (i < src.length) {
    const ch = src[i] as string;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === "") {
      quoted = true;
      i++;
    } else if (ch === ",") {
      row.push(field);
      field = "";
      i++;
    } else if (ch === "\n" || ch === "\r") {
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") out.push(row);
      row = [];
      i += ch === "\r" && src[i + 1] === "\n" ? 2 : 1;
    } else {
      field += ch;
      i++;
    }
  }
  if (quoted) throw new CsvError("a quoted field is not closed");
  if (field !== "" || row.length) {
    row.push(field);
    if (row.length > 1 || row[0] !== "") out.push(row);
  }
  return out;
}

const NUMBER = /^-?(?:\d+|\d*\.\d+)(?:[eE][+-]?\d+)?$/u;

/** Column names: trimmed, empty → `column_<n>`, duplicates → `<name>_<n>`. */
function header(raw: string[]): string[] {
  const seen = new Map<string, number>();
  return raw.map((name, index) => {
    const base = name.trim().slice(0, 100) || `column_${index + 1}`;
    const count = seen.get(base.toLowerCase()) ?? 0;
    seen.set(base.toLowerCase(), count + 1);
    return count ? `${base}_${count + 1}` : base;
  });
}

/** Parses one CSV table (header line first). Throws CsvError on a malformed or oversized table. */
export function parseCsv(text: string): Table {
  return parseCsvPages([text]);
}

/**
 * Parses the pages of one table (each page has its own header line; documents/1 delivers a Postgres table as pages) into
 * one table: columns are the union by name in first-seen order, a column missing on a page is null there. Types are decided
 * over all pages together, so a column is a number only when it is a number on every page.
 */
export function parseCsvPages(texts: readonly string[]): Table {
  const columns: string[] = [];
  const raw: Map<string, string>[] = [];
  const pages: number[] = [];
  for (const [page, text] of texts.entries()) {
    const all = records(text);
    const head = all.shift();
    if (!head || head.every((name) => !name.trim())) throw new CsvError("the table has no header line");
    if (head.length > MAX_COLUMNS) throw new CsvError(`the table has more than ${MAX_COLUMNS} columns`);
    const names = header(head);
    for (const name of names) if (!columns.includes(name)) columns.push(name);
    if (columns.length > MAX_COLUMNS) throw new CsvError(`the table has more than ${MAX_COLUMNS} columns`);
    for (const record of all) {
      raw.push(new Map(names.map((name, i) => [name, record[i] ?? ""])));
      pages.push(page);
    }
    if (raw.length > MAX_TABLE_ROWS) throw new CsvError(`the table has more than ${MAX_TABLE_ROWS} rows`);
  }
  const kinds = new Map(
    columns.map((name) => {
      const values = raw.map((r) => (r.get(name) ?? "").trim()).filter((v) => v !== "");
      if (!values.length) return [name, "text"];
      if (values.every((v) => NUMBER.test(v) && !/^-?0\d/u.test(v))) return [name, "number"];
      if (values.every((v) => /^(true|false)$/iu.test(v))) return [name, "boolean"];
      return [name, "text"];
    }),
  );
  const rows = raw.map((r) =>
    Object.fromEntries(
      columns.map((name) => {
        const value = r.get(name) ?? "";
        const trimmed = value.trim();
        if (trimmed === "") return [name, null];
        if (kinds.get(name) === "number") return [name, Number(trimmed)];
        if (kinds.get(name) === "boolean") return [name, trimmed.toLowerCase() === "true"];
        return [name, value];
      }),
    ),
  );
  return { columns, rows, pages };
}
