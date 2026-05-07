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
  EQUALS = 17,
  COLON = 18,
  COMMA = 19,

  AT_TYPE = 20,
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
  [TokenKind.EQUALS]: "=",
  [TokenKind.COLON]: ":",
  [TokenKind.COMMA]: ",",
  [TokenKind.AT_TYPE]: "@type",
};

export function tokenKindName(k: TokenKind): string {
  return tokenNames[k] ?? `TokenKind(${k})`;
}

export interface Position {
  readonly line: number;
  readonly column: number;
}

export function positionString(p: Position): string {
  return `${p.line}:${p.column}`;
}

export interface Token {
  readonly kind: TokenKind;
  readonly value: string;
  readonly pos: Position;
}
