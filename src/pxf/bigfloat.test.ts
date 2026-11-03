// SPDX-License-Identifier: MIT
// Copyright (c) 2026 TrendVidia, LLC.
/**
 * Drives the spec's `testdata/bigfloat/` corpus, vendored verbatim under
 * `testdata/corpus/bigfloat/`. An `enc-` case is PB bytes and the text an
 * encoder must write, a `dec-` case a document and the PB bytes it must bind,
 * an `err-` case a document to reject. Each case also checks that
 * `reference.json`, what protowire-go did, agrees with the fixture's kind.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createFileRegistry, fromBinary, toBinary, type DescMessage, type MessageShape } from "@bufbuild/protobuf";
import { reflect, type ReflectList, type ReflectMap, type ReflectMessage } from "@bufbuild/protobuf/reflect";
import { FileDescriptorSetSchema } from "@bufbuild/protobuf/wkt";
import { describe, expect, it } from "vitest";

import { BigFloatCodec, defineMessage, unmarshal as pbUnmarshal } from "../pb/index.js";
import { MAX_NUMERIC_LITERAL_DIGITS, bigFloatDigits, formatBigFloat, parseBigFloatLiteral } from "./bigfloat.js";
import { bindRow } from "./dataset_reader.js";
import { unmarshal, unmarshalFull } from "./decode.js";
import { marshal } from "./encode.js";
import { format } from "./format.js";
import { parse } from "./parser.js";

const dir = resolve(dirname(fileURLToPath(import.meta.url)), "testdata/corpus/bigfloat");
const reference = (JSON.parse(readFileSync(resolve(dir, "../reference.json"), "utf8")) as {
  fixtures: Record<
  string,
  { decode: { accept: boolean; hex?: string[] }; encode?: string }
>;
}).fixtures;
const registry = createFileRegistry(
  fromBinary(FileDescriptorSetSchema, new Uint8Array(readFileSync(resolve(dir, "bigfloat.binpb")))),
);
const H: DescMessage = registry.getMessage("bf.v1.H")!;
const Holder: DescMessage = createFileRegistry(
  fromBinary(
    FileDescriptorSetSchema,
    new Uint8Array(readFileSync(resolve(dir, "../../bigfloat-test.binpb"))),
  ),
).getMessage("bftest.v1.Holder")!;

const names = readdirSync(dir)
  .filter((f) => f.endsWith(".pxf"))
  .map((f) => f.slice(0, -".pxf".length));
const kind = (prefix: string): string[] => names.filter((n) => n.startsWith(prefix));
const text = (name: string): string => readFileSync(resolve(dir, `${name}.pxf`), "utf8");
const wire = (name: string): Uint8Array => new Uint8Array(readFileSync(resolve(dir, `${name}.binpb`)));
const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");

function rejection(run: () => unknown): string {
  try {
    run();
  } catch (e) {
    return String(e);
  }
  return "accepted";
}

describe("bigfloat corpus", () => {
  it("has every case, and no other kind", () => {
    expect([kind("enc-").length, kind("dec-").length, kind("err-").length, names.length]).toEqual([13, 18, 4, 35]);
  });

  for (const name of kind("enc-")) {
    it(name, () => {
      const out = marshal(fromBinary(H, wire(name)), H);
      expect(out).toBe(text(name));
      expect(reference[`bigfloat/${name}.pxf`]!.encode).toBe(text(name));
    });
  }

  for (const name of kind("dec-")) {
    it(name, () => {
      const got = toBinary(H, unmarshal(text(name), H));
      expect(hex(got)).toBe(hex(wire(name)));
      expect(reference[`bigfloat/${name}.pxf`]!.decode).toEqual({ accept: true, hex: [hex(wire(name))] });
    });
  }

  for (const name of kind("err-")) {
    it(name, () => {
      // Each names its cause, so a case cannot pass on an unrelated error.
      const want = name === "err-suffix-on-int32" ? 'field "count"' : "precision";
      expect(rejection(() => unmarshal(text(name), H))).toContain(want);
      expect(reference[`bigfloat/${name}.pxf`]!.decode.accept).toBe(false);
    });
  }
});

describe("bigfloat round trips", () => {
  for (const name of [...kind("enc-"), ...kind("dec-")]) {
    it(`${name}: text to message to text is a fixed point`, () => {
      const first = marshal(unmarshal(text(name), H), H);
      expect(marshal(unmarshal(first, H), H)).toBe(first);
    });
  }
});

/** The spec's `testdata/adversarial/` rows, as bytes: this repo vendors no copy. */
describe("MaxBigFloatExponent, adversarial rows", () => {
  const holder = defineMessage({ fields: [{ number: 3, name: "big_float", kind: { message: BigFloatCodec } }] });
  const pb = (h: string): unknown => pbUnmarshal(Uint8Array.from(Buffer.from(h, "hex")), holder);

  it.each([
    ["bigfloat-huge-exponent", "1a0b0a010110ffffffff071840", -1],
    ["bigfloat-huge-negative-exponent", "1a100a01011080808080f8ffffffff011840", -1],
    ["bigfloat-exponent-past-bound", "1a090a0101108080011840", -1],
    ["bigfloat-exponent-at-bound", "1a080a010110ff7f1840", 16384],
    ["bigfloat-negative-exponent-at-bound", "1a100a010110fffffeffffffffffff011840", -16384],
  ])("pb/%s", (_name, h, binary) => {
    if (binary === -1) expect(rejection(() => pb(h))).toContain("MaxBigFloatExponent=16384");
    else expect(pb(h)).toEqual({ big_float: { mantissa: Uint8Array.of(1), exponent: binary - 1, prec: 64 } });
  });

  it("pxf/bigfloat-huge-exponent", () => {
    expect(rejection(() => unmarshal("bf = 1e646456992\n", H))).toContain("MaxBigFloatExponent=16384");
  });

  it("pxf/bigfloat-exponent-at-bound", () => {
    expect(toBinary(H, unmarshal("bf = 1e4932\n", H))).toEqual(wire("dec-1e4932"));
  });

  it("is checked after rounding to the read precision", () => {
    // The top 4000 digits of 2^16384 are just under it, so the wide read keeps
    // binary exponent 16384 and the narrow one rounds up to 16385.
    const d = (2n ** 16384n).toString().slice(0, 4000);
    const below = `${d[0]}.${d.slice(1)}e4932`;
    expect(rejection(() => unmarshal(`bf = ${below}p13603\n`, H))).toBe("accepted");
    expect(rejection(() => unmarshal(`bf = ${below}p8\n`, H))).toContain("binary exponent 16385");
  });

  it("rejects both signs from a short literal", () => {
    for (const lit of ["1e4933", "-1e4933", "1e-4940", "1e99999999999999999999"]) {
      expect(rejection(() => unmarshal(`bf = ${lit}\n`, H)), lit).not.toBe("accepted");
    }
  });

  it("marshal refuses a value past the bound", () => {
    const m = unmarshal("bf { mantissa = b\"AQ==\"\n exponent = 16384\n prec = 64 }\n", H);
    expect(rejection(() => marshal(m, H))).toContain("MaxBigFloatExponent=16384");
  });

  it("marshal refuses a value rounding carries past the bound", () => {
    const m = unmarshal("bf { mantissa = b\"Dw==\"\n exponent = 16380\n prec = 2 }\n", H);
    expect(rejection(() => marshal(m, H))).toContain("binary exponent 16385");
  });
});

