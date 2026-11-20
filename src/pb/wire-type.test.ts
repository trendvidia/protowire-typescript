// SPDX-License-Identifier: MIT
// Copyright (c) 2026 TrendVidia, LLC.
/**
 * A tag's wire type, against protobuf-go (#120, protowire#614).
 *
 * A PB decoder does what protobuf does with a tag's wire type: it rejects wire
 * type 6 or 7 on any field, and handles a known field whose wire type does not
 * match its type as an unknown field, skipped by its wire type with the field
 * left as it was. The decoder used to read a known field by its kind whatever
 * the wire type said, so `0a01` on an int64 read the length byte as the value
 * 1, and `0e01` read wire type 6 as a varint.
 *
 * The oracle is testdata/wiretype-go.tsv, written by scripts/go-wiretype: the
 * inputs of protowire-go's encoding/pb/wire_type_test.go, every wire type on
 * every field of its conformance message, well formed and cut short, alone and
 * inside each message and map field, and the same records inside the
 * big-number messages. Each input must get protobuf-go's verdict. On accept,
 * the bytes protobuf-go writes for what it read, unknown fields dropped, must
 * decode here to what the input decoded to. On reject, where protowire-go's
 * error is a skip's, this port's error ends in the same words.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  BigFloatCodec,
  BigFloatValueCodec,
  BigIntValueCodec,
  DecimalCodec,
  DecimalValueCodec,
  type MessageCodec,
  defineMessage,
  unmarshal,
} from "./index.js";

const here = dirname(fileURLToPath(import.meta.url));

interface Row {
  hex: string;
  accept: boolean;
  known: string;
  goError: string;
}

function table(): Map<string, Row[]> {
  const out = new Map<string, Row[]>();
  let section: Row[] = [];
  for (const line of readFileSync(resolve(here, "testdata/wiretype-go.tsv"), "utf8").split("\n")) {
    if (line === "" || line.startsWith("#")) continue;
    if (line.startsWith("@ ")) {
      section = [];
      out.set(line.slice(2), section);
      continue;
    }
    const [hex, verdict, known, goError] = line.split("\t");
    section.push({ hex: hex!, accept: verdict === "accept", known: known!, goError: goError! });
  }
  return out;
}

const rows = table();

function bytes(hex: string): Uint8Array {
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

// conf.proto's Inner and All, as protowire-go's conformance_test.go has them.
interface Inner {
  name: string;
  n: bigint;
}

const InnerPb = defineMessage<Inner>({
  fields: [
    { number: 1, name: "name", kind: "string" },
    { number: 2, name: "n", kind: "int64" },
  ],
  create: () => ({ name: "", n: 0n }),
});

const inner = { message: InnerPb };

const AllPb = defineMessage<Record<string, unknown>>({
  fields: [
    { number: 1, name: "s", kind: "string" },
    { number: 2, name: "i64", kind: "int64" },
    { number: 3, name: "i32", kind: "int32" },
    { number: 4, name: "u64", kind: "uint64" },
    { number: 5, name: "u32", kind: "uint32" },
    { number: 6, name: "z64", kind: "sint64" },
    { number: 7, name: "z32", kind: "sint32" },
    { number: 8, name: "b", kind: "bool" },
    { number: 9, name: "f64", kind: "double" },
    { number: 10, name: "f32", kind: "float" },
    { number: 11, name: "buf", kind: "bytes" },
    { number: 12, name: "inner", kind: inner },
    { number: 13, name: "list", kind: inner, repeated: true },
    { number: 14, name: "nums", kind: "uint32", repeated: true },
    { number: 15, name: "zigs", kind: "sint64", repeated: true },
    { number: 16, name: "reals", kind: "float", repeated: true },
    { number: 17, name: "strs", kind: "string", repeated: true },
    { number: 18, name: "m", kind: "int64", mapKey: "string" },
    { number: 19, name: "mm", kind: inner, mapKey: "int32" },
    { number: 20, name: "a", kind: "string" },
    { number: 21, name: "c", kind: "int64" },
    { number: 22, name: "d", kind: inner },
    { number: 23, name: "flags", kind: "bool", repeated: true },
    { number: 24, name: "negs", kind: "int64", repeated: true },
    { number: 25, name: "bm", kind: "bool", mapKey: "bool" },
  ],
  // Every singular field at its zero, so a field read as zero and one not
  // read at all compare alike, as proto3 has them.
  create: () => ({
    s: "", i64: 0n, i32: 0, u64: 0n, u32: 0, z64: 0n, z32: 0, b: false, f64: 0, f32: 0,
    buf: new Uint8Array(), a: "", c: 0n,
  }),
});

/**
 * A map entry with a key and no message value reads here as null, where
 * protobuf-go reads an empty message (#123, protowire-go#307). That is not a
 * wire type's doing, so it is evened out here; this goes when #123 is fixed.
 */
