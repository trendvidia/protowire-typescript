// SPDX-License-Identifier: MIT
// Copyright (c) 2026 TrendVidia, LLC.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  BigFloat,
  BigFloatValueCodec,
  Decimal,
  DecimalValueCodec,
  type MessageCodec,
  defineMessage,
  marshal,
  unmarshal,
} from "./index.js";

const here = dirname(fileURLToPath(import.meta.url));
const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
const bytes = (h: string): Uint8Array => new Uint8Array(Buffer.from(h, "hex"));

type Holder<T> = { s?: T | null; l?: (T | null)[] };
const holder = <T,>(message: typeof DecimalValueCodec): MessageCodec<Holder<T>> =>
  defineMessage<Holder<T>>({
    fields: [
      { number: 1, name: "s", kind: { message } },
      { number: 2, name: "l", kind: { message }, repeated: true },
    ],
  });
const F = holder<BigFloat>(BigFloatValueCodec);
const D = holder<Decimal>(DecimalValueCodec);

function write<T>(v: Holder<T>, codec: MessageCodec<Holder<T>>): string {
  try {
    return hex(marshal(v, codec));
  } catch {
    return "ERR";
  }
}

describe("the value codecs write what protowire-go writes (testdata/bignum-go.txt)", () => {
  const cases = readFileSync(resolve(here, "testdata/bignum-go.txt"), "utf8")
    .split("\n")
    .filter((l) => l !== "" && !l.startsWith("#"));

  it("has its cases", () => {
    // Ties, carries, both bounds, signed zeros and scales past 4096, among them.
    expect(cases.length).toBe(1773);
    expect(cases.filter((l) => l.split("\t")[1]!.startsWith("ERR")).length).toBe(28);
  });

  it("matches every case, written and read back", () => {
    const wrong: string[] = [];
    for (const line of cases) {
      const [input, want] = line.split("\t") as [string, string];
      const f = input.split(" ");
      let got: string;
      if (f[0] === "F") {
        const v = new BigFloat({
          mantissa: BigInt(`0x${f[1]}`),
          exponent: Number(f[2]),
          prec: Number(f[3]),
          negative: f[4] === "1",
        });
        const w = write({ s: v, l: [v] }, F);
        got = `${w} ${w === "ERR" ? "" : write(unmarshal(bytes(w), F), F)}`;
      } else {
        const v = new Decimal(BigInt(f[1]!), Number(f[2]));
        const w = write({ s: v, l: [v] }, D);
        got = `${w} ${w === "ERR" ? "" : write(unmarshal(bytes(w), D), D)}`;
      }
      if (got !== want) wrong.push(`${input}\n  go: ${want.slice(0, 80)}\n  ts: ${got.slice(0, 80)}`);
    }
    expect(wrong.slice(0, 5)).toEqual([]);
  });
});

describe("Decimal", () => {
  it("keeps the scale it is given, and prints it", () => {
    const d = Decimal.parse("-1.50");
    expect([d.unscaled, d.scale]).toEqual([-150n, 2]);
    expect(d.toString()).toBe("-1.50");
    expect(new Decimal(5n, -2).toString()).toBe("500");
    expect(new Decimal(5n, 3).toString()).toBe("0.005");
  });

  it("reduces to the form a big.Rat has", () => {
    expect(Decimal.parse("1.00").reduced()).toEqual(new Decimal(1n, 0));
    expect(Decimal.parse("-1.50").reduced()).toEqual(new Decimal(-15n, 1));
    expect(new Decimal(5n, -2).reduced()).toEqual(new Decimal(500n, 0));
    expect(Decimal.parse("0.000").reduced()).toEqual(new Decimal(0n, 0));
  });

  it("is equal by value, whatever the scale", () => {
    expect(Decimal.parse("1.50").equals(Decimal.parse("1.5"))).toBe(true);
    expect(new Decimal(5n, -2).equals(Decimal.parse("500"))).toBe(true);
    expect(Decimal.parse("1.5").equals(Decimal.parse("1.05"))).toBe(false);
  });

  it("reads the scale a field-level producer wrote, not only the reduced one", () => {
    // 1.50 as unscaled 150, scale 2: what DecimalCodec writes for "1.50".
    const got = unmarshal(bytes("0a050a01961002"), D).s!;
    expect([got.unscaled, got.scale]).toEqual([150n, 2]);
    // A negative scale means trailing zeros.
    expect(unmarshal(bytes("0a0e0a010510feffffffffffffffff01"), D).s!.toString()).toBe("500");
  });

  it("refuses a scale past the bound before materialising it", () => {
    expect(() => unmarshal(bytes("0a060a0101108120"), D)).toThrow(/scale/);
    expect(() => marshal({ s: new Decimal(7n, 4097) }, D)).toThrow(
      "pxf.Decimal scale 4097 exceeds MaxNumericLiteralDigits=4096",
    );
  });

  it("refuses a scale that is not an integer", () => {
    expect(() => new Decimal(1n, 1.5)).toThrow(RangeError);
  });
});

