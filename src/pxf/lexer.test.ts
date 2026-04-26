import { describe, it, expect } from "vitest";
import { Lexer } from "./lexer.js";
import { TokenKind, type Token } from "./token.js";

function tokens(input: string): Token[] {
  const lex = new Lexer(input);
  const out: Token[] = [];
  for (const t of lex.tokens()) {
    if (t.kind !== TokenKind.EOF) out.push(t);
  }
  return out;
}

function kinds(input: string): TokenKind[] {
  return tokens(input).map((t) => t.kind);
}

describe("punctuation and whitespace", () => {
  it("emits braces, brackets, equals, colon, comma", () => {
    expect(kinds("{}[]=:,")).toEqual([
      TokenKind.LBRACE,
      TokenKind.RBRACE,
      TokenKind.LBRACKET,
      TokenKind.RBRACKET,
      TokenKind.EQUALS,
      TokenKind.COLON,
      TokenKind.COMMA,
    ]);
  });

  it("emits NEWLINE for \\n but skips spaces, tabs, carriage returns", () => {
    expect(kinds("  \t\r{\n}")).toEqual([
      TokenKind.LBRACE,
      TokenKind.NEWLINE,
      TokenKind.RBRACE,
    ]);
  });
});

describe("comments", () => {
  it("# line comment", () => {
    const t = tokens("# hello world");
    expect(t).toHaveLength(1);
    expect(t[0]?.kind).toBe(TokenKind.COMMENT);
    expect(t[0]?.value).toBe("# hello world");
  });

  it("// line comment", () => {
    const t = tokens("// just a note");
    expect(t[0]?.kind).toBe(TokenKind.COMMENT);
    expect(t[0]?.value).toBe("// just a note");
  });

  it("/* block comment */", () => {
    const t = tokens("/* inline */");
    expect(t[0]?.kind).toBe(TokenKind.COMMENT);
    expect(t[0]?.value).toBe("/* inline */");
  });

  it("multi-line block comment tracks position past the newline", () => {
    const t = tokens("/* line1\nline2 */ x");
    expect(t[0]?.kind).toBe(TokenKind.COMMENT);
    expect(t[1]?.kind).toBe(TokenKind.IDENT);
    expect(t[1]?.pos.line).toBe(2);
  });

  it("unterminated block comment is ILLEGAL", () => {
    const t = tokens("/* no close");
    expect(t[0]?.kind).toBe(TokenKind.ILLEGAL);
  });
});

describe("strings", () => {
  it("simple", () => {
    const t = tokens('"hello"');
    expect(t[0]?.kind).toBe(TokenKind.STRING);
    expect(t[0]?.value).toBe("hello");
  });

  it("escape sequences", () => {
    const t = tokens('"a\\nb\\tc\\rd\\\\e\\"f"');
    expect(t[0]?.value).toBe('a\nb\tc\rd\\e"f');
  });

  it("unknown escape is preserved as backslash + char", () => {
    const t = tokens('"\\q"');
    expect(t[0]?.value).toBe("\\q");
  });

  it("UTF-8 content passes through", () => {
    const t = tokens('"héllo, 世界"');
    expect(t[0]?.value).toBe("héllo, 世界");
  });

  it("unterminated string is ILLEGAL", () => {
    const t = tokens('"oops');
    expect(t[0]?.kind).toBe(TokenKind.ILLEGAL);
  });

  it("triple-quoted preserves embedded newlines", () => {
    const t = tokens('"""line1\nline2"""');
    expect(t[0]?.kind).toBe(TokenKind.STRING);
    expect(t[0]?.value).toBe("line1\nline2");
  });

  it("triple-quoted dedents using closing-line indent", () => {
    const src = `"""
  hello
  world
  """`;
    const t = tokens(src);
    expect(t[0]?.value).toBe("hello\nworld");
  });

  it("unterminated triple-string is ILLEGAL", () => {
    const t = tokens('"""no close');
    expect(t[0]?.kind).toBe(TokenKind.ILLEGAL);
  });
});

