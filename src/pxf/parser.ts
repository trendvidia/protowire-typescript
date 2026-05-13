// SPDX-License-Identifier: MIT
// Copyright (c) 2026 TrendVidia, LLC.
/**
 * Recursive-descent parser for PXF.
 * Mirrors `protowire/encoding/pxf/parser.go`.
 *
 * Newlines and comments are absorbed at the lexer-token boundary. Comments
 * accumulate in a pending buffer and are attached as `leadingComments` to
 * the next entry. Trailing inline comments are not yet captured (Go's parser
 * also leaves `TrailingComment` empty on the parser hot path; the
 * formatter populates it).
 */

import {
  type Assignment,
  type Block,
  type BlockVal,
  type BytesVal,
  type Comment,
  type Directive,
  type Document,
  type Entry,
  type ListVal,
  type MapEntry,
  type DatasetDirective,
  type DatasetRow,
  type ProtoDirective,
  type Value,
} from "./ast.js";
import { FUTURE_RESERVED_DIRECTIVES } from "./schema.js";
import { PxfError } from "./errors.js";
import { Lexer } from "./lexer.js";
import { type Position, type Token, TokenKind, tokenKindName } from "./token.js";

export function parse(input: string): Document {
  return new Parser(input).parseDocument();
}

class Parser {
  private readonly lex: Lexer;
  private current!: Token;
  private pendingComments: Comment[] = [];

  constructor(input: string) {
    this.lex = new Lexer(input);
    this.advance();
  }

  /**
   * Consume the next token, swallowing newlines and accumulating comments
   * into `pendingComments`. Returns the new `this.current` so callers can
   * pattern-match on it without TypeScript's narrowing-of-mutable-fields
   * limitations getting in the way.
   */
  private advance(): Token {
    while (true) {
      this.current = this.lex.next();
      if (this.current.kind === TokenKind.NEWLINE) continue;
      if (this.current.kind === TokenKind.COMMENT) {
        this.pendingComments.push({
          pos: this.current.pos,
          text: this.current.value,
        });
        continue;
      }
      return this.current;
    }
  }

  private flushComments(): Comment[] {
    if (this.pendingComments.length === 0) return [];
    const c = this.pendingComments;
    this.pendingComments = [];
    return c;
  }

  parseDocument(): Document {
    const leadingComments = this.flushComments();
    let typeUrl = "";
    const directives: Directive[] = [];
    const datasets: DatasetDirective[] = [];
    const protos: ProtoDirective[] = [];
    let bodyOffset = 0;

    // Top-of-document directive prelude. @type, @<name>, and @dataset may
    // interleave in any order; @type populates typeUrl, @<name> appends
    // to directives, @dataset appends to tables. bodyOffset tracks the
    // byte immediately after the last directive's last token so
    // consumers (e.g. chameleon) can hash from there; stays 0 when
    // there are no directives.
    let sawType = false;
    let firstTablePos: Position | null = null;
    directives_loop: for (;;) {
      switch (this.current.kind) {
        case TokenKind.AT_TYPE: {
          if (firstTablePos !== null) {
            throw new PxfError(
              this.current.pos,
              "@dataset directive cannot coexist with @type; the @dataset header declares the document's type (draft §3.4.4)",
            );
          }
          sawType = true;
          const next = this.advance();
          if (next.kind !== TokenKind.IDENT) {
            throw new PxfError(
              next.pos,
              `expected type name after @type, got ${tokenKindName(next.kind)}`,
            );
          }
          typeUrl = next.value;
          bodyOffset = next.pos.offset + next.value.length;
          this.advance();
          break;
        }
        case TokenKind.AT_DIRECTIVE: {
          const { directive, endOffset } = this.parseDirective();
          directives.push(directive);
          bodyOffset = endOffset;
          break;
        }
        case TokenKind.AT_DATASET: {
          if (sawType) {
            throw new PxfError(
              this.current.pos,
              "@dataset directive cannot coexist with @type; the @dataset header declares the document's type (draft §3.4.4)",
            );
          }
          const { table, endOffset } = this.parseDatasetDirective();
          if (firstTablePos === null) firstTablePos = table.pos;
          datasets.push(table);
          bodyOffset = endOffset;
          break;
        }
        case TokenKind.AT_PROTO: {
          const { proto, endOffset } = this.parseProtoDirective();
          protos.push(proto);
          bodyOffset = endOffset;
          break;
        }
        default:
          break directives_loop;
      }
    }

    // Standalone constraint (draft §3.4.4): a document containing any
    // @dataset directive MUST NOT also carry top-level field entries;
    // the @dataset header IS the document's type declaration.
    if (firstTablePos !== null && this.current.kind !== TokenKind.EOF) {
      throw new PxfError(
        firstTablePos,
        "@dataset directive cannot coexist with top-level field entries; the document's payload is the @dataset rows (draft §3.4.4)",
      );
    }

    const entries: Entry[] = [];
    while (this.current.kind !== TokenKind.EOF) {
      // Top-level: only field_entry is allowed. The document represents a
      // proto message, never a map<K,V>; map_entry (`:` form) is reserved
      // for the inside of a `{ ... }` block.
      entries.push(this.parseEntry({ allowMapEntry: false }));
    }
    return { typeUrl, directives, datasets, protos, bodyOffset, entries, leadingComments };
  }

