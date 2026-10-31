// SPDX-License-Identifier: MIT
// Copyright (c) 2026 TrendVidia, LLC.
/**
 * Keyed repeated fields (draft -01 §3.13, protowire#116). The corpus under
 * `testdata/keyed/` is vendored verbatim from the spec repository and shared
 * by every port; its README states each document's verdict. Mirrors the
 * reference's `keyed_test.go`. `keyed.binpb` comes from
 * `npm run gen:testdata:keyed:buf`.
 */

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  type DescMessage,
  type MessageShape,
  create,
  createFileRegistry,
  equals,
  fromBinary,
  toBinary,
} from "@bufbuild/protobuf";
import { FileDescriptorSetSchema } from "@bufbuild/protobuf/wkt";
import { type ReflectList, type ReflectMessage, reflect } from "@bufbuild/protobuf/reflect";
import { afterAll, describe, expect, it } from "vitest";

import { keyField } from "./annotations.js";
import type { Assignment, Block } from "./ast.js";
import { unmarshal, unmarshalFull } from "./decode.js";
import { marshal } from "./encode.js";
import { format } from "./format.js";
import { canonicalizeKeyed, identSafeEntryName } from "./keyed.js";
import { parse } from "./parser.js";
import { Result } from "./result.js";
import { validateDescriptor, violationString } from "./schema.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = resolve(here, "testdata/keyed");
const registry = createFileRegistry(
  fromBinary(
    FileDescriptorSetSchema,
    new Uint8Array(readFileSync(resolve(fixtureDir, "keyed.binpb"))),
  ),
);
const placementRegistry = createFileRegistry(
  fromBinary(
    FileDescriptorSetSchema,
    new Uint8Array(readFileSync(resolve(here, "testdata/key-placement-test.binpb"))),
  ),
);

function message(reg: { getMessage(n: string): DescMessage | undefined }, name: string): DescMessage {
  const m = reg.getMessage(name);
  if (!m) throw new Error(`missing descriptor for ${name}`);
  return m;
}

const Node = message(registry, "keyed.v1.Node");
const Deployment = message(registry, "keyed.v1.Deployment");
const Doc = message(registry, "keyed.v1.Doc");

function read(name: string): string {
  return readFileSync(resolve(fixtureDir, name), "utf8");
}

/** The fixture's message, resolved from its `@type` directive. */
function descOf(doc: string): DescMessage {
  return message(registry, parse(doc).typeUrl);
}

/** The document minus comment lines and the blank runs they leave behind:
 * what the encoder must reproduce byte for byte. */