describe("MaxNumericLiteralDigits", () => {
  it("13603 is the widest precision within it", () => {
    expect(bigFloatDigits(13603)).toBe(MAX_NUMERIC_LITERAL_DIGITS);
    expect(bigFloatDigits(13604)).toBe(MAX_NUMERIC_LITERAL_DIGITS + 1);
  });

  it("is one digit high with a float64 at 146964308, and this is not", () => {
    expect(bigFloatDigits(146964308)).toBe(44240665 + 1);
  });

  it("counts mantissa digits, and no leading zero, exponent or suffix", () => {
    const at = "1".repeat(4096);
    expect(rejection(() => parseBigFloatLiteral(at))).toBe("accepted");
    expect(rejection(() => parseBigFloatLiteral(`${at}1`))).toContain("MaxNumericLiteralDigits=4096");
    expect(rejection(() => parseBigFloatLiteral(`${"0".repeat(5000)}.${"0".repeat(4000)}${at}e4000`, "64"))).toBe("accepted");
  });

  it("marshal refuses a prec whose literal would be past it", () => {
    const m = unmarshal("bf { mantissa = b\"AQ==\"\n prec = 13604 }\n", H);
    expect(rejection(() => marshal(m, H))).toContain("renders to 4097 digits");
  });
});

describe("the suffix in other places", () => {
  it("lexes on every number and is kept by format", () => {
    for (const lit of ["1.5p53", "7p64", "1e-5p24", "-0p64", "1E+3p8"]) {
      expect(format(parse(`bf = ${lit}\n`))).toBe(`bf = ${lit}\n`);
    }
  });

  it("does not carry to the next number", () => {
    const m = reflect(H, unmarshal("bf = 1.5p53\ncount = 3\n", H));
    expect(m.get(H.fields[1]!)).toBe(3);
  });

  it("a p with no digit is not a suffix", () => {
    expect(rejection(() => unmarshal("bf = 1px\n", H))).toContain("expected");
  });

  it("is rejected on a map key by the parser", () => {
    expect(rejection(() => parse('m = {\n  1p5: "x"\n}\n'))).toContain("a key cannot carry a precision suffix (p5)");
  });

  it.each([
    ["i32 = 5p8", "i32"],
    ["i64 = 5p8", "i64"],
    ["u32 = 5p8", "u32"],
    ["u64 = 5p8", "u64"],
    ["f32 = 1.5p8", "f32"],
    ["f64 = 1.5p8", "f64"],
    ["color = 1p8", "color"],
    ["numbers = [1, 2p8]", "numbers"],
    ["by_name = { a: { mantissa = 1p8 } }", "mantissa"],
    ["wrapped = 5p8", "value"],
  ])("is rejected on %s, naming the field", (doc, field) => {
    expect(rejection(() => unmarshal(`${doc}\n`, Holder))).toContain(`not on field "${field}"`);
  });

  it("is rejected on a map key by the decoder", () => {
    expect(rejection(() => unmarshal('by_id = { 1p5: "x" }\n', Holder))).toContain("a key cannot carry a precision suffix (p5)");
  });

  it("survives a @dataset cell", () => {
    const doc = parse("@dataset bftest.v1.Holder ( bf )\n( 1.5p53 )\n");
    const row = doc.datasets[0]!.rows[0]!;
    expect(row.cells[0]).toMatchObject({ kind: "float", raw: "1.5", prec: "53" });
    expect(toBinary(Holder, bindRow(Holder, doc.datasets[0]!.columns, row))).toEqual(
      toBinary(Holder, unmarshalFull("bf = 1.5p53\n", Holder).message),
    );
  });

  it("clips a long suffix in its error", () => {
    expect(rejection(() => unmarshal(`bf = 1p${"9".repeat(100000)}\n`, H)).length).toBeLessThan(200);
  });
});

