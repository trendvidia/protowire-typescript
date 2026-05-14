// SPDX-License-Identifier: MIT
// Copyright (c) 2026 TrendVidia, LLC.
/**
 * Schema-bound PXF text encoder.
 * Mirrors `protowire/encoding/pxf/encode.go`.
 *
 * Handles scalars, enums, messages (block + WKT shortcuts), repeated lists,
 * maps (key-sorted), google.protobuf.Any sugar via a TypeResolver, and the
 * `_null` FieldMask channel for emitting `null` literals.
 */

import {
  type DescField,
  type DescMessage,
  type MessageShape,
  ScalarType,
  fromBinary,
} from "@bufbuild/protobuf";
import {
  type ReflectList,
  type ReflectMap,
  type ReflectMessage,
  reflect,
} from "@bufbuild/protobuf/reflect";

import { findNullMaskField } from "./annotations.js";
import { type TypeResolver } from "./decode.js";
import {
  findFieldByProtoName,
  isAny,
  isDuration,
  isTimestamp,
  isWrapperType,
} from "./descriptor.js";
import { Result } from "./result.js";

export interface MarshalOptions {
  /** Indentation string per level. Defaults to two spaces. */
  indent?: string;
  /** Emit fields whose value is the proto3 default (zero) instead of skipping them. */
  emitDefaults?: boolean;
  /** When set, prefix the output with `@type <typeURL>` and a blank line. */
  typeURL?: string;
  /** Required to encode `google.protobuf.Any` with sugar syntax. */
  typeResolver?: TypeResolver;
  /**
   * Alternative null source for messages without a top-level `_null`
   * FieldMask. Paths in this Result that are marked null are emitted as
   * `null` literals.
   */
  nullFields?: Result;
  /**
   * Strip trailing zero-valued h/m/s units from emitted Go-style
   * Duration literals (e.g. `720h0m0s` → `720h`, `1h30m0s` → `1h30m`).
   *
   * Default `false` preserves byte-equivalence with the canonical
   * Go reference's `time.Duration.String()` output. Set to `true`
   * when round-trip readability of the source file matters more
   * than wire-compatibility with the Go reference — typical for
   * config files maintained by humans (e.g. an `*.pxf` config a
   * maintainer edits via a UI, where seeing `720h` on disk is more
   * idiomatic than `720h0m0s`).
   *
   * Only emit-side: the parser accepts both forms regardless.
   * Sub-second durations (ns / µs / ms) already use a single unit
   * and are unaffected. Internal zero units between non-zero ones
   * (e.g. `1h0m30s` where the middle `0m` sits between non-zero h
   * and s) are preserved — the Go format requires them.
   */
  compactDuration?: boolean;
}

export function marshal<Desc extends DescMessage>(
  message: MessageShape<Desc>,
  schema: Desc,
  options?: MarshalOptions,
): string {
  const indent = options?.indent ?? "  ";
  const root = reflect(schema, message);
  const enc = new Encoder(
    indent,
    options?.emitDefaults ?? false,
    options?.typeResolver,
    options?.compactDuration ?? false,
  );
  enc.primeNullSet(root, options?.nullFields);
  if (options?.typeURL) {
    enc.buf += `@type ${options.typeURL}\n\n`;
  }
  enc.encodeMessage(root, 0);
  return enc.buf;
}

class Encoder {
  buf = "";
  private nullMaskFd: DescField | undefined;
  private nullSet: Set<string> | undefined;
  private pathPrefix = "";

  constructor(
    private readonly indent: string,
    private readonly emitDefaults: boolean,
    private readonly resolver: TypeResolver | undefined,
    private readonly compactDuration: boolean,
  ) {}

  /**
   * Discover the top-level `_null` FieldMask (if any) and snapshot its
   * paths into a Set. Falls back to `MarshalOptions.nullFields` for
   * schemas that don't carry a `_null` field. Mirrors the priming step
   * in Go's `Marshal`.
   */
  primeNullSet(root: ReflectMessage, fallback: Result | undefined): void {
    this.nullMaskFd = findNullMaskField(root.desc);
    if (this.nullMaskFd && root.isSet(this.nullMaskFd)) {
      const fmRefl = root.get(this.nullMaskFd) as ReflectMessage;
      const pathsFd = findFieldByProtoName(fmRefl.desc, "paths");
      if (pathsFd) {
        const list = fmRefl.get(pathsFd) as ReflectList<string>;
        const set = new Set<string>();
        for (const p of list) set.add(p);
        this.nullSet = set;
      }
      return;
    }
    if (fallback) {
      this.nullSet = new Set(fallback.nullPaths());
    }
  }

