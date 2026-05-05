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
  type Document,
  type Entry,
  type ListVal,
  type MapEntry,
  type Value,
} from "./ast.js";
import { PxfError } from "./errors.js";
import { Lexer } from "./lexer.js";
import { type Position, type Token, TokenKind, tokenKindName } from "./token.js";

export function parse(input: string): Document {
  return new Parser(input).parseDocument();
}

/**
 * Maximum allowed nesting depth for PXF parsing. Bounds stack costs on
 * adversarial input — see HARDENING.md § Recursion.
 */
const MAX_NESTING_DEPTH = 100;

class Parser {
  private readonly lex: Lexer;
  private current!: Token;
  private pendingComments: Comment[] = [];
  private depth = 0;

  constructor(input: string) {
    this.lex = new Lexer(input);
    this.advance();
  }

  private enter(pos: Position): void {
    this.depth++;
    if (this.depth > MAX_NESTING_DEPTH) {
      throw new PxfError(
        pos,
        `nesting depth exceeds maximum of ${MAX_NESTING_DEPTH}`,
      );
    }
  }

  private leave(): void {
    this.depth--;
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

    if (this.current.kind === TokenKind.AT_TYPE) {
      const next = this.advance();
      if (next.kind !== TokenKind.IDENT) {
        throw new PxfError(
          next.pos,
          `expected type name after @type, got ${tokenKindName(next.kind)}`,
        );
      }
      typeUrl = next.value;
      this.advance();
    }

    const entries: Entry[] = [];
    while (this.current.kind !== TokenKind.EOF) {
      entries.push(this.parseEntry());
    }
    return { typeUrl, entries, leadingComments };
  }

  private parseEntry(): Entry {
    const leadingComments = this.flushComments();
    const pos = this.current.pos;
    const k = this.current.kind;

    if (k !== TokenKind.IDENT && k !== TokenKind.STRING && k !== TokenKind.INT) {
      throw new PxfError(
        pos,
        `expected identifier, string, or integer, got ${tokenKindName(k)} (${JSON.stringify(this.current.value)})`,
      );
    }
    const key = this.current.value;
    this.advance();

    switch (this.current.kind) {
      case TokenKind.EQUALS: {
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
    this.enter(pos);
    try {
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
    } finally {
      this.leave();
    }
  }

  private parseBlockVal(): BlockVal {
    const pos = this.current.pos;
    this.advance(); // consume {
    const entries = this.parseBody();
    return { kind: "blockVal", pos, entries };
  }

  private parseBody(): Entry[] {
    this.enter(this.current.pos);
    try {
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
    } finally {
      this.leave();
    }
  }
}

/**
 * Decode a base64-encoded string (standard or raw — the lexer accepts both).
 * Padding is added back if the input was raw, so atob can decode it.
 */
function decodeBase64(s: string): Uint8Array {
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
