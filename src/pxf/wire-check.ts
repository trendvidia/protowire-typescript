// SPDX-License-Identifier: MIT
// Copyright (c) 2026 TrendVidia, LLC.
/**
 * Reads PB bytes by a message's descriptor and refuses what protobuf-go
 * refuses, before `@bufbuild/protobuf`'s `fromBinary` reads them (#125).
 *
 * `fromBinary` reads a value without checking it against where its message
 * ends, so a value cut short is read from the bytes after it: `0a01` as an
 * `int64` gives 1, and a packed list or a submessage takes bytes that belong
 * to its parent. It also takes a varint whose tenth byte overflows. protobuf-go
 * refuses all of these, and wire types 6 and 7, a stray end-group and a field
 * number past 2^29-1 as well (trendvidia/protowire#614).
 *
 * The walk skips every field it does not read into with {@link Reader.skip},
 * which follows protobuf-go's `protowire.ConsumeFieldValue`. It reads into each
 * submessage, group and map entry the descriptor names, and checks the
 * elements of a packed list by their wire type. It reads into nothing else: a
 * string or bytes field whose content would not parse as a message is not a
 * message.
 *
 * It only refuses. Where `fromBinary` refuses what protobuf-go accepts, such as
 * an `int64` sent as `0a0101`, the walk passes the bytes and `fromBinary` still
 * refuses them.
 */

import { type DescField, type DescMessage, type MessageShape, ScalarType, fromBinary } from "@bufbuild/protobuf";

import { Reader, WireType } from "../pb/wire.js";

/** `protowire.MaxValidNumber`: protobuf-go refuses a larger field number. */
const MAX_VALID_NUMBER = 0x1fff_ffff;

/** `protowire.DefaultRecursionLimit`, how deep protobuf-go's `proto.Unmarshal` reads. */
export const PROTOBUF_GO_RECURSION_LIMIT = 10000;

/** A message being read. */
interface Frame {
  /** The message's descriptor; for a map entry, the map field's value message, if any. */
  readonly desc: DescMessage | undefined;
  /** The map field, when this is one of its entries. */
  readonly map: MapField | undefined;
  /** Where its bytes end. */
  readonly end: number;
  /** The group's field number, or 0 when the message is length-delimited. */
  readonly group: number;
}

type MapField = Extract<DescField, { fieldKind: "map" }>;

const byNumber = new WeakMap<DescMessage, Map<number, DescField>>();

function field(desc: DescMessage, num: number): DescField | undefined {
  let m = byNumber.get(desc);
  if (m === undefined) {
    m = new Map(desc.fields.map((f) => [f.number, f]));
    byNumber.set(desc, m);
  }
  return m.get(num);
}

/** The wire type a scalar is written with. */
function scalarWireType(t: ScalarType): WireType {
  switch (t) {
    case ScalarType.DOUBLE:
    case ScalarType.FIXED64:
    case ScalarType.SFIXED64:
      return WireType.Fixed64;
    case ScalarType.FLOAT:
    case ScalarType.FIXED32:
    case ScalarType.SFIXED32:
      return WireType.Fixed32;
    case ScalarType.STRING:
    case ScalarType.BYTES:
      return WireType.LengthDelimited;
    default:
      return WireType.Varint;
  }
}

/** What a tag of `wireType` on field `fd` is read into, if anything. */
type Into =
  | { readonly kind: "message"; readonly desc: DescMessage; readonly group: boolean }
  | { readonly kind: "entry"; readonly map: MapField }
  | { readonly kind: "packed"; readonly element: WireType };

function into(cur: Frame, num: number, wireType: WireType): Into | undefined {
  if (cur.map !== undefined) {
    // A map entry: only a message value (field 2) is read into.
    if (num === 2 && cur.desc !== undefined && wireType === WireType.LengthDelimited) {
      return { kind: "message", desc: cur.desc, group: false };
    }
    return undefined;
  }
  const fd = cur.desc === undefined ? undefined : field(cur.desc, num);
  if (fd === undefined) return undefined;
  switch (fd.fieldKind) {
    case "message":
      return messageInto(fd.message, fd.delimitedEncoding, wireType);
    case "list":
      if (fd.listKind === "message") return messageInto(fd.message, fd.delimitedEncoding, wireType);
      if (wireType !== WireType.LengthDelimited) return undefined;
      {
        const element = fd.listKind === "enum" ? WireType.Varint : scalarWireType(fd.scalar);
        // A string or bytes element is length-delimited itself, not packed.
        return element === WireType.LengthDelimited ? undefined : { kind: "packed", element };
      }
    case "map":
      return wireType === WireType.LengthDelimited ? { kind: "entry", map: fd } : undefined;
    default:
      return undefined;
  }
}

