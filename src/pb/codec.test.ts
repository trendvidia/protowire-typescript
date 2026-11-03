// SPDX-License-Identifier: MIT
// Copyright (c) 2026 TrendVidia, LLC.
import { Envelope, EnvelopePb, newAppError } from "../envelope/index.js";
import { describe, it, expect } from "vitest";
import {
  BigFloatCodec,
  defineMessage,
  marshal,
  MAX_NESTING_DEPTH,
  unmarshal,
  type MessageCodec,
} from "./codec.js";

interface Inner {
  name: string;
  value: number;
}

const InnerPb: MessageCodec<Inner> = defineMessage<Inner>({
  fields: [
    { number: 1, name: "name", kind: "string" },
    { number: 2, name: "value", kind: "int32" },
  ],
  create: () => ({ name: "", value: 0 }),
});

interface Outer {
  title: string;
  count: number;
  score: number;
  active: boolean;
  data: Uint8Array;
  items: Inner[];
  signed: bigint;
  smallF: number;
}

const OuterPb: MessageCodec<Outer> = defineMessage<Outer>({
  fields: [
    { number: 1, name: "title", kind: "string" },
    { number: 2, name: "count", kind: "uint32" },
    { number: 3, name: "score", kind: "double" },
    { number: 4, name: "active", kind: "bool" },
    { number: 5, name: "data", kind: "bytes" },
    { number: 6, name: "items", kind: { message: InnerPb }, repeated: true },
    { number: 8, name: "signed", kind: "int64" },
    { number: 9, name: "smallF", kind: "float" },
  ],
  create: () => ({
    title: "",
    count: 0,
    score: 0,
    active: false,
    data: new Uint8Array(),
    items: [],
    signed: 0n,
    smallF: 0,
  }),
});

describe("scalar + nested + repeated round-trip", () => {
  it("round-trips a populated message", () => {
    const orig: Outer = {
      title: "hello",
      count: 42,
      score: 3.14,
      active: true,
      data: new Uint8Array([0xde, 0xad]),
      items: [
        { name: "a", value: 1 },
        { name: "b", value: -7 },
      ],
      signed: -12345n,
      smallF: 2.5,
    };
    const data = marshal(orig, OuterPb);
    const got = unmarshal(data, OuterPb);
    expect(got.title).toBe("hello");
    expect(got.count).toBe(42);
    expect(got.score).toBe(3.14);
    expect(got.active).toBe(true);
    expect(got.data).toEqual(new Uint8Array([0xde, 0xad]));
    expect(got.items).toHaveLength(2);
    expect(got.items[0]).toEqual({ name: "a", value: 1 });
    expect(got.items[1]).toEqual({ name: "b", value: -7 });
    expect(got.signed).toBe(-12345n);
    expect(got.smallF).toBeCloseTo(2.5, 5);
  });
});

describe("zero values", () => {
  it("an all-zero message marshals to empty bytes (proto3 semantics)", () => {
    const data = marshal(OuterPb.create(), OuterPb);
    expect(data.length).toBe(0);
  });

  it("zero round-trips back to zero", () => {
    const got = unmarshal(new Uint8Array(), OuterPb);
    expect(got).toEqual(OuterPb.create());
  });
});

describe("unknown fields", () => {
  it("are skipped on unmarshal", () => {
    interface Big {
      a: string;
      b: string;
      c: string;
    }
    const BigPb = defineMessage<Big>({
      fields: [
        { number: 1, name: "a", kind: "string" },
        { number: 2, name: "b", kind: "string" },
        { number: 3, name: "c", kind: "string" },
      ],
      create: () => ({ a: "", b: "", c: "" }),
    });
    const data = marshal({ a: "aa", b: "bb", c: "cc" }, BigPb);

    interface Small {
      a: string;
    }
    const SmallPb = defineMessage<Small>({
      fields: [{ number: 1, name: "a", kind: "string" }],
      create: () => ({ a: "" }),
    });
    const got = unmarshal(data, SmallPb);
    expect(got.a).toBe("aa");
  });
});

