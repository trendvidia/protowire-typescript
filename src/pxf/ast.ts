// SPDX-License-Identifier: MIT
// Copyright (c) 2026 TrendVidia, LLC.
/**
 * PXF AST types. Mirrors `protowire/encoding/pxf/ast.go` but uses TS
 * discriminated unions instead of Go's interface-with-marker pattern.
 *
 * Timestamps and durations are kept as their raw lexeme on the AST. A
 * downstream consumer (decoder, formatter) parses them when needed —
 * `Date.parse(raw)` for timestamps, or a custom Go-style parser for
 * durations (TS has no native duration type).
 */

import { type Position } from "./token.js";

export interface Comment {
  readonly pos: Position;
  /** Raw text including the comment prefix (`#`, `//`, or block-comment delimiters). */
  readonly text: string;
}

export interface Document {
  /** Empty when there is no `@type` directive. */
  readonly typeUrl: string;
  /** `@<name> *(prefix) [{ ... }]` blocks in source order; excludes
   * `@type` and `@table` (which have their own fields). */
  readonly directives: Directive[];
  /** `@table TYPE ( cols ) row*` directives in source order. Per draft
   * §3.4.4 a document with any `@table` MUST NOT also have `@type` or
   * top-level field entries — the parser enforces this. */
  readonly tables: TableDirective[];
  /** Byte offset where the schema-typed body begins (after all leading
   * directives). Zero when there are no directives, so chameleon hashes
   * from byte 0. */
  readonly bodyOffset: number;
  readonly entries: Entry[];
  /** Comments before the first entry (or before `@type`). */
  readonly leadingComments: Comment[];
}

/**
 * A top-of-document `@<name> *(<prefix-id>) [{ ... }]` entry. Side-channel
 * metadata that sits alongside the schema-typed body — e.g. chameleon's
 * `@header chameleon.v1.LayerHeader { id = "x" }`. The grammar is open-
 * ended: any name except `type` / `table` is parsed as a generic
 * `Directive`. Prefix identifiers are positional and per-directive:
 *
 *   - One prefix (v0.72.0 conventional shape) — the identifier names the
 *     inner block's message type, dotted. Used by `@header` and similar.
 *   - `@entry` (draft §3.4.3) — zero, one, or two prefix identifiers
 *     (label, type); a single prefix is disambiguated by the presence of
 *     a `.` (dotted ⇒ type; bare ⇒ label).
 *
 * `body` holds the raw bytes between `{` and `}` (both exclusive),
 * suitable for handing back to a follow-up `unmarshal` against the
 * consumer's chosen message. `body` is empty and `hasBody` is false when
 * the directive has no inline block.
 */
export interface Directive {
  readonly pos: Position;
  /** e.g. "header"; never "type" / "table". */
  readonly name: string;
  /** Identifiers between `@<name>` and the optional `{ ... }`, in source order. */
  readonly prefixes: string[];
  /** Back-compat for v0.72.0-era consumers: when exactly one prefix
   * identifier was supplied, `type` holds it. For zero / two-plus
   * prefixes, `type` is empty and callers MUST read `prefixes` directly. */
  readonly type: string;
  /** Raw inner bytes of the block (UTF-8 substring of the lexer input);
   * empty when `hasBody` is false. */
  readonly body: string;
  readonly hasBody: boolean;
  readonly leadingComments: Comment[];
}

/**
 * `@table <type> ( col1, col2, ... ) row*` directive at document root
 * (draft §3.4.4). Carries many instances of one message type in a single
 * document — the protowire-native CSV.
 *
 * Cells are scalar-shaped in v1 (no list, no block). A nullish cell
 * (see `TableRow.cells`) denotes an absent field; a `NullVal` cell
 * denotes a present-but-null field; any other cell denotes a present
 * field with that value.
 *
 * A document with any `TableDirective` MUST NOT have a `@type` directive
 * or any top-level field entries: the `@table` header IS the document's
 * type declaration. The parser enforces this.
 */
