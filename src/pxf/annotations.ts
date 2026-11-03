// SPDX-License-Identifier: MIT
// Copyright (c) 2026 TrendVidia, LLC.
/**
 * Read PXF field annotations (`pxf.required`, `pxf.default`, `pxf.key`, and the
 * `@required` / `@default` carrier) and discover the `_null` FieldMask. Mirrors `protowire/encoding/pxf/annotations.go`.
 *
 * The `pxf/annotations.proto` extensions are NOT registered with protobuf-es
 * here; the values land in `FieldOptions.$unknown`. We parse those raw
 * varint / length-delimited bytes directly, matching the Go fallback path.
 */

import { type DescField, type DescMessage, ScalarType } from "@bufbuild/protobuf";

import { formatBigFloat } from "./bigfloat.js";
import { formatBigInt, formatDecimal } from "./bignum.js";

const EXT_REQUIRED = 1314;
const EXT_DEFAULT = 1315;
const EXT_KEY = 1316;
const EXT_ANNOTATIONS = 1327;

const ANNOTATION_REQUIRED = "protowire.schema.v1.required";
const ANNOTATION_DEFAULT = "protowire.schema.v1.default";

export function isRequired(fd: DescField): boolean {
  return fieldOptions(fd).required;
}

export function getDefault(fd: DescField): string | undefined {
  return fieldOptions(fd).def;
}

/** Which of PXF's two spellings supplied an annotation. */
export type AnnotationSurface = "option" | "carrier";

/** What a field's options say about `required` and `default`, in both spellings. */
export interface FieldAnnotations {
  readonly required: boolean;
  readonly requiredSurface: AnnotationSurface;
  readonly def: string | undefined;
  readonly defSurface: AnnotationSurface;
  /** Why a `@default` could not be used; reported at bind time, never dropped. */
  readonly defProblem: string | undefined;
}

const annotationCache = new WeakMap<object, FieldAnnotations>();

/**
 * Read `(pxf.required)` / `(pxf.default)` and the `@required` / `@default`
 * carrier. A compiler emits only the spelling the author wrote, so a reader of
 * one enforces nothing for the other. Either spelling makes a field required.
 * Two different defaults are a schema error rather than a precedence rule.
 */
export function fieldOptions(fd: DescField): FieldAnnotations {
  const cached = annotationCache.get(fd);
  if (cached) return cached;
  const carrier = readCarrier(fd);
  const option = bracketOptions(fd);
  const required = option.required || carrier.required;
  let def = option.def;
  let defSurface: AnnotationSurface = "option";
  let defProblem: string | undefined;
  if (carrier.problem !== undefined) {
    defProblem = carrier.problem;
    defSurface = "carrier";
  } else if (carrier.def !== undefined) {
    if (def === undefined) {
      def = carrier.def;
      defSurface = "carrier";
    } else if (def !== carrier.def) {
      defProblem = `(pxf.default) = ${JSON.stringify(def)} and @default = ${JSON.stringify(carrier.def)} carry different values, and the two surfaces must not be reconciled (RFC-001 §8.5)`;
    }
  }
  const out: FieldAnnotations = {
    required,
    requiredSurface: option.required ? "option" : "carrier",
    def,
    defSurface,
    defProblem,
  };
  annotationCache.set(fd, out);
  return out;
}

function bracketOptions(fd: DescField): { required: boolean; def: string | undefined } {
  let required = false;
  for (const uf of fd.proto.options?.$unknown ?? []) {
    if (uf.no === EXT_REQUIRED && uf.wireType === 0) required = readVarint(uf.data) !== 0n;
  }
  return { required, def: getStringOption(fd, EXT_DEFAULT) };
}

/**
 * The raw `(pxf.key)` annotation value if set, even when its placement is
 * invalid: `validateDescriptor` reports bad placements, and {@link keyField}
 * resolves the annotation only when it is well-placed.
 */
export function getKeyName(fd: DescField): string | undefined {
  return getStringOption(fd, EXT_KEY);
}

/**
 * The key field of a keyed repeated field: the singular string field of
 * `fd`'s element message that `fd`'s `(pxf.key)` names (draft -01 §3.13).
 * Undefined when `fd` has no `(pxf.key)` or its placement is invalid.
 */
export function keyField(fd: DescField): DescField | undefined {
  if (fd.fieldKind !== "list" || fd.listKind !== "message") return undefined;
  const name = getKeyName(fd);
  if (!name) return undefined;
  const kf = fd.message.fields.find((f) => f.name === name);
  if (kf?.fieldKind !== "scalar" || kf.scalar !== ScalarType.STRING) return undefined;
  return kf;
}