  private writeIndent(level: number): void {
    for (let i = 0; i < level; i++) this.buf += this.indent;
  }

  private writeFieldPrefix(level: number, name: string): void {
    this.writeIndent(level);
    this.buf += `${name} = `;
  }

  encodeMessage(parent: ReflectMessage, level: number): void {
    for (const fd of parent.desc.fields) {
      // Skip the `_null` FieldMask itself at the top level — it's metadata.
      if (
        this.nullMaskFd &&
        this.pathPrefix === "" &&
        fd.number === this.nullMaskFd.number
      ) {
        continue;
      }

      const path = this.pathPrefix + fd.name;
      if (this.nullSet?.has(path)) {
        this.writeFieldPrefix(level, fd.name);
        this.buf += "null\n";
        continue;
      }

      if (!this.emitDefaults && !parent.isSet(fd)) continue;

      if (fd.fieldKind === "map") {
        this.encodeMapField(parent, fd, level);
        continue;
      }
      if (fd.fieldKind === "list") {
        this.encodeListField(parent, fd, level);
        continue;
      }
      if (fd.fieldKind === "message") {
        if (!parent.isSet(fd)) continue;
        this.encodeMessageField(fd, parent.get(fd) as ReflectMessage, level);
        continue;
      }

      this.writeFieldPrefix(level, fd.name);
      this.writeScalarOrEnum(fd, parent);
      this.buf += "\n";
    }
  }

  private encodeMessageField(
    fd: DescField,
    sub: ReflectMessage,
    level: number,
  ): void {
    if (fd.fieldKind !== "message") {
      throw new Error("internal: encodeMessageField on non-message");
    }
    const mdesc = fd.message;

    if (isTimestamp(mdesc)) {
      this.writeFieldPrefix(level, fd.name);
      this.buf += formatRfc3339Nano(sub);
      this.buf += "\n";
      return;
    }
    if (isDuration(mdesc)) {
      this.writeFieldPrefix(level, fd.name);
      this.buf += this.compactDuration
        ? compactTrailingZeroUnits(formatGoDuration(sub))
        : formatGoDuration(sub);
      this.buf += "\n";
      return;
    }
    if (isWrapperType(mdesc)) {
      const innerFd = findFieldByProtoName(mdesc, "value");
      if (!innerFd || innerFd.fieldKind !== "scalar") {
        throw new Error(`wrapper ${mdesc.typeName} missing scalar 'value'`);
      }
      this.writeFieldPrefix(level, fd.name);
      this.writeScalarValue(innerFd.scalar, sub.get(innerFd) as unknown);
      this.buf += "\n";
      return;
    }
    if (isAny(mdesc) && this.resolver && this.tryEncodeAny(fd, sub, level)) {
      return;
    }

    this.writeIndent(level);
    this.buf += `${fd.name} {\n`;
    const saved = this.pathPrefix;
    this.pathPrefix = saved + fd.name + ".";
    this.encodeMessage(sub, level + 1);
    this.pathPrefix = saved;
    this.writeIndent(level);
    this.buf += "}\n";
  }

  private encodeListField(parent: ReflectMessage, fd: DescField, level: number): void {
    if (fd.fieldKind !== "list") {
      throw new Error("internal: encodeListField on non-list");
    }
    const list = parent.get(fd) as ReflectList;
    if (list.size === 0 && !this.emitDefaults) return;

    this.writeFieldPrefix(level, fd.name);
    this.buf += "[\n";

    let i = 0;
    for (const elem of list) {
      if (fd.listKind === "message") {
        const sub = elem as ReflectMessage;
        const mdesc = fd.message;
        if (isTimestamp(mdesc)) {
          this.writeIndent(level + 1);
          this.buf += formatRfc3339Nano(sub);
        } else if (isDuration(mdesc)) {
          this.writeIndent(level + 1);
          this.buf += this.compactDuration
        ? compactTrailingZeroUnits(formatGoDuration(sub))
        : formatGoDuration(sub);
        } else if (isWrapperType(mdesc)) {
          const innerFd = findFieldByProtoName(mdesc, "value");
          if (!innerFd || innerFd.fieldKind !== "scalar") {
            throw new Error(`wrapper ${mdesc.typeName} missing scalar 'value'`);
          }
          this.writeIndent(level + 1);
          this.writeScalarValue(innerFd.scalar, sub.get(innerFd) as unknown);
        } else {
          this.writeIndent(level + 1);
          this.buf += "{\n";
          this.encodeMessage(sub, level + 2);
          this.writeIndent(level + 1);
          this.buf += "}";
        }
      } else if (fd.listKind === "enum") {
        this.writeIndent(level + 1);
        this.writeEnumValue(fd, elem as number);
      } else {
        this.writeIndent(level + 1);
        this.writeScalarValue(fd.scalar, elem);
      }

      if (i < list.size - 1) this.buf += ",";
      this.buf += "\n";
      i++;
    }

    this.writeIndent(level);
    this.buf += "]\n";
  }

