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
  readonly entries: Entry[];
  /** Comments before the first entry (or before `@type`). */
  readonly leadingComments: Comment[];
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
