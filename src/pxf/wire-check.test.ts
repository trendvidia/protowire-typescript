// SPDX-License-Identifier: MIT
// Copyright (c) 2026 TrendVidia, LLC.
/**
 * #125: `@bufbuild/protobuf` 2.12.0's `fromBinary` reads a value cut short from
 * the bytes after it, takes a varint whose tenth byte overflows, a stray
 * end-group and a field number past 2^29-1, and protobuf-go refuses each
 * (trendvidia/protowire#614). `checkWire` reads the bytes by the descriptor
 * first, wherever this port hands untrusted bytes to `fromBinary`: check-decode's
 * pb-render and an Any's value in the encoder.
 *
 * Every verdict a case gives as protobuf-go's was run through protowire-go's
 * check_decode (v1.19.0, protobuf-go v1.36.12) on the spec's
 * adversarial.proto, whose messages the first file below copies, and the
 * group and packed cases through protobuf-go's proto.Unmarshal into a
 * dynamicpb message of the second file.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { create, createFileRegistry, fromBinary, toBinary } from "@bufbuild/protobuf";
import { AnySchema, FileDescriptorSetSchema } from "@bufbuild/protobuf/wkt";
import { describe, expect, it } from "vitest";

import { unmarshal } from "./decode.js";
import { marshal, unpackAny } from "./encode.js";
import { PROTOBUF_GO_RECURSION_LIMIT, checkWire, fromBinaryChecked } from "./wire-check.js";

const T = { INT64: 3, INT32: 5, FIXED32: 7, STRING: 9, GROUP: 10, MESSAGE: 11, BYTES: 12 } as const;
const L = { OPTIONAL: 1, REPEATED: 3 } as const;

function f(name: string, number: number, type: number, label: number = L.OPTIONAL, typeName?: string) {
  return { name, number, type, label, ...(typeName ? { typeName } : {}) };
}

function entry(name: string, value: ReturnType<typeof f>) {
  return { name, field: [f("key", 1, T.STRING), value], options: { mapEntry: true } };
}

const reg = createFileRegistry(
  create(FileDescriptorSetSchema, {
    file: [
      {
        // The spec's testdata/adversarial/adversarial.proto, its PB messages.
        name: "adversarial.proto",
        package: "adversarial.v1",
        syntax: "proto3",
        messageType: [
          {
            name: "Tree",
            field: [
              f("child", 1, T.MESSAGE, L.OPTIONAL, ".adversarial.v1.Tree"),
              f("label", 2, T.STRING),
              f("children", 3, T.MESSAGE, L.REPEATED, ".adversarial.v1.Tree"),
              f("branches", 4, T.MESSAGE, L.REPEATED, ".adversarial.v1.Tree.BranchesEntry"),
              f("tags", 5, T.MESSAGE, L.REPEATED, ".adversarial.v1.Tree.TagsEntry"),
            ],
            nestedType: [
              entry("BranchesEntry", f("value", 2, T.MESSAGE, L.OPTIONAL, ".adversarial.v1.Tree")),
              entry("TagsEntry", f("value", 2, T.STRING)),
            ],
          },
          { name: "StringHolder", field: [f("value", 1, T.STRING)] },
          { name: "BytesHolder", field: [f("value", 1, T.BYTES)] },
          { name: "BigIntHolder", field: [f("value", 1, T.INT64)] },
          { name: "ListHolder", field: [f("values", 1, T.INT32, L.REPEATED)] },
        ],
      },
      {
        // proto2: message G { optional group Grp = 1 { map<string, string> m = 1; } }
        //         message P { repeated fixed32 f = 1; }
        name: "group.proto",
        package: "wirecheck.v1",
        syntax: "proto2",
        messageType: [
          {
            name: "G",
            field: [f("grp", 1, T.GROUP, L.OPTIONAL, ".wirecheck.v1.G.Grp")],
            nestedType: [
              {
                name: "Grp",
                field: [f("m", 1, T.MESSAGE, L.REPEATED, ".wirecheck.v1.G.Grp.MEntry")],
                nestedType: [entry("MEntry", f("value", 2, T.STRING))],
              },
            ],
          },
          { name: "P", field: [f("f", 1, T.FIXED32, L.REPEATED)] },
        ],
      },
    ],
  }),
);

const msg = (name: string) => reg.getMessage(name)!;
const Tree = msg("adversarial.v1.Tree");
const G = msg("wirecheck.v1.G");
const P = msg("wirecheck.v1.P");

function hex(s: string): Uint8Array {
  return Uint8Array.from(Buffer.from(s, "hex"));
}

/** What check-decode's pb-render does with the bytes: undefined when accepted. */
function pbRender(schema: string, h: string): string | undefined {
  const desc = msg(`adversarial.v1.${schema}`);
  try {
    marshal(fromBinaryChecked(desc, hex(h), PROTOBUF_GO_RECURSION_LIMIT), desc);
    return undefined;
  } catch (e) {
    return (e as Error).message;
  }
}