describe("bytes literal", () => {
  it("standard base64 decodes", () => {
    const t = tokens('b"SGVsbG8="');
    expect(t[0]?.kind).toBe(TokenKind.BYTES);
    expect(t[0]?.value).toBe("SGVsbG8=");
  });

  it("raw (unpadded) base64 is accepted", () => {
    const t = tokens('b"SGVsbG8"');
    expect(t[0]?.kind).toBe(TokenKind.BYTES);
  });

  it("invalid base64 is ILLEGAL", () => {
    const t = tokens('b"!!!"');
    expect(t[0]?.kind).toBe(TokenKind.ILLEGAL);
  });

  it("plain `b` followed by ident is just an ident, not bytes", () => {
    const t = tokens("bool");
    expect(t[0]?.kind).toBe(TokenKind.IDENT);
    expect(t[0]?.value).toBe("bool");
  });
});

describe("numbers", () => {
  it("integer", () => {
    const t = tokens("123");
    expect(t[0]?.kind).toBe(TokenKind.INT);
    expect(t[0]?.value).toBe("123");
  });

  it("negative integer", () => {
    const t = tokens("-456");
    expect(t[0]?.kind).toBe(TokenKind.INT);
    expect(t[0]?.value).toBe("-456");
  });

  it("float with decimal", () => {
    const t = tokens("1.23");
    expect(t[0]?.kind).toBe(TokenKind.FLOAT);
    expect(t[0]?.value).toBe("1.23");
  });

  it("float with exponent", () => {
    const t = tokens("6.022e23");
    expect(t[0]?.kind).toBe(TokenKind.FLOAT);
    expect(t[0]?.value).toBe("6.022e23");
  });

  it("negative float with exponent", () => {
    const t = tokens("-1.5e-10");
    expect(t[0]?.kind).toBe(TokenKind.FLOAT);
    expect(t[0]?.value).toBe("-1.5e-10");
  });

  it("bare minus with no digits is ILLEGAL", () => {
    const t = tokens("-x");
    expect(t[0]?.kind).toBe(TokenKind.ILLEGAL);
  });
});

describe("timestamps", () => {
  it("Z suffix", () => {
    const t = tokens("2024-01-15T10:30:00Z");
    expect(t[0]?.kind).toBe(TokenKind.TIMESTAMP);
    expect(t[0]?.value).toBe("2024-01-15T10:30:00Z");
  });

  it("with offset", () => {
    const t = tokens("2024-01-15T10:30:00+05:30");
    expect(t[0]?.kind).toBe(TokenKind.TIMESTAMP);
  });

  it("with fractional seconds", () => {
    const t = tokens("2024-01-15T10:30:00.123456789Z");
    expect(t[0]?.kind).toBe(TokenKind.TIMESTAMP);
  });

  it("invalid month is ILLEGAL", () => {
    const t = tokens("2024-13-01T00:00:00Z");
    expect(t[0]?.kind).toBe(TokenKind.ILLEGAL);
  });

  it("year 1234 + non-timestamp continuation falls back to int", () => {
    // 1234 followed by a comma is just an int, not a timestamp prefix.
    const t = tokens("1234,");
    expect(t[0]?.kind).toBe(TokenKind.INT);
    expect(t[0]?.value).toBe("1234");
  });
});

describe("durations", () => {
  it("seconds", () => {
    const t = tokens("30s");
    expect(t[0]?.kind).toBe(TokenKind.DURATION);
    expect(t[0]?.value).toBe("30s");
  });

  it("composite", () => {
    const t = tokens("1h30m45s");
    expect(t[0]?.kind).toBe(TokenKind.DURATION);
  });

  it("negative", () => {
    const t = tokens("-1h30m");
    expect(t[0]?.kind).toBe(TokenKind.DURATION);
    expect(t[0]?.value).toBe("-1h30m");
  });

  it("nanoseconds and milliseconds", () => {
    expect(tokens("100ns")[0]?.kind).toBe(TokenKind.DURATION);
    expect(tokens("250ms")[0]?.kind).toBe(TokenKind.DURATION);
    expect(tokens("3us")[0]?.kind).toBe(TokenKind.DURATION);
  });

  it("`Nd` (no day unit) lexes as INT then IDENT, not duration", () => {
    // `d` isn't a duration unit (h/m/s/n/u), so the duration branch never fires.
    // Same behavior as Go's lexer: 5 → INT, d → IDENT.
    const ts = tokens("5d");
    expect(ts.map((t) => t.kind)).toEqual([TokenKind.INT, TokenKind.IDENT]);
  });

  it("`1.5s` lexes as FLOAT then IDENT (float branch wins over duration)", () => {
    // Go's lexer takes the same path: a `.` after digits commits to lexFloat,
    // which doesn't know about durations. Realistic PXF uses integer durations.
    const ts = tokens("1.5s");
    expect(ts.map((t) => t.kind)).toEqual([TokenKind.FLOAT, TokenKind.IDENT]);
  });

  it("malformed duration is ILLEGAL once a unit letter triggers duration lex", () => {
    // `5sx` enters lexDuration on `s`, then eats through `x`, then validation fails.
    const t = tokens("5sx");
    expect(t[0]?.kind).toBe(TokenKind.ILLEGAL);
  });
});