describe("singular nested message presence", () => {
  interface Wrap {
    inner: Inner | null;
  }
  const WrapPb = defineMessage<Wrap>({
    fields: [{ number: 1, name: "inner", kind: { message: InnerPb } }],
    create: () => ({ inner: null }),
  });

  it("null inner is omitted; default round-trips to null", () => {
    const data = marshal({ inner: null }, WrapPb);
    expect(data.length).toBe(0);
    expect(unmarshal(data, WrapPb).inner).toBeNull();
  });

  it("populated inner round-trips", () => {
    const data = marshal({ inner: { name: "x", value: 9 } }, WrapPb);
    expect(unmarshal(data, WrapPb).inner).toEqual({ name: "x", value: 9 });
  });

  it("an empty inner message still emits a tag with zero-length blob", () => {
    const data = marshal({ inner: { name: "", value: 0 } }, WrapPb);
    // tag(1, LengthDelim) = 0x0A, then length 0
    expect(data).toEqual(new Uint8Array([0x0a, 0x00]));
    expect(unmarshal(data, WrapPb).inner).toEqual({ name: "", value: 0 });
  });
});

describe("map<string, string>", () => {
  interface WithMap {
    meta: Record<string, string>;
  }
  const WithMapPb = defineMessage<WithMap>({
    fields: [{ number: 1, name: "meta", kind: "string", mapKey: "string" }],
    create: () => ({ meta: {} }),
  });

  it("round-trips entries", () => {
    const data = marshal({ meta: { a: "1", b: "2", "key with space": "v" } }, WithMapPb);
    const got = unmarshal(data, WithMapPb);
    expect(got.meta).toEqual({ a: "1", b: "2", "key with space": "v" });
  });

  it("empty map produces empty bytes", () => {
    const data = marshal({ meta: {} }, WithMapPb);
    expect(data.length).toBe(0);
    expect(unmarshal(data, WithMapPb).meta).toEqual({});
  });
});

describe("map<int32, string>", () => {
  interface WithIntMap {
    codes: Record<string, string>;
  }
  const Pb = defineMessage<WithIntMap>({
    fields: [{ number: 1, name: "codes", kind: "string", mapKey: "int32" }],
    create: () => ({ codes: {} }),
  });

  it("round-trips entries with numeric keys serialized as strings", () => {
    const data = marshal({ codes: { 404: "Not Found", 500: "Internal" } }, Pb);
    const got = unmarshal(data, Pb);
    expect(got.codes).toEqual({ "404": "Not Found", "500": "Internal" });
  });
});

describe("schema validation", () => {
  it("rejects duplicate field numbers", () => {
    expect(() =>
      defineMessage({
        fields: [
          { number: 1, name: "a", kind: "string" },
          { number: 1, name: "b", kind: "string" },
        ],
      }),
    ).toThrow(/duplicate field number/);
  });

  it("rejects repeated + map on the same field", () => {
    expect(() =>
      defineMessage({
        fields: [
          { number: 1, name: "x", kind: "string", repeated: true, mapKey: "string" },
        ],
      }),
    ).toThrow(/repeated and a map/);
  });
});

interface Tree {
  child?: Tree;
  label?: string;
  branches?: Record<string, Tree>;
  tags?: Record<string, string>;
}

// Field 3, adversarial.v1.Tree's `children`, isn't needed here. The getters
// let the codec name itself.
const TreePb: MessageCodec<Tree> = defineMessage<Tree>({
  fields: [
    {
      number: 1,
      name: "child",
      get kind() {
        return { message: TreePb };
      },
    },
    { number: 2, name: "label", kind: "string" },
    {
      number: 4,
      name: "branches",
      mapKey: "string",
      get kind() {
        return { message: TreePb };
      },
    },
    { number: 5, name: "tags", kind: "string", mapKey: "string" },
  ],
});

const wrap = (n: number, inner: Tree): Tree => {
  let t = inner;
  for (let i = 0; i < n; i++) t = { child: t };
  return t;
};

const wrapBranches = (n: number, inner: Tree): Tree => {
  let t = inner;
  for (let i = 0; i < n; i++) t = { branches: { k: t } };
  return t;
};

