// SPDX-License-Identifier: MIT
// Copyright (c) 2026 TrendVidia, LLC.
import { describe, it, expect } from "vitest";
import {
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
