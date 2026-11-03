// SPDX-License-Identifier: MIT
// Copyright (c) 2026 TrendVidia, LLC.
/**
 * The struct-binding table (protowire#509): twins of the reference's structs
 * in values_table_test.go, each compared with the bytes protowire-go writes,
 * from the spec repo's testdata/values/values.tsv, copied to testdata/.
 *
 * Every row has a twin. pxf.BigInt binds to a bigint, pxf.Decimal to a Decimal
 * (protowire-go's *big.Rat) and pxf.BigFloat to a BigFloat (its *big.Float),
 * and these rows pin the reduced form a language value is written in (draft
 * -01 § PXF Annotations).
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  BigFloat,
  BigFloatValueCodec,
  BigIntValueCodec,
  Decimal,
  DecimalValueCodec,
  type MessageCodec,
  defineMessage,
  marshal,
} from "./index.js";

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

const dec = { message: DecimalValueCodec };
const flt = { message: BigFloatValueCodec };
const VDecimal = defineMessage({ fields: [{ number: 1, name: "d", kind: dec }] }) as never;
const VDecimals = defineMessage({ fields: [{ number: 1, name: "ds", kind: dec, repeated: true }] }) as never;
const VBigNums = defineMessage({
  fields: [
    { number: 1, name: "i", kind: { message: BigIntValueCodec } },
    { number: 2, name: "d", kind: dec },
    { number: 3, name: "f", kind: flt },
  ],
}) as never;
const VBigFloat = defineMessage({ fields: [{ number: 1, name: "f", kind: flt }] }) as never;
const VBigFloatMap = defineMessage({ fields: [{ number: 1, name: "m", kind: flt, mapKey: "string" }] }) as never;
const D = (s: string): Decimal => Decimal.parse(s);

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
  Decimal: [VDecimal, { d: D("3.1415") }],
  DecimalOne: [VDecimal, { d: D("1.00") }],
  DecimalFiveE2: [VDecimal, { d: new Decimal(5n, -2) }],
  DecimalFifteen: [VDecimal, { d: D("15.00") }],
  DecimalZero: [VDecimal, { d: D("0.00") }],
  DecimalNegative: [VDecimal, { d: D("-1.50") }],
  Decimals: [VDecimals, { ds: [D("0.00"), D("1.00"), new Decimal(5n, -2)] }],
  DecimalsNullElement: [VDecimals, { ds: [D("1"), null] }],
  BigNumsZero: [VBigNums, { i: 0n, d: D("0"), f: new BigFloat({ mantissa: 0n, exponent: 0, prec: 0 }) }],
  BigNumsNegative: [
    VBigNums,
    { i: -12345678901234567890n, d: D("-0.5"), f: BigFloat.fromNumber(-1.5) },
  ],
  BigFloatMapNullValue: [VBigFloatMap, { m: { k: null } }],
  BigFloatPrec64: [VBigFloat, { f: BigFloat.fromNumber(1.5, 64) }],
};


describe("the struct-binding table", () => {
  it("twins every row", () => {
    for (const name of rows.keys()) {
      expect(TWINS[name] !== undefined, `${name} has no twin`).toBe(true);
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
