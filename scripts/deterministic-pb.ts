// SPDX-License-Identifier: MIT
// Copyright (c) 2026 TrendVidia, LLC.
// A deterministic protobuf writer for check-decode's pxf-pb mode: fields in
// number order, map entries in key order, as protobuf-go's Deterministic
// option writes them. protobuf-es keeps a map's JavaScript key order, which
// puts integer-like keys first, so the write gate cannot rely on toBinary.

import { type DescField, type DescMessage, type Message, ScalarType } from "@bufbuild/protobuf";
import { type ReflectList, type ReflectMap, type ReflectMessage, reflect } from "@bufbuild/protobuf/reflect";
import { BinaryWriter, WireType } from "@bufbuild/protobuf/wire";

const VARINT = new Set([
  ScalarType.INT32, ScalarType.INT64, ScalarType.UINT32, ScalarType.UINT64,
  ScalarType.SINT32, ScalarType.SINT64, ScalarType.BOOL,
]);
const FIXED64 = new Set([ScalarType.FIXED64, ScalarType.SFIXED64, ScalarType.DOUBLE]);
const FIXED32 = new Set([ScalarType.FIXED32, ScalarType.SFIXED32, ScalarType.FLOAT]);

function wireType(t: ScalarType): WireType {
  if (VARINT.has(t)) return WireType.Varint;
  if (FIXED64.has(t)) return WireType.Bit64;
  if (FIXED32.has(t)) return WireType.Bit32;
  return WireType.LengthDelimited;
}

function scalar(w: BinaryWriter, t: ScalarType, v: unknown): void {
  switch (t) {
    case ScalarType.DOUBLE: w.double(v as number); break;
    case ScalarType.FLOAT: w.float(v as number); break;
    case ScalarType.INT64: w.int64(v as bigint); break;
    case ScalarType.UINT64: w.uint64(v as bigint); break;
    case ScalarType.INT32: w.int32(v as number); break;
    case ScalarType.FIXED64: w.fixed64(v as bigint); break;
    case ScalarType.FIXED32: w.fixed32(v as number); break;
    case ScalarType.BOOL: w.bool(v as boolean); break;
    case ScalarType.STRING: w.string(v as string); break;
    case ScalarType.BYTES: w.bytes(v as Uint8Array); break;
    case ScalarType.UINT32: w.uint32(v as number); break;
    case ScalarType.SFIXED32: w.sfixed32(v as number); break;
    case ScalarType.SFIXED64: w.sfixed64(v as bigint); break;
    case ScalarType.SINT32: w.sint32(v as number); break;
    case ScalarType.SINT64: w.sint64(v as bigint); break;
  }
}

function compareKeys(a: unknown, b: unknown): number {
  if (typeof a === "string" && typeof b === "string") {
    const x = Buffer.from(a), y = Buffer.from(b);
    return Buffer.compare(x, y);
  }
  if (typeof a === "boolean") return Number(a) - Number(b as boolean);
  const x = BigInt(a as number | bigint), y = BigInt(b as number | bigint);
  return x < y ? -1 : x > y ? 1 : 0;
}

function writeMessage(w: BinaryWriter, m: ReflectMessage): void {
  const fields = [...m.desc.fields].sort((a, b) => a.number - b.number);
  for (const fd of fields) {
    // -0 has its sign bit set, so protobuf writes it, where isSet sees a zero.
    const negZero = fd.fieldKind === "scalar" && Object.is(m.get(fd), -0);
    if (!m.isSet(fd) && !negZero) continue;
    writeField(w, fd, m);
  }
  for (const u of (m.message as { $unknown?: { no: number; wireType: WireType; data: Uint8Array }[] }).$unknown ?? []) {
    w.tag(u.no, u.wireType).raw(u.data);
  }
}

function writeSub(w: BinaryWriter, no: number, delimited: boolean, sub: ReflectMessage): void {
  if (delimited) {
    w.tag(no, WireType.StartGroup);
    writeMessage(w, sub);
    w.tag(no, WireType.EndGroup);
    return;
  }
  w.tag(no, WireType.LengthDelimited).fork();
  writeMessage(w, sub);
  w.join();
}

function writeField(w: BinaryWriter, fd: DescField, m: ReflectMessage): void {
  switch (fd.fieldKind) {
    case "scalar":
      w.tag(fd.number, wireType(fd.scalar));
      scalar(w, fd.scalar, m.get(fd));
      return;
    case "enum":
      w.tag(fd.number, WireType.Varint).int32(m.get(fd) as number);
      return;
    case "message":
      writeSub(w, fd.number, fd.delimitedEncoding, m.get(fd) as ReflectMessage);
      return;
    case "list": {
      const list = m.get(fd) as ReflectList;
      if (fd.listKind === "message") {
        for (const el of list) writeSub(w, fd.number, fd.delimitedEncoding, el as ReflectMessage);
        return;
      }
      const t = fd.listKind === "enum" ? ScalarType.INT32 : fd.scalar!;
      if (fd.packed) {
        w.tag(fd.number, WireType.LengthDelimited).fork();
        for (const v of list) scalar(w, t, v);
        w.join();
        return;
      }
      for (const v of list) {
        w.tag(fd.number, wireType(t));
        scalar(w, t, v);
      }
      return;
    }
    case "map": {
      const map = m.get(fd) as ReflectMap;
      const entries = [...map].sort((a, b) => compareKeys(a[0], b[0]));
      for (const [k, v] of entries) {
        w.tag(fd.number, WireType.LengthDelimited).fork();
        w.tag(1, wireType(fd.mapKey));
        scalar(w, fd.mapKey, k);
        if (fd.mapKind === "message") {
          w.tag(2, WireType.LengthDelimited).fork();
          writeMessage(w, v as ReflectMessage);
          w.join();
        } else if (fd.mapKind === "enum") {
          w.tag(2, WireType.Varint).int32(v as number);
        } else {
          w.tag(2, wireType(fd.scalar));
          scalar(w, fd.scalar, v);
        }
        w.join();
      }
      return;
    }
  }
}

/** `message` as protobuf-go's deterministic Marshal writes it. */
export function deterministicBinary(desc: DescMessage, message: Message): Uint8Array {
  const w = new BinaryWriter();
  writeMessage(w, reflect(desc, message));
  return w.finish();
}