function getStringOption(fd: DescField, ext: number): string | undefined {
  const ufs = fd.proto.options?.$unknown;
  if (!ufs) return undefined;
  for (const uf of ufs) {
    if (uf.no === ext && uf.wireType === 2) {
      // LengthDelimited payload: data starts with a length varint, then the
      // string bytes. protobuf-es records the full prefixed payload here.
      const [len, off] = readVarintWithLength(uf.data);
      return new TextDecoder().decode(uf.data.subarray(off, off + Number(len)));
    }
  }
  return undefined;
}

/**
 * Returns the `_null` field on `desc` if it exists and is a
 * `google.protobuf.FieldMask`. Returns undefined otherwise.
 */
export function findNullMaskField(desc: DescMessage): DescField | undefined {
  for (const f of desc.fields) {
    if (
      f.name === "_null" &&
      f.fieldKind === "message" &&
      f.message.typeName === "google.protobuf.FieldMask"
    ) {
      return f;
    }
  }
  return undefined;
}

function readVarint(data: Uint8Array): bigint {
  let result = 0n;
  let shift = 0n;
  for (let i = 0; i < data.length && i < 10; i++) {
    const byte = data[i]!;
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return result;
    shift += 7n;
  }
  throw new Error("invalid varint in field options");
}

function readVarintWithLength(data: Uint8Array): [bigint, number] {
  let result = 0n;
  let shift = 0n;
  for (let i = 0; i < data.length && i < 10; i++) {
    const byte = data[i]!;
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return [result, i + 1];
    shift += 7n;
  }
  throw new Error("invalid varint in field options");
}

// ---- The annotation carrier (RFC-001 §8.1), read from its wire bytes ------
//
// protowire/schema/v1/descriptor.proto, by field number. Mirrors the
// reference's carrier.go. AnnotationList.entries = 1; Annotation.name = 1,
// args = 2; AnnotationArg.name = 1, then one value member.
const ARG_STRING = 10;
const ARG_INT = 11;
const ARG_DOUBLE = 12;
const ARG_BOOL = 13;
const ARG_BYTES = 14;
const ARG_LITERAL = 15;
const ARG_BIG_INT = 16;
const ARG_DECIMAL = 17;
const ARG_BIG_FLOAT = 18;

interface WireField {
  readonly no: number;
  readonly wire: number;
  readonly int: bigint;
  readonly bytes: Uint8Array | undefined;
}

/** The fields of `data`, stopping at the first that does not parse. */
function wireFields(data: Uint8Array): WireField[] {
  const out: WireField[] = [];
  let i = 0;
  const varint = (): bigint | undefined => {
    let v = 0n;
    for (let shift = 0n; i < data.length && shift < 70n; shift += 7n) {
      const b = data[i++]!;
      v |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) return v;
    }
    return undefined;
  };
  while (i < data.length) {
    const tag = varint();
    if (tag === undefined) return out;
    const no = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    if (wire === 0) {
      const int = varint();
      if (int === undefined) return out;
      out.push({ no, wire, int, bytes: undefined });
    } else if (wire === 1 || wire === 5) {
      const size = wire === 1 ? 8 : 4;
      if (i + size > data.length) return out;
      let int = 0n;
      for (let k = size - 1; k >= 0; k--) int = (int << 8n) | BigInt(data[i + k]!);
      i += size;
      out.push({ no, wire, int, bytes: undefined });
    } else if (wire === 2) {
      const len = varint();
      if (len === undefined || i + Number(len) > data.length) return out;
      out.push({ no, wire, int: 0n, bytes: data.subarray(i, i + Number(len)) });
      i += Number(len);
    } else {
      return out;
    }
  }
  return out;
}

const utf8 = new TextDecoder();

function readCarrier(fd: DescField): { required: boolean; def?: string; problem?: string } {
  const got: { required: boolean; def?: string; problem?: string } = { required: false };
  for (const uf of fd.proto.options?.$unknown ?? []) {
    if (uf.no !== EXT_ANNOTATIONS || uf.wireType !== 2) continue;
    const [len, off] = readVarintWithLength(uf.data);
    for (const entry of wireFields(uf.data.subarray(off, off + Number(len)))) {
      if (entry.no === 1 && entry.bytes) applyAnnotation(got, entry.bytes, fd);
    }
  }
  return got;
}