  /**
   * peekKind returns the kind of the next significant token (skipping
   * newlines and comments) without consuming it. Used by parseDirective
   * to disambiguate "this IDENT is a directive prefix" from "this IDENT
   * is a body field key".
   */
  private peekKind(): TokenKind {
    const snap = this.lex.snapshot();
    const savedCurrent = this.current;
    const nComments = this.pendingComments.length;
    this.advance();
    const k = this.current.kind;
    this.lex.restore(snap);
    this.current = savedCurrent;
    this.pendingComments.length = nComments;
    return k;
  }

  /**
   * parseDirective reads `@<name> *(<prefix-id>) [{ ... }]`. AT_DIRECTIVE
   * is current on entry. Returns the directive plus the byte offset
   * immediately past the directive's last token (the `}` for block form,
   * the last prefix identifier for bare form, or `@<name>` if neither
   * is present).
   *
   * One-token lookahead disambiguates zero-or-more prefix identifiers
   * from body field keys: an IDENT followed by `=` or `:` is a body key,
   * not a prefix.
   */
  private parseDirective(): { directive: Directive; endOffset: number } {
    const leadingComments = this.flushComments();
    const atPos = this.current.pos;
    const name = this.current.value;
    if (FUTURE_RESERVED_DIRECTIVES.has(name)) {
      throw new PxfError(
        atPos,
        `@${name} is a spec-reserved directive name with no v1 semantics (draft §3.4.6)`,
      );
    }
    const prefixes: string[] = [];
    let endOffset = atPos.offset + 1 + name.length; // `@` + name
    this.advance();

    // Zero-or-more prefix identifiers.
    while (this.current.kind === TokenKind.IDENT) {
      const next = this.peekKind();
      if (next === TokenKind.EQUALS || next === TokenKind.COLON) break;
      prefixes.push(this.current.value);
      endOffset = this.current.pos.offset + this.current.value.length;
      this.advance();
    }

    // Back-compat: a single prefix populates the legacy `type` field,
    // matching v0.72.0's single-Type shape so existing consumers
    // (e.g. chameleon's `@header T { ... }` reader) keep working.
    const type = prefixes.length === 1 ? prefixes[0]! : "";

    let body = "";
    let hasBody = false;
    if (this.current.kind === TokenKind.LBRACE) {
      const open = this.current.pos.offset;
      // Use parseBlockVal to validate inner content (string / brace /
      // comment well-formedness); then slice the raw bytes between `{`
      // and `}` from the input for body.
      this.parseBlockVal();
      const close = findMatchingBrace(this.lex.inputView(), open);
      if (close < 0) {
        // parseBlockVal succeeded so a matching brace must exist —
        // defensive belt-and-braces.
        throw new PxfError(atPos, `directive @${name}: unmatched '{'`);
      }
      body = this.lex.inputView().slice(open + 1, close);
      hasBody = true;
      endOffset = close + 1;
    }

    return {
      directive: { pos: atPos, name, prefixes, type, body, hasBody, leadingComments },
      endOffset,
    };
  }

