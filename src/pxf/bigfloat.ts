// SPDX-License-Identifier: MIT
// Copyright (c) 2026 TrendVidia, LLC.
/**
 * The PXF text form of `pxf.BigFloat` (draft -01 § PXF Annotations,
 * protowire#406 and #410). Mirrors the BigFloat half of
 * `protowire/encoding/pxf/wellknown.go`, which leans on `big.Float`. JS has no
 * big float, so everything here is exact rational arithmetic on BigInt, and a
 * Number only ever holds a count: of bits, of digits, or an exponent.
 */

/**
 * Caps the digits of a numeric literal: the significant digits of its
 * mantissa, leading zeros excluded, and not its exponent or precision suffix
 * (HARDENING.md § Mandatory limits, protowire#410).
 */
export const MAX_NUMERIC_LITERAL_DIGITS = 4096;

/**
 * Bounds the magnitude of a BigFloat's binary exponent, the wire exponent plus
 * the mantissa's bit length (HARDENING.md § Mandatory limits, protowire#281).
 * Rendering a value in decimal costs time that grows with the square of it.
 */
export const MAX_BIG_FLOAT_EXPONENT = 16384;

/** The precision a literal without a suffix is read at. */
const DEFAULT_PREC = 256;

/** A literal's value farther than this many decades from 1 is past the exponent
 * bound whatever its digits: 2^16385 is about 10^4932.7. */
const MAX_DECIMAL_MAGNITUDE = 4940;

/** floor(log10(2) × 2^128). */
const LOG10_2_Q128 = 0x4d104d427de7fbcc47c4acd605be48bcn;

/** The fields of a `pxf.BigFloat`. */
export interface BigFloatFields {
  readonly mantissa: Uint8Array;
  readonly exponent: number;
  readonly prec: number;
  readonly negative: boolean;
}

/** Shortens a literal for an error message: the input sets its length. */
export function clipLiteral(s: string): string {
  return s.length <= 24 ? s : `${s.slice(0, 24)}…`;
}

/**
 * The significant digits a value of `prec` bits is written with: the decimal
 * digits of 2^prec, plus one. `prec` comes off the wire or out of a document,
 * so 2^prec is never computed: the digit count is floor(prec × log10 2) + 1,
 * taken in 128-bit fixed point, which is exact for every uint32 (a float64 is
 * one digit high at prec 146964308).
 */
export function bigFloatDigits(prec: number): number {
  return Number((BigInt(prec) * LOG10_2_Q128) >> 128n) + 2;
}

/**
 * The binary exponent of the value a mantissa and wire exponent denote, or
 * undefined for a zero mantissa, which has none.
 */
export function bigFloatBinaryExponent(mantissa: Uint8Array, exponent: number): number | undefined {
  let first = 0;
  while (first < mantissa.length && mantissa[first] === 0) first++;
  if (first === mantissa.length) return undefined;
  return exponent + 8 * (mantissa.length - first - 1) + (32 - Math.clz32(mantissa[first]!));
}

function exceedsExponentBound(e: number): boolean {
  return e > MAX_BIG_FLOAT_EXPONENT || e < -MAX_BIG_FLOAT_EXPONENT;
}

function bitLength(n: bigint): number {
  const hex = n.toString(16);
  return (hex.length - 1) * 4 + (32 - Math.clz32(Number.parseInt(hex[0]!, 16)));
}

/**
 * Rounds num/den, both positive, half to even to an integer of exactly `prec`
 * bits. Returns it with the shift that scaled it: value ≈ q × 2^-shift.
 */
function roundToPrec(num: bigint, den: bigint, prec: number): { q: bigint; shift: number } {
  const top = 1n << BigInt(prec);
  // num/den lies in (2^(l-1), 2^(l+1)), so at this shift q has prec or prec+1 bits.
  const l = bitLength(num) - bitLength(den);
  let shift = prec - l;
  const divide = (s: number): { q: bigint; r: bigint; d: bigint } => {
    const n = s >= 0 ? num << BigInt(s) : num;
    const d = s >= 0 ? den : den << BigInt(-s);
    return { q: n / d, r: n % d, d };
  };
  let step = divide(shift);
  if (step.q >= top) {
    shift--;
    step = divide(shift);
  }
  let { q } = step;
  const twice = step.r * 2n;
  if (twice > step.d || (twice === step.d && (q & 1n) === 1n)) q += 1n;
  if (q === top) {
    q >>= 1n;
    shift--;
  }
  return { q, shift };
}

