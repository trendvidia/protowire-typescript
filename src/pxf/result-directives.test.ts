// SPDX-License-Identifier: MIT
// Copyright (c) 2026 TrendVidia, LLC.
/**
 * Tests for `Result.directives()` / `Result.tables()` — PR 3 of the
 * v0.72-v0.75 TypeScript catch-up. The direct decoder now populates
 * the directive vectors on Result during `unmarshalFull`, so
 * consumers (chameleon's @header reader, table binders, etc.) can
 * read the document-root directives after a decode call.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  type DescMessage,
  type Registry,
  createFileRegistry,
  fromBinary,
} from "@bufbuild/protobuf";
import { FileDescriptorSetSchema } from "@bufbuild/protobuf/wkt";
import { describe, expect, it } from "vitest";

import { unmarshal, unmarshalFull } from "./decode.js";

const here = dirname(fileURLToPath(import.meta.url));
const fdsBytes = readFileSync(resolve(here, "testdata/test.binpb"));
const registry: Registry = createFileRegistry(
  fromBinary(FileDescriptorSetSchema, new Uint8Array(fdsBytes)),
);

function getMessage(typeName: string): DescMessage {
  const m = registry.getMessage(typeName);
  if (!m) throw new Error(`missing descriptor for ${typeName}`);
  return m;
}

const AllTypes = getMessage("test.v1.AllTypes");

describe("Result.directives", () => {
  it("empty document — both accessors empty", () => {
    const { result } = unmarshalFull('string_field = "x"', AllTypes);
    expect(result.directives()).toEqual([]);
    expect(result.tables()).toEqual([]);
  });

  it("bare directive recorded", () => {
    const { result } = unmarshalFull('@frob\nstring_field = "x"', AllTypes);
    const dirs = result.directives();
    expect(dirs).toHaveLength(1);
    expect(dirs[0]!.name).toBe("frob");
    expect(dirs[0]!.prefixes).toEqual([]);
    expect(dirs[0]!.hasBody).toBe(false);
    expect(dirs[0]!.type).toBe("");
  });

  it("single prefix populates legacy type", () => {
    const { result } = unmarshalFull(
      '@header pkg.Hdr { id = "h" }\nstring_field = "x"',
      AllTypes,
    );
    const d = result.directives()[0]!;
    expect(d.name).toBe("header");
    expect(d.prefixes).toEqual(["pkg.Hdr"]);
    expect(d.type).toBe("pkg.Hdr");
    expect(d.hasBody).toBe(true);
    expect(d.body).toContain('id = "h"');
  });

  it("two prefixes leave legacy type empty", () => {
    const { result } = unmarshalFull(
      '@entry mylabel pkg.MsgType\nstring_field = "x"',
      AllTypes,
    );
    const d = result.directives()[0]!;
    expect(d.prefixes).toEqual(["mylabel", "pkg.MsgType"]);
    expect(d.type).toBe("");
  });

  it("multiple directives in source order", () => {
    const { result } = unmarshalFull(
      `@header pkg.Hdr { id = "h" }
@frob alpha beta
@meta
string_field = "x"
`,
      AllTypes,
    );
    expect(result.directives().map((d) => d.name)).toEqual(["header", "frob", "meta"]);
    expect(result.directives()[1]!.prefixes).toEqual(["alpha", "beta"]);
    expect(result.directives()[2]!.prefixes).toEqual([]);
  });

  it("nested block body preserved", () => {
    const { result } = unmarshalFull(
      '@h T { inner { a = 1 nested { b = "x" } } }\nstring_field = "y"',
      AllTypes,
    );
    const d = result.directives()[0]!;
    expect(d.hasBody).toBe(true);
    expect(d.body).toContain("inner {");
    expect(d.body).toContain("nested {");
    expect(d.body).toContain('b = "x"');
  });

  it("@type does not leak into directives()", () => {
    const { result } = unmarshalFull(
      `@type test.v1.AllTypes
@frob alpha
string_field = "x"
`,
      AllTypes,
    );
    expect(result.directives()).toHaveLength(1);
    expect(result.directives()[0]!.name).toBe("frob");
  });
});

describe("Result.tables", () => {
  it("@table recorded with columns and rows", () => {
    const { result } = unmarshalFull(
      `@table trades.v1.Trade ( px, qty )
( 100, 5 )
( 101, 7 )
`,
      AllTypes,
    );
    expect(result.tables()).toHaveLength(1);
    const t = result.tables()[0]!;
    expect(t.type).toBe("trades.v1.Trade");
    expect(t.columns).toEqual(["px", "qty"]);
    expect(t.rows).toHaveLength(2);
    expect(t.rows[0]!.cells).toHaveLength(2);
  });

  it("cells carry actual values", () => {
    const { result } = unmarshalFull(
      `@table x.Row ( a, b, c )
( 42, "hello", true )
`,
      AllTypes,
    );
    const row = result.tables()[0]!.rows[0]!;
    expect(row.cells[0]).toMatchObject({ kind: "int", raw: "42" });
    expect(row.cells[1]).toMatchObject({ kind: "string", value: "hello" });
    expect(row.cells[2]).toMatchObject({ kind: "bool", value: true });
  });

  it("three-state cells: absent / null / set", () => {
    const { result } = unmarshalFull(
      `@table x.Row ( a, b, c )
( 1, , null )
`,
      AllTypes,
    );
    const row = result.tables()[0]!.rows[0]!;
    expect(row.cells[0]).toMatchObject({ kind: "int", raw: "1" });
    expect(row.cells[1]).toBeNull(); // absent
    expect(row.cells[2]).toMatchObject({ kind: "null" });
  });

  it("multiple tables in source order", () => {
    const { result } = unmarshalFull(
      `@table a.Row ( x )
( 1 )
@table b.Row ( y, z )
( "p", "q" )
`,
      AllTypes,
    );
    expect(result.tables().map((t) => t.type)).toEqual(["a.Row", "b.Row"]);
  });

  it("@table populates only tables(), not directives()", () => {
    const { result } = unmarshalFull("@table x.Row ( a )\n( 1 )\n", AllTypes);
    expect(result.tables()).toHaveLength(1);
    expect(result.directives()).toEqual([]);
  });

  it("directives and tables coexist before body-less @table", () => {
    const { result } = unmarshalFull(
      `@header pkg.Hdr { id = "h" }
@table x.Row ( a )
( 1 )
`,
      AllTypes,
    );
    expect(result.directives()).toHaveLength(1);
    expect(result.tables()).toHaveLength(1);
    expect(result.directives()[0]!.name).toBe("header");
    expect(result.tables()[0]!.type).toBe("x.Row");
  });
});

describe("zero-allocation prelude on unmarshal (no result)", () => {
  it("unmarshal without result still succeeds", () => {
    // Regression check: the result-null branch must keep working.
    const msg = unmarshal(
      `@header pkg.Hdr { id = "h" }
@frob alpha beta
string_field = "x"
`,
      AllTypes,
    );
    expect((msg as unknown as { stringField: string }).stringField).toBe("x");
  });
});