export interface TableDirective {
  readonly pos: Position;
  /** Row message type, e.g. "trades.v1.Trade". */
  readonly type: string;
  /** Top-level field names on `type`; length >= 1. */
  readonly columns: string[];
  readonly rows: TableRow[];
  readonly leadingComments: Comment[];
}

/**
 * One parenthesized cell tuple in a `@table` directive. `cells` has the
 * same length as the containing `TableDirective.columns`. A `null` cell
 * denotes an absent field (the empty cell between two commas); a
 * `NullVal` denotes a present-but-null field; any other Value denotes a
 * present field with that value.
 */
export interface TableRow {
  readonly pos: Position;
  readonly cells: (Value | null)[];
}

// ---------------------------------------------------------------------------
// Entries — what appears in a message or map body
// ---------------------------------------------------------------------------

export type Entry = Assignment | MapEntry | Block;

/** `key = value` — a field assignment in a message context. */
export interface Assignment {
  readonly kind: "assignment";
  readonly pos: Position;
  readonly key: string;
  readonly value: Value;
  readonly leadingComments: Comment[];
  /** Inline comment after the value on the same source line, if any. */
  readonly trailingComment: string;
}

/** `key: value` — a key-value pair in a map context. */
export interface MapEntry {
  readonly kind: "mapEntry";
  readonly pos: Position;
  readonly key: string;
  readonly value: Value;
  readonly leadingComments: Comment[];
  readonly trailingComment: string;
}

/** `name { entries }` — a nested message. */
export interface Block {
  readonly kind: "block";
  readonly pos: Position;
  readonly name: string;
  readonly entries: Entry[];
  readonly leadingComments: Comment[];
}

// ---------------------------------------------------------------------------
// Values — what appears on the right of `=` or `:`
// ---------------------------------------------------------------------------

export type Value =
  | StringVal
  | IntVal
  | FloatVal
  | BoolVal
  | BytesVal
  | NullVal
  | IdentVal
  | TimestampVal
  | DurationVal
  | ListVal
  | BlockVal;

export interface StringVal {
  readonly kind: "string";
  readonly pos: Position;
  readonly value: string;
}

/** Integer literal, preserved as raw text — schema-bound decoder picks
 * the right numeric type (int32, int64 → bigint, etc). */
export interface IntVal {
  readonly kind: "int";
  readonly pos: Position;
  readonly raw: string;
}

/** Floating-point literal, raw text. */
export interface FloatVal {
  readonly kind: "float";
  readonly pos: Position;
  readonly raw: string;
}

export interface BoolVal {
  readonly kind: "bool";
  readonly pos: Position;
  readonly value: boolean;
}

/** Decoded base64 bytes (the wire-side representation). */
export interface BytesVal {
  readonly kind: "bytes";
  readonly pos: Position;
  readonly value: Uint8Array;
}

export interface NullVal {
  readonly kind: "null";
  readonly pos: Position;
}

/** Unquoted identifier used as a value — typically an enum name. */
export interface IdentVal {
  readonly kind: "ident";
  readonly pos: Position;
  readonly name: string;
}

/** RFC 3339 timestamp literal, raw text. */
export interface TimestampVal {
  readonly kind: "timestamp";
  readonly pos: Position;
  readonly raw: string;
}

/** Go-style duration literal, raw text. */
export interface DurationVal {
  readonly kind: "duration";
  readonly pos: Position;
  readonly raw: string;
}

/** `[ … ]` — a list of values. */
export interface ListVal {
  readonly kind: "list";
  readonly pos: Position;
  readonly elements: Value[];
}

/** Anonymous `{ … }` block — used for map entries and inline messages in lists. */
export interface BlockVal {
  readonly kind: "blockVal";
  readonly pos: Position;
  readonly entries: Entry[];
}