  /**
   * parseDatasetDirective reads `@dataset <type> ( col1, col2, ... ) row*`.
   * AT_DATASET is current on entry. See draft §3.4.4.
   */
  private parseDatasetDirective(): { table: DatasetDirective; endOffset: number } {
    const leadingComments = this.flushComments();
    const atPos = this.current.pos;
    this.advance(); // consume @dataset

    // Optional row message type. MAY be omitted when an anonymous @proto
    // directive precedes the dataset (draft §3.4.4 Anonymous binding).
    let type = "";
    if ((this.current.kind as TokenKind) === TokenKind.IDENT) {
      type = this.current.value;
      this.advance();
    }

    // Required: column list in `( ... )`. At least one column.
    if ((this.current.kind as TokenKind) !== TokenKind.LPAREN) {
      throw new PxfError(
        this.current.pos,
        `expected '(' to start @dataset column list, got ${tokenKindName(this.current.kind)}`,
      );
    }
    this.advance(); // consume (

    if (this.current.kind !== TokenKind.IDENT) {
      throw new PxfError(
        this.current.pos,
        `@dataset column list must contain at least one field name, got ${tokenKindName(this.current.kind)}`,
      );
    }
    const columns: string[] = [];
    for (;;) {
      if (this.current.kind !== TokenKind.IDENT) {
        throw new PxfError(
          this.current.pos,
          `expected column field name, got ${tokenKindName(this.current.kind)}`,
        );
      }
      const col = this.current.value;
      // v1: column entries are unqualified field names; dotted paths
      // reserved for a future revision.
      if (col.includes(".")) {
        throw new PxfError(
          this.current.pos,
          `@dataset column ${JSON.stringify(col)}: dotted column paths are not supported in v1 (draft §3.4.4)`,
        );
      }
      columns.push(col);
      this.advance();
      if ((this.current.kind as TokenKind) === TokenKind.COMMA) {
        this.advance();
        continue;
      }
      if ((this.current.kind as TokenKind) === TokenKind.RPAREN) break;
      throw new PxfError(
        this.current.pos,
        `expected ',' or ')' in @dataset column list, got ${tokenKindName(this.current.kind)}`,
      );
    }
    let endOffset = this.current.pos.offset + 1; // past `)`
    this.advance(); // consume )

    const rows: DatasetRow[] = [];
    while ((this.current.kind as TokenKind) === TokenKind.LPAREN) {
      const r = this.parseDatasetRow(columns.length);
      rows.push(r.row);
      endOffset = r.endOffset;
    }
    return {
      table: { pos: atPos, type, columns, rows, leadingComments },
      endOffset,
    };
  }

  /**
   * parseDatasetRow reads `( cell ( ',' cell )* )` with an arity check
   * against `expected`. LPAREN is current on entry.
   */
  private parseDatasetRow(expected: number): { row: DatasetRow; endOffset: number } {
    const pos = this.current.pos;
    this.advance(); // consume (

    const cells: (Value | null)[] = [];
    cells.push(this.parseRowCell());
    while ((this.current.kind as TokenKind) === TokenKind.COMMA) {
      this.advance();
      cells.push(this.parseRowCell());
    }
    if (this.current.kind !== TokenKind.RPAREN) {
      throw new PxfError(
        this.current.pos,
        `expected ',' or ')' in @dataset row, got ${tokenKindName(this.current.kind)}`,
      );
    }
    const endOffset = this.current.pos.offset + 1;
    this.advance(); // consume )
    if (cells.length !== expected) {
      throw new PxfError(
        pos,
        `@dataset row has ${cells.length} cells, expected ${expected} (column count)`,
      );
    }
    return { row: { pos, cells }, endOffset };
  }

