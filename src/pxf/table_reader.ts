// SPDX-License-Identifier: MIT
// Copyright (c) 2026 TrendVidia, LLC.
/**
 * Streaming consumption for the `@table` directive (draft §3.4.4).
 *
 * `unmarshalFull` materializes every row of an `@table` directive into
 * `Result.tables()`. That works for small datasets and breaks for the
 * CSV-replacement workload `@table` was designed for. `TableReader`
 * pulls one row at a time from the input string; per-row arity and the
 * v1 cell-grammar rule are enforced at consume time (not deferred to
 * end-of-input), and rows are yielded in source order — both
 * invariants the spec requires of streaming consumers.
 *
 * Convenience: `scan(schema)` reads the next row and binds its cells
 * to a fresh message of `schema`; `bindRow(schema, columns, row)` is
 * exported for callers iterating `Result.tables()[i].rows` from the
 * materializing path.
 *
 * Mirrors the cpp port at `protowire-cpp/src/pxf/table_reader.cc`.
 */

import {
  type DescMessage,
  type MessageShape,
} from "@bufbuild/protobuf";

import { type Directive, type TableRow } from "./ast.js";
import { unmarshal } from "./decode.js";
import { PxfError } from "./errors.js";
import { parse } from "./parser.js";
import { type Position } from "./token.js";

/**
 * Default cap on the @table header (leading directives plus the
 * `@table TYPE ( cols )` declaration). Real headers are tiny — a few
 * hundred bytes at most. The cap exists to fail-fast on misuse: a
 * TableReader pointed at a multi-megabyte non-`@table` input
 * shouldn't run through the whole buffer looking for one.
 */
export const DEFAULT_HEADER_MAX_BYTES = 64 * 1024;

/**
 * Streaming row reader for a single `@table` directive.
 *
 * A TableReader is positioned at the first row after `fromString()`
 * returns. Iterate via standard `for ... of` (the reader implements
 * the iterator protocol) or call `next()` until it returns `null`.
 *
 * For documents containing multiple `@table` directives, call
 * `fromString()` again on the result of `tail()`.
 */
export class TableReader implements IterableIterator<TableRow> {
  readonly type: string;
  readonly columns: readonly string[];
  readonly directives: readonly Directive[];
  /** True once the row sequence has been exhausted. */
  done = false;

  private readonly input: string;
  /** Byte offset of the next position to scan in `input`. */
  private offset: number;

  private constructor(
    input: string,
    type: string,
    columns: string[],
    directives: Directive[],
    bodyOffset: number,
  ) {
    this.input = input;
    this.type = type;
    this.columns = columns;
    this.directives = directives;
    this.offset = bodyOffset;
  }

  /**
   * Consume the leading directives and the `@table TYPE ( cols )`
   * header. Returns a reader positioned at the first row.
   *
   * Throws if the input contains no `@table` directive before EOF, on
   * a header parse error, or if the header byte budget is exceeded.
   */
  static fromString(input: string): TableReader {
    if (input.length > DEFAULT_HEADER_MAX_BYTES) {
      // Quick fail-fast — if there's no `@table` keyword anywhere in
      // the first 64 KiB of input, refuse to scan further. The
      // bytewise scan below would otherwise blast through the entire
      // buffer for a non-`@table` document.
      const at = findAtTableWithin(input, DEFAULT_HEADER_MAX_BYTES);
      if (at < 0) {
        throw new PxfError(
          { line: 1, column: 1, offset: 0 },
          `pxf: @table header exceeds ${DEFAULT_HEADER_MAX_BYTES} bytes; raise the budget or check that the input begins with \`@table TYPE (cols)\``,
        );
      }
    }
    // The header parse uses the AST parser. We only need the prelude
    // (leading directives + the @table header up through its closing
    // `)`); rows are parsed one at a time. Calling parse() on the
    // whole input would also materialize every row — wasteful — so
    // we slice up to the column-list `)` instead.
    const headerEnd = scanHeaderEnd(input);
    if (headerEnd < 0) {
      // No `@table` in input.
      throw new PxfError(
        { line: 1, column: 1, offset: 0 },
        "pxf: no @table directive in stream",
      );
    }
    const headerSlice = input.slice(0, headerEnd + 1);
    const doc = parse(headerSlice);
    if (doc.tables.length === 0) {
      // Defensive — scanHeaderEnd found `@table` but parse() disagreed.
      throw new PxfError(
        { line: 1, column: 1, offset: 0 },
        "pxf: no @table directive in stream",
      );
    }
    const tbl = doc.tables[0]!;
    return new TableReader(
      input,
      tbl.type,
      [...tbl.columns],
      [...doc.directives],
      headerEnd + 1,
    );
  }

