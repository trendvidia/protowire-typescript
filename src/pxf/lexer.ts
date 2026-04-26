/**
 * Tokenizer for PXF (Proto eXpressive Format).
 * Mirrors `protowire/encoding/pxf/lexer.go`.
 *
 * Recognizes:
 *  - Comments: `# ...`, `// ...`, `/* ... *\/`
 *  - Strings: `"..."` (with `\"`, `\\`, `\n`, `\t`, `\r` escapes) and
 *    `"""..."""` triple-quoted with closing-line indent dedent
 *  - Bytes: `b"<base64>"` (standard or raw, validated at lex time)
 *  - Integers, floats (with optional sign and exponent)
 *  - RFC 3339 timestamps: 4 digits + `-` triggers timestamp lex; validated
 *  - Go-style durations: digits + a unit letter (h/m/s/ns/us/ms); validated
 *  - Identifiers (with `.` allowed for dotted package names), `true` /
 *    `false` / `null` keywords, `@type` directive
 *  - Punctuation: `{ } [ ] = : ,`
 */

import { type Position, type Token, TokenKind } from "./token.js";

export class Lexer {
  private pos = 0;
  private line = 1;
  private col = 1;

  constructor(private readonly input: string) {}

  /** Returns the next token. Returns an EOF token at end-of-input forever. */
  next(): Token {
    this.skipSpaces();
    if (this.pos >= this.input.length) {
      return { kind: TokenKind.EOF, value: "", pos: this.currentPos() };
    }

    const pos = this.currentPos();
    const ch = this.peek();

    if (ch === "\n") {
      this.advance();
      return { kind: TokenKind.NEWLINE, value: "\n", pos };
    }

    if (ch === "#") return this.lexLineComment(pos);
    if (ch === "/" && this.peekAt(1) === "/") return this.lexLineComment(pos);
    if (ch === "/" && this.peekAt(1) === "*") return this.lexBlockComment(pos);

    if (ch === '"') {
      if (this.peekAt(1) === '"' && this.peekAt(2) === '"') {
        return this.lexTripleString(pos);
      }
      return this.lexString(pos);
    }
    if (ch === "b" && this.peekAt(1) === '"') return this.lexBytes(pos);

    switch (ch) {
      case "{": this.advance(); return { kind: TokenKind.LBRACE, value: "{", pos };
      case "}": this.advance(); return { kind: TokenKind.RBRACE, value: "}", pos };
      case "[": this.advance(); return { kind: TokenKind.LBRACKET, value: "[", pos };
      case "]": this.advance(); return { kind: TokenKind.RBRACKET, value: "]", pos };
      case "=": this.advance(); return { kind: TokenKind.EQUALS, value: "=", pos };
      case ":": this.advance(); return { kind: TokenKind.COLON, value: ":", pos };
      case ",": this.advance(); return { kind: TokenKind.COMMA, value: ",", pos };
      case "@": return this.lexDirective(pos);
    }

    if (ch === "-" || isDigit(ch)) return this.lexNumber(pos);
    if (isIdentStart(ch)) return this.lexIdent(pos);

    this.advance();
    return { kind: TokenKind.ILLEGAL, value: ch, pos };
  }

  /** Iterate until EOF, useful for tests and consumers that want everything up front. */
  *tokens(): Generator<Token> {
    while (true) {
      const t = this.next();
      yield t;
      if (t.kind === TokenKind.EOF) return;
    }
  }

  private peek(): string {
    return this.pos < this.input.length ? this.input[this.pos]! : "";
  }

  private peekAt(offset: number): string {
    const i = this.pos + offset;
    return i < this.input.length ? this.input[i]! : "";
  }

  private advance(): string {
    if (this.pos >= this.input.length) return "";
    const ch = this.input[this.pos]!;
    this.pos++;
    if (ch === "\n") {
      this.line++;
      this.col = 1;
    } else {
      this.col++;
    }
    return ch;
  }

  private currentPos(): Position {
    return { line: this.line, column: this.col };
  }

  private skipSpaces(): void {
    while (this.pos < this.input.length) {
      const ch = this.input[this.pos]!;
      if (ch === " " || ch === "\t" || ch === "\r") {
        this.advance();
      } else {
        break;
      }
    }
  }

  private lexLineComment(pos: Position): Token {
    const start = this.pos;
    while (this.pos < this.input.length && this.input[this.pos] !== "\n") {
      this.advance();
    }
    return { kind: TokenKind.COMMENT, value: this.input.slice(start, this.pos), pos };
  }

