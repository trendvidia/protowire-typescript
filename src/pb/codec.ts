// SPDX-License-Identifier: MIT
// Copyright (c) 2026 TrendVidia, LLC.
/**
 * Schema-driven protobuf binary marshal/unmarshal.
 *
 * Mirrors the Go `encoding/pb` package's struct-tag approach, but with
 * an explicit field schema (TS has no struct tags or runtime field metadata).
 *
 * Wire-format choices match proto3 semantics:
 *   - int32 / int64: plain varint, with negative values sign-extended to a
 *     10-byte uint64 (proto3 `int32` / `int64`).
 *   - sint32 / sint64: zigzag varint (proto3 `sint32` / `sint64`); more
 *     compact for negative values.
 *   - uint32 / uint64: plain varint.
 *   - bool: varint (0/1).
 *   - float: fixed32; double: fixed64.
 *   - string and bytes: length-delimited.
 *   - nested messages: length-delimited.
 *   - repeated fields: one tag+value per element when written; a reader also
 *     takes the packed form.
 *
 * Maps follow the proto3 spec: `repeated MapEntry { key = 1; value = 2; }`.
 */

import { Reader, Writer, WireType } from "./wire.js";

/**
 * How deep a message may nest. The root is depth 0, and every submessage and
 * map entry is one descent, whatever the entry's value type: a message whose
 * deepest point is exactly this many descents is accepted, and one more is
 * rejected (HARDENING.md § Recursion).
 */
export const MAX_NESTING_DEPTH = 100;

/** MaxMessageSize (HARDENING.md § Mandatory limits), also the default
 * MaxRepeatedCount. */
export const MAX_MESSAGE_SIZE = 64 << 20;

export interface UnmarshalOptions {
  /** Bytes of input a call may read. Default {@link MAX_MESSAGE_SIZE}. */
  readonly maxMessageSize?: number;
  /** Elements of one repeated or map field. Default {@link MAX_MESSAGE_SIZE}. */
  readonly maxRepeatedCount?: number;
  /** How deep a message may nest. Default {@link MAX_NESTING_DEPTH}. */
  readonly maxNestingDepth?: number;
  /** The bound on a Decimal's scale. Default 4096. */
  readonly maxNumericLiteralDigits?: number;
  /** The bound on a BigFloat's binary exponent. Default {@link MAX_BIG_FLOAT_EXPONENT}. */
  readonly maxBigFloatExponent?: number;
}

function readerFor(data: Uint8Array, options: UnmarshalOptions | undefined): Reader {
  const max = options?.maxMessageSize ?? MAX_MESSAGE_SIZE;
  if (data.length > max) throw new Error(`input of ${data.length} bytes exceeds MaxMessageSize=${max}`);
  const r = new Reader(data);
  r.maxRepeated = options?.maxRepeatedCount ?? MAX_MESSAGE_SIZE;
  r.maxDepth = options?.maxNestingDepth ?? MAX_NESTING_DEPTH;
  r.maxDigits = options?.maxNumericLiteralDigits ?? 4096;
  r.maxBigFloatExponent = options?.maxBigFloatExponent ?? MAX_BIG_FLOAT_EXPONENT;
  return r;
}

/**
 * Bounds the magnitude of a `pxf.BigFloat`'s binary exponent, the wire exponent
 * plus the mantissa's bit length (HARDENING.md § Mandatory limits,
 * protowire#281). Rendering the value in decimal costs time that grows with
 * the square of it.
 */
export const MAX_BIG_FLOAT_EXPONENT = 16384;

export type ScalarKind =
  | "bool"
  | "int32"
  | "int64"
  | "sint32"
  | "sint64"
  | "uint32"
  | "uint64"
  | "float"
  | "double"
  | "string"
  | "bytes";

/** Map keys may not be float/double/bytes per the proto3 spec. */
export type MapKeyKind =
  | "bool"
  | "int32"
  | "int64"
  | "sint32"
  | "sint64"
  | "uint32"
  | "uint64"
  | "string";

export type Kind = ScalarKind | { readonly message: CodecBase };

export interface FieldSpec {
  readonly number: number;
  readonly name: string;
  readonly kind: Kind;
  /** Mark a non-map field as repeated. Mutually exclusive with `mapKey`. */
  readonly repeated?: boolean;
  /** Set to make this field a map. The field's `kind` is the value's kind. */
  readonly mapKey?: MapKeyKind;
}