function applyAnnotation(
  got: { required: boolean; def?: string; problem?: string },
  entry: Uint8Array,
  fd: DescField,
): void {
  let name = "";
  const args: Uint8Array[] = [];
  for (const f of wireFields(entry)) {
    if (f.no === 1 && f.bytes) name = utf8.decode(f.bytes);
    if (f.no === 2 && f.bytes) args.push(f.bytes);
  }
  if (name === ANNOTATION_REQUIRED) {
    got.required = true;
    return;
  }
  if (name !== ANNOTATION_DEFAULT || got.def !== undefined || got.problem !== undefined) return;
  const arg = args.find((a) => {
    const n = wireFields(a).find((f) => f.no === 1 && f.bytes);
    const argName = n ? utf8.decode(n.bytes!) : "";
    return argName === "" || argName === "value";
  });
  if (!arg) {
    got.problem = "@default carries no value argument";
    return;
  }
  const r = argLiteral(arg, fd);
  if ("problem" in r) got.problem = r.problem;
  else got.def = r.literal;
}

function unsignedTarget(fd: DescField): boolean {
  if (fd.fieldKind === "scalar") {
    return (
      fd.scalar === ScalarType.UINT32 ||
      fd.scalar === ScalarType.FIXED32 ||
      fd.scalar === ScalarType.UINT64 ||
      fd.scalar === ScalarType.FIXED64
    );
  }
  if (fd.fieldKind === "message") {
    return (
      fd.message.typeName === "google.protobuf.UInt32Value" ||
      fd.message.typeName === "google.protobuf.UInt64Value"
    );
  }
  return false;
}

/** One AnnotationArg as the literal the bracket spelling would carry. */
function argLiteral(arg: Uint8Array, fd: DescField): { literal: string } | { problem: string } {
  for (const f of wireFields(arg)) {
    switch (f.no) {
      case ARG_STRING:
        if (f.bytes) return { literal: utf8.decode(f.bytes) };
        break;
      case ARG_INT:
        if (f.wire === 0) {
          const v = unsignedTarget(fd) ? BigInt.asUintN(64, f.int) : BigInt.asIntN(64, f.int);
          return { literal: v.toString() };
        }
        break;
      case ARG_DOUBLE:
        if (f.wire === 1) {
          const view = new DataView(new ArrayBuffer(8));
          view.setBigUint64(0, f.int);
          return { literal: String(view.getFloat64(0)) };
        }
        break;
      case ARG_BOOL:
        if (f.wire === 0) return { literal: f.int !== 0n ? "true" : "false" };
        break;
      case ARG_BYTES:
        if (f.bytes) return { literal: Buffer.from(f.bytes).toString("base64") };
        break;
      case ARG_LITERAL:
        if (f.bytes) return literalValue(f.bytes);
        break;
      case ARG_BIG_INT:
        if (f.bytes) {
          const parts = wireFields(f.bytes);
          return {
            literal: formatBigInt({
              abs: parts.find((x) => x.no === 1)?.bytes ?? new Uint8Array(),
              negative: (parts.find((x) => x.no === 2)?.int ?? 0n) !== 0n,
            }),
          };
        }
        break;
      case ARG_DECIMAL:
        if (f.bytes) {
          const parts = wireFields(f.bytes);
          const scale = Number(BigInt.asIntN(32, parts.find((x) => x.no === 2)?.int ?? 0n));
          try {
            return {
              literal: formatDecimal({
                unscaled: parts.find((x) => x.no === 1)?.bytes ?? new Uint8Array(),
                scale,
                negative: (parts.find((x) => x.no === 3)?.int ?? 0n) !== 0n,
              }),
            };
          } catch (e) {
            return { problem: `@default's decimal_value: ${(e as Error).message}` };
          }
        }
        break;
      case ARG_BIG_FLOAT:
        if (f.bytes) {
          const parts = wireFields(f.bytes);
          const prec = Number(parts.find((x) => x.no === 3)?.int ?? 0n);
          if (prec === 0) return { problem: "@default's big_float_value declares no precision" };
          try {
            return {
              literal: formatBigFloat({
                mantissa: parts.find((x) => x.no === 1)?.bytes ?? new Uint8Array(),
                exponent: Number(BigInt.asIntN(32, parts.find((x) => x.no === 2)?.int ?? 0n)),
                prec,
                negative: (parts.find((x) => x.no === 4)?.int ?? 0n) !== 0n,
              }),
            };
          } catch (e) {
            return { problem: `@default's big_float_value: ${(e as Error).message}` };
          }
        }
        break;
    }
  }
  return { problem: "@default's value is empty" };
}

function literalValue(b: Uint8Array): { literal: string } | { problem: string } {
  for (const f of wireFields(b)) {
    if (f.no === 1 && f.bytes) {
      const name = wireFields(f.bytes).find((x) => x.no === 2 && x.bytes);
      if (name) return { literal: utf8.decode(name.bytes!) };
      return { problem: "@default names an enum value the lowering pass left unresolved" };
    }
  }
  return { problem: "@default carries a message or list literal, and a default is exactly one literal" };
}