function emptyMapMessages(m: Record<string, unknown>): Record<string, unknown> {
  const mm = m.mm as Record<string, unknown>;
  for (const k of Object.keys(mm)) if (mm[k] === null) mm[k] = InnerPb.create();
  return m;
}

/** The skip's part of protowire-go's error: "corrupt field 3 in map entry: unexpected EOF". */
function skipError(goError: string): string | undefined {
  const at = goError.indexOf("corrupt field ");
  return at < 0 ? undefined : goError.slice(at);
}

function check(
  section: string,
  codec: MessageCodec<unknown>,
  normalise: (v: never) => unknown = (v) => v,
  normaliseWant: (v: never) => unknown = (v) => v,
): void {
  const cases = rows.get(section)!;
  let accepted = 0;
  let rejected = 0;
  let sameWords = 0;
  for (const row of cases) {
    let got: unknown;
    let error: unknown;
    try {
      got = unmarshal(bytes(row.hex), codec);
    } catch (e) {
      error = e;
    }
    if (!row.accept) {
      rejected++;
      expect(error, `${row.hex}: protobuf-go rejects it`).toBeInstanceOf(Error);
      const words = skipError(row.goError);
      if (words !== undefined && error instanceof Error) {
        expect(error.message, `${row.hex}: protowire-go says ${row.goError}`).toMatch(new RegExp(`${escape(words)}$`));
        sameWords++;
      }
      continue;
    }
    accepted++;
    expect(error, `${row.hex}: protobuf-go accepts it`).toBeUndefined();
    const want = normaliseWant(unmarshal(bytes(row.known), codec) as never);
    expect(normalise(got as never), `${row.hex}: values differ from protobuf-go's (${row.known})`).toEqual(want);
  }
  // A positive marker that both verdicts, and the error text, were exercised.
  console.log(`${section}: ${cases.length} inputs, protobuf-go accepts ${accepted}, rejects ${rejected}; ${sameWords} errors in protowire-go's words`);
  expect(accepted).toBeGreaterThan(100);
  expect(rejected).toBeGreaterThan(100);
  expect(sameWords).toBeGreaterThan(100);
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("a tag's wire type, as protobuf-go reads it (testdata/wiretype-go.tsv)", () => {
  it("every wire type on every field of conf.All", () => {
    expect(rows.get("All")).toHaveLength(608);
    check("All", AllPb as MessageCodec<unknown>, emptyMapMessages as (v: never) => unknown);
  });

  // BigNums{i: BigInt, d: Decimal, f: BigFloat}, through both shapes the
  // port binds them to.
  it("every wire type inside the big-number messages, read into fields", () => {
    const codec = defineMessage({
      fields: [
        { number: 1, name: "i", kind: { message: BigIntValueCodec } },
        { number: 2, name: "d", kind: { message: DecimalCodec } },
        { number: 3, name: "f", kind: { message: BigFloatCodec } },
      ],
    });
    expect(rows.get("BigNums")).toHaveLength(420);
    // A field read as zero and one not read at all compare alike.
    const zeros = (v: { d?: object; f?: object }): unknown => ({
      ...v,
      ...(v.d && { d: { unscaled: new Uint8Array(), scale: 0, negative: false, ...v.d } }),
      ...(v.f && { f: { mantissa: new Uint8Array(), exponent: 0, prec: 0, negative: false, ...v.f } }),
    });
    check("BigNums", codec as MessageCodec<unknown>, zeros as (v: never) => unknown, zeros as (v: never) => unknown);
  });

  it("every wire type inside the big-number messages, read into values", () => {
    const codec = defineMessage({
      fields: [
        { number: 1, name: "i", kind: { message: BigIntValueCodec } },
        { number: 2, name: "d", kind: { message: DecimalValueCodec } },
        { number: 3, name: "f", kind: { message: BigFloatValueCodec } },
      ],
    });
    check("BigNums", codec as MessageCodec<unknown>);
  });
});

// The rows of #120's table, by name, with protowire-go v1.19.0's error.
describe("the rows of #120", () => {
  const I64 = defineMessage<{ v: bigint }>({ fields: [{ number: 1, name: "v", kind: "int64" }], create: () => ({ v: 0n }) });
  const Str = defineMessage<{ v: string }>({ fields: [{ number: 1, name: "v", kind: "string" }], create: () => ({ v: "" }) });
  const cases: [string, string, MessageCodec<{ v: unknown }>, string | null][] = [
    ["int64, wire type 6", "0e01", I64, "corrupt field 1: proto: cannot parse reserved wire type"],
    ["string, wire type 7", "0f0161", Str, "corrupt field 1: proto: cannot parse reserved wire type"],
    ["string, wire type 6", "0e0161", Str, "corrupt field 1: proto: cannot parse reserved wire type"],
    ["int64 sent as wire type 2", "0a0101", I64, null],
    ["int64 sent as wire type 5", "0d01000000", I64, null],
    ["string sent as wire type 0", "0801", Str, null],
    ["int64 as wire type 2, cut short", "0a01", I64, "corrupt field 1: unexpected EOF"],
    ["int64 as wire type 5, cut short", "0d01", I64, "corrupt field 1: unexpected EOF"],
  ];
  for (const [name, hex, codec, error] of cases) {
    it(name, () => {
      if (error !== null) {
        expect(() => unmarshal(bytes(hex), codec)).toThrow(error);
        return;
      }
      expect(unmarshal(bytes(hex), codec).v).toBe(codec === I64 ? 0n : "");
    });
  }
});

describe("a skipped field", () => {
  it("is not touched: an absent field stays absent and a list gets no element", () => {
    const codec = defineMessage<{ p?: bigint; l: string[]; kept?: string }>({
      fields: [
        { number: 1, name: "p", kind: "int64" },
        { number: 2, name: "l", kind: "string", repeated: true },
        { number: 3, name: "kept", kind: "string" },
      ],
    });
    const m = unmarshal(bytes("0d01000000" + "1001" + "1a0161"), codec);
    expect(m).toEqual({ l: [], kept: "a" });
  });

  it("does not undo a value already read", () => {
    const codec = defineMessage<{ v: bigint }>({ fields: [{ number: 1, name: "v", kind: "int64" }] });
    expect(unmarshal(bytes("0807" + "0a0101"), codec).v).toBe(7n);
  });
});

// protobuf-go's protowire.ConsumeFieldValue follows 10001 nested groups and
// refuses 10002 (DefaultRecursionLimit, 10000, counts from 0), measured in Go
// for protowire-cpp#186. A skip follows them with a list, not by recursion.
describe("nested groups", () => {
  const codec = defineMessage<{ v: bigint }>({ fields: [{ number: 1, name: "v", kind: "int64" }] });
  const nested = (n: number): Uint8Array => {
    const out = new Uint8Array(2 * n + 2);
    out.fill(0x7b, 0, n); // field 15, start group
    out.fill(0x7c, n, 2 * n); // field 15, end group
    out.set([0x08, 0x05], 2 * n); // then v = 5
    return out;
  };

  it("are skipped to their end, as many as protobuf-go follows", () => {
    expect(unmarshal(nested(10001), codec).v).toBe(5n);
  });

  it("are refused one past that", () => {
    expect(() => unmarshal(nested(10002), codec)).toThrow("corrupt field 15: proto: parse error");
  });

  it("are refused when another field's end closes one", () => {
    expect(() => unmarshal(bytes("7b" + "74"), codec)).toThrow("corrupt field 15: proto: mismatching end group marker");
  });
});