  private lexBlockComment(pos: Position): Token {
    const start = this.pos;
    this.advance(); // /
    this.advance(); // *
    while (this.pos + 1 < this.input.length) {
      if (this.input[this.pos] === "*" && this.input[this.pos + 1] === "/") {
        this.advance(); // *
        this.advance(); // /
        return { kind: TokenKind.COMMENT, value: this.input.slice(start, this.pos), pos };
      }
      this.advance();
    }
    return { kind: TokenKind.ILLEGAL, value: "unterminated block comment", pos };
  }

  private lexString(pos: Position): Token {
    this.advance(); // opening "
    let out = "";
    while (this.pos < this.input.length) {
      const ch = this.advance();
      if (ch === '"') {
        return { kind: TokenKind.STRING, value: out, pos };
      }
      if (ch === "\\") {
        if (this.pos >= this.input.length) {
          return { kind: TokenKind.ILLEGAL, value: "unterminated escape sequence", pos };
        }
        const esc = this.advance();
        switch (esc) {
          case '"': out += '"'; break;
          case "\\": out += "\\"; break;
          case "n": out += "\n"; break;
          case "t": out += "\t"; break;
          case "r": out += "\r"; break;
          default: out += "\\" + esc; break;
        }
        continue;
      }
      out += ch;
    }
    return { kind: TokenKind.ILLEGAL, value: "unterminated string", pos };
  }

  private lexTripleString(pos: Position): Token {
    this.advance(); // "
    this.advance(); // "
    this.advance(); // "
    const start = this.pos;
    while (this.pos + 2 < this.input.length) {
      if (
        this.input[this.pos] === '"' &&
        this.input[this.pos + 1] === '"' &&
        this.input[this.pos + 2] === '"'
      ) {
        const raw = this.input.slice(start, this.pos);
        this.advance(); // "
        this.advance(); // "
        this.advance(); // "
        return { kind: TokenKind.STRING, value: dedent(raw), pos };
      }
      this.advance();
    }
    return { kind: TokenKind.ILLEGAL, value: "unterminated triple-quoted string", pos };
  }

  private lexBytes(pos: Position): Token {
    this.advance(); // b
    const tok = this.lexString(pos);
    if (tok.kind !== TokenKind.STRING) return tok;
    if (!isValidBase64(tok.value)) {
      return { kind: TokenKind.ILLEGAL, value: "invalid base64 in bytes literal", pos };
    }
    return { kind: TokenKind.BYTES, value: tok.value, pos };
  }

  private lexDirective(pos: Position): Token {
    this.advance(); // @
    const start = this.pos;
    while (this.pos < this.input.length && isIdentPart(this.input[this.pos]!)) {
      this.advance();
    }
    const name = this.input.slice(start, this.pos);
    if (name === "type") {
      return { kind: TokenKind.AT_TYPE, value: "@type", pos };
    }
    return { kind: TokenKind.ILLEGAL, value: "@" + name, pos };
  }

  private lexNumber(pos: Position): Token {
    const start = this.pos;
    let neg = false;
    if (this.peek() === "-") {
      neg = true;
      this.advance();
      if (this.pos >= this.input.length || !isDigit(this.peek())) {
        return { kind: TokenKind.ILLEGAL, value: "-", pos };
      }
    }

    const digitStart = this.pos;
    while (this.pos < this.input.length && isDigit(this.peek())) {
      this.advance();
    }
    const digitCount = this.pos - digitStart;

    // Timestamp: exactly 4 digits followed by '-', only non-negative.
    if (!neg && digitCount === 4 && this.pos < this.input.length && this.peek() === "-") {
      return this.lexTimestamp(pos, start);
    }

    // Float: '.' or 'e'/'E'.
    if (this.pos < this.input.length) {
      const c = this.peek();
      if (c === "." || c === "e" || c === "E") return this.lexFloat(pos, start);
    }

    // Duration: digits followed by a time-unit letter.
    if (this.pos < this.input.length && isDurationUnit(this.peek())) {
      return this.lexDuration(pos, start);
    }

    return { kind: TokenKind.INT, value: this.input.slice(start, this.pos), pos };
  }

  private lexFloat(pos: Position, start: number): Token {
    if (this.peek() === ".") {
      this.advance();
      while (this.pos < this.input.length && isDigit(this.peek())) this.advance();
    }
    if (this.pos < this.input.length && (this.peek() === "e" || this.peek() === "E")) {
      this.advance();
      if (this.pos < this.input.length && (this.peek() === "+" || this.peek() === "-")) {
        this.advance();
      }
      while (this.pos < this.input.length && isDigit(this.peek())) this.advance();
    }
    return { kind: TokenKind.FLOAT, value: this.input.slice(start, this.pos), pos };
  }