describe("MAX_NESTING_DEPTH", () => {
  const half = MAX_NESTING_DEPTH / 2;
  const rows: [string, Tree, Tree][] = [
    ["submessages", wrap(MAX_NESTING_DEPTH, {}), wrap(MAX_NESTING_DEPTH + 1, {})],
    ["message-valued map entries", wrapBranches(half, {}), wrapBranches(half, wrap(1, {}))],
    [
      "a scalar-valued map entry",
      wrap(MAX_NESTING_DEPTH - 1, { tags: { k: "v" } }),
      wrap(MAX_NESTING_DEPTH, { tags: { k: "v" } }),
    ],
  ];

  for (const [name, atBound, onePast] of rows) {
    it(`${name}: accepts the bound and rejects one past`, () => {
      expect(() => unmarshal(marshal(atBound, TreePb), TreePb)).not.toThrow();
      expect(() => unmarshal(marshal(onePast, TreePb), TreePb)).toThrow(
        "nesting depth exceeds MaxNestingDepth=100",
      );
    });
  }

  it("counts depth, not the number of entries", () => {
    const tags: Record<string, string> = {};
    for (let i = 0; i < 300; i++) tags[`k${i}`] = "v";
    const t = wrap(MAX_NESTING_DEPTH - 1, { tags });
    const got = unmarshal(marshal(t, TreePb), TreePb);
    expect(got.child).toBeDefined();
  });
});

describe("a map entry carries key and value, zero-valued or not (protowire#295)", () => {
  it("matches the golden from protoc and protobuf-go", () => {
    const error = newAppError("", "").withMeta("", "");
    const bytes = EnvelopePb.marshal(new Envelope({ error }));
    expect(Buffer.from(bytes).toString("hex")).toBe("22062a040a001200");
  });
});

describe("packed repeated scalars", () => {
  const Ints = defineMessage<{ values: number[] }>({
    fields: [{ number: 1, name: "values", kind: "int32", repeated: true }],
    create: () => ({ values: [] }),
  });
  const packed = Uint8Array.of(0x0a, 0x03, 0x01, 0x02, 0x03);

  it("reads what protoc writes by default", () => {
    expect(unmarshal(packed, Ints).values).toEqual([1, 2, 3]);
  });

  it("reads both forms in one message", () => {
    expect(unmarshal(Uint8Array.of(0x08, 0x09, 0x0a, 0x01, 0x07), Ints).values).toEqual([9, 7]);
  });

  it("rejects a run overrunning its message", () => {
    expect(() => unmarshal(Uint8Array.of(0x0a, 0x09, 0x01), Ints)).toThrow();
  });

  it("counts elements against MaxRepeatedCount", () => {
    expect(() => unmarshal(packed, Ints, { maxRepeatedCount: 2 })).toThrow(/MaxRepeatedCount=2/);
    expect(unmarshal(packed, Ints, { maxRepeatedCount: 3 }).values).toHaveLength(3);
  });
});

