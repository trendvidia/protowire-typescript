// SPDX-License-Identifier: MIT
// Copyright (c) 2026 TrendVidia, LLC.
/**
 * Language values for `pxf.Decimal` and `pxf.BigFloat`, the JavaScript twins
 * of protowire-go's `*big.Rat` and `*big.Float` (protowire#509). They hold a
 * value exactly and do no arithmetic: convert to a library of your choice to
 * compute with one.
 */

import {
  bigIntOf,
  bitLength,
  bytesOf,
  formatBigFloat,
  parseBigFloatString,
  roundToPrec,
} from "../pxf/bigfloat.js";
import { parseDecimal } from "../pxf/bignum.js";

/**
 * A decimal number: `unscaled × 10^(-scale)`. A negative scale means trailing
 * zeros, so `new Decimal(5n, -2)` is 500.
 *
 * It keeps the scale it is given, so `Decimal.parse("1.50").toString()` is
 * `"1.50"`. Written to `pb` it takes the reduced form a `big.Rat` has, with no
 * trailing zeros after the point: 1.50 is written as 1.5, and 1.00 as 1, as
 * protowire-go writes them.
 */
export class Decimal {
  readonly unscaled: bigint;
  readonly scale: number;

  constructor(unscaled: bigint, scale = 0) {
    if (!Number.isSafeInteger(scale)) {
      throw new RangeError(`Decimal scale ${scale} is not an integer`);
    }
    this.unscaled = unscaled;
    this.scale = scale;
  }

  /** Reads a PXF decimal literal: digits with an optional point, such as `-1.50`. */
  static parse(s: string): Decimal {
    const f = parseDecimal(s);
    const abs = bigIntOf(f.unscaled);
    return new Decimal(f.negative ? -abs : abs, f.scale);
  }

  isZero(): boolean {
    return this.unscaled === 0n;
  }

  /**
   * The same value with the least scale that is not negative: what a `big.Rat`
   * holds, and what `pb` writes.
   */
  reduced(): Decimal {
    let u = this.unscaled;
    let s = this.scale;
    if (s < 0) {
      u *= 10n ** BigInt(-s);
      s = 0;
    }
    if (u === 0n) return new Decimal(0n, 0);
    while (s > 0 && u % 10n === 0n) {
      u /= 10n;
      s--;
    }
    return new Decimal(u, s);
  }

  /** Whether the two are the same number, whatever their scales. */
  equals(other: Decimal): boolean {
    const a = this.reduced();
    const b = other.reduced();
    return a.unscaled === b.unscaled && a.scale === b.scale;
  }

  toString(): string {
    const sign = this.unscaled < 0n ? "-" : "";
    let abs = this.unscaled < 0n ? -this.unscaled : this.unscaled;
    if (this.scale <= 0) {
      if (this.scale < 0) abs *= 10n ** BigInt(-this.scale);
      return sign + abs.toString();
    }
    const digits = abs.toString().padStart(this.scale + 1, "0");
    const point = digits.length - this.scale;
    return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
  }
}

/** The parts a {@link BigFloat} is built from. */
export interface BigFloatParts {
  /** The magnitude's integer mantissa, not negative. */
  readonly mantissa: bigint;
  /** value = ±mantissa × 2^exponent. */
  readonly exponent: number;
  /** Bits of precision; the value is rounded to it, half to even. */
  readonly prec: number;
  /** The sign, which a zero keeps too: -0 is a value. */
  readonly negative?: boolean;
}

/**
 * A binary floating-point number of a stated precision, as `big.Float` holds
 * one: `(-1)^negative × mantissa × 2^exponent`, rounded to `prec` bits, half
 * to even. A precision of 0 holds only ±0, as `big.Float` does.
 *
 * The constructor rounds and normalises, so two that are the same value at the
 * same precision have the same parts: `mantissa` has no trailing zero bits, and
 * a zero has mantissa 0 and exponent 0.
 */
export class BigFloat {
  readonly mantissa: bigint;
  readonly exponent: number;
  readonly prec: number;
  readonly negative: boolean;

  constructor(parts: BigFloatParts) {
    const { prec } = parts;
    if (!Number.isInteger(prec) || prec < 0 || prec > 0xffffffff) {
      throw new RangeError(`BigFloat prec ${prec} is not a uint32`);
    }
    if (parts.mantissa < 0n) {
      throw new RangeError("BigFloat mantissa is negative; set negative instead");
    }
    if (!Number.isSafeInteger(parts.exponent)) {
      throw new RangeError(`BigFloat exponent ${parts.exponent} is not an integer`);
    }
    let m = prec === 0 ? 0n : parts.mantissa;
    let e = parts.exponent;
    if (m !== 0n && bitLength(m) > prec) {
      const { q, shift } = roundToPrec(m, 1n, prec);
      m = q;
      e -= shift;
    }
    if (m === 0n) {
      e = 0;
    } else {
      // Drop the trailing zero bits: m & -m is the lowest set bit.
      const zeros = bitLength(m & -m) - 1;
      m >>= BigInt(zeros);
      e += zeros;
    }
    this.mantissa = m;
    this.exponent = e;
    this.prec = prec;
    this.negative = parts.negative ?? false;
  }

  /**
   * Reads a PXF big float literal, such as `1.5p64` or `-0`. Without a
   * precision suffix it is read at 256 bits, as PXF reads one.
   */
  static parse(s: string): BigFloat {
    const f = parseBigFloatString(s);
    return new BigFloat({ mantissa: bigIntOf(f.mantissa), exponent: f.exponent, prec: f.prec, negative: f.negative });
  }

  /** The exact value of a finite number, at 53 bits as `big.NewFloat` makes it. */
  static fromNumber(x: number, prec = 53): BigFloat {
    if (!Number.isFinite(x)) throw new RangeError(`BigFloat has no ${x}`);
    const negative = x < 0 || Object.is(x, -0);
    let m = Math.abs(x);
    let e = 0;
    // Doubling a double is exact, and a finite one is an integer within 1074.
    while (!Number.isInteger(m)) {
      m *= 2;
      e--;
    }
    return new BigFloat({ mantissa: BigInt(m), exponent: e, prec, negative });
  }

  isZero(): boolean {
    return this.mantissa === 0n;
  }

  /** Same value, sign and precision. */
  equals(other: BigFloat): boolean {
    return (
      this.mantissa === other.mantissa &&
      this.exponent === other.exponent &&
      this.prec === other.prec &&
      this.negative === other.negative
    );
  }

  /** The PXF literal, such as `1.5p64`, from which {@link BigFloat.parse} reads it back. */
  toString(): string {
    return formatBigFloat({
      mantissa: this.mantissa === 0n ? new Uint8Array() : bytesOf(this.mantissa),
      exponent: this.exponent,
      prec: this.prec,
      negative: this.negative,
    });
  }
}