function bytesOf(n: bigint): Uint8Array {
  const hex = n.toString(16);
  return Uint8Array.from(Buffer.from(hex.length % 2 === 0 ? hex : `0${hex}`, "hex"));
}

function bigIntOf(bytes: Uint8Array): bigint {
  if (bytes.length === 0) return 0n;
  return BigInt(`0x${Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("hex")}`);
}

/** A suffix's digits as a bit count, or an error naming why it cannot be one. */
function readPrecision(s: string, prec: string): number {
  // A suffix longer than a uint32 is rejected without being converted.
  const p = prec.length <= 10 ? Number(prec) : 0;
  if (p === 0 || p > 0xffffffff) {
    throw new Error(
      `big float literal ${clipLiteral(s)}p${clipLiteral(prec)}: precision suffix p${clipLiteral(prec)} is not a positive bit count`,
    );
  }
  const n = bigFloatDigits(p);
  if (n > MAX_NUMERIC_LITERAL_DIGITS) {
    throw new Error(
      `big float literal ${clipLiteral(s)}p${p}: precision p${p} renders to ${n} digits; MaxNumericLiteralDigits=${MAX_NUMERIC_LITERAL_DIGITS}`,
    );
  }
  return p;
}

/** A decimal exponent's digits fit an int64, the reference's limit for one. */
function fitsInt64(exp: string): boolean {
  const digits = exp.replace(/^[+-]?0*/, "");
  if (digits.length > 19) return false;
  const v = BigInt(digits === "" ? "0" : digits);
  return v <= (exp.startsWith("-") ? 1n << 63n : (1n << 63n) - 1n);
}

