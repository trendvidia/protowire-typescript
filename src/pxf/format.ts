/**
 * Format an AST Document back to PXF source text, preserving comments.
 * Mirrors `protowire/encoding/pxf/format.go`.
 *
 * This is the "round-trip via AST" path used by the `protowire fmt`
 * subcommand. It is lossy in two ways the Go formatter is also lossy:
 *  - List elements are always comma-separated on output (commas are
 *    optional in input).
 *  - The string quoter only re-emits the escape sequences the lexer
 *    accepts (`\"`, `\\`, `\n`, `\t`, `\r`); all other characters,
 *    including non-printable control chars, pass through verbatim.
 *    Use a `bytes` field for arbitrary binary data.
 */

import type {
  Comment,
  Document,
  Entry,
  Value,
} from "./ast.js";

export interface FormatOptions {
  /** Indent unit; default is two spaces. */
  readonly indent?: string;
}

export function format(doc: Document, options: FormatOptions = {}): string {
  const indent = options.indent ?? "  ";
  const f = new Formatter(indent);

  if (doc.typeUrl !== "") {
    f.write("@type ");
    f.write(doc.typeUrl);
    f.write("\n\n");
  }

  f.writeComments(doc.leadingComments, 0);
  f.formatEntries(doc.entries, 0);

  return f.finish();
}

class Formatter {
  private out: string[] = [];
  constructor(private readonly indent: string) {}

  finish(): string {
    return this.out.join("");
  }

  write(s: string): void {
    this.out.push(s);
  }

  writeIndent(level: number): void {
    for (let i = 0; i < level; i++) this.out.push(this.indent);
  }

  writeComments(comments: readonly Comment[], level: number): void {
    for (const c of comments) {
      this.writeIndent(level);
      this.write(c.text);
      this.write("\n");
    }
  }

  formatEntries(entries: readonly Entry[], level: number): void {
    for (const e of entries) {
      switch (e.kind) {
        case "assignment": {
          this.writeComments(e.leadingComments, level);
          this.writeIndent(level);
          this.write(e.key);
          this.write(" = ");
          this.formatValue(e.value, level);
          if (e.trailingComment !== "") {
            this.write(" ");
            this.write(e.trailingComment);
          }
          this.write("\n");
          break;
        }
        case "mapEntry": {
          this.writeComments(e.leadingComments, level);
          this.writeIndent(level);
          this.write(needsQuoting(e.key) ? quoteString(e.key) : e.key);
          this.write(": ");
          this.formatValue(e.value, level);
          if (e.trailingComment !== "") {
            this.write(" ");
            this.write(e.trailingComment);
          }
          this.write("\n");
          break;
        }
        case "block": {
          this.writeComments(e.leadingComments, level);
          this.writeIndent(level);
          this.write(e.name);
          this.write(" {\n");
          this.formatEntries(e.entries, level + 1);
          this.writeIndent(level);
          this.write("}\n");
          break;
        }
      }
    }
  }

  formatValue(v: Value, level: number): void {
    switch (v.kind) {
      case "string":
        this.write(quoteString(v.value));
        return;
      case "int":
        this.write(v.raw);
        return;
      case "float":
        this.write(v.raw);
        return;
      case "bool":
        this.write(v.value ? "true" : "false");
        return;
      case "bytes":
        this.write('b"');
        this.write(encodeBase64(v.value));
        this.write('"');
        return;
      case "null":
        this.write("null");
        return;
      case "ident":
        this.write(v.name);
        return;
      case "timestamp":
        this.write(v.raw);
        return;
      case "duration":
        this.write(v.raw);
        return;
      case "list": {
        this.write("[\n");
        for (let i = 0; i < v.elements.length; i++) {
          this.writeIndent(level + 1);
          this.formatValue(v.elements[i]!, level + 1);
          if (i < v.elements.length - 1) this.write(",");
          this.write("\n");
        }
        this.writeIndent(level);
        this.write("]");
        return;
      }
      case "blockVal": {
        this.write("{\n");
        this.formatEntries(v.entries, level + 1);
        this.writeIndent(level);
        this.write("}");
        return;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Re-emit only the escape sequences the lexer recognizes. Non-printable
 * characters that aren't in the list pass through unchanged — they're a
 * limitation users should avoid by using a `bytes` field.
 */
function quoteString(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    switch (ch) {
      case "\\": out += "\\\\"; break;
      case '"': out += '\\"'; break;
      case "\n": out += "\\n"; break;
      case "\t": out += "\\t"; break;
      case "\r": out += "\\r"; break;
      default: out += ch; break;
    }
  }
  out += '"';
  return out;
}

/**
 * A map key needs quoting when it isn't a valid identifier — first char
 * must be `[A-Za-z_]`, subsequent chars must be `[A-Za-z0-9_]`. Numeric
 * keys (e.g. `404`) are emitted unquoted by their string form too, but
 * the parser accepts them as INT tokens, so this fast-path is fine.
 */
function needsQuoting(s: string): boolean {
  if (s === "") return true;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (i === 0) {
      if (!isIdentStart(ch)) return true;
    } else {
      if (!isIdentStart(ch) && !isDigit(ch)) return true;
    }
  }
  return false;
}

function isIdentStart(ch: string): boolean {
  return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_";
}

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

function encodeBase64(bytes: Uint8Array): string {
  if (typeof btoa !== "undefined") {
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
    return btoa(bin);
  }
  const buf = (globalThis as { Buffer?: { from(b: Uint8Array): { toString(enc: string): string } } }).Buffer;
  if (buf) return buf.from(bytes).toString("base64");
  throw new Error("no base64 encoder available (btoa / Buffer)");
}