/**
 * Type-erased codec interface used internally for nested-message encoding.
 * Public users see {@link MessageCodec} which preserves the value type.
 */
export interface CodecBase {
  readonly fields: ReadonlyArray<FieldSpec>;
  readonly byNumber: ReadonlyMap<number, FieldSpec>;
  create(): unknown;
  marshalInto(w: Writer, value: unknown): void;
  unmarshalFrom(r: Reader, end: number, into: unknown): void;
}

export interface MessageCodec<T> extends CodecBase {
  create(): T;
  marshal(value: T): Uint8Array;
  unmarshal(data: Uint8Array, options?: UnmarshalOptions): T;
}

export interface DefineMessageOpts<T> {
  readonly fields: ReadonlyArray<FieldSpec>;
  /** Factory invoked by unmarshal to produce a target instance. Defaults to `{}`. */
  readonly create?: () => T;
}

export function defineMessage<T extends object>(
  opts: DefineMessageOpts<T>,
): MessageCodec<T> {
  const byNumber = new Map<number, FieldSpec>();
  for (const f of opts.fields) {
    if (f.number < 1) {
      throw new Error(`field '${f.name}' has invalid number ${f.number}`);
    }
    if (byNumber.has(f.number)) {
      const other = byNumber.get(f.number)!;
      throw new Error(
        `duplicate field number ${f.number} ('${other.name}' and '${f.name}')`,
      );
    }
    if (f.repeated && f.mapKey !== undefined) {
      throw new Error(`field '${f.name}' cannot be both repeated and a map`);
    }
    byNumber.set(f.number, f);
  }
  const create = opts.create ?? ((): T => ({}) as T);

  const codec: MessageCodec<T> = {
    fields: opts.fields,
    byNumber,
    create,
    marshalInto(w, value) {
      marshalMessageInto(w, value, this);
    },
    unmarshalFrom(r, end, into) {
      unmarshalMessageFrom(r, end, into, this);
    },
    marshal(value) {
      const w = new Writer();
      marshalMessageInto(w, value, this);
      return w.finish();
    },
    unmarshal(data, options) {
      const r = readerFor(data, options);
      const obj = create();
      unmarshalMessageFrom(r, data.length, obj, this);
      return obj;
    },
  };
  return codec;
}

/** A `pxf.BigFloat`: value = (-1)^negative × mantissa × 2^exponent, rounded to prec bits. */
export interface BigFloatValue {
  mantissa?: Uint8Array;
  exponent?: number;
  prec?: number;
  negative?: boolean;
}

function checkBigFloat(v: BigFloatValue, max: number): void {
  // Precision 0 is zero, and a zero mantissa is zero at any exponent.
  const m = v.mantissa;
  if (!v.prec || !m) return;
  const first = m.findIndex((b) => b !== 0);
  if (first < 0) return;
  const e = (v.exponent ?? 0) + 8 * (m.length - first - 1) + (32 - Math.clz32(m[first]!));
  if (e > max || e < -max) {
    throw new Error(`pxf.BigFloat binary exponent ${e} exceeds MaxBigFloatExponent=${max}`);
  }
}

const bigFloatFields = defineMessage<BigFloatValue>({
  fields: [
    { number: 1, name: "mantissa", kind: "bytes" },
    { number: 2, name: "exponent", kind: "int32" },
    { number: 3, name: "prec", kind: "uint32" },
    { number: 4, name: "negative", kind: "bool" },
  ],
});

/**
 * The codec of a `pxf.BigFloat`, for a field's `{ message: BigFloatCodec }`.
 * It rejects a value past {@link MAX_BIG_FLOAT_EXPONENT}, nested or not.
 */
export const BigFloatCodec: MessageCodec<BigFloatValue> = {
  ...bigFloatFields,
  unmarshalFrom(r, end, into) {
    bigFloatFields.unmarshalFrom(r, end, into);
    checkBigFloat(into as BigFloatValue, r.maxBigFloatExponent);
  },
  unmarshal(data, options) {
    const v = bigFloatFields.unmarshal(data, options);
    checkBigFloat(v, options?.maxBigFloatExponent ?? MAX_BIG_FLOAT_EXPONENT);
    return v;
  },
};

/** The shape of a `pxf.Decimal` on the wire. */
export interface DecimalValue {
  unscaled?: Uint8Array;
  scale?: number;
  negative?: boolean;
}