  /**
   * Read the next row. Returns `null` when the table's row sequence
   * is exhausted; once null is returned, subsequent calls return the
   * same null (`done` is set).
   */
  next(): IteratorResult<TableRow> {
    if (this.done) return { value: undefined, done: true };
    // Skip whitespace + comments to the next `(` or end-of-rows.
    let i = this.offset;
    while (i < this.input.length) {
      const ch = this.input[i]!;
      if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
        i++;
        continue;
      }
      const j = skipStringOrComment(this.input, i);
      if (j === -1) {
        // Incomplete construct mid-skip — for a string-backed reader
        // we have the whole input, so an incomplete here means
        // unterminated. Mirror the parser's error.
        throw new PxfError(positionAt(this.input, i), "pxf: unterminated string or comment");
      }
      if (j !== i) {
        i = j;
        continue;
      }
      break;
    }
    if (i >= this.input.length || this.input[i] !== "(") {
      this.done = true;
      this.offset = i;
      return { value: undefined, done: true };
    }
    // Find the matching `)` to delimit the row body. String-aware.
    const end = findMatchingParen(this.input, i);
    if (end < 0) {
      throw new PxfError(positionAt(this.input, i), "pxf: unterminated @table row");
    }
    // Parse the row by handing a synthetic `@table _.Row (c1,...)
    // <rowBytes>` to the AST parser, reusing parseTableRow's arity
    // check and v1 cell-grammar enforcement.
    const rowBytes = this.input.slice(i, end + 1);
    const synthetic = buildSyntheticRow(this.columns, rowBytes);
    let row: TableRow;
    try {
      const tdoc = parse(synthetic);
      if (tdoc.tables.length === 0 || tdoc.tables[0]!.rows.length === 0) {
        throw new PxfError(
          positionAt(this.input, i),
          "pxf: TableReader: synthetic row parse produced no row",
        );
      }
      row = tdoc.tables[0]!.rows[0]!;
    } catch (e) {
      // Advance past the bad row anyway so a re-call doesn't loop.
      this.offset = end + 1;
      throw e;
    }
    this.offset = end + 1;
    return { value: row, done: false };
  }

  [Symbol.iterator](): IterableIterator<TableRow> {
    return this;
  }

  /**
   * Read the next row and bind its cells to a fresh message of
   * `schema`. Returns the bound message, or `null` if the row
   * sequence is exhausted (in which case `done` is set).
   */
  scan<Desc extends DescMessage>(
    schema: Desc,
    options?: { skipValidate?: boolean },
  ): MessageShape<Desc> | null {
    const r = this.next();
    if (r.done) return null;
    return bindRow(schema, this.columns, r.value, options);
  }

  /**
   * Returns the unconsumed bytes of the input, so callers can chain a
   * second `TableReader` for documents with multiple `@table`
   * directives:
   *
   *     const tr1 = TableReader.fromString(src);
   *     for (const row of tr1) { ... }
   *     const tr2 = TableReader.fromString(tr1.tail());
   *
   * Should only be called after iteration has exhausted (i.e.
   * `done === true`). Calling earlier returns bytes the current
   * reader still intends to consume.
   */
  tail(): string {
    return this.input.slice(this.offset);
  }
}

/**
 * Bind a row's cells to fields of a fresh `schema` message by column
 * name. `columns` and `row.cells` MUST have the same length.
 *
 * Cell-state semantics:
 *   - `null` cell — field absent. (pxf.default) applies if declared;
 *     (pxf.required) errors if neither default nor value is present.
 *   - `NullVal` cell — field cleared (draft §3.9).
 *   - any other — field set to the cell's value.
 *
 * Strategy: render the row as a synthetic PXF body (`<col> = <val>`
 * per non-null cell) and run it through `unmarshal`. This mirrors
 * `protowire-cpp`'s BindRow and reuses every branch of the existing
 * decoder — WKT timestamps / durations, wrapper-type nullability,
 * enum-by-name resolution, `pxf.required` / `pxf.default`, oneof —
 * instead of growing a parallel Value→FieldDescriptor switch.
 *
 * `skipValidate` defaults to `true`: descriptors were validated once
 * when the caller constructed the schema/registry, and re-running
 * the reserved-name check per row is wasteful in tight loops.
 */