describe("identifiers and keywords", () => {
  it("plain ident", () => {
    expect(tokens("name")[0]).toEqual(
      expect.objectContaining({ kind: TokenKind.IDENT, value: "name" }),
    );
  });

  it("dotted ident (package.Type)", () => {
    expect(tokens("infra.v1.ServerConfig")[0]?.value).toBe("infra.v1.ServerConfig");
  });

  it("true / false → BOOL", () => {
    expect(tokens("true")[0]?.kind).toBe(TokenKind.BOOL);
    expect(tokens("false")[0]?.kind).toBe(TokenKind.BOOL);
  });

  it("null → NULL", () => {
    expect(tokens("null")[0]?.kind).toBe(TokenKind.NULL);
  });

  it("identifiers with underscore and digits", () => {
    expect(tokens("_name123")[0]?.value).toBe("_name123");
  });
});

describe("@type directive", () => {
  it("recognized", () => {
    const t = tokens("@type");
    expect(t[0]?.kind).toBe(TokenKind.AT_TYPE);
    expect(t[0]?.value).toBe("@type");
  });

  it("unknown @directive is ILLEGAL", () => {
    const t = tokens("@bogus");
    expect(t[0]?.kind).toBe(TokenKind.ILLEGAL);
  });
});

describe("position tracking", () => {
  it("line + column advance", () => {
    const t = tokens('"a"\n  name');
    // STRING, NEWLINE, IDENT
    expect(t).toHaveLength(3);
    expect(t[0]?.pos).toEqual({ line: 1, column: 1 });
    expect(t[1]?.pos).toEqual({ line: 1, column: 4 });
    expect(t[2]?.pos).toEqual({ line: 2, column: 3 });
  });
});

describe("end-to-end sample", () => {
  it("PXF README example tokenizes cleanly", () => {
    const src = `@type infra.v1.ServerConfig

hostname = "web-01.prod.example.com"
port     = 8443
enabled  = true

# Well-known type literals
created_at = 2024-01-15T10:30:00Z
timeout    = 30s

# Nested messages use block syntax
tls {
  cert_file = "/etc/ssl/cert.pem"
  key_file  = "/etc/ssl/key.pem"
  verify    = true
}
`;
    const ts = tokens(src);
    // No ILLEGAL tokens.
    expect(ts.find((t) => t.kind === TokenKind.ILLEGAL)).toBeUndefined();
    // Spot-check a few key tokens are present in the right order.
    const meaningful = ts.filter(
      (t) => t.kind !== TokenKind.NEWLINE && t.kind !== TokenKind.COMMENT,
    );
    expect(meaningful[0]?.kind).toBe(TokenKind.AT_TYPE);
    expect(meaningful[1]?.value).toBe("infra.v1.ServerConfig");
    expect(meaningful.find((t) => t.kind === TokenKind.TIMESTAMP)?.value)
      .toBe("2024-01-15T10:30:00Z");
    expect(meaningful.find((t) => t.kind === TokenKind.DURATION)?.value)
      .toBe("30s");
    expect(meaningful.filter((t) => t.kind === TokenKind.LBRACE)).toHaveLength(1);
  });
});