const LITERAL_RE = /^(-?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;

/**
 * Reads a literal at the precision its suffix's digits state, or at 256 bits
 * when `prec` is undefined, round half even. The suffix is checked first, then
 * the digit limit, and the exponent bound on the rounded value.
 */
export function parseBigFloatLiteral(s: string, prec?: string): BigFloatFields {
  const suffixed = prec !== undefined;
  const readPrec = suffixed ? readPrecision(s, prec) : DEFAULT_PREC;

  const m = LITERAL_RE.exec(s);
  const whole = m?.[2] ?? "";
  const frac = m?.[3] ?? "";
  const exp = m?.[4] ?? "0";
  if (!m || whole.length + frac.length === 0 || !fitsInt64(exp)) {
    throw new Error(`invalid big float: ${clipLiteral(s)}`);
  }
  const negative = m[1] === "-";
  const digits = (whole + frac).replace(/^0+/, "");
  if (digits.length > MAX_NUMERIC_LITERAL_DIGITS) {
    throw new Error(`numeric literal has ${digits.length} digits; MaxNumericLiteralDigits=${MAX_NUMERIC_LITERAL_DIGITS}`);
  }
  if (digits === "") {
    return { mantissa: new Uint8Array(), exponent: 0, prec: suffixed ? readPrec : 0, negative };
  }

  // The value is digits × 10^scale. An exponent past a Number's safe range is
  // clamped: it stays far outside the bound, which is all it is used for here.
  const e = exp.replace(/^[+-]/, "").replace(/^0+/, "").length > 15 ? (exp.startsWith("-") ? -1e15 : 1e15) : Number(exp);
  const scale = e - frac.length;
  const magnitude = digits.length - 1 + scale;
  if (Math.abs(magnitude) > MAX_DECIMAL_MAGNITUDE) {
    throw new Error(
      `big float literal ${clipLiteral(s)} has a binary exponent past MaxBigFloatExponent=${MAX_BIG_FLOAT_EXPONENT}`,
    );
  }

  const power = 10n ** BigInt(Math.abs(scale));
  const d = BigInt(digits);
  const { q, shift } = scale >= 0 ? roundToPrec(d * power, 1n, readPrec) : roundToPrec(d, power, readPrec);
  const binary = readPrec - shift;
  if (exceedsExponentBound(binary)) {
    throw new Error(
      `big float literal ${clipLiteral(s)} has binary exponent ${binary}, and MaxBigFloatExponent=${MAX_BIG_FLOAT_EXPONENT} bounds its magnitude`,
    );
  }
  return { mantissa: bytesOf(q), exponent: 0 - shift, prec: readPrec, negative };
}

/** Reads a literal that arrives as one string, suffix included: a `(pxf.default)`. */
export function parseBigFloatString(s: string): BigFloatFields {
  const at = s.indexOf("p");
  if (at < 0) return parseBigFloatLiteral(s);
  const prec = s.slice(at + 1);
  if (prec === "") throw new Error(`big float literal ${clipLiteral(s)}: precision suffix p is not a positive bit count`);
  if (!/^\d+$/.test(prec)) throw new Error(`invalid big float: ${clipLiteral(s)}`);
  return parseBigFloatLiteral(s.slice(0, at), prec);
}

/** Rounds a digit string to `n` digits, half to even. `point` follows a carry out. */
function roundDigits(digits: string, point: number, n: number): { digits: string; point: number } {
  if (digits.length <= n) return { digits, point };
  const next = digits.charCodeAt(n) - 0x30;
  const tie = next === 5 && /^0*$/.test(digits.slice(n + 1));
  const odd = (digits.charCodeAt(n - 1) - 0x30) % 2 === 1;
  const kept = digits.slice(0, n);
  if (next < 5 || (tie && !odd)) return { digits: kept, point };
  const up = (BigInt(kept) + 1n).toString();
  return { digits: up, point: point + up.length - n };
}

/** C's `%g` at `n` significant digits of `0.digits × 10^point`, without trailing zeros. */
function formatG(all: string, point: number, n: number): string {
  const rounded = roundDigits(all, point, n);
  const digits = rounded.digits.replace(/0+$/, "");
  const at = rounded.point;
  const exp = at - 1;
  if (exp < -4 || exp >= n) {
    const rest = digits.slice(1);
    const abs = Math.abs(exp);
    return `${digits[0]!}${rest === "" ? "" : `.${rest}`}e${exp < 0 ? "-" : "+"}${abs < 10 ? "0" : ""}${abs}`;
  }
  if (at <= 0) return `0.${"0".repeat(-at)}${digits}`;
  if (digits.length <= at) return digits + "0".repeat(at - digits.length);
  return `${digits.slice(0, at)}.${digits.slice(at)}`;
}

/**
 * Writes the literal for a BigFloat's fields: `n` = {@link bigFloatDigits}
 * significant digits, round half even, in `%g` form, then `p<prec>`, so a
 * reader gets the value back exactly. A mantissa wider than prec is the value
 * rounded to prec. A message past either limit has no literal, and is an error.
 */
export function formatBigFloat(f: BigFloatFields): string {
  const sign = f.negative ? "-" : "";
  // A precision of zero is zero, whatever the other fields say.
  if (f.prec === 0) return `${sign}0`;
  const e = bigFloatBinaryExponent(f.mantissa, f.exponent);
  if (e !== undefined && exceedsExponentBound(e)) {
    throw new Error(`pxf.BigFloat binary exponent ${e} exceeds MaxBigFloatExponent=${MAX_BIG_FLOAT_EXPONENT}`);
  }
  const n = bigFloatDigits(f.prec);
  if (n > MAX_NUMERIC_LITERAL_DIGITS) {
    throw new Error(
      `pxf.BigFloat prec ${f.prec} bits renders to ${n} digits; MaxNumericLiteralDigits=${MAX_NUMERIC_LITERAL_DIGITS}`,
    );
  }
  const suffix = `p${f.prec}`;
  if (e === undefined) return `${sign}0${suffix}`;

  let mantissa = bigIntOf(f.mantissa);
  let exponent = f.exponent;
  if (bitLength(mantissa) > f.prec) {
    const { q, shift } = roundToPrec(mantissa, 1n, f.prec);
    mantissa = q;
    exponent -= shift;
    // Rounding can carry the value over the bound, where no reader takes it.
    const rounded = exponent + bitLength(q);
    if (exceedsExponentBound(rounded)) {
      throw new Error(`pxf.BigFloat binary exponent ${rounded} exceeds MaxBigFloatExponent=${MAX_BIG_FLOAT_EXPONENT}`);
    }
  }

  // m × 2^-k = m × 5^k × 10^-k, so the decimal expansion is exact.
  if (exponent >= 0) {
    const digits = (mantissa << BigInt(exponent)).toString();
    return `${sign}${formatG(digits, digits.length, n)}${suffix}`;
  }
  const k = -exponent;
  const digits = (mantissa * 5n ** BigInt(k)).toString();
  return `${sign}${formatG(digits, digits.length - k, n)}${suffix}`;
}