function checkDecimal(v: DecimalValue, max: number): void {
  const scale = v.scale ?? 0;
  if (scale > max || scale < -max) {
    throw new Error(`pxf.Decimal scale ${scale} exceeds MaxNumericLiteralDigits=${max}`);
  }
}

const decimalFields = defineMessage<DecimalValue>({
  fields: [
    { number: 1, name: "unscaled", kind: "bytes" },
    { number: 2, name: "scale", kind: "int32" },
    { number: 3, name: "negative", kind: "bool" },
  ],
});

/**
 * The codec of a `pxf.Decimal`, for a field's `{ message: DecimalCodec }`. It
 * rejects a scale past MaxNumericLiteralDigits, nested or not, before anything
 * is materialised from it.
 */
export const DecimalCodec: MessageCodec<DecimalValue> = {
  ...decimalFields,
  unmarshalFrom(r, end, into) {
    decimalFields.unmarshalFrom(r, end, into);
    checkDecimal(into as DecimalValue, r.maxDigits);
  },
  unmarshal(data, options) {
    const v = decimalFields.unmarshal(data, options);
    checkDecimal(v, options?.maxNumericLiteralDigits ?? 4096);
    return v;
  },
};

export function marshal<T>(value: T, codec: MessageCodec<T>): Uint8Array {
  return codec.marshal(value);
}

export function unmarshal<T>(data: Uint8Array, codec: MessageCodec<T>, options?: UnmarshalOptions): T {
  return codec.unmarshal(data, options);
}

// ---------------------------------------------------------------------------
// Marshal
// ---------------------------------------------------------------------------

function isZero(kind: ScalarKind, v: unknown): boolean {
  if (v === undefined || v === null) return true;
  switch (kind) {
    case "bool":
      return v === false;
    case "int32":
    case "sint32":
    case "uint32":
    case "float":
    case "double":
      return v === 0;
    case "int64":
    case "sint64":
    case "uint64":
      return v === 0n;
    case "string":
      return v === "";
    case "bytes":
      return (v as Uint8Array).length === 0;
  }
}

function wireTypeOf(kind: ScalarKind | "message"): WireType {
  switch (kind) {
    case "bool":
    case "int32":
    case "int64":
    case "sint32":
    case "sint64":
    case "uint32":
    case "uint64":
      return WireType.Varint;
    case "float":
      return WireType.Fixed32;
    case "double":
      return WireType.Fixed64;
    case "string":
    case "bytes":
    case "message":
      return WireType.LengthDelimited;
  }
}

function writeScalarValue(w: Writer, kind: ScalarKind, v: unknown): void {
  switch (kind) {
    case "bool":
      w.varint(v ? 1 : 0);
      return;
    case "int32": {
      // proto3 int32: plain varint; negative values sign-extend to uint64
      // and emit a 10-byte varint.
      const n = v as number;
      w.varint(n < 0 ? BigInt(n) : n);
      return;
    }
    case "int64":
      w.varint(typeof v === "bigint" ? v : BigInt(v as number));
      return;
    case "sint32":
      w.zigzag32(v as number);
      return;
    case "sint64":
      w.zigzag64(typeof v === "bigint" ? v : BigInt(v as number));
      return;
    case "uint32":
      w.varint(v as number);
      return;
    case "uint64":
      w.varint(typeof v === "bigint" ? v : BigInt(v as number));
      return;
    case "float":
      w.float(v as number);
      return;
    case "double":
      w.double(v as number);
      return;
    case "string":
      w.string(v as string);
      return;
    case "bytes":
      w.bytes(v as Uint8Array);
      return;
  }
}

function writeNestedMessage(w: Writer, codec: CodecBase, value: unknown): void {
  const inner = new Writer();
  codec.marshalInto(inner, value);
  const bytes = inner.finish();
  w.varint(bytes.length);
  w.raw(bytes);
}

function marshalMessageInto(w: Writer, value: unknown, codec: CodecBase): void {
  if (value === undefined || value === null) {
    throw new TypeError("cannot marshal null/undefined message");
  }
  const obj = value as Record<string, unknown>;

  for (const f of codec.fields) {
    const v = obj[f.name];

    if (f.mapKey !== undefined) {
      writeMapField(w, f, v);
      continue;
    }

    if (f.repeated) {
      writeRepeatedField(w, f, v);
      continue;
    }

    // Singular field.
    if (typeof f.kind === "string") {
      if (isZero(f.kind, v)) continue;
      w.tag(f.number, wireTypeOf(f.kind));
      writeScalarValue(w, f.kind, v);
    } else {
      if (v === undefined || v === null) continue;
      w.tag(f.number, WireType.LengthDelimited);
      writeNestedMessage(w, f.kind.message, v);
    }
  }
}