describe("BigFloat", () => {
  it("rounds to its precision half to even, and normalises", () => {
    // 0b1011 at 3 bits: halfway between 0b101 and 0b110, so to the even one.
    expect(new BigFloat({ mantissa: 0b1011n, exponent: 0, prec: 3 })).toEqual(
      new BigFloat({ mantissa: 0b11n, exponent: 2, prec: 3 }),
    );
    // 0b1001 at 3 bits: halfway, and 0b100 is even.
    const v = new BigFloat({ mantissa: 0b1001n, exponent: 0, prec: 3 });
    expect([v.mantissa, v.exponent]).toEqual([1n, 3]);
    // Trailing zero bits move into the exponent.
    expect(new BigFloat({ mantissa: 12n, exponent: 0, prec: 53 })).toEqual(
      new BigFloat({ mantissa: 3n, exponent: 2, prec: 53 }),
    );
  });

  it("holds only ±0 at precision 0, as big.Float does", () => {
    const v = new BigFloat({ mantissa: 5n, exponent: 9, prec: 0, negative: true });
    expect([v.mantissa, v.exponent, v.negative, v.isZero()]).toEqual([0n, 0, true, true]);
  });

  it("takes a number exactly, -0 included", () => {
    const v = BigFloat.fromNumber(0.1);
    expect(v.prec).toBe(53);
    expect(Number(v.mantissa) * 2 ** v.exponent).toBe(0.1);
    expect(BigFloat.fromNumber(-0).negative).toBe(true);
    expect(() => BigFloat.fromNumber(Number.NaN)).toThrow(RangeError);
  });

  it("reads and prints its PXF literal", () => {
    const v = BigFloat.parse("1.5p64");
    expect(v.equals(BigFloat.fromNumber(1.5, 64))).toBe(true);
    expect(v.toString()).toBe("1.5p64");
    expect(BigFloat.parse(v.toString()).equals(v)).toBe(true);
    expect(BigFloat.parse("-0").toString()).toBe("-0");
  });

  it("omits only +0 at precision 0 as a singular field", () => {
    expect(hex(marshal({ s: new BigFloat({ mantissa: 0n, exponent: 0, prec: 0 }) }, F))).toBe("");
    expect(hex(marshal({ s: new BigFloat({ mantissa: 0n, exponent: 0, prec: 0, negative: true }) }, F))).toBe(
      "0a022001",
    );
    expect(hex(marshal({ s: new BigFloat({ mantissa: 0n, exponent: 0, prec: 53 }) }, F))).toBe("0a021835");
  });

  it("refuses parts a big.Float could not have", () => {
    expect(() => new BigFloat({ mantissa: -1n, exponent: 0, prec: 8 })).toThrow(RangeError);
    expect(() => new BigFloat({ mantissa: 1n, exponent: 0, prec: -1 })).toThrow(RangeError);
    expect(() => new BigFloat({ mantissa: 1n, exponent: 0.5, prec: 8 })).toThrow(RangeError);
  });
});

describe("the value codecs and null", () => {
  it("write a null element or map value as an empty message", () => {
    expect(hex(marshal({ l: [Decimal.parse("1"), null] }, D))).toBe("12030a0101" + "1200");
    const M = defineMessage<{ m: Record<string, BigFloat | null> }>({
      fields: [{ number: 1, name: "m", kind: { message: BigFloatValueCodec }, mapKey: "string" }],
    });
    expect(hex(marshal({ m: { k: null } }, M))).toBe("0a050a016b1200");
  });

  it("refuse a value of another type rather than write something else", () => {
    expect(() => marshal({ s: 1.5 as never }, F)).toThrow(TypeError);
    expect(() => marshal({ s: "1.5" as never }, D)).toThrow(TypeError);
  });
});