/** n Trees nested through child (field 1) around `inner`, built from the inside out. */
function nested(n: number, inner: number[]): Uint8Array {
  const rev = inner.slice().reverse();
  for (let i = 0; i < n; i++) {
    let v = rev.length;
    const len: number[] = [];
    while (v >= 0x80) {
      len.push((v & 0x7f) | 0x80);
      v >>>= 7;
    }
    len.push(v);
    for (let j = len.length - 1; j >= 0; j--) rev.push(len[j]!);
    rev.push(0x0a);
  }
  return Uint8Array.from(rev.reverse());
}

const RESERVED = "corrupt field 3 in map entry: proto: cannot parse reserved wire type";

describe("pb-render refuses what protobuf-go refuses", () => {
  // #125's table: what fromBinary accepted and protobuf-go refuses.
  it.each([
    ["BigIntHolder", "0a01", "corrupt field 1: unexpected EOF"], // a length-delimited int64 cut short
    ["BigIntHolder", "0d01", "corrupt field 1: unexpected EOF"], // a fixed32 int64 cut short
    ["BigIntHolder", "08ffffffffffffffffff7f", "corrupt field 1: proto: variable length integer overflow"],
    ["BigIntHolder", "0c01", "corrupt field 1: proto: mismatching end group marker"], // a stray end-group
    ["StringHolder", "0c0161", "corrupt field 1: proto: mismatching end group marker"],
    ["BigIntHolder", "0b01", "corrupt field 1: proto: invalid field number"], // a group that never ends
    ["Tree", "0a011200", "corrupt field 2: unexpected EOF"], // child's label takes its length from the parent
    ["Tree", "2a020a0100", "corrupt field 1 in map entry: unexpected EOF"], // the same in a map entry
    ["ListHolder", "0a018001", "corrupt field 1: unexpected EOF"], // a packed varint finished by the parent
    ["ListHolder", "0a0b08ffffffffffffffffff7f", "corrupt field 1: proto: variable length integer overflow"],
  ])("%s %s", (schema, h, want) => {
    expect(pbRender(schema, h)).toBe(want);
    // fromBinary alone takes them: the day an upgrade refuses them, this
    // fails, and the walk is no longer what stops them.
    expect(() => fromBinary(msg(`adversarial.v1.${schema}`), hex(h))).not.toThrow();
  });

  // Refused before the walk too, by fromBinary; now in protowire-go's words.
  it.each([
    ["BigIntHolder", "0e01", "corrupt field 1: proto: cannot parse reserved wire type"],
    ["StringHolder", "0f0161", "corrupt field 1: proto: cannot parse reserved wire type"],
    ["BigIntHolder", "9f06", "corrupt field 99: proto: cannot parse reserved wire type"],
    ["BigIntHolder", "9e0601", "corrupt field 99: proto: cannot parse reserved wire type"],
    ["Tree", "2c", "corrupt field 5: proto: mismatching end group marker"],
    ["BigIntHolder", "0c", "corrupt field 1: proto: mismatching end group marker"],
    // fromBinary reads a tag as 32 bits, so a field number past 2^29-1 does
    // not fit it either.
    ["BigIntHolder", "888080801005", "corrupt tag"], // field 2^29+1
    ["BigIntHolder", "f8ffffff1f05", "corrupt tag"], // field 2^32-1
    ["Tree", "2b1f2c", "corrupt field 5: proto: cannot parse reserved wire type"], // in an unknown group
  ])("%s %s", (schema, h, want) => {
    expect(pbRender(schema, h)).toBe(want);
  });

  // What protobuf-go accepts passes. The field number 2^29-1 is the largest.
  it.each([
    ["BigIntHolder", "f8ffff7f05"],
    ["BigIntHolder", "08ffffffffffffffffff01"], // a tenth byte of 1 is in range
    ["ListHolder", "0a020101"],
    ["ListHolder", "0a00"],
    ["Tree", "4b4c"], // an empty unknown group
  ])("%s %s passes", (schema, h) => {
    expect(pbRender(schema, h)).toBeUndefined();
  });

  // Still divergent, and not this walk's to fix (#125, open). protobuf-go
  // skips a known field whose wire type does not match; fromBinary reads it
  // by its declared type, and refuses. The walk passes the bytes, since they
  // hold nothing protobuf-go refuses, so fromBinary is what refuses them.
  it.each([
    ["BigIntHolder", "0a0101", "illegal tag: field no 0 wire type 1"],
    ["BigIntHolder", "0d01000000", "illegal tag: field no 0 wire type 0"],
    ["StringHolder", "0801", "premature EOF"],
    ["Tree", "2801", "premature EOF"], // a map field sent as a varint
    ["Tree", "2b2c", "premature EOF"], // a map field sent as an empty group
    ["Tree", "2a021801", "illegal tag: field no 0 wire type 1"], // an unknown field in an entry
    ["Tree", "2a020801", "premature EOF"], // an entry's key sent as a varint
  ])("%s %s: protobuf-go accepts, fromBinary refuses", (schema, h, why) => {
    expect(checkWire(msg(`adversarial.v1.${schema}`), hex(h), PROTOBUF_GO_RECURSION_LIMIT)).toBeUndefined();
    expect(pbRender(schema, h)).toBe(why);
  });

  // The same rule with an accept on both sides: protobuf-go skips an empty
  // group sent on the int64 and leaves the value 0, and fromBinary reads the
  // end-group tag as the value 12.
  it("BigIntHolder 0b0c: both accept, with different values", () => {
    expect(pbRender("BigIntHolder", "0b0c")).toBeUndefined();
    expect(fromBinary(msg("adversarial.v1.BigIntHolder"), hex("0b0c"))).toMatchObject({ value: 12n });
  });
});