export function bindRow<Desc extends DescMessage>(
  schema: Desc,
  columns: readonly string[],
  row: TableRow,
  options?: { skipValidate?: boolean },
): MessageShape<Desc> {
  if (columns.length !== row.cells.length) {
    throw new PxfError(
      row.pos,
      `pxf: bindRow: ${columns.length} columns vs ${row.cells.length} cells`,
    );
  }
  let body = "";
  for (let i = 0; i < columns.length; i++) {
    const cell = row.cells[i]!;
    if (cell === null) continue;
    body += `${columns[i]} = ${cellToPxf(cell, row.pos)}\n`;
  }
  return unmarshal(body, schema, {
    skipValidate: options?.skipValidate ?? true,
  });
}

// ---- internal helpers ----------------------------------------------------

function cellToPxf(cell: NonNullable<TableRow["cells"][number]>, pos: Position): string {
  switch (cell.kind) {
    case "null":
      return "null";
    case "string":
      return `"${cell.value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    case "int":
    case "float":
    case "timestamp":
    case "duration":
      return cell.raw;
    case "bool":
      return cell.value ? "true" : "false";
    case "bytes": {
      // Re-encode bytes as base64 standard form. Both base64 chars
      // and the closing `"` make it through the lexer unchanged.
      return `b"${encodeBase64(cell.value)}"`;
    }
    case "ident":
      return cell.name;
    default:
      throw new PxfError(
        pos,
        // The parser rejects list/block cells before they reach us.
        `pxf: bindRow: unexpected cell kind ${(cell as { kind: string }).kind}`,
      );
  }
}

function encodeBase64(bytes: Uint8Array): string {
  if (typeof btoa !== "undefined") {
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
    return btoa(bin);
  }
  // Node fallback (Buffer is global in Node; some bundlers strip it).
  const buf = (globalThis as { Buffer?: { from(b: Uint8Array): { toString(enc: string): string } } })
    .Buffer;
  if (buf) return buf.from(bytes).toString("base64");
  throw new Error("no base64 encoder available (btoa / Buffer)");
}

function buildSyntheticRow(columns: readonly string[], rowBytes: string): string {
  // Use a placeholder type — the AST parser doesn't bind it to a
  // schema, just records it in TableDirective.type which we discard.
  return `@table _.Row (${columns.join(",")})\n${rowBytes}\n`;
}

/**
 * Find the byte offset of the next `@table` keyword outside strings /
 * comments, restricted to the first `maxBytes` of input. Returns the
 * offset on success, or -1 if not found.
 */
function findAtTableWithin(input: string, maxBytes: number): number {
  const limit = Math.min(input.length, maxBytes);
  let i = 0;
  while (i < limit) {
    const j = skipStringOrComment(input, i);
    if (j === -1) return -1; // unterminated within limit
    if (j !== i) {
      i = j;
      continue;
    }
    if (
      input[i] === "@" &&
      i + 6 <= limit &&
      input.slice(i, i + 6) === "@table"
    ) {
      const after = i + 6;
      if (after === input.length) return -1; // could be longer ident
      if (!isIdentPart(input[after]!)) return i;
    }
    i++;
  }
  return -1;
}

/**
 * Locates the end of the @table header — the closing `)` of the
 * column list. Returns the byte offset of that `)`, or -1 if no
 * `@table` is found.
 */
function scanHeaderEnd(input: string): number {
  const at = findAtTable(input);
  if (at < 0) return -1;
  const lparen = findNextChar(input, at + "@table".length, "(");
  if (lparen < 0) return -1;
  return findMatchingParen(input, lparen);
}