  /**
   * parseProtoDirective reads `@proto <body>` (draft §3.4.5). AT_PROTO
   * is current on entry. Four body shapes are lexically distinguished:
   *
   *   - `@proto { ... }`                 (anonymous)
   *   - `@proto <dotted-name> { ... }`   (named)
   *   - `@proto """..."""`               (source-form file)
   *   - `@proto b"..."`                  (descriptor)
   *
   * For brace-bounded shapes the body is sliced as raw bytes between
   * `{` and the matching `}` (exclusive); the contents are protobuf
   * source and are NOT decoded as PXF entries.
   */
  private parseProtoDirective(): { proto: ProtoDirective; endOffset: number } {
    const leadingComments = this.flushComments();
    const atPos = this.current.pos;
    this.advance(); // consume @proto

    switch (this.current.kind) {
      case TokenKind.LBRACE: {
        const { body, endOffset } = this.captureBraceBody("@proto (anonymous form)", atPos);
        return {
          proto: { pos: atPos, shape: "anonymous", typeName: "", body, leadingComments },
          endOffset,
        };
      }
      case TokenKind.IDENT: {
        const typeName = this.current.value;
        this.advance();
        if ((this.current.kind as TokenKind) !== TokenKind.LBRACE) {
          throw new PxfError(
            this.current.pos,
            `expected '{' after @proto ${typeName}, got ${tokenKindName(this.current.kind)}`,
          );
        }
        const { body, endOffset } = this.captureBraceBody(`@proto ${typeName}`, atPos);
        return {
          proto: { pos: atPos, shape: "named", typeName, body, leadingComments },
          endOffset,
        };
      }
      case TokenKind.STRING: {
        const body = new TextEncoder().encode(this.current.value);
        const endOffset = this.current.pos.offset + this.current.value.length;
        this.advance();
        return {
          proto: { pos: atPos, shape: "source", typeName: "", body, leadingComments },
          endOffset,
        };
      }
      case TokenKind.BYTES: {
        const raw = this.current.value;
        let decoded: Uint8Array;
        try {
          decoded = decodeBase64(raw);
        } catch (e) {
          throw new PxfError(
            this.current.pos,
            `@proto descriptor body: invalid base64: ${(e as Error).message}`,
          );
        }
        const endOffset = this.current.pos.offset + raw.length + 3; // b" … "
        this.advance();
        return {
          proto: { pos: atPos, shape: "descriptor", typeName: "", body: decoded, leadingComments },
          endOffset,
        };
      }
      default:
        throw new PxfError(
          this.current.pos,
          `expected '{', dotted identifier, triple-quoted string, or b"..." after @proto, got ${tokenKindName(this.current.kind)}`,
        );
    }
  }

  /**
   * Slice raw bytes between `{` and the matching `}` (both exclusive)
   * without decoding the body as PXF. LBRACE is current on entry.
   * Repositions the lexer past the closing brace.
   */
  private captureBraceBody(label: string, atPos: Position): { body: Uint8Array; endOffset: number } {
    const open = this.current.pos.offset;
    const close = findMatchingBrace(this.lex.inputView(), open);
    if (close < 0) {
      throw new PxfError(atPos, `${label}: unmatched '{'`);
    }
    const bodyStr = this.lex.inputView().slice(open + 1, close);
    const body = new TextEncoder().encode(bodyStr);
    this.lex.repositionTo(close + 1);
    this.advance();
    return { body, endOffset: close + 1 };
  }

  /**
   * parseRowCell consumes one cell of a @dataset row. Returns null for an
   * empty cell (no value between two commas, or at row start/end).
   * Rejects list ('[ ... ]') and block ('{ ... }') values per v1
   * cell-grammar (draft §3.4.4).
   */
  private parseRowCell(): Value | null {
    switch (this.current.kind) {
      case TokenKind.COMMA:
      case TokenKind.RPAREN:
        return null;
      case TokenKind.LBRACKET:
        throw new PxfError(
          this.current.pos,
          "@dataset cells cannot contain list values in v1 (draft §3.4.4)",
        );
      case TokenKind.LBRACE:
        throw new PxfError(
          this.current.pos,
          "@dataset cells cannot contain block values in v1 (draft §3.4.4)",
        );
      default:
        return this.parseValue();
    }
  }