describe("a map entry is read wherever it sits", () => {
  // fromBinary refuses each of these as well (`illegal tag: field no 3 wire
  // type 7`): its tag reader refuses wire types 6 and 7 everywhere. The walk
  // now refuses them first, in protowire-go's words.
  it.each([
    ["2a011f", RESERVED], // tags entry holding field 3, wire type 7
    ["2a011e", RESERVED], // wire type 6
    ["2a031f0a00", RESERVED], // the bad field, then a key
    ["2a030a001f", RESERVED], // a key, then the bad field
    ["22011f", RESERVED], // a branches entry
    ["0a032a011f", RESERVED], // child, then the bad entry
    ["0a050a032a011f", RESERVED], // child, child, then the bad entry
    ["1a032a011f", RESERVED], // children[0], then the bad entry
    ["220512032a011f", RESERVED], // a branches value Tree holding the bad entry
    ["2a031b1f1c", RESERVED], // a group 3 in the entry holding wire type 7
    ["2a032b1f2c", "corrupt field 5 in map entry: proto: cannot parse reserved wire type"],
    ["2a0b08ffffffffffffffffff7f", "corrupt field 1 in map entry: proto: variable length integer overflow"],
    ["2a06888080801005", "corrupt tag in map entry"],
  ])("%s", (h, want) => {
    expect(checkWire(Tree, hex(h), 100)).toBe(want);
    expect(pbRender("Tree", h)).toBe(want);
  });

  // Only messages are read into. protobuf-go accepts each of these.
  it.each([
    ["", "nothing"],
    ["2a00", "an empty entry"],
    ["2a022b2c", "an entry holding an empty group"],
    ["12032a011f", "a label holding bytes that would not parse as a Tree"],
    ["2a0512032a011f", "a tags value holding them"],
    ["4a032a011f", "an unknown field holding them"],
  ])("%s (%s) passes", (h) => {
    expect(checkWire(Tree, hex(h), 100)).toBeUndefined();
    expect(pbRender("Tree", h)).toBeUndefined();
  });

  it("bytes that would not parse as a message pass in a bytes field", () => {
    expect(pbRender("BytesHolder", "0a032a011f")).toBeUndefined();
  });
});

describe("a group is read as a message", () => {
  it.each([
    ["0b0a011f0c", RESERVED],
    ["0b0a020a000c", undefined], // an entry with an empty key
    ["0b0c", undefined], // an empty group
    ["0b0a00", "corrupt field 1: unexpected EOF"], // no end-group
    ["0b0a0014", "corrupt field 2: proto: mismatching end group marker"], // the wrong end-group
  ])("%s", (h, want) => {
    expect(checkWire(G, hex(h), 100)).toBe(want);
  });

  it("a group past the depth limit is skipped, not read into", () => {
    expect(checkWire(G, hex("0b1f0c"), 100)).toBe("corrupt field 3: proto: cannot parse reserved wire type");
    // Skipped as protobuf-go's ConsumeFieldValue skips it: the reserved wire
    // type is refused, and the entry inside is not read.
    expect(checkWire(G, hex("0b1f0c"), 0)).toBe("corrupt field 1: proto: cannot parse reserved wire type");
    expect(checkWire(G, hex("0b0a011f0c"), 0)).toBeUndefined();
  });
});