function findAtTable(input: string): number {
  let i = 0;
  while (i < input.length) {
    const j = skipStringOrComment(input, i);
    if (j === -1) return -1;
    if (j !== i) {
      i = j;
      continue;
    }
    if (
      input[i] === "@" &&
      i + 6 <= input.length &&
      input.slice(i, i + 6) === "@table"
    ) {
      const after = i + 6;
      if (after === input.length) return -1;
      if (!isIdentPart(input[after]!)) return i;
    }
    i++;
  }
  return -1;
}

function findNextChar(input: string, startFrom: number, ch: string): number {
  let i = startFrom;
  while (i < input.length) {
    const j = skipStringOrComment(input, i);
    if (j === -1) return -1;
    if (j !== i) {
      i = j;
      continue;
    }
    if (input[i] === ch) return i;
    i++;
  }
  return -1;
}

/**
 * Find the `)` that matches the `(` at `openIdx`. String / bytes-
 * literal / comment aware. Returns -1 on unterminated input.
 */
function findMatchingParen(input: string, openIdx: number): number {
  let depth = 1;
  let i = openIdx + 1;
  while (i < input.length) {
    const j = skipStringOrComment(input, i);
    if (j === -1) return -1;
    if (j !== i) {
      i = j;
      continue;
    }
    const ch = input[i]!;
    if (ch === "(") {
      depth++;
      i++;
    } else if (ch === ")") {
      depth--;
      if (depth === 0) return i;
      i++;
    } else {
      i++;
    }
  }
  return -1;
}

/**
 * Returns the byte offset past a string / bytes literal / comment
 * starting at `i`, or `i` unchanged if `i` is not at an opener.
 * Returns -1 if the construct is incomplete (unterminated).
 */
function skipStringOrComment(input: string, i: number): number {
  if (i >= input.length) return i;
  const ch = input[i]!;
  if (ch === '"') {
    if (i + 2 < input.length && input[i + 1] === '"' && input[i + 2] === '"') {
      return skipTripleString(input, i);
    }
    return skipSimpleString(input, i);
  }
  if (ch === "b" && i + 1 < input.length && input[i + 1] === '"') {
    return skipBytesLiteral(input, i);
  }
  if (ch === "#") return skipLineComment(input, i + 1);
  if (ch === "/" && i + 1 < input.length && input[i + 1] === "/") {
    return skipLineComment(input, i + 2);
  }
  if (ch === "/" && i + 1 < input.length && input[i + 1] === "*") {
    return skipBlockComment(input, i + 2);
  }
  return i;
}

function skipSimpleString(input: string, i: number): number {
  let j = i + 1;
  while (j < input.length) {
    const c = input[j]!;
    if (c === "\\") {
      if (j + 1 >= input.length) return -1;
      j += 2;
      continue;
    }
    if (c === '"') return j + 1;
    if (c === "\n") return -1;
    j++;
  }
  return -1;
}

function skipTripleString(input: string, i: number): number {
  let j = i + 3;
  while (j + 2 < input.length) {
    if (input[j] === '"' && input[j + 1] === '"' && input[j + 2] === '"') return j + 3;
    j++;
  }
  return -1;
}

function skipBytesLiteral(input: string, i: number): number {
  let j = i + 2; // past `b"`
  while (j < input.length) {
    const c = input[j]!;
    if (c === "\\") {
      if (j + 1 >= input.length) return -1;
      j += 2;
      continue;
    }
    if (c === '"') return j + 1;
    if (c === "\n") return -1;
    j++;
  }
  return -1;
}

function skipLineComment(input: string, from: number): number {
  let j = from;
  while (j < input.length && input[j] !== "\n") j++;
  return j;
}

function skipBlockComment(input: string, from: number): number {
  let j = from;
  while (j + 1 < input.length) {
    if (input[j] === "*" && input[j + 1] === "/") return j + 2;
    j++;
  }
  return -1;
}

function isIdentPart(c: string): boolean {
  return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || (c >= "0" && c <= "9") || c === "_";
}

/**
 * Best-effort line/column from a byte offset. Used for error positions
 * in the byte-level scanner where we don't have a Token to read from.
 */
function positionAt(input: string, offset: number): Position {
  let line = 1;
  let column = 1;
  const limit = Math.min(offset, input.length);
  for (let i = 0; i < limit; i++) {
    if (input[i] === "\n") {
      line++;
      column = 1;
    } else {
      column++;
    }
  }
  return { line, column, offset };
}
