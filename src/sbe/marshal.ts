/**
 * SBE marshal: serializes a proto message into the SBE binary format using a
 * pre-built MessageTemplate. Mirrors `protowire/encoding/sbe/marshal.go`.
 */

import { type DescField, type DescMessage, type MessageShape, ScalarType } from "@bufbuild/protobuf";
import { type ReflectList, type ReflectMessage, reflect } from "@bufbuild/protobuf/reflect";

import { Codec, GROUP_HEADER_SIZE, HEADER_SIZE } from "./sbe.js";
import type { FieldTemplate, GroupTemplate, MessageTemplate } from "./template.js";

export function marshal<Desc extends DescMessage>(
  codec: Codec,
  desc: Desc,
  msg: MessageShape<Desc>,
): Uint8Array {
  const tmpl = codec.template(desc.typeName);
  return marshalMessage(reflect(desc, msg), tmpl);
}

function marshalMessage(refl: ReflectMessage, tmpl: MessageTemplate): Uint8Array {
  let total = HEADER_SIZE + tmpl.blockLength;
  for (const gt of tmpl.groups) {
    const list = refl.get(gt.fd) as ReflectList<unknown>;
    total += GROUP_HEADER_SIZE + list.size * gt.blockLength;
  }

  const buf = new Uint8Array(total);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  view.setUint16(0, tmpl.blockLength, true);
  view.setUint16(2, tmpl.templateId, true);
  view.setUint16(4, tmpl.schemaId, true);
  view.setUint16(6, tmpl.version, true);

  for (const ft of tmpl.fields) {
    writeField(view, HEADER_SIZE, ft, refl);
  }

  let pos = HEADER_SIZE + tmpl.blockLength;
  for (const gt of tmpl.groups) {
    pos += marshalGroup(view, pos, refl, gt);
  }

  return buf;
}

function writeField(
  view: DataView,
  base: number,
  ft: FieldTemplate,
  refl: ReflectMessage,
): void {
  if (ft.composite.length > 0) {
    const sub = refl.get(ft.fd) as ReflectMessage;
    for (const sf of ft.composite) {
      writeField(view, base + ft.offset, sf, sub);
    }
    return;
  }

  const fd = ft.fd;
  const off = base + ft.offset;
  const raw = refl.get(fd);

  switch (ft.encoding) {
    case "int8":
      view.setInt8(off, intToNumber(raw));
      return;
    case "int16":
      view.setInt16(off, intToNumber(raw), true);
      return;
    case "int32":
      view.setInt32(off, intToNumber(raw), true);
      return;
    case "int64":
      view.setBigInt64(off, toBigInt(raw), true);
      return;
    case "uint8":
      view.setUint8(off, uintToNumber(fd, raw));
      return;
    case "uint16":
      view.setUint16(off, uintToNumber(fd, raw), true);
      return;
    case "uint32":
      view.setUint32(off, uintToNumber(fd, raw), true);
      return;
    case "uint64":
      view.setBigUint64(off, toBigUint(fd, raw), true);
      return;
    case "float":
      view.setFloat32(off, Number(raw), true);
      return;
    case "double":
      view.setFloat64(off, Number(raw), true);
      return;
    case "char": {
      const bytes = toCharBytes(fd, raw);
      const len = Math.min(bytes.length, ft.size);
      const dst = new Uint8Array(view.buffer, view.byteOffset + off, ft.size);
      dst.set(bytes.subarray(0, len));
      // Remaining bytes already zero (allocator initialized).
      return;
    }
    case "":
      throw new Error(`sbe: composite field ${fd.name} has no encoding`);
  }
}

function marshalGroup(
  view: DataView,
  pos: number,
  parent: ReflectMessage,
  gt: GroupTemplate,
): number {
  const list = parent.get(gt.fd) as ReflectList<unknown>;
  const n = list.size;

  view.setUint16(pos, gt.blockLength, true);
  view.setUint16(pos + 2, n, true);

  for (let i = 0; i < n; i++) {
    const entry = list.get(i) as ReflectMessage;
    const start = pos + GROUP_HEADER_SIZE + i * gt.blockLength;
    for (const ft of gt.fields) {
      writeField(view, start, ft, entry);
    }
  }

  return GROUP_HEADER_SIZE + n * gt.blockLength;
}

function intToNumber(raw: unknown): number {
  if (typeof raw === "bigint") return Number(raw);
  return Number(raw);
}

function uintToNumber(fd: DescField, raw: unknown): number {
  if (fd.fieldKind === "scalar" && fd.scalar === ScalarType.BOOL) {
    return raw ? 1 : 0;
  }
  if (typeof raw === "bigint") return Number(raw);
  return Number(raw);
}

function toBigInt(raw: unknown): bigint {
  if (typeof raw === "bigint") return raw;
  return BigInt(Number(raw));
}

function toBigUint(fd: DescField, raw: unknown): bigint {
  if (fd.fieldKind === "scalar" && fd.scalar === ScalarType.BOOL) {
    return raw ? 1n : 0n;
  }
  if (typeof raw === "bigint") return raw;
  return BigInt(Number(raw));
}

function toCharBytes(fd: DescField, raw: unknown): Uint8Array {
  if (fd.fieldKind === "scalar" && fd.scalar === ScalarType.BYTES) {
    return raw instanceof Uint8Array ? raw : new Uint8Array(0);
  }
  return new TextEncoder().encode(typeof raw === "string" ? raw : "");
}
