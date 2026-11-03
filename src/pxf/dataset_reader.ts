// SPDX-License-Identifier: MIT
// Copyright (c) 2026 TrendVidia, LLC.
/**
 * Streaming consumption for the `@dataset` directive (draft §3.4.4).
 *
 * `unmarshalFull` materializes every row of an `@dataset` directive into
 * `Result.datasets()`. That works for small datasets and breaks for the
 * CSV-replacement workload `@dataset` was designed for. `DatasetReader`
 * pulls one row at a time from the input string; per-row arity and the
 * v1 cell-grammar rule are enforced at consume time (not deferred to
 * end-of-input), and rows are yielded in source order — both
 * invariants the spec requires of streaming consumers.
 *
 * Convenience: `scan(schema)` reads the next row and binds its cells
 * to a fresh message of `schema`; `bindRow(schema, columns, row)` is
 * exported for callers iterating `Result.datasets()[i].rows` from the
 * materializing path.
 *
 * Mirrors the cpp port at `protowire-cpp/src/pxf/dataset_reader.cc`.
 */

import {
  type DescMessage,
  type MessageShape,
} from "@bufbuild/protobuf";

import { type Directive, type DatasetRow } from "./ast.js";
import { findNullMaskField, getDefault, isRequired } from "./annotations.js";
import { type TypeResolver, unmarshal, unmarshalFull } from "./decode.js";
import {
  findFieldByProtoName,
  isAny,
  isDuration,
  isTimestamp,
  isWrapperType,
} from "./descriptor.js";
import { PxfError } from "./errors.js";
import { formatValue } from "./format.js";
import { columnPathError, parse } from "./parser.js";
import { type Position } from "./token.js";

/**
 * Default cap on the @dataset header (leading directives plus the
 * `@dataset TYPE ( cols )` declaration). Real headers are tiny — a few
 * hundred bytes at most. The cap exists to fail-fast on misuse: a
 * DatasetReader pointed at a multi-megabyte non-`@dataset` input
 * shouldn't run through the whole buffer looking for one.
 */
export const DEFAULT_HEADER_MAX_BYTES = 64 * 1024;

/**
 * Streaming row reader for a single `@dataset` directive.
 *
 * A DatasetReader is positioned at the first row after `fromString()`
 * returns. Iterate via standard `for ... of` (the reader implements
 * the iterator protocol) or call `next()` until it returns `null`.
 *
 * For documents containing multiple `@dataset` directives, call
 * `fromString()` again on the result of `tail()`.
 */