describe("32-bit varint kinds keep the low 32 bits of a 10-byte varint (#95)", () => {
  const varint = (v: bigint): number[] => {
    const out: number[] = [];
    do {
      let b = Number(v & 0x7fn);
      v >>= 7n;
      if (v > 0n) b |= 0x80;
      out.push(b);
    } while (v > 0n);
    return out;
  };
  const one = <T,>(kind: "uint32" | "bool" | "sint32", v: bigint): T => {
    const M = defineMessage<{ x: T }>({ fields: [{ number: 1, name: "x", kind }], create: () => ({}) as { x: T } });
    return unmarshal(Uint8Array.from([0x08, ...varint(v)]), M).x;
  };
  const big = (n: number) => 2n ** BigInt(n);

  it.each([
    ["uint32", big(32) + 5n, 5],
    ["uint32", big(63) + 5n, 5],
    ["bool", big(63) + 5n, true],
    ["bool", big(32), true],
    ["sint32", big(63) + 5n, -3],
  ] as const)("%s %s", (kind, v, want) => {
    expect(one(kind, v)).toBe(want);
  });

  it("rejects a varint past 10 bytes", () => {
    const M = defineMessage<{ x: number }>({ fields: [{ number: 1, name: "x", kind: "uint32" }], create: () => ({ x: 0 }) });
    expect(() => unmarshal(Uint8Array.from([0x08, ...Array(10).fill(0xff), 0x01]), M)).toThrow(/longer than 10 bytes/);
  });

  it.each([
    [big(32), "0, a zero"],
    [big(32) + 53n, "53"],
    [big(64) - 1n, "4294967295, past the bound"],
  ])("BigFloatCodec prec %s reads as %s", (prec, _) => {
    const wire = Uint8Array.from([0x0a, 0x01, 0x01, 0x18, ...varint(prec)]);
    if (prec === big(64) - 1n) {
      expect(() => unmarshal(wire, BigFloatCodec)).toThrow(/prec 4294967295/);
    } else {
      expect(unmarshal(wire, BigFloatCodec).prec).toBe(Number(prec % big(32)));
    }
  });

  it("BigFloatCodec bounds prec as a precision suffix is bounded", () => {
    const at = Uint8Array.from([0x0a, 0x01, 0x01, 0x18, ...varint(13603n)]);
    const past = Uint8Array.from([0x0a, 0x01, 0x01, 0x18, ...varint(13604n)]);
    expect(unmarshal(at, BigFloatCodec).prec).toBe(13603);
    expect(() => unmarshal(past, BigFloatCodec)).toThrow(/prec above 13603/);
  });
});

describe("invalid UTF-8 in a string field (#93)", () => {
  const S = defineMessage<{ s: string; l: string[]; m: Record<string, string> }>({
    fields: [
      { number: 1, name: "s", kind: "string" },
      { number: 2, name: "l", kind: "string", repeated: true },
      { number: 3, name: "m", kind: "string", mapKey: "string" },
    ],
    create: () => ({ s: "", l: [], m: {} }),
  });
  const bad = [0x41, 0xff, 0xfe];

  it.each([
    ["a field", [0x0a, 3, ...bad]],
    ["a list element", [0x12, 3, ...bad]],
    ["a map key", [0x1a, 7, 0x0a, 3, ...bad, 0x12, 0]],
    ["a map value", [0x1a, 7, 0x0a, 0, 0x12, 3, ...bad]],
    ["a lone surrogate", [0x0a, 3, 0xed, 0xa0, 0x80]],
  ])("is rejected in %s", (_, bytes) => {
    expect(() => unmarshal(Uint8Array.from(bytes), S)).toThrow(/invalid UTF-8 in string/);
  });

  it("keeps valid UTF-8", () => {
    const text = "café€";
    const enc = new TextEncoder().encode(text);
    expect(unmarshal(Uint8Array.from([0x0a, enc.length, ...enc]), S).s).toBe(text);
  });
});

describe("marshal refuses a message nested past MaxNestingDepth (protowire#502)", () => {
  interface Node { child?: Node; tags: Record<string, Node> }
  const NodePb: MessageCodec<Node> = defineMessage<Node>({
    fields: [
      { number: 1, name: "child", get kind() { return { message: NodePb }; } },
      { number: 2, name: "tags", mapKey: "string", get kind() { return { message: NodePb }; } },
    ],
    create: () => ({ tags: {} }),
  });
  const chain = (n: number): Node => {
    let node: Node = { tags: {} };
    for (let i = 0; i < n; i++) node = { child: node, tags: {} };
    return node;
  };

  it("writes 100 levels and refuses 101", () => {
    expect(() => marshal(chain(100), NodePb)).not.toThrow();
    expect(() => marshal(chain(101), NodePb)).toThrow(/MaxNestingDepth=100/);
    expect(() => marshal(chain(101), NodePb, { maxNestingDepth: 101 })).not.toThrow();
  });

  it("counts a map entry as a descent of its own", () => {
    let node: Node = { tags: {} };
    for (let i = 0; i < 50; i++) node = { tags: { k: node } };
    expect(() => marshal(node, NodePb)).not.toThrow();
    expect(() => marshal({ tags: { k: node } }, NodePb)).toThrow(/MaxNestingDepth=100/);
  });
});
