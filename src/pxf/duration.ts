// SPDX-License-Identifier: MIT
// Copyright (c) 2026 TrendVidia, LLC.
//
// Go-style duration parse + format. Public exports of the helpers
// that the schema-bound `marshal` / `unmarshal` use internally for
// `google.protobuf.Duration` fields.
//
// Consumer use case: an editor UI that round-trips a config file
// holding Duration fields through unmarshal → typed message → user
// edit → marshal. The UI's form field is naturally a Go-duration
// string (`"720h"`, `"1h30m"`), not a `{seconds, nanos}` struct.
// `formatGoDuration` converts the parsed Duration to its string
// form for display; `parseGoDuration` converts the user's input
// back to the `{seconds, nanos}` shape that `@bufbuild/protobuf`'s
// `create()` accepts for the Duration init field.
//
// The format is Go's `time.Duration.String()` grammar:
//   <signed> <units>
//   units := <num>[.<frac>] (ns | us | µs | ms | s | m | h)+
//
// Examples:
//   "0s"         → { seconds: 0n,    nanos: 0 }
//   "720h"       → { seconds: 2592000n, nanos: 0 }
//   "1h30m"      → { seconds: 5400n,  nanos: 0 }
//   "500µs"      → { seconds: 0n,    nanos: 500000 }
//   "-2.5s"      → { seconds: -2n,   nanos: -500000000 }
//
// The decoder and encoder both import from this module so a single
// definition of Go-duration semantics powers both directions.

const NANOS_PER_SECOND = 1_000_000_000n;
const NANOS_PER_MICRO = 1_000n;
const NANOS_PER_MILLI = 1_000_000n;

const GO_DURATION_PART_RE = /^(\d+)(\.\d+)?(ns|us|µs|ms|s|m|h)/;

const GO_DURATION_UNIT_NANOS: Record<string, bigint> = {
  ns: 1n,
  us: 1_000n,
  "µs": 1_000n,
  ms: 1_000_000n,
  s: 1_000_000_000n,
  m: 60_000_000_000n,
  h: 3_600_000_000_000n,
};

/** DurationParts mirrors the seconds/nanos split that
 *  `google.protobuf.Duration` carries on the wire. Both fields share
 *  the overall sign — negative durations have negative seconds AND
 *  negative nanos (or zero on whichever doesn't contribute). */
export interface DurationParts {
  seconds: bigint;
  nanos: number;
}

/** Options for `formatGoDuration`. */
export interface FormatGoDurationOptions {
  /**
   * Strip trailing zero-valued h/m/s units from the emitted literal
   * (e.g. `720h0m0s` → `720h`, `1h30m0s` → `1h30m`). Internal zero
   * units between non-zero ones (`1h0m30s`) and sub-second forms
   * (`<n>ns`, `<n>µs`, `<n>ms`) are preserved unchanged. The
   * canonical zero `0s` always passes through.
   *
   * Default `false` preserves byte-equivalence with Go's
   * `time.Duration.String()` (the property the v1.0 line guarantees
   * for `marshal` output).
   */
  compact?: boolean;
}

/**
 * Parse a Go-style duration literal (e.g. `1h30m`, `-2.5s`, `100ms`)
 * into proto Duration `{seconds, nanos}`. Both parts share the
 * overall sign.
 *
 * Throws on syntax errors. Accepts a leading `+` or `-`; rejects an
 * empty string. The single-character literal `"0"` is treated as zero
 * even though it lacks a unit suffix (mirrors Go's `time.ParseDuration`
 * for the same edge case).
 *
 * Suitable for direct use as the init shape for `@bufbuild/protobuf`'s
 * `create(DurationSchema, ...)` — protobuf-es accepts a plain
 * `{seconds, nanos}` object there.
 */
