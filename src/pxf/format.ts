// SPDX-License-Identifier: MIT
// Copyright (c) 2026 TrendVidia, LLC.
/**
 * Format an AST Document back to PXF source text, preserving comments.
 * Mirrors `protowire/encoding/pxf/format.go`.
 *
 * This is the "round-trip via AST" path used by the `protowire fmt`
 * subcommand. It keeps every directive, in document order, with its dataset
 * rows. It is lossy in two ways the Go formatter is also lossy:
 *  - List elements are always comma-separated on output (commas are
 *    optional in input).
 *  - The string quoter only re-emits the escape sequences the lexer
 *    accepts (`\"`, `\\`, `\n`, `\t`, `\r`); all other characters,
 *    including non-printable control chars, pass through verbatim.
 *    Use a `bytes` field for arbitrary binary data.
 */

import { identSafeEntryName } from "./keyed.js";
import type {
  Comment,
  DatasetDirective,
  Directive,
  Document,
  Entry,
  MapEntry,
  ProtoDirective,
  Value,
} from "./ast.js";

export interface FormatOptions {
  /** Indent unit; default is two spaces. */
  readonly indent?: string;
}

export function format(doc: Document, options: FormatOptions = {}): string {
  const indent = options.indent ?? "  ";
  const f = new Formatter(indent);

  // Every directive but @type, in document order: an anonymous @proto binds
  // to the typed directive after it, so the order is part of the meaning.
  // @type binds nothing, so writing it first changes nothing.
  const others: TopDirective[] = [
    ...doc.directives.map((d) => ({ kind: "named" as const, d })),
    ...doc.datasets.map((d) => ({ kind: "dataset" as const, d })),
    ...doc.protos.map((d) => ({ kind: "proto" as const, d })),
  ].sort((a, b) => a.d.pos.offset - b.d.pos.offset);

  if (others.length === 0) {
    if (doc.typeUrl !== "") {
      f.write("@type ");
      f.write(doc.typeUrl);
      f.write("\n\n");
    }
    f.writeComments(doc.leadingComments, 0);
    f.formatEntries(doc.entries, 0);
    return f.finish();
  }

  if (doc.typeUrl !== "") f.write(`@type ${doc.typeUrl}\n`);
  f.writeComments(doc.leadingComments, 0);
  for (const top of others) {
    f.writeComments(top.d.leadingComments, 0);
    switch (top.kind) {
      case "named":
        f.formatNamedDirective(top.d);
        break;
      case "dataset":
        f.formatDataset(top.d);
        break;
      case "proto":
        f.formatProto(top.d);
        break;
    }
  }
  if (doc.entries.length > 0) {
    f.write("\n");
    f.formatEntries(doc.entries, 0);
  }
  return f.finish();
}

type TopDirective =
  | { readonly kind: "named"; readonly d: Directive }
  | { readonly kind: "dataset"; readonly d: DatasetDirective }
  | { readonly kind: "proto"; readonly d: ProtoDirective };

/** One value as PXF text. Mirrors the reference's `FormatValue`. */
export function formatValue(v: Value): string {
  const f = new Formatter("  ");
  f.formatValue(v, 0);
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

  /** `@<name> prefix* [{ body }]`, the body as written: it is raw text. */
  formatNamedDirective(d: Directive): void {
    this.write(`@${d.name}`);
    for (const p of d.prefixes) this.write(` ${p}`);
    if (d.hasBody) this.write(` {${d.body}}`);
    this.write("\n");
  }

  /** The header, then one row per line; an empty cell is an absent field. */
  formatDataset(d: DatasetDirective): void {
    this.write("@dataset");
    if (d.type !== "") this.write(` ${d.type}`);
    this.write(` (${d.columns.join(", ")})\n`);
    for (const row of d.rows) {
      this.write("(");
      row.cells.forEach((cell, i) => {
        if (i > 0) this.write(", ");
        if (cell !== null && cell !== undefined) this.formatValue(cell, 0);
      });
      this.write(")\n");
    }
  }

  formatProto(d: ProtoDirective): void {
    this.write("@proto");
    switch (d.shape) {
      case "anonymous":
        this.write(` {${new TextDecoder().decode(d.body)}}`);
        break;
      case "named":
        this.write(` ${d.typeName} {${new TextDecoder().decode(d.body)}}`);
        break;
      case "source":
        this.write(` """${new TextDecoder().decode(d.body)}"""`);
        break;
      case "descriptor":
        this.write(` b"${encodeBase64(d.body)}"`);
        break;
    }
    this.write("\n");
  }

  formatEntries(entries: readonly Entry[], level: number): void {
    for (const e of entries) {
      switch (e.kind) {
        case "assignment": {
          this.writeComments(e.leadingComments, level);
          this.writeIndent(level);
          this.write(e.keyQuoted ? quoteString(e.key) : e.key);
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
          this.write(mapKeyNeedsQuotes(e) ? quoteString(e.key) : e.key);
          this.write(": ");
          this.formatValue(e.value, level);
          if (e.trailingComment !== "") {
            this.write(" ");
            this.write(e.trailingComment);
          }
          this.write("\n");
          break;
        }
        case "typeEntry": {
          this.writeComments(e.leadingComments, level);
          this.writeIndent(level);
          this.write(`@type = ${quoteString(e.url)}`);
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
          this.write(e.nameQuoted ? quoteString(e.name) : e.name);
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
      case "float":
        this.write(v.prec === undefined ? v.raw : `${v.raw}p${v.prec}`);
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
 * Re-emit a string in PXF source syntax. Mirrors the schema-bound encoder's
 * `writeQuotedString` (encode.ts): emits the simple escape mnemonics for
 * `"`, `\`, `\n`, `\r`, `\t`, and `\xHH` for any other byte under 0x20.
 * Code units ≥ 0x20 pass through literally — valid UTF-8 stays UTF-8.
 */
const HEX = "0123456789abcdef";

function quoteString(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    switch (code) {
      case 0x22: out += '\\"'; break;
      case 0x5c: out += "\\\\"; break;
      case 0x0a: out += "\\n"; break;
      case 0x0d: out += "\\r"; break;
      case 0x09: out += "\\t"; break;
      default:
        if (code < 0x20) {
          out += "\\x" + HEX[(code >> 4) & 0xf] + HEX[code & 0xf];
        } else {
          out += s[i];
        }
    }
  }
  out += '"';
  return out;
}

const BARE_MAP_KEY_RE = /^(?:[A-Za-z_][A-Za-z0-9_.]*|-?[0-9]+)$/;

/**
 * A key written quoted stays quoted unless it is identifier-safe. A key written
 * bare stays bare, since quoting `true` or `404` would change what it denotes
 * (draft -01 § Entries and Keys, protowire#306). An entry built in code has no
 * spelling: it goes bare when it reads back as one bare key.
 */
function mapKeyNeedsQuotes(e: MapEntry): boolean {
  if (e.keyQuoted === true) return !identSafeEntryName(e.key);
  if (e.keyQuoted === false) return false;
  return !BARE_MAP_KEY_RE.test(e.key) || e.key === "null";
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
