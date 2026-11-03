// SPDX-License-Identifier: MIT
// Copyright (c) 2026 TrendVidia, LLC.
/**
 * SBE unmarshal: decodes an SBE binary buffer into a proto message using a
 * pre-built MessageTemplate. Mirrors `protowire/encoding/sbe/unmarshal.go`.
 */

import { type DescField, type DescMessage, type MessageShape, ScalarType } from "@bufbuild/protobuf";
import { type ReflectList, type ReflectMessage, reflect } from "@bufbuild/protobuf/reflect";

import { Codec, GROUP_HEADER_SIZE, HEADER_SIZE } from "./sbe.js";

/** A string field holds UTF-8, so a char[] that is not is refused (HARDENING.md § UTF-8).
 * A field carrying another text encoding is declared bytes. */
const strictUtf8 = new TextDecoder("utf-8", { fatal: true });
import type { FieldTemplate, GroupTemplate, MessageTemplate } from "./template.js";

/** MaxMessageSize (HARDENING.md § Mandatory limits), also the default
 * MaxRepeatedCount. */
export const MAX_MESSAGE_SIZE = 64 << 20;

export interface UnmarshalOptions {
  /** Bytes of input a call may read. Default {@link MAX_MESSAGE_SIZE}. */
  readonly maxMessageSize?: number;
  /** Entries of one repeating group. Default {@link MAX_MESSAGE_SIZE}. */
  readonly maxRepeatedCount?: number;
}

export function unmarshal<Desc extends DescMessage>(
  codec: Codec,
  desc: Desc,
  msg: MessageShape<Desc>,
  data: Uint8Array,
  options?: UnmarshalOptions,
): void {
  const max = options?.maxMessageSize ?? MAX_MESSAGE_SIZE;
  if (data.length > max) throw new Error(`sbe: input of ${data.length} bytes exceeds MaxMessageSize=${max}`);
  const tmpl = codec.template(desc.typeName);
  unmarshalMessage(reflect(desc, msg), tmpl, data, options?.maxRepeatedCount ?? MAX_MESSAGE_SIZE);
}

