// SPDX-License-Identifier: MIT
// Copyright (c) 2026 TrendVidia, LLC.
/**
 * The struct-binding table (protowire#509): twins of the reference's structs
 * in values_table_test.go, each compared with the bytes protowire-go writes,
 * from the spec repo's testdata/values/values.tsv, copied to testdata/.
 *
 * A row whose value has no language-value binding here is listed in
 * FIELD_LEVEL with the reason. JavaScript has no decimal or arbitrary-precision
 * float, so pxf.Decimal and pxf.BigFloat are bound field by field, and a
 * producer of a message's fields writes them as they are, where these rows pin
 * the reduced form a language value is written in (draft -01 § PXF Annotations).
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { BigIntValueCodec, type MessageCodec, defineMessage, marshal } from "./index.js";

const here = dirname(fileURLToPath(import.meta.url));
const rows = new Map(
  readFileSync(resolve(here, "testdata/values.tsv"), "utf8")
    .split("\n")
    .filter((l) => l !== "" && !l.startsWith("#"))
    .map((l) => {
      const [name, hex, value] = l.split("\t");
      return [name!, { hex: hex!, value: value! }];
    }),
);

const Leaf = defineMessage<{ name: string; n: number }>({
  fields: [
    { number: 1, name: "name", kind: "string" },
    { number: 2, name: "n", kind: "int32" },
  ],
  create: () => ({ name: "", n: 0 }),
});

const TWINS: Record<string, [MessageCodec<never>, unknown]> = {
  Ints: [
    defineMessage({
      fields: [
        { number: 1, name: "a", kind: "int64" },
        { number: 2, name: "b", kind: "int64" },
        { number: 3, name: "c", kind: "int32" },
        { number: 4, name: "m", kind: "int64", mapKey: "string" },
        { number: 5, name: "mi", kind: "int32", mapKey: "string" },
      ],
    }) as never,
    { a: -1n, b: -1n, c: -1, m: { k: -1n }, mi: { k: -1 } },
  ],
  Age: [defineMessage({ fields: [{ number: 1, name: "age", kind: "int32" }] }) as never, { age: 30 }],
  MinLong: [defineMessage({ fields: [{ number: 1, name: "v", kind: "int64" }] }) as never, { v: -(2n ** 63n) }],
  Zigzag: [
    defineMessage({
      fields: [
        { number: 1, name: "d", kind: "sint64" },
        { number: 2, name: "e", kind: "sint32" },
      ],
    }) as never,
    { d: -1n, e: -2 },
  ],
  Packed: [
    defineMessage({
      fields: [
        { number: 1, name: "xs", kind: "int32", repeated: true },
        { number: 2, name: "ys", kind: "int64", repeated: true },
        { number: 3, name: "bs", kind: "bool", repeated: true },
        { number: 4, name: "ds", kind: "double", repeated: true },
        { number: 5, name: "fs", kind: "float", repeated: true },
      ],
    }) as never,
    { xs: [1, 0, -1], ys: [300n], bs: [true, false], ds: [1.5], fs: [-2.5] },
  ],
  ZeroMapEntry: [
    defineMessage({
      fields: [
        { number: 1, name: "m", kind: "string", mapKey: "string" },
        { number: 2, name: "z", kind: "int32", mapKey: "string" },
        { number: 3, name: "k", kind: "string", mapKey: "int32" },
      ],
    }) as never,
    { m: { "": "" }, z: { zero: 0 }, k: { 0: "v" } },
  ],
  Nested: [
    defineMessage({
      fields: [
        { number: 1, name: "s", kind: "string" },
        { number: 2, name: "ls", kind: { message: Leaf }, repeated: true },
        { number: 3, name: "ss", kind: "string", repeated: true },
      ],
    }) as never,
    { s: "x", ls: [{ name: "", n: 0 }, { name: "l", n: -3 }], ss: ["", "s"] },
  ],
  Zeros: [
    defineMessage({
      fields: [
        { number: 1, name: "i", kind: "int32" },
        { number: 2, name: "s", kind: "string" },
        { number: 3, name: "b", kind: "bool" },
        { number: 4, name: "d", kind: "double" },
        { number: 5, name: "bs", kind: "bytes" },
        { number: 6, name: "u", kind: "uint64" },
      ],
    }) as never,
    { i: 0, s: "", b: false, d: 0, bs: new Uint8Array(), u: 0n },
  ],
  BigNumsNull: [
    defineMessage({ fields: [{ number: 1, name: "i", kind: { message: BigIntValueCodec } }] }) as never,
    {},
  ],
  BigIntsZeroElement: [
    defineMessage({ fields: [{ number: 1, name: "is", kind: { message: BigIntValueCodec }, repeated: true }] }) as never,
    { is: [0n, 1n] },
  ],
  BigIntsNullElement: [
    defineMessage({ fields: [{ number: 1, name: "is", kind: { message: BigIntValueCodec }, repeated: true }] }) as never,
    { is: [1n, null] },
  ],
};

const FIELD_LEVEL: Record<string, string> = {
  Decimal: "pxf.Decimal is bound field by field here",
  DecimalOne: "pxf.Decimal is bound field by field here",
  DecimalFiveE2: "pxf.Decimal is bound field by field here",
  DecimalFifteen: "pxf.Decimal is bound field by field here",
  DecimalZero: "pxf.Decimal is bound field by field here",
  DecimalNegative: "pxf.Decimal is bound field by field here",
  Decimals: "pxf.Decimal is bound field by field here",
  DecimalsNullElement: "pxf.Decimal is bound field by field here",
  BigNumsZero: "it holds a pxf.Decimal and a pxf.BigFloat, bound field by field here",
  BigNumsNegative: "it holds a pxf.Decimal and a pxf.BigFloat, bound field by field here",
  BigFloatMapNullValue: "pxf.BigFloat is bound field by field here",
  BigFloatPrec64: "pxf.BigFloat is bound field by field here",
};

describe("the struct-binding table", () => {
  it("names every row, as a twin or with the reason it has none", () => {
    for (const name of rows.keys()) {
      expect(TWINS[name] !== undefined || FIELD_LEVEL[name] !== undefined, `${name} has no twin`).toBe(true);
    }
  });

  for (const [name, [codec, value]] of Object.entries(TWINS)) {
    it(`${name}: ${rows.get(name)?.value}`, () => {
      const row = rows.get(name);
      expect(row, `${name} is not in values.tsv`).toBeDefined();
      expect(Buffer.from(marshal(value as never, codec)).toString("hex")).toBe(row!.hex);
    });
  }
});
