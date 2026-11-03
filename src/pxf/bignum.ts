// SPDX-License-Identifier: MIT
// Copyright (c) 2026 TrendVidia, LLC.
/**
 * The literal forms of `pxf.BigInt` and `pxf.Decimal`. Mirrors the reference's
 * `parseBigInt`, `parseDecimal`, `formatBigInt` and `readDecimalStr`.
 */

import { DEFAULT_NUMERIC_LIMITS, MAX_NUMERIC_LITERAL_DIGITS, type NumericLimits } from "./bigfloat.js";

export interface BigIntFields {
  readonly abs: Uint8Array;
  readonly negative: boolean;
}

export interface DecimalFields {
  readonly unscaled: Uint8Array;
  readonly scale: number;
  readonly negative: boolean;
}

/** Leading zeros are not significant (protowire#410). */
function countDigits(s: string): number {
  let n = 0;
  let leading = true;
  for (const c of s) {
    if (c === "e" || c === "E" || c === "p") break;
    if (c < "0" || c > "9" || (leading && c === "0")) continue;
    leading = false;
    n++;
  }
  return n;
}

function checkDigits(s: string, max: number): void {
  if (s.length <= max) return;
  const n = countDigits(s);
  if (n > max) {
    throw new Error(`numeric literal has ${n} digits; MaxNumericLiteralDigits=${max}`);
  }
}

function toBytes(v: bigint): Uint8Array {
  if (v === 0n) return new Uint8Array();
  const hex = v.toString(16);
  return new Uint8Array(Buffer.from(hex.length % 2 === 0 ? hex : `0${hex}`, "hex"));
}

function fromBytes(b: Uint8Array): bigint {
  return b.length === 0 ? 0n : BigInt(`0x${Buffer.from(b).toString("hex")}`);
}

/** A literal the decoder would refuse is an error here, not an unreadable document. */
function bounded(kind: string, s: string): string {
  if (s.length > MAX_NUMERIC_LITERAL_DIGITS) {
    const n = countDigits(s);
    if (n > MAX_NUMERIC_LITERAL_DIGITS) {
      throw new Error(`${kind} renders to ${n} digits; MaxNumericLiteralDigits=${MAX_NUMERIC_LITERAL_DIGITS}`);
    }
  }
  return s;
}

export function parseBigInt(s: string, lim: NumericLimits = DEFAULT_NUMERIC_LIMITS): BigIntFields {
  checkDigits(s, lim.maxDigits);
  if (!/^-?[0-9]+$/.test(s)) throw new Error(`invalid big integer: ${s}`);
  const negative = s.startsWith("-");
  const abs = BigInt(negative ? s.slice(1) : s);
  return { abs: toBytes(abs), negative: negative && abs !== 0n };
}

export function formatBigInt(f: BigIntFields): string {
  const abs = fromBytes(f.abs);
  return bounded("pxf.BigInt", `${f.negative && abs !== 0n ? "-" : ""}${abs}`);
}

/** The scale counts the digits after the point, so `1.00` has scale 2. */
export function parseDecimal(s: string, lim: NumericLimits = DEFAULT_NUMERIC_LIMITS): DecimalFields {
  checkDigits(s, lim.maxDigits);
  const m = /^(-?)([0-9]+)(?:\.([0-9]*))?$/.exec(s);
  if (!m) throw new Error(`invalid decimal: ${s}`);
  const frac = m[3] ?? "";
  if (frac.length > lim.maxDigits) {
    throw new Error(`pxf.Decimal scale ${frac.length} exceeds MaxNumericLiteralDigits=${lim.maxDigits}`);
  }
  return { unscaled: toBytes(BigInt(m[2]! + frac)), scale: frac.length, negative: m[1] === "-" };
}

/** The bound comes first: the scale is four bytes whoever wrote them chose. */
export function checkDecimalScale(scale: number): void {
  if (scale > MAX_NUMERIC_LITERAL_DIGITS || scale < -MAX_NUMERIC_LITERAL_DIGITS) {
    throw new Error(`pxf.Decimal scale ${scale} exceeds MaxNumericLiteralDigits=${MAX_NUMERIC_LITERAL_DIGITS}`);
  }
}

/** value = unscaled × 10^(-scale): a negative scale means trailing zeros. */
export function formatDecimal(f: DecimalFields): string {
  checkDecimalScale(f.scale);
  const sign = f.negative ? "-" : "";
  let unscaled = fromBytes(f.unscaled);
  if (f.scale < 0) unscaled *= 10n ** BigInt(-f.scale);
  const scale = Math.max(f.scale, 0);
  let digits = unscaled.toString();
  if (scale === 0) return bounded("pxf.Decimal", sign + digits);
  digits = digits.padStart(scale + 1, "0");
  const point = digits.length - scale;
  return bounded("pxf.Decimal", `${sign}${digits.slice(0, point)}.${digits.slice(point)}`);
}