function clean(data: string): string {
  const kept = data.split("\n").filter((l) => !l.trimStart().startsWith("#"));
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

function fmt(doc: string, desc: DescMessage): string {
  return format(canonicalizeKeyed(parse(doc), desc));
}

function elements(msg: MessageShape<DescMessage>, desc: DescMessage, field: string): ReflectMessage[] {
  const fd = desc.fields.find((f) => f.name === field);
  if (!fd) throw new Error(`no field ${field}`);
  return [...(reflect(desc, msg).get(fd) as ReflectList)] as ReflectMessage[];
}

function str(m: ReflectMessage, field: string): string {
  const fd = m.desc.fields.find((f) => f.name === field);
  if (!fd) throw new Error(`no field ${field}`);
  return m.get(fd) as string;
}

function ids(msg: MessageShape<DescMessage>): string[] {
  return elements(msg, Node, "children").map((c) => str(c, "id"));
}

// ---------------- Fixture corpus ----------------

const ROUND_TRIP = ["roundtrip-keyed.pxf", "roundtrip-quoted.pxf"];
const REJECT: [string, string][] = [
  ["err-duplicate-key.pxf", 'duplicate key "greeting" in keyed field "children"'],
  ["err-duplicate-key-spelling.pxf", 'duplicate key "greeting" in keyed field "children"'],
  ["err-key-conflict.pxf", 'key field "id" = "farewell" conflicts with entry name "greeting" in keyed field "children"'],
  ["err-empty-key.pxf", 'empty entry name in keyed field "children": the empty string is not a valid key'],
  ["err-empty-key-anonymous.pxf", 'explicit empty-string assignment to key field "id" of keyed field "children": the empty string is not a valid key'],
  ["err-quoted-name-unkeyed.pxf", `quoted entry name "a" is only valid inside a keyed repeated field's block (draft -01 §3.13)`],
];
const FMT_PAIRS = ["fmt-unquote", "fmt-anonymous-to-keyed"];

/** Fixture files a test has actually read, the positive marker checked below. */
const ran = new Set<string>();
function fixture(name: string): string {
  ran.add(name);
  return read(name);
}

describe("keyed fixture corpus", () => {
  it.each(ROUND_TRIP)("%s: decode → encode reproduces the body", (name) => {
    const data = fixture(name);
    const desc = descOf(data);
    const msg = unmarshal(data, desc);
    expect(marshal(msg, desc, { typeURL: parse(data).typeUrl })).toBe(clean(data));
    const full = unmarshalFull(data, desc).message;
    expect(equals(desc, full, msg)).toBe(true);
    // Canonical already: fmt only drops the comments' placement, not the form.
    expect(clean(fmt(data, desc))).toBe(clean(data));
  });

  it("roundtrip-quoted.pxf: quoting survives the schema-less formatter", () => {
    const data = fixture("roundtrip-quoted.pxf");
    expect(format(parse(data))).toContain('"us-east-1" {');
    const regions = elements(unmarshal(data, Deployment), Deployment, "regions");
    expect(regions.map((r) => str(r, "name"))).toEqual(["us-east-1", "eu-west-2"]);
  });

  it("anonymous-equivalence.pxf: same message as the keyed form; canonicalizes to it", () => {
    const anon = fixture("anonymous-equivalence.pxf");
    const keyed = read("roundtrip-keyed.pxf");
    const anonMsg = unmarshal(anon, Node);
    expect(equals(Node, anonMsg, unmarshal(keyed, Node))).toBe(true);
    expect(toBinary(Node, anonMsg)).toEqual(toBinary(Node, unmarshal(keyed, Node)));
    expect(marshal(anonMsg, Node, { typeURL: "keyed.v1.Node" })).toBe(clean(keyed));
    expect(clean(fmt(anon, Node))).toBe(clean(keyed));
  });

  it("redundant-key-ok.pxf: legal, and fmt drops the assignment", () => {
    const data = fixture("redundant-key-ok.pxf");
    const msg = unmarshal(data, Node);
    expect(ids(msg)).toEqual(["greeting"]);
    expect(marshal(msg, Node).match(/id = /g)).toHaveLength(1);
    expect(fmt(data, Node).match(/id = /g)).toHaveLength(1);
    expect(fmt(data, Node)).toContain('greeting {\n    type = "Label"\n  }');
  });

  it("anonymous-duplicate-ok.pxf: decodes, and stays anonymous on encode and fmt", () => {
    const data = fixture("anonymous-duplicate-ok.pxf");
    const msg = unmarshal(data, Node);
    expect(ids(msg)).toEqual(["dup", "dup"]);
    expect(marshal(msg, Node)).toContain("children = [");
    expect(fmt(data, Node)).toContain("children = [");
  });

  it.each(REJECT)("%s: parses, then the schema layer rejects it", (name, want) => {
    const data = fixture(name);
    const desc = descOf(data);
    expect(() => parse(data)).not.toThrow();
    expect(() => unmarshal(data, desc)).toThrow(want);
    expect(() => unmarshalFull(data, desc)).toThrow(want);
  });

  it.each(FMT_PAIRS)("%s: formats to .expected.pxf, a fixed point", (pair) => {
    const input = fixture(`${pair}.pxf`);
    const expected = fixture(`${pair}.expected.pxf`);
    const desc = descOf(input);
    expect(fmt(input, desc)).toBe(expected);
    expect(fmt(expected, desc)).toBe(expected);
  });

  // Runs last: a fixture added upstream and vendored must get a verdict here.
  it("every .pxf in the corpus is covered", () => {
    const onDisk = readdirSync(fixtureDir).filter((f) => f.endsWith(".pxf")).sort();
    expect(onDisk).toHaveLength(15);
    expect([...ran].sort()).toEqual(onDisk);
  });

  afterAll(() => {
    console.log(`keyed fixtures run: ${ran.size}`);
  });
});

// ---------------- Beyond the fixtures ----------------

describe("descriptor helpers", () => {
  it("keyField resolves only a well-placed annotation", () => {
    const f = (d: DescMessage, n: string) => d.fields.find((x) => x.name === n)!;
    expect(keyField(f(Node, "children"))?.name).toBe("id");
    expect(keyField(f(Node, "id"))).toBeUndefined();
    expect(keyField(f(Doc, "items"))).toBeUndefined();
    const Bad = message(placementRegistry, "test.v1.keyplacement.Bad");
    for (const fd of Bad.fields) expect(keyField(fd)).toBeUndefined();
  });

  it.each([
    ["greeting", true],
    ["user.name", true],
    ["_x1", true],
    ["nan", true],
    ["us-east-1", false],
    ["1abc", false],
    ["", false],
    ["true", false],
    ["false", false],
    ["null", false],
    ["a\nb", false],
  ])("identSafeEntryName(%j) is %j", (name, ok) => {
    expect(identSafeEntryName(name)).toBe(ok);
  });
});

describe("(pxf.key) placement", () => {
  const Bad = message(placementRegistry, "test.v1.keyplacement.Bad");
  const Clean = message(placementRegistry, "test.v1.keyclosure.Clean");

  it("reports one violation per misplaced annotation", () => {
    const vs = validateDescriptor(Bad);
    expect(vs.map((v) => [v.element.split(".").pop(), v.kind, v.detail])).toEqual([
      ["int_key", "keyOption", "key field test.v1.keyplacement.Elem.num must be a singular string field"],
      ["on_map", "keyOption", "(pxf.key) is valid only on repeated message-typed fields"],
      ["on_repeated_scalar", "keyOption", "(pxf.key) is valid only on repeated message-typed fields"],
      ["on_scalar", "keyOption", "(pxf.key) is valid only on repeated message-typed fields"],
      ["on_singular", "keyOption", "(pxf.key) is valid only on repeated message-typed fields"],
      ["repeated_key", "keyOption", "key field test.v1.keyplacement.Elem.tags must be a singular string field"],
      ["unknown_key", "keyOption", 'element message test.v1.keyplacement.Elem has no field "missing"'],
    ]);
    expect(violationString(vs[0]!)).toBe(
      'key-placement-test.proto: field "test.v1.keyplacement.Bad.int_key": invalid (pxf.key) = "num": key field test.v1.keyplacement.Elem.num must be a singular string field (draft -01 §3.13)',
    );
  });

  it("covers the import closure and names the declaring file", () => {
    const vs = validateDescriptor(Clean);
    expect(vs).toHaveLength(7);
    expect(new Set(vs.map((v) => v.file))).toEqual(new Set(["key-placement-test.proto"]));
  });

  it("is rejected at bind time, unless the caller skips validation", () => {
    expect(() => unmarshal('name = "x"', Clean)).toThrow(/PXF schema violations:\n.*invalid \(pxf\.key\)/);
    expect(() => unmarshal('name = "x"', Clean, { skipValidate: true })).not.toThrow();
  });

  it("a conforming schema has no violations", () => {
    expect(validateDescriptor(Node)).toEqual([]);
  });
});

describe("decode", () => {
  it("the assignment spelling is the same block, entry by entry", () => {
    const msg = unmarshal(
      'id = "root"\nchildren = {\n  greeting { type = "Label" }\n  counter_row = { type = "HBox" }\n}\n',
      Node,
    );
    expect(ids(msg)).toEqual(["greeting", "counter_row"]);
  });

  it("a named entry takes only a block value", () => {
    expect(() => unmarshal('children { greeting = "x" }', Node)).toThrow(/must have a block value/);
    expect(() => unmarshal("children { greeting }", Node)).toThrow(/expected '\{' or '='/);
    expect(() => unmarshal("children { 1 { } }", Node)).toThrow(/expected entry name/);
    expect(() => unmarshal("children { true { } }", Node)).toThrow(/expected entry name/);
    expect(() => unmarshal("children { a { }", Node)).toThrow(/expected '}' to close keyed field/);
  });

  it("an empty name is rejected in the assignment spelling too", () => {
    expect(() => unmarshal('children { "" = { } }', Node)).toThrow(/empty entry name/);
  });

  it("an explicit empty key inside a named entry is rejected", () => {
    expect(() => unmarshal('children { a { id = "" } }', Node)).toThrow(/explicit empty-string/);
  });

  it("duplicates are per block: separate bindings concatenate unchecked", () => {
    const msg = unmarshal(
      'children {\n  a { }\n}\nchildren = [ { id = "b" } ]\nchildren {\n  a { }\n}\n',
      Node,
    );
    expect(ids(msg)).toEqual(["a", "b", "a"]);
  });

  it("entry names are atoms: a dotted name is one key", () => {
    const msg = unmarshal("children { user.name { } }", Node);
    expect(ids(msg)).toEqual(["user.name"]);
    expect(marshal(msg, Node)).toBe("children {\n  user.name {\n  }\n}\n");
  });

  it("the key checks do not leak into nested elements", () => {
    const msg = unmarshal(
      'children { a { children = [ { id = "other" } ] } }',
      Node,
    );
    expect(ids(elements(msg, Node, "children")[0]!.message)).toEqual(["other"]);
  });

  it("a quoted name in message context is rejected, discardUnknown or not", () => {
    for (const doc of ['"id" = "x"', '"id" { }', '"nope" = 1', 'children { a { "id" = "a" } }']) {
      expect(() => unmarshal(doc, Node)).toThrow(/only valid inside a keyed/);
      expect(() => unmarshal(doc, Node, { discardUnknown: true })).toThrow(/only valid inside a keyed/);
    }
  });

  it("an element's fields get indexed Result paths, not the parent's", () => {
    const { result } = unmarshalFull('children { a { type = "T" } }', Node);
    expect(result.isSet("children")).toBe(true);
    expect(result.isSet("children[0].type")).toBe(true);
    expect(result.isAbsent("type")).toBe(true);
    const anon = unmarshalFull('children = [ { id = "a" type = "T" } ]', Node).result;
    expect(anon.isSet("children[0].type")).toBe(true);
    expect(anon.isAbsent("type")).toBe(true);
  });
});

describe("encode", () => {
  const node = (id: string) => {
    const m = create(Node);
    (m as unknown as { id: string; type: string }).id = id;
    (m as unknown as { id: string; type: string }).type = "T";
    return m;
  };
  const root = (...kids: MessageShape<DescMessage>[]) => {
    const m = create(Node);
    (m as unknown as { children: unknown[] }).children = kids;
    return m;
  };

  it("uses the keyed form exactly when every key is present and distinct", () => {
    expect(marshal(root(node("a"), node("b")), Node)).toBe(
      'children {\n  a {\n    type = "T"\n  }\n  b {\n    type = "T"\n  }\n}\n',
    );
    expect(marshal(root(node("a"), node("")), Node)).toContain("children = [");
    expect(marshal(root(node("a"), node("a")), Node)).toContain("children = [");
  });

  it("quotes names that are not identifier-safe, keywords included", () => {
    const out = marshal(root(node("true"), node("null"), node("a b")), Node);
    expect(out).toContain('"true" {');
    expect(out).toContain('"null" {');
    expect(out).toContain('"a b" {');
    expect(ids(unmarshal(out, Node))).toEqual(["true", "null", "a b"]);
  });

  it("nests without repeating keys", () => {
    const doc = 'id = "root"\nchildren {\n  outer {\n    children {\n      inner {\n        type = "Leaf"\n      }\n    }\n  }\n}\n';
    expect(marshal(unmarshal(doc, Node), Node)).toBe(doc);
  });

  it("an element's nulls round-trip through nullFields by indexed path", () => {
    const doc = 'children {\n  a {\n    type = null\n  }\n}\n';
    const { message: msg, result } = unmarshalFull(doc, Node);
    expect(result.nullPaths()).toEqual(["children[0].type"]);
    expect(marshal(msg, Node, { nullFields: result })).toBe(doc);
  });

  it("does not treat a parent path as an element's null", () => {
    const nulls = new Result();
    nulls.markNull("type");
    expect(marshal(root(node("a")), Node, { nullFields: nulls })).toBe(
      'type = null\nchildren {\n  a {\n    type = "T"\n  }\n}\n',
    );
  });
});


describe("keyed blocks and MaxNestingDepth", () => {
  const Node = message(registry, "keyed.v1.Node");
  // Each level is the block's `{` and the entry's `{`, so two descents.
  const chain = (levels: number, inner: string): string =>
    "children { a { ".repeat(levels) + inner + " } }".repeat(levels);

  it("counts the block's own { (HARDENING.md § Recursion)", () => {
    expect(() => unmarshal(chain(50, ""), Node)).not.toThrow();
    expect(() => unmarshal(chain(50, "children { }"), Node)).toThrow(/MaxNesting/);
  });
});

describe("canonicalizeKeyed", () => {
  it("normalizes the assignment spellings and leaves the input alone", () => {
    const src = 'children = {\n  "greeting" = { type = "Label" }\n}\n';
    const doc = parse(src);
    expect(format(canonicalizeKeyed(doc, Node))).toBe(
      'children {\n  greeting {\n    type = "Label"\n  }\n}\n',
    );
    expect(format(doc)).toBe('children = {\n  "greeting" = {\n    type = "Label"\n  }\n}\n');
  });

  it("recurses through nested keyed blocks and anonymous lists", () => {
    const src = 'children {\n  "a" {\n    children = [\n      {\n        id = "b"\n      }\n    ]\n  }\n}\n';
    expect(fmt(src, Node)).toBe("children {\n  a {\n    children {\n      b {\n      }\n    }\n  }\n}\n");
  });

  it.each([
    ["absent key", 'children = [\n  {\n    type = "T"\n  }\n]\n'],
    ["empty key", 'children = [\n  {\n    id = ""\n  }\n]\n'],
    ["non-string key", "children = [\n  {\n    id = 1\n  }\n]\n"],
    ["key set twice", 'children = [\n  {\n    id = "a"\n    id = "a"\n  }\n]\n'],
  ])("keeps an ineligible binding anonymous: %s", (_label, src) => {
    expect(fmt(src, Node)).toBe(src);
  });

  it("leaves what it cannot honestly rewrite untouched", () => {
    const conflict = 'children {\n  a {\n    id = "b"\n  }\n}\n';
    expect(fmt(conflict, Node)).toBe(conflict);
    const quotedUnkeyed = 'items {\n  "a" {\n  }\n}\n';
    expect(fmt(quotedUnkeyed, Doc)).toBe(quotedUnkeyed);
    const unknown = 'nope = [\n  {\n    id = "a"\n  }\n]\n';
    expect(fmt(unknown, Node)).toBe(unknown);
  });

  it("reaches keyed fields through singular, map and plain-list parents", () => {
    const Holder = message(placementRegistry, "test.v1.keyclosure.Holder");
    const kids = 'kids = [\n    {\n      id = "a"\n    }\n  ]';
    const keyed = "kids {\n    a {\n    }\n  }";
    expect(fmt(`single {\n  ${kids}\n}\n`, Holder)).toBe(`single {\n  ${keyed}\n}\n`);
    expect(fmt(`single = {\n  ${kids}\n}\n`, Holder)).toBe(`single = {\n  ${keyed}\n}\n`);
    const deeper = (s: string) => s.replace(/\n/g, "\n  ");
    expect(fmt(`by_name = {\n  x: {\n    ${deeper(kids)}\n  }\n}\n`, Holder)).toBe(
      `by_name = {\n  x: {\n    ${deeper(keyed)}\n  }\n}\n`,
    );
    expect(fmt(`plain = [\n  {\n    ${deeper(kids)}\n  }\n]\n`, Holder)).toBe(
      `plain = [\n  {\n    ${deeper(keyed)}\n  }\n]\n`,
    );
  });

  it("moves a dropped key's comment to the next entry", () => {
    const src = 'children {\n  a {\n    # note\n    id = "a"\n    type = "T"\n  }\n}\n';
    expect(fmt(src, Node)).toBe('children {\n  a {\n    # note\n    type = "T"\n  }\n}\n');
  });

  it("keeps a keyed block's entry that is not a block", () => {
    const src = 'children {\n  a = 1\n}\n';
    expect(fmt(src, Node)).toBe(src);
  });

  it("parsed quoted-ness is reset once the name is canonical", () => {
    const out = canonicalizeKeyed(parse('children { "a" { } }'), Node);
    const entry = (out.entries[0] as Block).entries[0] as Block;
    expect(entry.nameQuoted).toBe(false);
    const asAssign = parse('children { "a" = { } }').entries[0] as Block;
    expect((asAssign.entries[0] as Assignment).keyQuoted).toBe(true);
  });
});