  private encodeMapField(parent: ReflectMessage, fd: DescField, level: number): void {
    if (fd.fieldKind !== "map") {
      throw new Error("internal: encodeMapField on non-map");
    }
    const map = parent.get(fd) as ReflectMap;
    if (map.size === 0 && !this.emitDefaults) return;

    this.writeFieldPrefix(level, fd.name);
    this.buf += "{\n";

    const entries: Array<[string, unknown]> = [];
    for (const [k, v] of map) {
      entries.push([formatMapKey(fd.mapKey, k), v]);
    }
    entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

    for (const [keyStr, val] of entries) {
      if (fd.mapKind === "message") {
        this.writeIndent(level + 1);
        this.buf += `${keyStr}: {\n`;
        this.encodeMessage(val as ReflectMessage, level + 2);
        this.writeIndent(level + 1);
        this.buf += "}\n";
      } else if (fd.mapKind === "enum") {
        this.writeIndent(level + 1);
        this.buf += `${keyStr}: `;
        this.writeEnumValue(fd, val as number);
        this.buf += "\n";
      } else {
        this.writeIndent(level + 1);
        this.buf += `${keyStr}: `;
        this.writeScalarValue(fd.scalar, val);
        this.buf += "\n";
      }
    }

    this.writeIndent(level);
    this.buf += "}\n";
  }

  /** Top-level scalar/enum dispatch for fields read off a parent ReflectMessage. */
  private writeScalarOrEnum(fd: DescField, parent: ReflectMessage): void {
    if (fd.fieldKind === "enum") {
      this.writeEnumValue(fd, parent.get(fd) as number);
      return;
    }
    if (fd.fieldKind !== "scalar") {
      throw new Error(`internal: writeScalarOrEnum on ${fd.fieldKind} field`);
    }
    this.writeScalarValue(fd.scalar, parent.get(fd) as unknown);
  }

  private writeEnumValue(fd: DescField, num: number): void {
    const enumDesc = fd.enum;
    if (!enumDesc) {
      throw new Error(`internal: missing enum descriptor for field ${fd.name}`);
    }
    const ev = enumDesc.values.find((v) => v.number === num);
    this.buf += ev ? ev.name : String(num);
  }

  private writeScalarValue(kind: ScalarType, val: unknown): void {
    switch (kind) {
      case ScalarType.STRING:
        this.buf += writeQuotedString(val as string);
        return;
      case ScalarType.BOOL:
        this.buf += (val as boolean) ? "true" : "false";
        return;
      case ScalarType.INT32:
      case ScalarType.SINT32:
      case ScalarType.SFIXED32:
      case ScalarType.UINT32:
      case ScalarType.FIXED32:
        this.buf += String(val as number);
        return;
      case ScalarType.INT64:
      case ScalarType.SINT64:
      case ScalarType.SFIXED64:
      case ScalarType.UINT64:
      case ScalarType.FIXED64:
        this.buf += (val as bigint).toString();
        return;
      case ScalarType.FLOAT:
      case ScalarType.DOUBLE:
        this.buf += formatFloat(val as number);
        return;
      case ScalarType.BYTES:
        this.buf += `b"${encodeBase64(val as Uint8Array)}"`;
        return;
      default:
        throw new Error(`unsupported scalar kind: ${kind}`);
    }
  }

