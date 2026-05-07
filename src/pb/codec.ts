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
 *   - repeated fields: one tag+value per element (non-packed).
 *
 * Maps follow the proto3 spec: `repeated MapEntry { key = 1; value = 2; }`.
 */

import { Reader, Writer, WireType } from "./wire.js";

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
  unmarshal(data: Uint8Array): T;
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
    unmarshal(data) {
      const r = new Reader(data);
      const obj = create();
      unmarshalMessageFrom(r, data.length, obj, this);
      return obj;
    },
  };
  return codec;
}

export function marshal<T>(value: T, codec: MessageCodec<T>): Uint8Array {
  return codec.marshal(value);
}

export function unmarshal<T>(data: Uint8Array, codec: MessageCodec<T>): T {
  return codec.unmarshal(data);
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
    if (!isZero(keyKind, key)) {
      inner.tag(1, wireTypeOf(keyKind));
      writeScalarValue(inner, keyKind, key);
    }
    if (valueIsMessage) {
      if (val !== undefined && val !== null) {
        inner.tag(2, WireType.LengthDelimited);
        writeNestedMessage(inner, (f.kind as { message: CodecBase }).message, val);
      }
    } else {
      const sk = f.kind as ScalarKind;
      if (!isZero(sk, val)) {
        inner.tag(2, wireTypeOf(sk));
        writeScalarValue(inner, sk, val);
      }
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

  while (r.pos < end) {
    const { fieldNumber, wireType } = r.tag();
    const f = codec.byNumber.get(fieldNumber);
    if (f === undefined) {
      r.skip(wireType);
      continue;
    }

    if (f.mapKey !== undefined) {
      readMapEntry(r, obj, f);
      continue;
    }

    if (f.repeated) {
      const arr = obj[f.name] as unknown[];
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

function readNestedMessage(r: Reader, codec: CodecBase): unknown {
  const len = r.varint();
  const end = r.pos + len;
  if (end > r.data.length) throw new Error("nested message exceeds buffer");
  const obj = codec.create();
  codec.unmarshalFrom(r, end, obj);
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
