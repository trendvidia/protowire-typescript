// SPDX-License-Identifier: MIT
// Copyright (c) 2026 TrendVidia, LLC.
/**
 * Ported from the reference's `lexer_duration_test.go`: fractional and `µs`
 * duration literals (draft -01 §3.3), and the forms next to them that stay
 * floats and identifiers.
 */
import { describe, expect, it } from "vitest";

import { formatGoDuration, parseGoDuration } from "./duration.js";
import { Lexer } from "./lexer.js";
import { TokenKind } from "./token.js";

const KIND: Record<string, TokenKind> = {
  DURATION: TokenKind.DURATION,
  FLOAT: TokenKind.FLOAT,
  INT: TokenKind.INT,
  IDENT: TokenKind.IDENT,
  ILLEGAL: TokenKind.ILLEGAL,
  COMMA: TokenKind.COMMA,
  RBRACKET: TokenKind.RBRACKET,
  RBRACE: TokenKind.RBRACE,
  COMMENT: TokenKind.COMMENT,
  NEWLINE: TokenKind.NEWLINE,
};

const CASES: [string, [string, string][]][] = [
  ["30s", [["DURATION", "30s"]]],
  ["1h30m", [["DURATION", "1h30m"]]],
  ["500ms", [["DURATION", "500ms"]]],
  ["1.5h", [["DURATION", "1.5h"]]],
  ["2µs", [["DURATION", "2µs"]]],
  ["2us", [["DURATION", "2us"]]],
  ["1.234567ms", [["DURATION", "1.234567ms"]]],
  ["1.5ms", [["DURATION", "1.5ms"]]],
  ["312.5µs", [["DURATION", "312.5µs"]]],
  ["1.234µs", [["DURATION", "1.234µs"]]],
  ["1h30m0.5s", [["DURATION", "1h30m0.5s"]]],
  ["-1.5s", [["DURATION", "-1.5s"]]],
  ["-312.5µs", [["DURATION", "-312.5µs"]]],
  ["0s", [["DURATION", "0s"]]],
  ["1.5ns", [["DURATION", "1.5ns"]]],
  ["1.5us", [["DURATION", "1.5us"]]],
  ["1.5µs", [["DURATION", "1.5µs"]]],
  ["1.5s", [["DURATION", "1.5s"]]],
  ["1.5m", [["DURATION", "1.5m"]]],
  ["1h30.5m", [["DURATION", "1h30.5m"]]],
  ["1.5h30.5m1.5s", [["DURATION", "1.5h30.5m1.5s"]]],
  ["1h30m500ms", [["DURATION", "1h30m500ms"]]],
  ["1ms234us567ns", [["DURATION", "1ms234us567ns"]]],
  ["250ms", [["DURATION", "250ms"]]],
  ["1.5", [["FLOAT", "1.5"]]],
  ["1.5e3", [["FLOAT", "1.5e3"]]],
  ["1.5E-3", [["FLOAT", "1.5E-3"]]],
  ["-1.5", [["FLOAT", "-1.5"]]],
  ["1.", [["FLOAT", "1."]]],
  ["1.e3", [["FLOAT", "1.e3"]]],
  ["1.5e3ms", [["FLOAT", "1.5e3"], ["IDENT", "ms"]]],
  ["1e3s", [["FLOAT", "1e3"], ["IDENT", "s"]]],
  ["1.ms", [["FLOAT", "1."], ["IDENT", "ms"]]],
  ["1.5x", [["FLOAT", "1.5"], ["IDENT", "x"]]],
  ["1.5 x", [["FLOAT", "1.5"], ["IDENT", "x"]]],
  ["5x", [["INT", "5"], ["IDENT", "x"]]],
  ["1.5min", [["ILLEGAL", "invalid duration: 1.5min"]]],
  ["5min", [["ILLEGAL", "invalid duration: 5min"]]],
  ["2μs", [["INT", "2"], ["ILLEGAL", "\u03bc"], ["IDENT", "s"]]],
  ["2µ", [["ILLEGAL", "invalid duration: 2µ"]]],
  ["2µm", [["ILLEGAL", "invalid duration: 2µm"]]],
  ["1.5ms,", [["DURATION", "1.5ms"], ["COMMA", ","]]],
  ["1.5ms]", [["DURATION", "1.5ms"], ["RBRACKET", "]"]]],
  ["1.5ms}", [["DURATION", "1.5ms"], ["RBRACE", "}"]]],
  ["1.5ms#c", [["DURATION", "1.5ms"], ["COMMENT", "#c"]]],
  ["1.5ms\n", [["DURATION", "1.5ms"], ["NEWLINE", "\n"]]],
  ["2µs 3", [["DURATION", "2µs"], ["INT", "3"]]],
];

describe("duration literal tokens", () => {
  it.each(CASES)("%s", (input, want) => {
    const got = [...new Lexer(input).tokens()]
      .filter((t) => t.kind !== TokenKind.EOF)
      .map((t) => [t.kind, t.value]);
    expect(got).toEqual(want.map(([k, v]) => [KIND[k], v]));
  });
});

describe("what the encoder writes reads back", () => {
  it.each([
    [1n, 500_000_000], [0n, 312_500], [0n, 2_000], [0n, 1_234_567], [5400n, 500_000_000],
    [-2n, -500_000_000], [0n, -312_500], [3600n, 0], [0n, 1],
  ])("%d s %d ns", (seconds, nanos) => {
    const text = formatGoDuration({ seconds, nanos });
    const toks = [...new Lexer(text).tokens()].filter((t) => t.kind !== TokenKind.EOF);
    expect(toks.map((t) => t.kind)).toEqual([TokenKind.DURATION]);
    expect(parseGoDuration(toks[0]!.value)).toEqual({ seconds, nanos });
  });
});