  /**
   * Try to encode an Any field with sugar syntax. Returns true on success;
   * false to fall back to plain `{ type_url = ..., value = ... }` encoding
   * when the resolver can't find the URL or the bytes can't be unpacked.
   */
  private tryEncodeAny(
    fd: DescField,
    anyMsg: ReflectMessage,
    level: number,
  ): boolean {
    if (fd.fieldKind !== "message") return false;
    const anyDesc = fd.message;
    const typeUrlFd = findFieldByProtoName(anyDesc, "type_url");
    const valueFd = findFieldByProtoName(anyDesc, "value");
    if (!typeUrlFd || !valueFd) return false;

    const typeURL = anyMsg.get(typeUrlFd) as string;
    if (typeURL === "") return false;
    const valueBytes = anyMsg.get(valueFd) as Uint8Array;

    const innerDesc = this.resolver!.findMessageByURL(typeURL);
    if (!innerDesc) return false;

    let inner;
    try {
      inner = fromBinary(innerDesc, valueBytes);
    } catch {
      return false;
    }
    const innerRefl = reflect(innerDesc, inner);

    this.writeIndent(level);
    this.buf += `${fd.name} {\n`;
    this.writeIndent(level + 1);
    this.buf += `@type = ${writeQuotedString(typeURL)}\n`;
    const saved = this.pathPrefix;
    this.pathPrefix = saved + fd.name + ".";
    this.encodeMessage(innerRefl, level + 1);
    this.pathPrefix = saved;
    this.writeIndent(level);
    this.buf += "}\n";
    return true;
  }
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

const HEX = "0123456789abcdef";

/** Quote a string using PXF escape conventions. Same set as decode.ts. */
function writeQuotedString(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    switch (ch) {
      case 0x22: out += '\\"'; break;
      case 0x5c: out += "\\\\"; break;
      case 0x0a: out += "\\n"; break;
      case 0x0d: out += "\\r"; break;
      case 0x09: out += "\\t"; break;
      default:
        if (ch < 0x20) {
          out += `\\x${HEX[(ch >> 4) & 0xf]!}${HEX[ch & 0xf]!}`;
        } else {
          out += s[i];
        }
    }
  }
  out += '"';
  return out;
}

function formatFloat(f: number): string {
  if (f === Infinity) return "inf";
  if (f === -Infinity) return "-inf";
  if (Number.isNaN(f)) return "nan";
  // JS's default Number→String already uses the shortest round-trippable
  // representation, which matches Go's %g in practice for typical values.
  return String(f);
}

function encodeBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

function formatMapKey(kind: ScalarType, key: unknown): string {
  switch (kind) {
    case ScalarType.STRING: {
      const s = key as string;
      return isValidIdent(s) ? s : writeQuotedString(s);
    }
    case ScalarType.BOOL:
      return (key as boolean) ? "true" : "false";
    case ScalarType.INT32:
    case ScalarType.SINT32:
    case ScalarType.SFIXED32:
    case ScalarType.UINT32:
    case ScalarType.FIXED32:
      return String(key as number);
    case ScalarType.INT64:
    case ScalarType.SINT64:
    case ScalarType.SFIXED64:
    case ScalarType.UINT64:
    case ScalarType.FIXED64:
      return (key as bigint).toString();
    default:
      return String(key);
  }
}

function isValidIdent(s: string): boolean {
  if (s === "" || s === "true" || s === "false" || s === "null") return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const isLetter = (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x5f;
    const isDigit = c >= 0x30 && c <= 0x39;
    if (i === 0 ? !isLetter : !(isLetter || isDigit)) return false;
  }
  return true;
}

/**
 * Format a Timestamp ReflectMessage as RFC 3339 with optional fractional
 * seconds (no trailing zeros), like Go's `time.Format(time.RFC3339Nano)`.
 */