describe("literal forms", () => {
  const precOf = (sub: ReflectMessage): unknown => sub.get(sub.desc.fields.find((f) => f.name === "prec")!);
  const field = (m: MessageShape<DescMessage>, name: string): unknown =>
    reflect(Holder, m).get(Holder.fields.find((f) => f.name === name)!);
  const prec = (lit: string): unknown => precOf(reflect(H, unmarshal(`bf = ${lit}\n`, H)).get(H.fields[0]!) as ReflectMessage);

  it("a zero keeps a stated precision only", () => {
    expect(prec("0")).toBe(0);
    expect(prec("0.000")).toBe(0);
    expect(prec("0e99")).toBe(0);
    expect(prec("0p64")).toBe(64);
  });

  it("rounds half to even", () => {
    // 1.5 in one bit is a tie and goes to 2; 2.5 in two bits is a tie and goes to 2.
    expect(parseBigFloatLiteral("1.5", "1")).toMatchObject({ mantissa: Uint8Array.of(1), exponent: 1, prec: 1 });
    expect(parseBigFloatLiteral("2.5", "2")).toMatchObject({ mantissa: Uint8Array.of(2), exponent: 0, prec: 2 });
    expect(parseBigFloatLiteral("3.5", "2")).toMatchObject({ mantissa: Uint8Array.of(2), exponent: 1, prec: 2 });
  });

  it("rounds exactly where big.Float.Parse does not", () => {
    // Just under the tie between 2 and 3 × 2^-16383, so 2. protowire-go v1.15.0
    // reads 3 (measured). The spec's rule is exact, and a check with exact
    // fractions in Python agrees with this.
    const lit = "4.2026289288901168828283472716521907532475991810580890501360340372609e-4932";
    expect(parseBigFloatLiteral(lit, "2").mantissa).toEqual(Uint8Array.of(2));
  });

  it("writes in %g form", () => {
    const lit = (l: string, p: string): string => formatBigFloat(parseBigFloatLiteral(l, p));
    expect(lit("0.0001220703125", "64")).toBe("0.0001220703125p64");
    expect(lit("0.00006103515625", "64")).toBe("6.103515625e-05p64");
    expect(lit("1e20", "64")).toBe("100000000000000000000p64");
    expect(lit("1e21", "64")).toBe("1e+21p64");
    expect(lit("7.5", "4")).toBe("7.5p4");
    // 9.5 has 5 bits: at 4 it is a tie, and rounds to the even 10.
    expect(lit("9.5", "4")).toBe("10p4");
  });

  it("rounds a tie in the digits half to even", () => {
    // 0.125 at 2 digits is a tie after an even digit, and 0.375 after an odd one.
    expect(formatBigFloat({ mantissa: Uint8Array.of(1), exponent: -3, prec: 1, negative: false })).toBe("0.12p1");
    expect(formatBigFloat({ mantissa: Uint8Array.of(3), exponent: -3, prec: 2, negative: false })).toBe("0.38p2");
  });

  it("takes a list element and a map value, and writes them back", () => {
    const doc = 'by_name = {\n  a: 2.5p8\n}\nlist = [\n  1.5p53,\n  -0p64\n]\n';
    const m = unmarshal(doc, Holder);
    expect((field(m, "list") as ReflectList).size).toBe(2);
    expect((field(m, "by_name") as ReflectMap).size).toBe(1);
    const out = marshal(m, Holder);
    expect(out).toContain("a: 2.5p8\n");
    expect(out).toContain("1.5p53,\n");
    expect(out).toContain("-0p64\n");
    expect(toBinary(Holder, unmarshal(out, Holder))).toEqual(toBinary(Holder, m));
  });

  it("takes a (pxf.default), at its suffix's precision", () => {
    const { message } = unmarshalFull("", Holder);
    expect(precOf(field(message, "with_default") as ReflectMessage)).toBe(53);
  });

  it("marks the fields of a literal present", () => {
    expect(unmarshalFull("bf = 1.5p53\n", H).result.isAbsent("bf.prec")).toBe(false);
  });
});