function messageInto(desc: DescMessage, delimited: boolean, wireType: WireType): Into | undefined {
  // A group is read from a start-group tag, any other message from a
  // length-delimited one. Another wire type is an unknown field.
  if (wireType !== (delimited ? WireType.StartGroup : WireType.LengthDelimited)) return undefined;
  return { kind: "message", desc, group: delimited };
}

/**
 * Undefined when `data` holds nothing protobuf-go refuses as `desc`, or why it
 * does, in protowire-go's words, such as `corrupt field 3 in map entry: proto:
 * cannot parse reserved wire type`.
 *
 * `maxDepth` is the deepest the walk reads: one descent for each submessage,
 * group and map entry. Below it a message is skipped unread, so it is the
 * limit of the reader that reads the bytes next, or larger. The walk keeps the
 * messages it is in on a list, not on the call stack.
 */
export function checkWire(desc: DescMessage, data: Uint8Array, maxDepth: number): string | undefined {
  const r = new Reader(data);
  const open: Frame[] = [];
  let cur: Frame = { desc, map: undefined, end: data.length, group: 0 };
  for (;;) {
    if (r.pos === cur.end) {
      if (cur.group !== 0) return corrupt(cur.group, open[open.length - 1]!, "unexpected EOF");
      const up = open.pop();
      if (up === undefined) return undefined;
      cur = up;
      continue;
    }

    // protowire.ConsumeTag, then the field number check protobuf-go makes in
    // a message and in a map entry.
    let num: number;
    let wireType: WireType;
    const b = data[r.pos]!;
    if (b < 0x80) {
      // A one-byte tag, the common case, read without a bigint.
      r.pos++;
      num = b >> 3;
      wireType = (b & 7) as WireType;
    } else {
      const at = r.pos;
      try {
        r.skip(WireType.Varint, 0, cur.end);
      } catch {
        return corruptTag(cur);
      }
      r.pos = at;
      const tag = r.varintBig();
      num = Number(tag >> 3n);
      wireType = Number(tag & 7n) as WireType;
    }
    if (num < 1 || num > MAX_VALID_NUMBER) return corruptTag(cur);

    if (wireType === WireType.EndGroup && num === cur.group) {
      cur = open.pop()!;
      continue;
    }

    const next = open.length < maxDepth ? into(cur, num, wireType) : undefined;
    if (next?.kind === "message" && next.group) {
      open.push(cur);
      cur = { desc: next.desc, map: undefined, end: cur.end, group: num };
      continue;
    }
    const start = r.pos;
    try {
      // The skip checks the value and finds where it ends, whether or not it
      // is read into.
      r.skip(wireType, num, cur.end);
      if (next === undefined) continue;
      const end = r.pos;
      r.pos = start;
      r.varint(); // the length, which the skip has checked
      if (next.kind === "packed") {
        while (r.pos < end) r.skip(next.element, num, end);
        continue;
      }
      open.push(cur);
      cur =
        next.kind === "entry"
          ? { desc: next.map.mapKind === "message" ? next.map.message : undefined, map: next.map, end, group: 0 }
          : { desc: next.desc, map: undefined, end, group: 0 };
    } catch (e) {
      return corrupt(num, cur, e instanceof Error ? e.message : String(e));
    }
  }
}

/** `checkWire`, then `fromBinary`: protobuf-go's verdict where it refuses. */
export function fromBinaryChecked<Desc extends DescMessage>(
  desc: Desc,
  data: Uint8Array,
  maxDepth: number,
): MessageShape<Desc> {
  const err = checkWire(desc, data, maxDepth);
  if (err !== undefined) throw new Error(err);
  return fromBinary(desc, data);
}

// protowire-go's pb texts: `corrupt field %d%s: %v` and `corrupt tag%s`.
function corrupt(num: number, where: Frame, cause: string): string {
  return `corrupt field ${num}${where.map !== undefined ? " in map entry" : ""}: ${cause}`;
}

function corruptTag(where: Frame): string {
  return where.map !== undefined ? "corrupt tag in map entry" : "corrupt tag";
}