export class DatasetReader implements IterableIterator<DatasetRow> {
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
   * Consume the leading directives and the `@dataset TYPE ( cols )`
   * header. Returns a reader positioned at the first row.
   *
   * Throws if the input contains no `@dataset` directive before EOF, on
   * a header parse error, or if the header byte budget is exceeded.
   */
  static fromString(input: string): DatasetReader {
    if (input.length > DEFAULT_HEADER_MAX_BYTES) {
      // Quick fail-fast — if there's no `@dataset` keyword anywhere in
      // the first 64 KiB of input, refuse to scan further. The
      // bytewise scan below would otherwise blast through the entire
      // buffer for a non-`@dataset` document.
      const at = findAtTableWithin(input, DEFAULT_HEADER_MAX_BYTES);
      if (at < 0) {
        throw new PxfError(
          { line: 1, column: 1, offset: 0 },
          `pxf: @dataset header exceeds ${DEFAULT_HEADER_MAX_BYTES} bytes; raise the budget or check that the input begins with \`@dataset TYPE (cols)\``,
        );
      }
    }
    // The header parse uses the AST parser. We only need the prelude
    // (leading directives + the @dataset header up through its closing
    // `)`); rows are parsed one at a time. Calling parse() on the
    // whole input would also materialize every row — wasteful — so
    // we slice up to the column-list `)` instead.
    const headerEnd = scanHeaderEnd(input);
    if (headerEnd < 0) {
      // No `@dataset` in input.
      throw new PxfError(
        { line: 1, column: 1, offset: 0 },
        "pxf: no @dataset directive in stream",
      );
    }
    const headerSlice = input.slice(0, headerEnd + 1);
    const doc = parse(headerSlice);
    if (doc.datasets.length === 0) {
      // Defensive — scanHeaderEnd found `@dataset` but parse() disagreed.
      throw new PxfError(
        { line: 1, column: 1, offset: 0 },
        "pxf: no @dataset directive in stream",
      );
    }
    const tbl = doc.datasets[0]!;
    return new DatasetReader(
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
  next(): IteratorResult<DatasetRow> {
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
    // Rows end only at end of input or at the next directive (protowire#336).
    if (i < this.input.length && this.input[i] !== "(" && this.input[i] !== "@") {
      throw new PxfError(
        positionAt(this.input, i),
        "@dataset directive cannot coexist with top-level field entries (draft §3.4.4)",
      );
    }
    if (i >= this.input.length || this.input[i] !== "(") {
      this.done = true;
      this.offset = i;
      return { value: undefined, done: true };
    }
    // Find the matching `)` to delimit the row body. String-aware.
    const end = findMatchingParen(this.input, i);
    if (end < 0) {
      throw new PxfError(positionAt(this.input, i), "pxf: unterminated @dataset row");
    }
    // Parse the row by handing a synthetic `@dataset _.Row (c1,...)
    // <rowBytes>` to the AST parser, reusing parseDatasetRow's arity
    // check and v1 cell-grammar enforcement.
    const rowBytes = this.input.slice(i, end + 1);
    const synthetic = buildSyntheticRow(this.columns, rowBytes);
    let row: DatasetRow;
    try {
      const tdoc = parse(synthetic);
      if (tdoc.datasets.length === 0 || tdoc.datasets[0]!.rows.length === 0) {
        throw new PxfError(
          positionAt(this.input, i),
          "pxf: DatasetReader: synthetic row parse produced no row",
        );
      }
      row = tdoc.datasets[0]!.rows[0]!;
    } catch (e) {
      // Advance past the bad row anyway so a re-call doesn't loop.
      this.offset = end + 1;
      throw e;
    }
    this.offset = end + 1;
    return { value: row, done: false };
  }

  [Symbol.iterator](): IterableIterator<DatasetRow> {
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
   * second `DatasetReader` for documents with multiple `@dataset`
   * directives:
   *
   *     const tr1 = DatasetReader.fromString(src);
   *     for (const row of tr1) { ... }
   *     const tr2 = DatasetReader.fromString(tr1.tail());
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
 * the bind-time checks per row is wasteful in tight loops.
 */
export function bindRow<Desc extends DescMessage>(
  schema: Desc,
  columns: readonly string[],
  row: DatasetRow,
  options?: { skipValidate?: boolean; typeResolver?: TypeResolver },
): MessageShape<Desc> {
  if (columns.length !== row.cells.length) {
    throw new PxfError(
      row.pos,
      `pxf: bindRow: ${columns.length} columns vs ${row.cells.length} cells`,
    );
  }
  const problem = columnPathProblem(schema, columns);
  if (problem !== undefined) throw new PxfError(row.pos, problem);
  const { body, spans } = rowBody(columns, row);
  const opts = {
    skipValidate: options?.skipValidate ?? true,
    ...(options?.typeResolver ? { typeResolver: options.typeResolver } : {}),
  };
  try {
    // The post-decode pass gives an empty cell its default, rejects it for
    // (pxf.required), and lets a null cell satisfy required.
    return rowNeedsPresence(schema)
      ? unmarshalFull(body, schema, opts).message
      : unmarshal(body, schema, opts);
  } catch (err) {
    if (!(err instanceof PxfError)) throw err;
    const span = spans.find((sp) => err.pos.line >= sp.first && err.pos.line <= sp.last);
    throw new PxfError(row.pos, span ? `column ${columns[span.col]}: ${err.detail}` : err.detail);
  }
}

// ---- internal helpers ----------------------------------------------------

/** Types written as a literal, which a path cannot go into. pxf.Secret is not
 * here: it has a block form too. */
function isLiteralMessage(desc: DescMessage): boolean {
  return (
    isTimestamp(desc) ||
    isDuration(desc) ||
    isWrapperType(desc) ||
    desc.typeName === "pxf.BigInt" ||
    desc.typeName === "pxf.Decimal" ||
    desc.typeName === "pxf.BigFloat"
  );
}

/**
 * The header rules that need the row type: each segment names a field, and
 * each segment but the last a singular message field not written as a literal.
 * They are checked when a row binds, so a table with no rows is not rejected
 * for breaking one.
 */
function columnPathProblem(desc: DescMessage, columns: readonly string[]): string | undefined {
  const header = columnPathError(columns);
  if (header) return header.message;
  for (const c of columns) {
    let md = desc;
    const segments = c.split(".");
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]!;
      const fd = findFieldByProtoName(md, seg);
      if (!fd) return `@dataset column ${JSON.stringify(c)}: ${md.typeName} has no field ${JSON.stringify(seg)}`;
      if (i === segments.length - 1) break;
      const at = JSON.stringify(segments.slice(0, i + 1).join("."));
      if (fd.fieldKind === "map") {
        return `@dataset column ${JSON.stringify(c)}: ${at} is a map field, and a column path cannot go through one; use a value cell for ${at} (draft §3.4.4)`;
      }
      if (fd.fieldKind === "list") {
        return `@dataset column ${JSON.stringify(c)}: ${at} is a repeated field, and a column path cannot go through one; use a value cell for ${at} (draft §3.4.4)`;
      }
      if (fd.fieldKind !== "message") return `@dataset column ${JSON.stringify(c)}: ${at} is not a message field`;
      if (isLiteralMessage(fd.message)) {
        return `@dataset column ${JSON.stringify(c)}: ${at} is a ${fd.message.typeName}, which is written as a literal; a column path cannot go into it (draft §3.4.4)`;
      }
      md = fd.message;
    }
  }
  return undefined;
}

const presenceCache = new WeakMap<DescMessage, boolean>();

/** Whether a row must go through the full pipeline: a reachable field carries
 * a default or required, or the type has a `_null` mask. An Any counts, since
 * a cell may name its type. */
function rowNeedsPresence(desc: DescMessage): boolean {
  let need = presenceCache.get(desc);
  if (need === undefined) {
    need = findNullMaskField(desc) !== undefined || hasAnnotations(desc, new Set());
    presenceCache.set(desc, need);
  }
  return need;
}

function hasAnnotations(desc: DescMessage, seen: Set<string>): boolean {
  if (seen.has(desc.typeName)) return false;
  seen.add(desc.typeName);
  if (isAny(desc)) return true;
  for (const fd of desc.fields) {
    if (isRequired(fd) || getDefault(fd) !== undefined) return true;
    if (fd.message && hasAnnotations(fd.message, seen)) return true;
  }
  return false;
}

/** One entry of a row body: a column's cell, or a block its paths share. */
interface BodyNode {
  readonly name: string;
  readonly col: number;
  readonly children: BodyNode[];
}

interface CellSpan {
  readonly col: number;
  readonly first: number;
  readonly last: number;
}

/**
 * A row as a PXF body. A non-empty cell in column `c` is `c = <value>`, and one
 * in `a.b.c` is `c = <value>` inside `a { b { ... } }`. Every cell under one
 * prefix lands in that one block, in the order its first non-empty cell
 * appears: two blocks would bind the sub-message twice. A prefix with no
 * non-empty cell writes no block, so the field stays absent.
 *
 * The body opens with an empty line, so an error at 1:1 (a missing required
 * field) falls in no column's span.
 */
function rowBody(columns: readonly string[], row: DatasetRow): { body: string; spans: CellSpan[] } {
  const root: BodyNode[] = [];
  row.cells.forEach((cell, col) => {
    if (cell === null) return;
    const segments = columns[col]!.split(".");
    let level = root;
    for (const seg of segments.slice(0, -1)) {
      let block = level.find((n) => n.col < 0 && n.name === seg);
      if (!block) {
        block = { name: seg, col: -1, children: [] };
        level.push(block);
      }
      level = block.children;
    }
    level.push({ name: segments[segments.length - 1]!, col, children: [] });
  });
  const spans: CellSpan[] = [];
  let body = "\n";
  let line = 2;
  const write = (nodes: BodyNode[]): void => {
    for (const n of nodes) {
      if (n.col < 0) {
        body += `${n.name} {\n`;
        line++;
        write(n.children);
        body += "}\n";
        line++;
      } else {
        const text = formatValue(row.cells[n.col]!);
        const height = text.split("\n").length;
        spans.push({ col: n.col, first: line, last: line + height - 1 });
        body += `${n.name} = ${text}\n`;
        line += height;
      }
    }
  };
  write(root);
  return { body, spans };
}

function buildSyntheticRow(columns: readonly string[], rowBytes: string): string {
  // Use a placeholder type — the AST parser doesn't bind it to a
  // schema, just records it in DatasetDirective.type which we discard.
  return `@dataset _.Row (${columns.join(",")})\n${rowBytes}\n`;
}

/**
 * Find the byte offset of the next `@dataset` keyword outside strings /
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
      i + 8 <= limit &&
      input.slice(i, i + 8) === "@dataset"
    ) {
      const after = i + 8;
      if (after === input.length) return -1; // could be longer ident
      if (!isIdentPart(input[after]!)) return i;
    }
    i++;
  }
  return -1;
}

/**
 * Locates the end of the @dataset header — the closing `)` of the
 * column list. Returns the byte offset of that `)`, or -1 if no
 * `@dataset` is found.
 */
function scanHeaderEnd(input: string): number {
  const at = findAtTable(input);
  if (at < 0) return -1;
  const lparen = findNextChar(input, at + "@dataset".length, "(");
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
      i + 8 <= input.length &&
      input.slice(i, i + 8) === "@dataset"
    ) {
      const after = i + 8;
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