function writeRepeatedField(w: Writer, f: FieldSpec, v: unknown): void {
  if (!Array.isArray(v) || v.length === 0) return;
  if (typeof f.kind === "string") {
    for (const item of v) {
      w.tag(f.number, wireTypeOf(f.kind));
      writeScalarValue(w, f.kind, item);
    }
  } else {
    for (const item of v) {
      if (item === undefined || item === null) continue;
      w.tag(f.number, WireType.LengthDelimited);
      writeNestedMessage(w, f.kind.message, item);
    }
  }
}

function writeMapField(w: Writer, f: FieldSpec, v: unknown): void {
  if (v === undefined || v === null) return;
  const keyKind = f.mapKey!;
  const valueIsMessage = typeof f.kind !== "string";
  for (const [key, val] of mapEntries(v, keyKind)) {
    const inner = new Writer();
    // Both, zero-valued or not, as protoc and protobuf-go write them
    // (protowire#295).
    inner.tag(1, wireTypeOf(keyKind));
    writeScalarValue(inner, keyKind, key);
    if (valueIsMessage) {
      inner.tag(2, WireType.LengthDelimited);
      if (val !== undefined && val !== null) {
        writeNestedMessage(inner, (f.kind as { message: CodecBase }).message, val);
      } else {
        inner.varint(0);
      }
    } else {
      const sk = f.kind as ScalarKind;
      inner.tag(2, wireTypeOf(sk));
      writeScalarValue(inner, sk, val);
    }
    const blob = inner.finish();
    w.tag(f.number, WireType.LengthDelimited);
    w.varint(blob.length);
    w.raw(blob);
  }
}

function* mapEntries(
  v: unknown,
  keyKind: MapKeyKind,
): Generator<[unknown, unknown]> {
  if (v instanceof Map) {
    for (const [k, val] of v.entries()) yield [k, val];
    return;
  }
  if (typeof v !== "object" || v === null) return;
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    yield [parseMapKey(k, keyKind), val];
  }
}

function parseMapKey(k: string, keyKind: MapKeyKind): unknown {
  switch (keyKind) {
    case "bool":
      return k === "true";
    case "int32":
    case "uint32":
      return Number(k);
    case "int64":
    case "uint64":
      return BigInt(k);
    case "string":
      return k;
  }
}

// ---------------------------------------------------------------------------
// Unmarshal
// ---------------------------------------------------------------------------

function unmarshalMessageFrom(
  r: Reader,
  end: number,
  into: unknown,
  codec: CodecBase,
): void {
  if (into === undefined || into === null) {
    throw new TypeError("cannot unmarshal into null/undefined target");
  }
  const obj = into as Record<string, unknown>;

  // Initialize empty containers for repeated/map fields if not already set,
  // so wire-absent collections come back as [] / {} rather than undefined.
  for (const f of codec.fields) {
    if (f.mapKey !== undefined && obj[f.name] === undefined) {
      obj[f.name] = {};
    } else if (f.repeated && obj[f.name] === undefined) {
      obj[f.name] = [];
    }
  }

  const mapEntries = new Map<number, number>();
  while (r.pos < end) {
    const { fieldNumber, wireType } = r.tag();
    const f = codec.byNumber.get(fieldNumber);
    if (f === undefined) {
      r.skip(wireType);
      continue;
    }

    if (f.mapKey !== undefined) {
      // Counted as read: measuring the object per entry would be quadratic.
      const seen = mapEntries.get(fieldNumber) ?? 0;
      if (seen >= r.maxRepeated) {
        throw new Error(`map field '${f.name}' exceeds MaxRepeatedCount=${r.maxRepeated}`);
      }
      mapEntries.set(fieldNumber, seen + 1);
      readMapEntry(r, obj, f);
      continue;
    }

    if (f.repeated) {
      const arr = obj[f.name] as unknown[];
      // Packed, proto3's default for a numeric scalar: one length-delimited
      // run of values. A reader takes either form.
      if (
        wireType === WireType.LengthDelimited &&
        typeof f.kind === "string" &&
        wireTypeOf(f.kind) !== WireType.LengthDelimited
      ) {
        const length = r.varint();
        const stop = r.pos + length;
        if (stop > end) throw new Error(`packed field '${f.name}' overruns its message`);
        while (r.pos < stop) {
          if (arr.length >= r.maxRepeated) {
            throw new Error(`repeated field '${f.name}' exceeds MaxRepeatedCount=${r.maxRepeated}`);
          }
          arr.push(readScalarValue(r, f.kind));
        }
        if (r.pos !== stop) throw new Error(`packed field '${f.name}' overran its length`);
        continue;
      }
      if (arr.length >= r.maxRepeated) {
        throw new Error(`repeated field '${f.name}' exceeds MaxRepeatedCount=${r.maxRepeated}`);
      }
      if (typeof f.kind === "string") {
        arr.push(readScalarValue(r, f.kind));
      } else {
        arr.push(readNestedMessage(r, f.kind.message));
      }
      continue;
    }

    if (typeof f.kind === "string") {
      obj[f.name] = readScalarValue(r, f.kind);
    } else {
      obj[f.name] = readNestedMessage(r, f.kind.message);
    }
  }
  if (r.pos !== end) {
    throw new Error(`message overran expected end (pos=${r.pos}, end=${end})`);
  }
}