  private parseEntry(opts: { allowMapEntry: boolean } = { allowMapEntry: true }): Entry {
    const leadingComments = this.flushComments();
    const pos = this.current.pos;
    const k = this.current.kind;

    if (k !== TokenKind.IDENT && k !== TokenKind.STRING && k !== TokenKind.INT) {
      throw new PxfError(
        pos,
        `expected identifier, string, or integer, got ${tokenKindName(k)} (${JSON.stringify(this.current.value)})`,
      );
    }
    const keyKind = k;
    const key = this.current.value;
    this.advance();

    switch (this.current.kind) {
      case TokenKind.EQUALS: {
        // `=` denotes a field assignment on a proto message; the key must be
        // an identifier (= proto field name). Map-style keys (string/integer)
        // are only valid with `:`. See docs/grammar.ebnf → field_entry.
        if (keyKind !== TokenKind.IDENT) {
          throw new PxfError(
            pos,
            `field assignment with '=' requires an identifier key, got ${tokenKindName(keyKind)} (${JSON.stringify(key)}); use ':' for map entries`,
          );
        }
        this.advance();
        const value = this.parseValue();
        const a: Assignment = {
          kind: "assignment",
          pos,
          key,
          value,
          leadingComments,
          trailingComment: "",
        };
        return a;
      }
      case TokenKind.COLON: {
        // Map entry. Only allowed inside a `{ ... }` block, never at
        // document top level. See docs/grammar.ebnf → document.
        if (!opts.allowMapEntry) {
          throw new PxfError(
            pos,
            `map entry (':' form) is only allowed inside a '{ … }' block; use '=' for top-level field assignments`,
          );
        }
        this.advance();
        const value = this.parseValue();
        const m: MapEntry = {
          kind: "mapEntry",
          pos,
          key,
          value,
          leadingComments,
          trailingComment: "",
        };
        return m;
      }
      case TokenKind.LBRACE: {
        // `{ ... }` denotes a submessage field; same identifier-only rule
        // as `=` applies. See docs/grammar.ebnf → field_entry.
        if (keyKind !== TokenKind.IDENT) {
          throw new PxfError(
            pos,
            `submessage block requires an identifier key, got ${tokenKindName(keyKind)} (${JSON.stringify(key)})`,
          );
        }
        this.advance(); // consume {
        const entries = this.parseBody();
        const b: Block = {
          kind: "block",
          pos,
          name: key,
          entries,
          leadingComments,
        };
        return b;
      }
      default:
        throw new PxfError(
          this.current.pos,
          `expected '=', ':', or '{' after ${JSON.stringify(key)}, got ${tokenKindName(this.current.kind)}`,
        );
    }
  }

  private parseValue(): Value {
    const pos = this.current.pos;
    const tok = this.current;

    switch (tok.kind) {
      case TokenKind.STRING: {
        this.advance();
        return { kind: "string", pos, value: tok.value };
      }
      case TokenKind.INT: {
        this.advance();
        return { kind: "int", pos, raw: tok.value };
      }
      case TokenKind.FLOAT: {
        this.advance();
        return { kind: "float", pos, raw: tok.value };
      }
      case TokenKind.BOOL: {
        this.advance();
        return { kind: "bool", pos, value: tok.value === "true" };
      }
      case TokenKind.BYTES: {
        this.advance();
        const v: BytesVal = { kind: "bytes", pos, value: decodeBase64(tok.value) };
        return v;
      }
      case TokenKind.TIMESTAMP: {
        this.advance();
        return { kind: "timestamp", pos, raw: tok.value };
      }
      case TokenKind.DURATION: {
        this.advance();
        return { kind: "duration", pos, raw: tok.value };
      }
      case TokenKind.NULL: {
        this.advance();
        return { kind: "null", pos };
      }
      case TokenKind.IDENT: {
        this.advance();
        return { kind: "ident", pos, name: tok.value };
      }
      case TokenKind.LBRACKET:
        return this.parseList();
      case TokenKind.LBRACE:
        return this.parseBlockVal();
      default:
        throw new PxfError(
          pos,
          `expected value, got ${tokenKindName(tok.kind)} (${JSON.stringify(tok.value)})`,
        );
    }
  }

  private parseList(): ListVal {
    const pos = this.current.pos;
    this.advance(); // consume [

    const elements: Value[] = [];
    while (
      this.current.kind !== TokenKind.RBRACKET &&
      this.current.kind !== TokenKind.EOF
    ) {
      elements.push(this.parseValue());
      if (this.current.kind === TokenKind.COMMA) this.advance();
    }
    if (this.current.kind !== TokenKind.RBRACKET) {
      throw new PxfError(
        this.current.pos,
        `expected ']', got ${tokenKindName(this.current.kind)}`,
      );
    }
    this.advance();
    return { kind: "list", pos, elements };
  }