function formatRfc3339Nano(ts: ReflectMessage): string {
  const sf = findFieldByProtoName(ts.desc, "seconds");
  const nf = findFieldByProtoName(ts.desc, "nanos");
  const seconds = (sf ? (ts.get(sf) as bigint) : 0n);
  const nanos = nf ? (ts.get(nf) as number) : 0;

  // Build the date portion from integer seconds (UTC).
  const ms = Number(seconds) * 1000;
  const d = new Date(ms);
  const date =
    `${pad4(d.getUTCFullYear())}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}` +
    `T${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;

  if (nanos === 0) return `${date}Z`;

  // Render 9 fractional digits then strip trailing zeros (RFC 3339 nano).
  let frac = String(Math.abs(nanos)).padStart(9, "0");
  frac = frac.replace(/0+$/, "");
  return `${date}.${frac}Z`;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function pad4(n: number): string {
  return String(n).padStart(4, "0");
}

const NANOS_PER_SECOND = 1_000_000_000n;
const NANOS_PER_MICRO = 1_000n;
const NANOS_PER_MILLI = 1_000_000n;

/**
 * Format a Duration ReflectMessage as a Go-style duration string. Mirrors
 * `time.Duration.String()`: leading-zero h/m units omitted, sub-second
 * durations use the smallest unit (ns / µs / ms) that gives a non-zero
 * leading digit, and `0s` is the canonical zero.
 */
function formatGoDuration(d: ReflectMessage): string {
  const sf = findFieldByProtoName(d.desc, "seconds");
  const nf = findFieldByProtoName(d.desc, "nanos");
  const seconds = sf ? (d.get(sf) as bigint) : 0n;
  const nanos = nf ? (d.get(nf) as number) : 0;

  let total = seconds * NANOS_PER_SECOND + BigInt(nanos);
  if (total === 0n) return "0s";

  const neg = total < 0n;
  if (neg) total = -total;

  let out: string;
  if (total < NANOS_PER_SECOND) {
    if (total < NANOS_PER_MICRO) {
      out = `${total.toString()}ns`;
    } else if (total < NANOS_PER_MILLI) {
      out = `${trimFraction(total, NANOS_PER_MICRO)}µs`;
    } else {
      out = `${trimFraction(total, NANOS_PER_MILLI)}ms`;
    }
  } else {
    const secsPart = total / NANOS_PER_SECOND;
    const fracNanos = total % NANOS_PER_SECOND;
    const sec = secsPart % 60n;
    const minTotal = secsPart / 60n;
    const minute = minTotal % 60n;
    const hour = minTotal / 60n;

    const secStr = trimFraction(sec * NANOS_PER_SECOND + fracNanos, NANOS_PER_SECOND);

    if (hour > 0n) {
      out = `${hour.toString()}h${minute.toString()}m${secStr}s`;
    } else if (minute > 0n) {
      out = `${minute.toString()}m${secStr}s`;
    } else {
      out = `${secStr}s`;
    }
  }
  return neg ? `-${out}` : out;
}

/**
 * Trim trailing zero-valued h/m/s units from a Go-style duration string
 * produced by `formatGoDuration`. Powers the `compactDuration` MarshalOption.
 *
 * Rules:
 *   - sub-second forms (`<n>ns`, `<n>µs`, `<n>ms`) pass through unchanged
 *     since they already use a single unit;
 *   - `0s` passes through unchanged (canonical zero);
 *   - `720h0m0s` → `720h`, `1h30m0s` → `1h30m`, `30m0s` → `30m`;
 *   - `1h0m30s` is left alone — the internal `0m` sits between non-zero
 *     h and s, so it is structural rather than trailing.
 *
 * The trim runs repeatedly so a chain of trailing zero units collapses in
 * one pass through the loop. Leading `-` on negative durations is
 * preserved by stripping it for the inner trim and re-prepending.
 */
function compactTrailingZeroUnits(s: string): string {
  if (s === "0s" || s === "-0s") return s;
  const neg = s.startsWith("-");
  let body = neg ? s.slice(1) : s;
  // Repeatedly strip a trailing `0(h|m|s)` ONLY when the `0` is a
  // standalone unit-value-zero — i.e., preceded by a unit letter
  // (h/m/s/µ/n), not by a digit. This rules out trimming the trailing
  // `0` of a multi-digit number like the `0` in `720h`. Go's duration
  // emit never produces consecutive `<num><unit><num><unit>` without
  // a unit letter between them, so requiring the prefix to end in one
  // of [hmsµn] correctly distinguishes the two cases.
  let prev = "";
  while (prev !== body) {
    prev = body;
    const m = body.match(/^(.+?[hmsµn])0(h|m|s)$/);
    if (m !== null) {
      const trimmed = m[1];
      if (trimmed !== undefined && trimmed !== "") {
        body = trimmed;
      }
    }
  }
  return neg ? `-${body}` : body;
}

/**
 * Format `value / unit` with up to (digits-of-unit) fractional places, with
 * trailing zeros trimmed. Returns "5" not "5.000". Used by `formatGoDuration`
 * to print "1.5" out of `1500ms` ÷ `1000ms`.
 */
function trimFraction(value: bigint, unit: bigint): string {
  const whole = value / unit;
  const remainder = value % unit;
  if (remainder === 0n) return whole.toString();
  // Compute fractional digits: pad remainder to width(unit)-1 zeros, trim.
  const unitStr = unit.toString();
  const fracDigits = unitStr.length - 1;
  const remStr = remainder.toString().padStart(fracDigits, "0").replace(/0+$/, "");
  return `${whole.toString()}.${remStr}`;
}
