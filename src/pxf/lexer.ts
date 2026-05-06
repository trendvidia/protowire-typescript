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

// Module-scoped UTF-8 codec instances for string-literal lexing.
// `fatal: true` makes the decoder throw on invalid UTF-8 instead of
// substituting U+FFFD — required for HARDENING.md § UTF-8 conformance,
// since `\xNN` and `\nnn` escapes emit raw bytes that can form invalid
// sequences (e.g. `\xFF\xFE`).
const utf8Encoder = new TextEncoder();
const utf8FatalDecoder = new TextDecoder("utf-8", { fatal: true });

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

    // Accumulate the string as a UTF-8 byte sequence so we can validate
    // it at close time. `\xNN` / `\nnn` escapes inject raw bytes that may
    // form invalid UTF-8 (HARDENING.md § UTF-8 — e.g. `"\xFF\xFE"` must be
    // rejected). Regular chars and `\u`/`\U` escapes contribute valid UTF-8
    // bytes; raw-byte escapes contribute one byte each. The final fatal
    // TextDecoder pass either yields the JS string or throws.
    const bytes: number[] = [];
    let pending = "";
    const flushPending = (): void => {
      if (pending.length === 0) return;
      const u = utf8Encoder.encode(pending);
      for (let i = 0; i < u.length; i++) bytes.push(u[i]!);
      pending = "";
    };

    while (this.pos < this.input.length) {
      const ch = this.advance();
      if (ch === '"') {
        flushPending();
        let value: string;
        try {
          value = utf8FatalDecoder.decode(new Uint8Array(bytes));
        } catch {
          return {
            kind: TokenKind.ILLEGAL,
            value: "invalid UTF-8 in string literal",
            pos,
          };
        }
        return { kind: TokenKind.STRING, value, pos };
      }
      if (ch !== "\\") {
        pending += ch;
        continue;
      }
      flushPending();
      if (this.pos >= this.input.length) {
        return { kind: TokenKind.ILLEGAL, value: "unterminated escape sequence", pos };
      }
      const esc = this.advance();
      switch (esc) {
        case '"': bytes.push(0x22); break;
        case "\\": bytes.push(0x5c); break;
        case "'": bytes.push(0x27); break;
        case "?": bytes.push(0x3f); break;
        case "a": bytes.push(0x07); break;
        case "b": bytes.push(0x08); break;
        case "f": bytes.push(0x0c); break;
        case "n": bytes.push(0x0a); break;
        case "r": bytes.push(0x0d); break;
        case "t": bytes.push(0x09); break;
        case "v": bytes.push(0x0b); break;
        case "x": {
          // \xNN injects one raw byte. The byte sequence is validated as
          // UTF-8 at close time, so e.g. `\xFF\xFE` rejects.
          const b = this.readHexByte();
          if (b === null) {
            return { kind: TokenKind.ILLEGAL, value: "invalid \\x escape: expected 2 hex digits", pos };
          }
          bytes.push(b);
          break;
        }
        case "0": case "1": case "2": case "3": {
          // \nnn — exactly 3 octal digits, leading 0–3 keeps the value ≤ 0xFF.
          const b = this.readOctRest(esc);
          if (b === null) {
            return { kind: TokenKind.ILLEGAL, value: "invalid octal escape: expected 3 octal digits", pos };
          }
          bytes.push(b);
          break;
        }
        case "u": {
          const r = this.readHexRune(4);
          if (r === null || !isValidRune(r)) {
            return { kind: TokenKind.ILLEGAL, value: "invalid \\u escape: expected 4 hex digits forming a valid codepoint", pos };
          }
          const u = utf8Encoder.encode(String.fromCodePoint(r));
          for (let i = 0; i < u.length; i++) bytes.push(u[i]!);
          break;
        }
        case "U": {
          const r = this.readHexRune(8);
          if (r === null || !isValidRune(r)) {
            return { kind: TokenKind.ILLEGAL, value: "invalid \\U escape: expected 8 hex digits forming a valid codepoint", pos };
          }
          const u = utf8Encoder.encode(String.fromCodePoint(r));
          for (let i = 0; i < u.length; i++) bytes.push(u[i]!);
          break;
        }
        default:
          return { kind: TokenKind.ILLEGAL, value: `unknown escape sequence \\${esc}`, pos };
      }
    }
    return { kind: TokenKind.ILLEGAL, value: "unterminated string", pos };
  }

  /** Reads exactly 2 hex digits from the current position. */
  private readHexByte(): number | null {
    if (this.pos + 1 >= this.input.length) return null;
    const hi = hexVal(this.input[this.pos]!);
    const lo = hexVal(this.input[this.pos + 1]!);
    if (hi === null || lo === null) return null;
    this.advance(); this.advance();
    return (hi << 4) | lo;
  }

  /** Reads exactly N hex digits from the current position. */
  private readHexRune(n: number): number | null {
    if (this.pos + n > this.input.length) return null;
    let r = 0;
    for (let i = 0; i < n; i++) {
      const v = hexVal(this.input[this.pos]!);
      if (v === null) return null;
      r = (r << 4) | v;
      this.advance();
    }
    return r;
  }

  /** Reads two more octal digits after the leading one already consumed
   *  (as part of `\nnn` — exactly 3 octal digits total). The caller has
   *  restricted `first` to 0–3 so the value can't exceed 0xFF. */
  private readOctRest(first: string): number | null {
    if (this.pos + 1 >= this.input.length) return null;
    const d1 = octVal(this.input[this.pos]!);
    const d2 = octVal(this.input[this.pos + 1]!);
    if (d1 === null || d2 === null) return null;
    this.advance(); this.advance();
    return ((first.charCodeAt(0) - 0x30) << 6) | (d1 << 3) | d2;
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
    if (this.pos >= this.input.length || this.input[this.pos] !== '"') {
      return { kind: TokenKind.ILLEGAL, value: "expected '\"' after b", pos };
    }
    this.advance(); // opening "
    const start = this.pos;
    while (this.pos < this.input.length) {
      const ch = this.input[this.pos];
      if (ch === '"') {
        const raw = this.input.slice(start, this.pos);
        this.advance(); // closing "
        if (!isValidBase64(raw)) {
          return { kind: TokenKind.ILLEGAL, value: "invalid base64 in bytes literal", pos };
        }
        return { kind: TokenKind.BYTES, value: raw, pos };
      }
      if (ch === "\n") {
        return { kind: TokenKind.ILLEGAL, value: "unterminated bytes literal", pos };
      }
      this.advance();
    }
    return { kind: TokenKind.ILLEGAL, value: "unterminated bytes literal", pos };
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

function hexVal(ch: string): number | null {
  if (ch >= "0" && ch <= "9") return ch.charCodeAt(0) - 0x30;
  if (ch >= "a" && ch <= "f") return ch.charCodeAt(0) - 0x61 + 10;
  if (ch >= "A" && ch <= "F") return ch.charCodeAt(0) - 0x41 + 10;
  return null;
}

function octVal(ch: string): number | null {
  if (ch >= "0" && ch <= "7") return ch.charCodeAt(0) - 0x30;
  return null;
}

/** Mirrors Go's utf8.ValidRune: rejects > U+10FFFF and the surrogate range. */
function isValidRune(r: number): boolean {
  return r >= 0 && r <= 0x10FFFF && (r < 0xD800 || r > 0xDFFF);
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