  private parseBlockVal(): BlockVal {
    const pos = this.current.pos;
    this.advance(); // consume {
    const entries = this.parseBody();
    return { kind: "blockVal", pos, entries };
  }

  private parseBody(): Entry[] {
    const entries: Entry[] = [];
    while (
      this.current.kind !== TokenKind.RBRACE &&
      this.current.kind !== TokenKind.EOF
    ) {
      entries.push(this.parseEntry());
    }
    if (this.current.kind !== TokenKind.RBRACE) {
      throw new PxfError(
        this.current.pos,
        `expected '}', got ${tokenKindName(this.current.kind)}`,
      );
    }
    this.advance();
    return entries;
  }
}

/**
 * findMatchingBrace returns the index of the `}` that matches the `{`
 * at `openOffset`. Mirrors the lexer's string / comment handling so
 * braces inside literals don't confuse the brace count. Returns -1 on
 * unterminated input. Used by parseDirective to slice the raw bytes of
 * a directive's inline block.
 */
export function findMatchingBrace(input: string, openOffset: number): number {
  let depth = 1;
  let i = openOffset + 1;
  const n = input.length;
  const skipString = (j: number): number => {
    if (j + 2 < n && input[j + 1] === '"' && input[j + 2] === '"') {
      let k = j + 3;
      while (k + 2 < n) {
        if (input[k] === '"' && input[k + 1] === '"' && input[k + 2] === '"') return k + 3;
        k++;
      }
      return -1;
    }
    let k = j + 1;
    while (k < n) {
      if (input[k] === "\\") {
        if (k + 1 >= n) return -1;
        k += 2;
        continue;
      }
      if (input[k] === '"') return k + 1;
      if (input[k] === "\n") return -1;
      k++;
    }
    return -1;
  };
  const skipBytes = (j: number): number => {
    let k = j + 2; // past `b"`
    while (k < n) {
      if (input[k] === "\\") {
        if (k + 1 >= n) return -1;
        k += 2;
        continue;
      }
      if (input[k] === '"') return k + 1;
      if (input[k] === "\n") return -1;
      k++;
    }
    return -1;
  };
  const skipEol = (j: number): number => {
    while (j < n && input[j] !== "\n") j++;
    return j;
  };
  while (i < n) {
    const ch = input[i]!;
    if (ch === "{") {
      depth++;
      i++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
      i++;
    } else if (ch === '"') {
      i = skipString(i);
      if (i < 0) return -1;
    } else if (ch === "b" && i + 1 < n && input[i + 1] === '"') {
      i = skipBytes(i);
      if (i < 0) return -1;
    } else if (ch === "#") {
      i = skipEol(i + 1);
    } else if (ch === "/" && i + 1 < n && input[i + 1] === "/") {
      i = skipEol(i + 2);
    } else if (ch === "/" && i + 1 < n && input[i + 1] === "*") {
      let j = i + 2;
      let closed = false;
      while (j + 1 < n) {
        if (input[j] === "*" && input[j + 1] === "/") {
          j += 2;
          closed = true;
          break;
        }
        j++;
      }
      if (!closed) return -1;
      i = j;
    } else {
      i++;
    }
  }
  return -1;
}

/**
 * Decode a base64-encoded string (standard or raw — the lexer accepts both).
 * Padding is added back if the input was raw, so atob can decode it.
 */
export function decodeBase64(s: string): Uint8Array {
  let padded = s;
  const mod = padded.length % 4;
  if (mod === 2) padded += "==";
  else if (mod === 3) padded += "=";
  // mod 0 → already padded; mod 1 was rejected at lex time.
  if (typeof atob !== "undefined") {
    const bin = atob(padded);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  // Node fallback (Buffer is global in Node, may not be in some bundlers)
  const buf = (globalThis as { Buffer?: { from(s: string, enc: string): Uint8Array } }).Buffer;
  if (buf) return new Uint8Array(buf.from(padded, "base64"));
  throw new Error("no base64 decoder available (atob / Buffer)");
}
