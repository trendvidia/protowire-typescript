// SPDX-License-Identifier: MIT
// Copyright (c) 2026 TrendVidia, LLC.
import { describe, it, expect } from "vitest";
import { Reader, Writer, WireType } from "./wire.js";

function roundTripVarint(value: number | bigint): bigint {
  const w = new Writer();
  w.varint(value);
  const r = new Reader(w.finish());
  return r.varintBig();
}

describe("Writer/Reader varint", () => {
  it("encodes 0 as a single byte", () => {
    const w = new Writer();
    w.varint(0);
    expect(w.finish()).toEqual(new Uint8Array([0]));
  });

  it("round-trips small numbers", () => {
    for (const v of [0, 1, 127, 128, 255, 256, 16383, 16384]) {
      expect(Number(roundTripVarint(v))).toBe(v);
    }
  });

  it("round-trips numbers up to MAX_SAFE_INTEGER", () => {
    const v = Number.MAX_SAFE_INTEGER;
    expect(Number(roundTripVarint(v))).toBe(v);
  });

  it("round-trips bigints across the uint64 range", () => {
    const cases = [0n, 1n, 0x80n, 0xffn, 0xffffn, 0xffff_ffffn, 0xffff_ffff_ffff_ffffn];
    for (const v of cases) {
      expect(roundTripVarint(v)).toBe(v);
    }
  });

  it("encodes 150 as the canonical proto example [0x96, 0x01]", () => {
    const w = new Writer();
    w.varint(150);
    expect(w.finish()).toEqual(new Uint8Array([0x96, 0x01]));
  });
});

describe("zigzag", () => {
  it("matches the proto3 zigzag spec for 32-bit", () => {
    const cases: Array<[number, number]> = [
      [0, 0],
      [-1, 1],
      [1, 2],
      [-2, 3],
      [2147483647, 4294967294],
      [-2147483648, 4294967295],
    ];
    for (const [signed, encoded] of cases) {
      const w = new Writer();
      w.zigzag32(signed);
      const bytes = w.finish();
      const r = new Reader(bytes);
      expect(Number(r.varintBig())).toBe(encoded);

      const r2 = new Reader(bytes);
      expect(r2.zigzag32()).toBe(signed);
    }
  });

  it("round-trips 64-bit zigzag for boundary values", () => {
    const cases = [
      0n,
      -1n,
      1n,
      -2n,
      9223372036854775807n, // int64 max
      -9223372036854775808n, // int64 min
    ];
    for (const v of cases) {
      const w = new Writer();
      w.zigzag64(v);
      const r = new Reader(w.finish());
      expect(r.zigzag64()).toBe(v);
    }
  });
});

describe("fixed widths", () => {
  it("round-trips fixed32", () => {
    for (const v of [0, 1, 0x7fff_ffff, 0xffff_ffff]) {
      const w = new Writer();
      w.fixed32(v);
      const r = new Reader(w.finish());
      expect(r.fixed32()).toBe(v);
    }
  });

  it("round-trips fixed64 across uint64", () => {
    const cases = [0n, 1n, 0xffff_ffffn, 0xffff_ffff_ffff_ffffn];
    for (const v of cases) {
      const w = new Writer();
      w.fixed64(v);
      const r = new Reader(w.finish());
      expect(r.fixed64()).toBe(v);
    }
  });

  it("round-trips floats and doubles", () => {
    const w = new Writer();
    w.float(2.5);
    w.double(3.141592653589793);
    const r = new Reader(w.finish());
    expect(r.float()).toBeCloseTo(2.5, 5);
    expect(r.double()).toBe(3.141592653589793);
  });
});

describe("strings and bytes", () => {
  it("round-trips utf-8 strings", () => {
    const w = new Writer();
    w.string("héllo, 世界");
    const r = new Reader(w.finish());
    expect(r.string()).toBe("héllo, 世界");
  });

  it("round-trips bytes", () => {
    const w = new Writer();
    w.bytes(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
    const r = new Reader(w.finish());
    expect(r.bytes()).toEqual(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
  });
});

describe("tags", () => {
  it("encodes (1, Varint) as 0x08", () => {
    const w = new Writer();
    w.tag(1, WireType.Varint);
    expect(w.finish()).toEqual(new Uint8Array([0x08]));
  });

  it("decodes back to (fieldNumber, wireType)", () => {
    const w = new Writer();
    w.tag(15, WireType.LengthDelimited);
    const r = new Reader(w.finish());
    expect(r.tag()).toEqual({ fieldNumber: 15, wireType: WireType.LengthDelimited });
  });
});

describe("skip", () => {
  it("skips varint, fixed32, fixed64, length-delim", () => {
    const w = new Writer();
    w.tag(1, WireType.Varint);
    w.varint(150);
    w.tag(2, WireType.Fixed32);
    w.fixed32(0xdead_beef);
    w.tag(3, WireType.Fixed64);
    w.fixed64(0xdead_beef_cafe_baben);
    w.tag(4, WireType.LengthDelimited);
    w.string("skip me");
    w.tag(5, WireType.Varint);
    w.varint(7);

    const r = new Reader(w.finish());
    while (!r.eof()) {
      const { fieldNumber, wireType } = r.tag();
      if (fieldNumber === 5) {
        expect(r.varint()).toBe(7);
      } else {
        r.skip(wireType);
      }
    }
  });

  it("follows a group to its own end-group, and refuses what protobuf-go refuses", () => {
    // Field 3: start group, field 1 = 1, a nested group 2, end group 3; then field 4.
    const r = new Reader(Uint8Array.from([0x1b, 0x08, 0x01, 0x13, 0x14, 0x1c, 0x20, 0x07]));
    const { fieldNumber, wireType } = r.tag();
    r.skip(wireType, fieldNumber);
    expect(r.tag()).toEqual({ fieldNumber: 4, wireType: WireType.Varint });
    const skip = (bytes: number[], wireType: number, fieldNumber = 1) => () =>
      new Reader(Uint8Array.from(bytes)).skip(wireType as WireType, fieldNumber);
    expect(skip([0x14], WireType.StartGroup)).toThrow("proto: mismatching end group marker"); // field 2 ends group 1
    expect(skip([], WireType.EndGroup)).toThrow("proto: mismatching end group marker");
    expect(skip([0x01], 6)).toThrow("proto: cannot parse reserved wire type");
    expect(skip([0x01], 7)).toThrow("proto: cannot parse reserved wire type");
    expect(skip([0x01, 0x00], WireType.Fixed32)).toThrow("unexpected EOF");
    expect(skip([0x02, 0x00], WireType.LengthDelimited)).toThrow("unexpected EOF");
    expect(skip([0x00], WireType.StartGroup)).toThrow("proto: invalid field number");
    expect(skip([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x02], WireType.Varint)).toThrow(
      "proto: variable length integer overflow",
    );
  });

  it("does not run past the end it is given", () => {
    const r = new Reader(Uint8Array.from([0x01, 0x00, 0x00, 0x00]));
    expect(() => r.skip(WireType.Fixed32, 1, 2)).toThrow("unexpected EOF");
  });

  it("rejects truncated varint", () => {
    const r = new Reader(new Uint8Array([0x80]));
    expect(() => r.varintBig()).toThrow(/truncated/);
  });
});