function readScalarValue(r: Reader, kind: ScalarKind): unknown {
  switch (kind) {
    case "bool":
      return r.varint() !== 0;
    case "int32": {
      // proto3 int32: read 10-byte-tolerant varint, take low 32 bits as signed.
      const u = r.varintBig();
      return Number(BigInt.asIntN(32, u));
    }
    case "int64": {
      const u = r.varintBig();
      return BigInt.asIntN(64, u);
    }
    case "sint32":
      return r.zigzag32();
    case "sint64":
      return r.zigzag64();
    case "uint32":
      return r.varint();
    case "uint64":
      return r.varintBig();
    case "float":
      return r.float();
    case "double":
      return r.double();
    case "string":
      return r.string();
    case "bytes":
      return r.bytes();
  }
}

function descend(r: Reader): void {
  if (++r.depth > r.maxDepth) {
    throw new Error(`nesting depth exceeds MaxNestingDepth=${r.maxDepth}`);
  }
}

function readNestedMessage(r: Reader, codec: CodecBase): unknown {
  const len = r.varint();
  const end = r.pos + len;
  if (end > r.data.length) throw new Error("nested message exceeds buffer");
  descend(r);
  const obj = codec.create();
  codec.unmarshalFrom(r, end, obj);
  r.depth--;
  return obj;
}

function readMapEntry(
  r: Reader,
  obj: Record<string, unknown>,
  f: FieldSpec,
): void {
  const len = r.varint();
  const end = r.pos + len;
  if (end > r.data.length) throw new Error("map entry exceeds buffer");
  descend(r);

  const keyKind = f.mapKey!;
  let key: unknown = mapKeyZero(keyKind);
  let value: unknown = scalarZero(f.kind);

  while (r.pos < end) {
    const { fieldNumber, wireType } = r.tag();
    if (fieldNumber === 1) {
      key = readScalarValue(r, keyKind);
    } else if (fieldNumber === 2) {
      if (typeof f.kind === "string") {
        value = readScalarValue(r, f.kind);
      } else {
        value = readNestedMessage(r, f.kind.message);
      }
    } else {
      r.skip(wireType);
    }
  }
  if (r.pos !== end) {
    throw new Error(`map entry overran (pos=${r.pos}, end=${end})`);
  }
  r.depth--;

  let target = obj[f.name] as Record<string, unknown> | undefined;
  if (target === undefined) {
    target = {};
    obj[f.name] = target;
  }
  target[String(key)] = value;
}

function mapKeyZero(kind: MapKeyKind): unknown {
  switch (kind) {
    case "bool":
      return false;
    case "int32":
    case "sint32":
    case "uint32":
      return 0;
    case "int64":
    case "sint64":
    case "uint64":
      return 0n;
    case "string":
      return "";
  }
}

function scalarZero(kind: Kind): unknown {
  if (typeof kind !== "string") return null;
  switch (kind) {
    case "bool":
      return false;
    case "int32":
    case "sint32":
    case "uint32":
    case "float":
    case "double":
      return 0;
    case "int64":
    case "sint64":
    case "uint64":
      return 0n;
    case "string":
      return "";
    case "bytes":
      return new Uint8Array();
  }
}
