// SPDX-License-Identifier: MIT
// Copyright (c) 2026 TrendVidia, LLC.
/**
 * MaxNestingDepth for the PXF parser and decoder (HARDENING.md § Recursion).
 * The documents have the shapes of the protowire corpus rows
 * `pxf/deep-nesting-*`, built here because this repo doesn't vendor the corpus.
 */

import { type DescMessage, create, createFileRegistry } from "@bufbuild/protobuf";
import {
  FieldDescriptorProto_Label,
  FieldDescriptorProto_Type,
  FileDescriptorProtoSchema,
} from "@bufbuild/protobuf/wkt";
import { describe, expect, it } from "vitest";

import { unmarshal, unmarshalFull } from "./decode.js";
import { PxfError } from "./errors.js";
import { MAX_NESTING_DEPTH, parse } from "./parser.js";

const { STRING, MESSAGE } = FieldDescriptorProto_Type;
const { OPTIONAL, REPEATED } = FieldDescriptorProto_Label;

function field(name: string, number: number, label: FieldDescriptorProto_Label, typeName?: string) {
  return {
    name,
    number,
    jsonName: name,
    label,
    type: typeName ? MESSAGE : STRING,
    ...(typeName ? { typeName } : {}),
  };
}

function mapEntry(name: string, valueType?: string) {
  return {
    name,
    field: [field("key", 1, OPTIONAL), field("value", 2, OPTIONAL, valueType)],
    options: { mapEntry: true },
  };
}

// The corpus's adversarial.v1.Tree.
const tree: DescMessage = (() => {
  const fileProto = create(FileDescriptorProtoSchema, {
    name: "limits.proto",
    package: "limits.test.v1",
    syntax: "proto3",
    messageType: [
      {
        name: "Tree",
        field: [
          field("child", 1, OPTIONAL, ".limits.test.v1.Tree"),
          field("label", 2, OPTIONAL),
          field("children", 3, REPEATED, ".limits.test.v1.Tree"),
          field("branches", 4, REPEATED, ".limits.test.v1.Tree.BranchesEntry"),
          field("tags", 5, REPEATED, ".limits.test.v1.Tree.TagsEntry"),
        ],
        nestedType: [mapEntry("BranchesEntry", ".limits.test.v1.Tree"), mapEntry("TagsEntry")],
      },
    ],
  });
  const m = createFileRegistry(fileProto, () => undefined).getMessage("limits.test.v1.Tree");
  if (!m) throw new Error("missing descriptor for Tree");
  return m;
})();

const nest = (open: string, n: number, inner: string, close: string): string =>
  open.repeat(n) + inner + close.repeat(n);

const blocks = (n: number) => nest("child { ", n, 'label = "x"', " }");
// `= {` is a value, so the decoder reaches it by another path from `child {`.
const assignedBlocks = (n: number) => nest("child = { ", n, 'label = "x"', " }");
const lists = (pairs: number, extra: number) =>
  nest("children = [{ ", pairs, blocks(extra), " }]");
const maps = (pairs: number, extra: number) =>
  nest("branches = { k: { ", pairs, blocks(extra), " } }");
const scalarMap = (n: number) => nest("child { ", n, 'tags = { k: "v" }', " }");

const half = MAX_NESTING_DEPTH / 2;

describe("MAX_NESTING_DEPTH", () => {
  const rows: [string, string, string][] = [
    ["blocks", blocks(MAX_NESTING_DEPTH), blocks(MAX_NESTING_DEPTH + 1)],
    ["assigned blocks", assignedBlocks(MAX_NESTING_DEPTH), assignedBlocks(MAX_NESTING_DEPTH + 1)],
    ["lists and blocks", lists(half, 0), lists(half, 1)],
    ["maps", maps(half, 0), maps(half, 1)],
    ["a scalar map", scalarMap(MAX_NESTING_DEPTH - 1), scalarMap(MAX_NESTING_DEPTH)],
  ];

  it("is 100", () => {
    expect(MAX_NESTING_DEPTH).toBe(100);
  });

  for (const [name, atBound, onePast] of rows) {
    it(`${name}: the parser accepts the bound and rejects one past`, () => {
      expect(() => parse(atBound)).not.toThrow();
      expect(() => parse(onePast)).toThrow(/MaxNestingDepth=100/);
    });

    it(`${name}: unmarshal accepts the bound and rejects one past`, () => {
      expect(() => unmarshal(atBound, tree)).not.toThrow();
      expect(() => unmarshal(onePast, tree)).toThrow(/MaxNestingDepth=100/);
    });

    it(`${name}: unmarshalFull accepts the bound and rejects one past`, () => {
      expect(() => unmarshalFull(atBound, tree)).not.toThrow();
      expect(() => unmarshalFull(onePast, tree)).toThrow(/MaxNestingDepth=100/);
    });
  }

  it("counts depth, not the number of blocks", () => {
    const wide = `${blocks(MAX_NESTING_DEPTH)}\n`.replace("child", "label = \"y\"\nchild");
    expect(() => unmarshal(wide, tree)).not.toThrow();
    const siblings = `branches = { ${Array.from({ length: 200 }, (_, i) => `k${i}: { label = "x" }`).join(" ")} }`;
    expect(() => parse(siblings)).not.toThrow();
    expect(() => unmarshal(siblings, tree)).not.toThrow();
  });

  it("rejects a document too deep for the stack with a PxfError", () => {
    const doc = "child { ".repeat(100_000);
    expect(() => parse(doc)).toThrow(PxfError);
    expect(() => unmarshal(doc, tree)).toThrow(PxfError);
  });

  it("counts the skipped text of an unknown field", () => {
    const opts = { discardUnknown: true };
    for (const [atBound, onePast] of [
      [nest("nope { ", 100, "", " }"), nest("nope { ", 101, "", " }")],
      [`nope = ${nest("[ ", 100, "", " ]")}`, `nope = ${nest("[ ", 101, "", " ]")}`],
      [`nope = ${nest("[{ a = ", 50, "1", " }]")}`, `nope = ${nest("[{ a = ", 50, "[]", " }]")}`],
    ] as const) {
      expect(() => unmarshal(atBound, tree, opts)).not.toThrow();
      expect(() => unmarshal(onePast, tree, opts)).toThrow(/MaxNestingDepth=100/);
    }
    // From where the skip began: 99 blocks, then an unknown field's block
    // at the bound and with one more inside.
    expect(() => unmarshal(nest("child { ", 99, "nope { }", " }"), tree, opts)).not.toThrow();
    expect(() => unmarshal(nest("child { ", 99, "nope { a { } }", " }"), tree, opts)).toThrow(
      /MaxNestingDepth=100/,
    );
  });

  it("counts a directive block", () => {
    const atBound = `@header ${nest("{ a = ", 99, "{}", " }")}`;
    const onePast = `@header ${nest("{ a = ", 100, "{}", " }")}`;
    expect(() => parse(atBound)).not.toThrow();
    expect(() => unmarshal(atBound, tree)).not.toThrow();
    expect(() => parse(onePast)).toThrow(/MaxNestingDepth=100/);
    expect(() => unmarshal(onePast, tree)).toThrow(/MaxNestingDepth=100/);
  });
});