export function parseGoDuration(s: string): DurationParts {
  if (s === "0") return { seconds: 0n, nanos: 0 };
  let neg = false;
  if (s.startsWith("-") || s.startsWith("+")) {
    neg = s[0] === "-";
    s = s.slice(1);
  }
  if (s === "") throw new Error("invalid duration");
  let totalNanos = 0n;
  while (s.length > 0) {
    const m = GO_DURATION_PART_RE.exec(s);
    if (m === null) throw new Error(`invalid duration: ${s}`);
    const intPart = m[1]!;
    const fracPart = m[2] ?? "";
    const unit = m[3]!;
    const unitNanos = GO_DURATION_UNIT_NANOS[unit];
    if (unitNanos === undefined) throw new Error(`unknown duration unit: ${unit}`);
    totalNanos += BigInt(intPart) * unitNanos;
    if (fracPart !== "") {
      const fracDigits = fracPart.slice(1);
      const fracInt = BigInt(fracDigits);
      const denom = 10n ** BigInt(fracDigits.length);
      totalNanos += (fracInt * unitNanos) / denom;
    }
    s = s.slice(m[0].length);
  }
  if (neg) totalNanos = -totalNanos;
  const sign = totalNanos < 0n ? -1n : 1n;
  const abs = sign * totalNanos;
  const secondsAbs = abs / NANOS_PER_SECOND;
  const nanosAbs = abs % NANOS_PER_SECOND;
  return {
    seconds: sign * secondsAbs,
    nanos: Number(sign * nanosAbs),
  };
}

/**
 * Format a proto Duration `{seconds, nanos}` as a Go-style duration
 * string. Mirrors `time.Duration.String()`: leading-zero h/m units
 * are omitted, sub-second durations use the smallest unit
 * (ns / µs / ms) that gives a non-zero leading digit, and `0s` is the
 * canonical zero.
 *
 * Pass `{ compact: true }` to strip trailing zero h/m/s units
 * (`720h0m0s` → `720h`); the default is full Go-canonical output for
 * byte-equivalence with the Go reference.
 */
export function formatGoDuration(
  d: DurationParts,
  options?: FormatGoDurationOptions,
): string {
  const compact = options?.compact ?? false;

  let total = d.seconds * NANOS_PER_SECOND + BigInt(d.nanos);
  if (total === 0n) return "0s";

  const neg = total < 0n;
  if (neg) total = -total;

  let out: string;
  if (total < NANOS_PER_SECOND) {
    if (total < NANOS_PER_MICRO) {
      out = `${total.toString()}ns`;
    } else if (total < NANOS_PER_MILLI) {
      out = `${trimFraction(total, NANOS_PER_MICRO)}µs`;
    } else {
      out = `${trimFraction(total, NANOS_PER_MILLI)}ms`;
    }
  } else {
    const secsPart = total / NANOS_PER_SECOND;
    const fracNanos = total % NANOS_PER_SECOND;
    const sec = secsPart % 60n;
    const minTotal = secsPart / 60n;
    const minute = minTotal % 60n;
    const hour = minTotal / 60n;

    const secStr = trimFraction(sec * NANOS_PER_SECOND + fracNanos, NANOS_PER_SECOND);

    if (hour > 0n) {
      out = `${hour.toString()}h${minute.toString()}m${secStr}s`;
    } else if (minute > 0n) {
      out = `${minute.toString()}m${secStr}s`;
    } else {
      out = `${secStr}s`;
    }
    if (compact) {
      out = compactTrailingZeroUnits(out);
    }
  }
  return neg ? `-${out}` : out;
}

/**
 * Trim trailing zero-valued h/m/s units. The `0` must be preceded by
 * a unit letter (h/m/s/µ/n), never by a digit — `720h` is never
 * trimmed to `72`. Internal zero units between non-zero ones
 * (`1h0m30s`) are preserved per Go's structural emit rule.
 */
function compactTrailingZeroUnits(s: string): string {
  if (s === "0s" || s === "-0s") return s;
  const neg = s.startsWith("-");
  let body = neg ? s.slice(1) : s;
  let prev = "";
  while (prev !== body) {
    prev = body;
    const m = body.match(/^(.+?[hmsµn])0(h|m|s)$/);
    if (m !== null) {
      const trimmed = m[1];
      if (trimmed !== undefined && trimmed !== "") {
        body = trimmed;
      }
    }
  }
  return neg ? `-${body}` : body;
}

/**
 * Format `value / unit` with up to (digits-of-unit) fractional places,
 * trailing zeros trimmed. Returns "5" not "5.000". Used by
 * `formatGoDuration` to print "1.5" out of `1500ms` ÷ `1000ms`.
 */
function trimFraction(value: bigint, unit: bigint): string {
  const whole = value / unit;
  const remainder = value % unit;
  if (remainder === 0n) return whole.toString();
  // Pad the remainder to width(unit)-1 zeros (i.e. 9 zeros for
  // nanoseconds), then trim trailing zeros to keep the literal terse.
  const unitDigits = unit.toString().length - 1;
  const fracStr = remainder.toString().padStart(unitDigits, "0");
  const trimmed = fracStr.replace(/0+$/, "");
  return `${whole.toString()}.${trimmed}`;
}