  private lexTimestamp(pos: Position, start: number): Token {
    while (this.pos < this.input.length) {
      const ch = this.peek();
      if (
        ch === " " || ch === "\n" || ch === "\t" || ch === "\r" ||
        ch === "," || ch === "]" || ch === "}" || ch === "#"
      ) break;
      if (ch === "/" && (this.peekAt(1) === "/" || this.peekAt(1) === "*")) break;
      this.advance();
    }
    const raw = this.input.slice(start, this.pos);
    if (!isValidRfc3339(raw)) {
      return { kind: TokenKind.ILLEGAL, value: "invalid timestamp: " + raw, pos };
    }
    return { kind: TokenKind.TIMESTAMP, value: raw, pos };
  }

  private lexDuration(pos: Position, start: number): Token {
    while (this.pos < this.input.length) {
      const ch = this.peek();
      if (!(isDigit(ch) || isLowerAlpha(ch) || ch === ".")) break;
      this.advance();
    }
    const raw = this.input.slice(start, this.pos);
    if (!isValidGoDuration(raw)) {
      return { kind: TokenKind.ILLEGAL, value: "invalid duration: " + raw, pos };
    }
    return { kind: TokenKind.DURATION, value: raw, pos };
  }

  private lexIdent(pos: Position): Token {
    const start = this.pos;
    while (this.pos < this.input.length && isIdentPart(this.input[this.pos]!)) {
      this.advance();
    }
    const val = this.input.slice(start, this.pos);
    if (val === "true" || val === "false") {
      return { kind: TokenKind.BOOL, value: val, pos };
    }
    if (val === "null") {
      return { kind: TokenKind.NULL, value: val, pos };
    }
    return { kind: TokenKind.IDENT, value: val, pos };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

function isIdentStart(ch: string): boolean {
  return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_";
}

function isIdentPart(ch: string): boolean {
  return isIdentStart(ch) || isDigit(ch) || ch === ".";
}

function isDurationUnit(ch: string): boolean {
  return ch === "h" || ch === "m" || ch === "s" || ch === "n" || ch === "u";
}

function isLowerAlpha(ch: string): boolean {
  return ch >= "a" && ch <= "z";
}

/**
 * Strip the closing-line indent from each line in a triple-quoted string body.
 * Leading newline (right after opening `"""`) is stripped. If the line before
 * the closing `"""` is whitespace-only, that whitespace becomes the base
 * indent and is removed from each preceding line.
 */
function dedent(s: string): string {
  if (s.length > 0 && s[0] === "\n") s = s.slice(1);
  const lines = s.split("\n");
  if (lines.length === 0) return "";
  const last = lines[lines.length - 1]!;
  if (last.trim() === "") {
    const indent = last;
    lines.pop();
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.startsWith(indent)) lines[i] = line.slice(indent.length);
    }
  }
  return lines.join("\n");
}

/**
 * Validate RFC 3339 timestamps, accepting both `Z` and numeric offsets, plus
 * optional fractional seconds. Calendar fields are sanity-checked via Date.
 */
const RFC3339_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function isValidRfc3339(s: string): boolean {
  const m = RFC3339_RE.exec(s);
  if (!m) return false;
  // Date.parse normalizes; require non-NaN. This catches e.g. month 13.
  return !Number.isNaN(Date.parse(s));
}

/**
 * Validate a Go-style duration: a possibly-signed sequence of decimal numbers
 * each followed by a unit (`ns`, `us`, `µs`, `ms`, `s`, `m`, `h`).
 *
 * The lexer never feeds in `µs` because µ is non-ASCII and isn't accepted
 * during the digit/letter scan, but the regex permits it for completeness.
 */
const GO_DURATION_RE = /^-?(\d+(\.\d+)?(ns|us|µs|ms|s|m|h))+$/;

function isValidGoDuration(s: string): boolean {
  return GO_DURATION_RE.test(s);
}

/**
 * Accept either standard (padded) or raw (unpadded) base64. Length-mod-4
 * rule weeds out a `==`-padded string of size 1 and similar nonsense.
 */
function isValidBase64(s: string): boolean {
  if (s === "") return true;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return false;
  if (s.indexOf("=") === -1) {
    return s.length % 4 !== 1; // raw: any length except mod 4 == 1
  }
  return s.length % 4 === 0; // standard: length must be a multiple of 4
}
