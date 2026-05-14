// SPDX-License-Identifier: MIT
// Copyright (c) 2026 TrendVidia, LLC.
//
// Tests for the publicly-exported Go-style duration parse + format
// helpers. Round-trip property coverage that `parse(format(x)) === x`
// for representative inputs, plus the edge cases that drove the
// extraction (consumer UIs needing standalone access).

import { describe, expect, it } from "vitest";

import {
  type DurationParts,
  formatGoDuration,
  parseGoDuration,
} from "./duration.js";

describe("parseGoDuration", () => {
  it("parses whole-hour values", () => {
    expect(parseGoDuration("720h")).toEqual({ seconds: 2_592_000n, nanos: 0 });
  });

  it("parses hour + minute composition", () => {
    expect(parseGoDuration("1h30m")).toEqual({ seconds: 5400n, nanos: 0 });
  });

  it("parses canonical zero", () => {
    expect(parseGoDuration("0s")).toEqual({ seconds: 0n, nanos: 0 });
  });

  it("parses the special-case bare '0' (no unit)", () => {
    expect(parseGoDuration("0")).toEqual({ seconds: 0n, nanos: 0 });
  });

  it("parses sub-second us / µs / ms / ns", () => {
    expect(parseGoDuration("500us")).toEqual({ seconds: 0n, nanos: 500_000 });
    expect(parseGoDuration("500µs")).toEqual({ seconds: 0n, nanos: 500_000 });
    expect(parseGoDuration("100ms")).toEqual({ seconds: 0n, nanos: 100_000_000 });
    expect(parseGoDuration("250ns")).toEqual({ seconds: 0n, nanos: 250 });
  });

  it("parses fractional seconds", () => {
    expect(parseGoDuration("2.5s")).toEqual({ seconds: 2n, nanos: 500_000_000 });
  });

  it("parses negative values with shared sign on seconds + nanos", () => {
    const d = parseGoDuration("-2.5s");
    expect(d.seconds).toBe(-2n);
    expect(d.nanos).toBe(-500_000_000);
  });

  it("accepts leading +", () => {
    expect(parseGoDuration("+720h")).toEqual({ seconds: 2_592_000n, nanos: 0 });
  });

  it("rejects empty string", () => {
    expect(() => parseGoDuration("")).toThrow(/invalid duration/);
  });

  it("rejects an unknown unit suffix", () => {
    expect(() => parseGoDuration("5d")).toThrow(/invalid duration/);
  });

  it("rejects garbage", () => {
    expect(() => parseGoDuration("seven hours")).toThrow(/invalid duration/);
  });
});

describe("formatGoDuration", () => {
  it("emits canonical zero as 0s", () => {
    expect(formatGoDuration({ seconds: 0n, nanos: 0 })).toBe("0s");
  });

  it("emits hour composition with leading-zero h/m/s units (Go-canonical)", () => {
    // 720h is what time.Duration.String() emits as "720h0m0s".
    expect(formatGoDuration({ seconds: 2_592_000n, nanos: 0 })).toBe("720h0m0s");
  });

  it("emits 1h30m as 1h30m0s by default", () => {
    expect(formatGoDuration({ seconds: 5400n, nanos: 0 })).toBe("1h30m0s");
  });

  it("emits sub-second µs path", () => {
    expect(formatGoDuration({ seconds: 0n, nanos: 500_000 })).toBe("500µs");
  });

  it("emits sub-second ms path", () => {
    expect(formatGoDuration({ seconds: 0n, nanos: 100_000_000 })).toBe("100ms");
  });

  it("emits sub-microsecond ns path", () => {
    expect(formatGoDuration({ seconds: 0n, nanos: 250 })).toBe("250ns");
  });

  it("emits negative durations with leading -", () => {
    expect(formatGoDuration({ seconds: -2n, nanos: -500_000_000 })).toBe("-2.5s");
  });
});

describe("formatGoDuration + compact: true", () => {
  it("strips trailing zero units (720h0m0s → 720h)", () => {
    expect(formatGoDuration({ seconds: 2_592_000n, nanos: 0 }, { compact: true })).toBe("720h");
  });

  it("strips trailing zero units (1h30m0s → 1h30m)", () => {
    expect(formatGoDuration({ seconds: 5400n, nanos: 0 }, { compact: true })).toBe("1h30m");
  });

  it("preserves internal zero unit between non-zero h and s", () => {
    // 1 hour + 30 seconds = 3630s. Canonical "1h0m30s" — the 0m is
    // structural, not trailing; compact form keeps it.
    expect(formatGoDuration({ seconds: 3630n, nanos: 0 }, { compact: true })).toBe("1h0m30s");
  });

  it("0s stays 0s", () => {
    expect(formatGoDuration({ seconds: 0n, nanos: 0 }, { compact: true })).toBe("0s");
  });

  it("sub-second forms pass through unchanged", () => {
    expect(formatGoDuration({ seconds: 0n, nanos: 500_000 }, { compact: true })).toBe("500µs");
  });

  it("preserves sign on negative durations", () => {
    expect(formatGoDuration({ seconds: -2_592_000n, nanos: 0 }, { compact: true })).toBe("-720h");
  });
});

describe("round-trip: parse(format(x)) === x", () => {
  const cases: DurationParts[] = [
    { seconds: 0n, nanos: 0 },
    { seconds: 2_592_000n, nanos: 0 }, // 720h
    { seconds: 5400n, nanos: 0 },      // 1h30m0s
    { seconds: 3630n, nanos: 0 },      // 1h0m30s
    { seconds: 2n, nanos: 500_000_000 },   // 2.5s
    { seconds: 0n, nanos: 500_000 },       // 500µs
    { seconds: 0n, nanos: 100_000_000 },   // 100ms
    { seconds: 0n, nanos: 250 },           // 250ns
    { seconds: -2n, nanos: -500_000_000 }, // -2.5s
  ];
  for (const c of cases) {
    it(`{ seconds: ${c.seconds}, nanos: ${c.nanos} }`, () => {
      expect(parseGoDuration(formatGoDuration(c))).toEqual(c);
      expect(parseGoDuration(formatGoDuration(c, { compact: true }))).toEqual(c);
    });
  }
});