describe("a packed list is read by its elements' wire type", () => {
  it.each([
    ["0a0401000000", undefined],
    ["0a03010000", "corrupt field 1: unexpected EOF"],
    ["0a0301000000", "corrupt field 1: unexpected EOF"],
  ])("%s", (h, want) => {
    expect(checkWire(P, hex(h), 100)).toBe(want);
  });

  it("fromBinary finishes a packed fixed32 with its parent's byte", () => {
    expect(fromBinary(P, hex("0a0301000000"))).toMatchObject({ f: [1] });
  });
});

describe("depth", () => {
  // The walk counts one descent for each submessage, group and map entry and
  // reads no deeper than it is told: the bad entry here is the fourth descent.
  it("stops at the limit it is given", () => {
    const bytes = nested(3, [0x2a, 0x01, 0x1f]);
    expect(checkWire(Tree, bytes, 4)).toBe(RESERVED);
    expect(checkWire(Tree, bytes, 3)).toBeUndefined();
  });

  // It keeps its open messages on a list, not the call stack: 200000 nested
  // Trees, with a bad entry at the bottom. fromBinary runs out of stack on
  // this; the walk does not.
  it("walks 200000 levels without recursing", () => {
    expect(checkWire(Tree, nested(200_000, []), Infinity)).toBeUndefined();
    expect(checkWire(Tree, nested(200_000, [0x2a, 0x01, 0x1f]), Infinity)).toBe(RESERVED);
    expect(() => fromBinary(Tree, nested(200_000, []))).toThrow(RangeError);
  });

  it("pb-render refuses a deep input without crashing", () => {
    const bytes = Buffer.from(nested(200_000, [0x2a, 0x01, 0x1f])).toString("hex");
    expect(pbRender("Tree", bytes)).toBeDefined();
  });
});

describe("an Any's value is checked before fromBinary reads it", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const anyReg = createFileRegistry(
    fromBinary(FileDescriptorSetSchema, new Uint8Array(readFileSync(resolve(here, "testdata/any-readback-test.binpb")))),
  );
  const Holder = anyReg.getMessage("anyreadback.v1.Holder")!;
  // Inner { string a = 1; int32 b = 2; map<string, int32> m = 3; Timestamp ts = 4; }
  const Inner = anyReg.getMessage("anyreadback.v1.Inner")!;
  const typeResolver = { findMessageByURL: (u: string) => anyReg.getMessage(u.slice(u.lastIndexOf("/") + 1)) };

  function written(value: string): { text: string; same: boolean } {
    const payload = create(AnySchema, { typeUrl: "type.googleapis.com/anyreadback.v1.Inner", value: hex(value) });
    const m = create(Holder, { payload } as never);
    const text = marshal(m, Holder, { typeResolver });
    const back = unmarshal(text, Holder, { typeResolver });
    return { text, same: toBinary(Holder, back).every((b, i) => b === toBinary(Holder, m)[i]) };
  }

  // #125's done-when: a value holding a record whose wire type does not
  // match its field is written as type_url and value. This held before the
  // walk too, since a body is written only when it reads back as the same
  // bytes (protowire#501).
  it.each([
    ["0801", "a as a varint: fromBinary refuses it"],
    ["1501000000", "b as a fixed32: fromBinary reads 1, then refuses the rest"],
    ["1501", "b as a fixed32 cut short: fromBinary reads 1, the walk refuses it"],
    ["1801", "m as a varint"],
  ])("%s (%s) stays raw", (value) => {
    const { text, same } = written(value);
    expect(text).toContain("type_url = ");
    expect(text).not.toContain("@type = ");
    expect(same).toBe(true);
  });

  // What the walk changes: fromBinary no longer decides what is unpacked.
  it.each([
    ["1501", "b as a fixed32 cut short"],
    ["1a011f", "an m entry holding wire type 7"],
    ["1a011e", "an m entry holding wire type 6"],
    ["1f", "wire type 7 on the message itself"],
  ])("%s (%s) is not unpacked", (value) => {
    expect(unpackAny(Inner, hex(value), 100)).toBeUndefined();
  });

  it("a well-formed value is unpacked", () => {
    expect(unpackAny(Inner, hex("1a00"), 100)).toBeDefined();
    expect(written("0a0178").text).toContain('@type = "type.googleapis.com/anyreadback.v1.Inner"');
  });
});
