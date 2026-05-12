// SPDX-License-Identifier: MIT
// Copyright (c) 2026 TrendVidia, LLC.
/**
 * Lexical tokens and source positions for PXF (Proto eXpressive Format).
 * Mirrors `protowire/encoding/pxf/token.go`.
 */

export const enum TokenKind {
  EOF = 0,
  ILLEGAL = 1,
  NEWLINE = 2,
  COMMENT = 3,

  IDENT = 4,
  STRING = 5,
  INT = 6,
  FLOAT = 7,
  BOOL = 8,
  NULL = 9,
  BYTES = 10,
  TIMESTAMP = 11,
  DURATION = 12,

  LBRACE = 13,
  RBRACE = 14,
  LBRACKET = 15,
  RBRACKET = 16,
  LPAREN = 17,
  RPAREN = 18,
  EQUALS = 19,
  COLON = 20,
  COMMA = 21,

  AT_TYPE = 22,
  /** Generic `@<ident>` where ident ≠ "type" and ≠ "table". Token.value
   * holds the bare name (no leading `@`); the parser uses it as the
   * directive's name. */
  AT_DIRECTIVE = 23,
  /** `@table` — bulk-row directive (draft §3.4.4). */
  AT_TABLE = 24,
}

const tokenNames: Record<number, string> = {
  [TokenKind.EOF]: "EOF",
  [TokenKind.ILLEGAL]: "ILLEGAL",
  [TokenKind.NEWLINE]: "newline",
  [TokenKind.COMMENT]: "comment",
  [TokenKind.IDENT]: "identifier",
  [TokenKind.STRING]: "string",
  [TokenKind.INT]: "integer",
  [TokenKind.FLOAT]: "float",
  [TokenKind.BOOL]: "bool",
  [TokenKind.NULL]: "null",
  [TokenKind.BYTES]: "bytes",
  [TokenKind.TIMESTAMP]: "timestamp",
  [TokenKind.DURATION]: "duration",
  [TokenKind.LBRACE]: "{",
  [TokenKind.RBRACE]: "}",
  [TokenKind.LBRACKET]: "[",
  [TokenKind.RBRACKET]: "]",
  [TokenKind.LPAREN]: "(",
  [TokenKind.RPAREN]: ")",
  [TokenKind.EQUALS]: "=",
  [TokenKind.COLON]: ":",
  [TokenKind.COMMA]: ",",
  [TokenKind.AT_TYPE]: "@type",
  [TokenKind.AT_DIRECTIVE]: "@<directive>",
  [TokenKind.AT_TABLE]: "@table",
};

export function tokenKindName(k: TokenKind): string {
  return tokenNames[k] ?? `TokenKind(${k})`;
}

export interface Position {
  readonly line: number;
  readonly column: number;
  /** Byte offset into the lexer's input. Used by directive body
   * extraction to slice the raw bytes between `{` and `}`; line/column
   * remain the primary user-facing identifier. Zero is the start of
   * input. */
  readonly offset: number;
}

export function positionString(p: Position): string {
  return `${p.line}:${p.column}`;
}

export interface Token {
  readonly kind: TokenKind;
  readonly value: string;
  readonly pos: Position;
}