function unmarshalMessage(refl: ReflectMessage, tmpl: MessageTemplate, data: Uint8Array, maxRepeated: number): void {
  if (data.length < HEADER_SIZE) {
    throw new Error(`sbe: data too short for header: ${data.length} bytes`);
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  const blockLength = view.getUint16(0, true);
  const templateId = view.getUint16(2, true);
  if (templateId !== tmpl.templateId) {
    throw new Error(`sbe: template ID mismatch: got ${templateId}, want ${tmpl.templateId}`);
  }

  const end = HEADER_SIZE + blockLength;
  if (data.length < end) {
    throw new Error(`sbe: data too short for root block: need ${end}, have ${data.length}`);
  }

  for (const ft of tmpl.fields) {
    readField(view, data, HEADER_SIZE, ft, refl);
  }

  let pos = end;
  for (const gt of tmpl.groups) {
    pos += unmarshalGroup(view, data, pos, refl, gt, maxRepeated);
  }
}

function readField(
  view: DataView,
  data: Uint8Array,
  base: number,
  ft: FieldTemplate,
  parent: ReflectMessage,
): void {
  if (ft.composite.length > 0) {
    // Build a fresh sub-message and assign it on the parent.
    const sub = createMessage(ft.fd);
    for (const sf of ft.composite) {
      readField(view, data, base + ft.offset, sf, sub);
    }
    parent.set(ft.fd, sub);
    return;
  }

  const fd = ft.fd;
  const off = base + ft.offset;

  switch (ft.encoding) {
    case "int8":
      setIntField(parent, fd, view.getInt8(off));
      return;
    case "int16":
      setIntField(parent, fd, view.getInt16(off, true));
      return;
    case "int32":
      setIntField(parent, fd, view.getInt32(off, true));
      return;
    case "int64":
      setInt64Field(parent, fd, view.getBigInt64(off, true));
      return;
    case "uint8":
      setUintField(parent, fd, view.getUint8(off));
      return;
    case "uint16":
      setUintField(parent, fd, view.getUint16(off, true));
      return;
    case "uint32":
      setUintField(parent, fd, view.getUint32(off, true));
      return;
    case "uint64":
      setUint64Field(parent, fd, view.getBigUint64(off, true));
      return;
    case "float":
      parent.set(fd, view.getFloat32(off, true));
      return;
    case "double":
      parent.set(fd, view.getFloat64(off, true));
      return;
    case "char": {
      const slice = data.subarray(off, off + ft.size);
      if (fd.fieldKind === "scalar" && fd.scalar === ScalarType.BYTES) {
        // Copy so caller buffer can be reused.
        parent.set(fd, new Uint8Array(slice));
      } else {
        // STRING — trim trailing null padding.
        let n = slice.length;
        while (n > 0 && slice[n - 1] === 0) n--;
        let text: string;
        try {
          text = strictUtf8.decode(slice.subarray(0, n));
        } catch {
          throw new Error(`sbe: invalid UTF-8 in string field ${fd.name}`);
        }
        parent.set(fd, text);
      }
      return;
    }
    case "":
      throw new Error(`sbe: composite field ${fd.name} has no encoding`);
  }
}

function unmarshalGroup(
  view: DataView,
  data: Uint8Array,
  pos: number,
  parent: ReflectMessage,
  gt: GroupTemplate,
  maxRepeated: number,
): number {
  if (data.length < pos + GROUP_HEADER_SIZE) {
    throw new Error(`sbe: data too short for group header`);
  }
  const blockLength = view.getUint16(pos, true);
  const numInGroup = view.getUint16(pos + 2, true);
  if (numInGroup > maxRepeated) {
    throw new Error(`sbe: group count ${numInGroup} exceeds MaxRepeatedCount=${maxRepeated}`);
  }

  const total = GROUP_HEADER_SIZE + numInGroup * blockLength;
  if (data.length < pos + total) {
    throw new Error(
      `sbe: data too short for group entries: need ${pos + total}, have ${data.length}`,
    );
  }

  const list = parent.get(gt.fd) as ReflectList<unknown>;
  for (let i = 0; i < numInGroup; i++) {
    const entry = createMessage(gt.fd);
    const start = pos + GROUP_HEADER_SIZE + i * blockLength;
    for (const ft of gt.fields) {
      readField(view, data, start, ft, entry);
    }
    list.add(entry);
  }

  return total;
}

function createMessage(fd: DescField): ReflectMessage {
  if (fd.fieldKind !== "message" && !(fd.fieldKind === "list" && fd.listKind === "message")) {
    throw new Error(`sbe: cannot create sub-message for field ${fd.name}`);
  }
  // For both single message fields and message-list element types, the
  // descriptor is `fd.message`.
  const desc: DescMessage = (fd as { message: DescMessage }).message;
  return reflect(desc);
}

function setIntField(parent: ReflectMessage, fd: DescField, v: number): void {
  if (fd.fieldKind !== "scalar") {
    throw new Error(`sbe: setIntField on non-scalar ${fd.name}`);
  }
  switch (fd.scalar) {
    case ScalarType.INT64:
    case ScalarType.SINT64:
    case ScalarType.SFIXED64:
      parent.set(fd, BigInt(v));
      return;
    default:
      parent.set(fd, v);
  }
}

function setInt64Field(parent: ReflectMessage, fd: DescField, v: bigint): void {
  if (fd.fieldKind === "scalar") {
    switch (fd.scalar) {
      case ScalarType.INT32:
      case ScalarType.SINT32:
      case ScalarType.SFIXED32:
        parent.set(fd, Number(v));
        return;
    }
  }
  parent.set(fd, v);
}

function setUintField(parent: ReflectMessage, fd: DescField, v: number): void {
  if (fd.fieldKind === "enum") {
    parent.set(fd, v);
    return;
  }
  if (fd.fieldKind !== "scalar") {
    throw new Error(`sbe: setUintField on non-scalar ${fd.name}`);
  }
  switch (fd.scalar) {
    case ScalarType.BOOL:
      parent.set(fd, v !== 0);
      return;
    case ScalarType.UINT64:
    case ScalarType.FIXED64:
      parent.set(fd, BigInt(v));
      return;
    default:
      parent.set(fd, v);
  }
}

function setUint64Field(parent: ReflectMessage, fd: DescField, v: bigint): void {
  if (fd.fieldKind === "scalar") {
    switch (fd.scalar) {
      case ScalarType.UINT32:
      case ScalarType.FIXED32:
        parent.set(fd, Number(v));
        return;
    }
  }
  parent.set(fd, v);
}
