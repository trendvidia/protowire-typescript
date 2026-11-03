// SPDX-License-Identifier: MIT
// Copyright (c) 2026 TrendVidia, LLC.
/**
 * MaxNumericLiteralDigits and MaxBigFloatExponent per call, in the PXF decoder
 * and the pb codecs (HARDENING.md § Mandatory limits).
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createFileRegistry, fromBinary } from "@bufbuild/protobuf";
import { FileDescriptorSetSchema } from "@bufbuild/protobuf/wkt";
import { describe, expect, it } from "vitest";

import { BigFloatCodec, DecimalCodec, unmarshal as pbUnmarshal } from "../pb/index.js";
import { unmarshal } from "./decode.js";

const here = dirname(fileURLToPath(import.meta.url));
const load = (dir: string) =>
  createFileRegistry(
    fromBinary(
      FileDescriptorSetSchema,
      new Uint8Array(readFileSync(resolve(here, `testdata/corpus/${dir}/${dir}.binpb`))),
    ),
  );
const Holder = load("bignum").getMessage("bignum.v1.Holder")!;
const H = load("bigfloat").getMessage("bf.v1.H")!;

describe("MaxNumericLiteralDigits", () => {
  it("bounds a BigInt literal's significant digits", () => {
    expect(() => unmarshal("i = 0012345", Holder, { maxNumericLiteralDigits: 4 })).toThrow(/MaxNumericLiteralDigits=4/);
    expect(() => unmarshal("i = 0012345", Holder, { maxNumericLiteralDigits: 5 })).not.toThrow();
  });

  it("bounds a Decimal's scale", () => {
    expect(() => unmarshal("d = 0.001", Holder, { maxNumericLiteralDigits: 2 })).toThrow(/scale 3/);
    expect(() => unmarshal("d = 0.001", Holder, { maxNumericLiteralDigits: 3 })).not.toThrow();
  });

  it("bounds a BigFloat literal and the digits its suffix needs", () => {
    expect(() => unmarshal("bf = 123.45p53", H, { maxNumericLiteralDigits: 4 })).toThrow(/MaxNumericLiteralDigits=4/);
    expect(() => unmarshal("bf = 1p53", H, { maxNumericLiteralDigits: 16 })).toThrow(/renders to 17 digits/);
    expect(() => unmarshal("bf = 1p53", H, { maxNumericLiteralDigits: 17 })).not.toThrow();
  });

  it("bounds a Decimal's scale on the pb wire", () => {
    const scale5 = Uint8Array.of(0x10, 0x05);
    expect(() => pbUnmarshal(scale5, DecimalCodec, { maxNumericLiteralDigits: 4 })).toThrow(/scale 5/);
    expect(pbUnmarshal(scale5, DecimalCodec, { maxNumericLiteralDigits: 5 }).scale).toBe(5);
  });
});

describe("MaxBigFloatExponent", () => {
  it("bounds a literal's binary exponent, and can be raised", () => {
    expect(() => unmarshal("bf = 1024p53", H, { maxBigFloatExponent: 10 })).toThrow(/MaxBigFloatExponent=10/);
    expect(() => unmarshal("bf = 1024p53", H, { maxBigFloatExponent: 11 })).not.toThrow();
    expect(() => unmarshal("bf = 1e5000p53", H)).toThrow(/MaxBigFloatExponent=16384/);
    expect(() => unmarshal("bf = 1e5000p53", H, { maxBigFloatExponent: 17000 })).not.toThrow();
  });

  it("bounds it on the pb wire", () => {
    // mantissa 0x01, exponent 20, prec 53: binary exponent 21.
    const wire = Uint8Array.of(0x0a, 0x01, 0x01, 0x10, 0x14, 0x18, 0x35);
    expect(() => pbUnmarshal(wire, BigFloatCodec, { maxBigFloatExponent: 20 })).toThrow(/MaxBigFloatExponent=20/);
    expect(() => pbUnmarshal(wire, BigFloatCodec, { maxBigFloatExponent: 21 })).not.toThrow();
  });
});
