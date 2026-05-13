// SPDX-License-Identifier: MIT
// Copyright (c) 2026 TrendVidia, LLC.
/**
 * Parser-tier tests for the v0.72-v0.75 directive grammar:
 *   - @<name> *(<prefix>) [{ ... }]   (draft §3.4.2)
 *   - @entry  *(<prefix>) [{ ... }]   (draft §3.4.3)
 *   - @dataset  <type> ( cols ) row*    (draft §3.4.4)
 *
 * These exercise `parse(...)` directly and assert on AST shape. Decode-
 * tier wiring (Result accessors, DatasetReader, bindRow) arrives in later
 * PRs of the v0.72-v0.75 catch-up.
 */

import { describe, expect, it } from "vitest";

import { parse } from "./parser.js";

describe("Directive", () => {
  it("bare directive — no prefix, no body", () => {
    const doc = parse('@frob\nname = "x"\n');
    expect(doc.directives).toHaveLength(1);
    expect(doc.directives[0]!.name).toBe("frob");
    expect(doc.directives[0]!.prefixes).toEqual([]);
    expect(doc.directives[0]!.hasBody).toBe(false);
    expect(doc.directives[0]!.type).toBe("");
    expect(doc.entries).toHaveLength(1);
  });

  it("single prefix populates legacy `type` field", () => {
    // v0.72.0-era chameleon shape: `@header Type { ... }`.
    const doc = parse('@header chameleon.v1.LayerHeader { id = "x" }\nbody = "z"\n');
    expect(doc.directives).toHaveLength(1);
    const d = doc.directives[0]!;
    expect(d.name).toBe("header");
    expect(d.prefixes).toEqual(["chameleon.v1.LayerHeader"]);
    expect(d.type).toBe("chameleon.v1.LayerHeader");
    expect(d.hasBody).toBe(true);
    expect(d.body).toContain('id = "x"');
  });

  it("two prefixes leave type empty", () => {
    const doc = parse('@entry mylabel pkg.MsgType { x = 1 }\nname = "z"\n');
    const d = doc.directives[0]!;
    expect(d.name).toBe("entry");
    expect(d.prefixes).toEqual(["mylabel", "pkg.MsgType"]);
    expect(d.type).toBe("");
  });

  it("prefix lookahead stops at body key", () => {
    // `@foo BarType\nbody_key = ...`: BarType is a prefix; body_key is the
    // first body assignment (disambiguated because it's followed by `=`).
    const doc = parse('@foo BarType\nbody_key = "x"\n');
    expect(doc.directives).toHaveLength(1);
    expect(doc.directives[0]!.prefixes).toEqual(["BarType"]);
    expect(doc.entries).toHaveLength(1);
  });

  it("multiple directives in source order", () => {
    const doc = parse(`@type some.MsgType
@header pkg.Header { id = "h1" }
@frob alpha beta
name = "z"
`);
    expect(doc.typeUrl).toBe("some.MsgType");
    expect(doc.directives.map((d) => d.name)).toEqual(["header", "frob"]);
    expect(doc.directives[1]!.prefixes).toEqual(["alpha", "beta"]);
    expect(doc.bodyOffset).toBeGreaterThan(0);
  });

  it("body offset matches end of last directive", () => {
    const doc = parse("@frob alpha\nname = 1\n");
    // "alpha" starts at offset 6 (after "@frob ") and is length 5, so end = 11.
    expect(doc.bodyOffset).toBe(11);
  });

  it("block body preserves raw bytes verbatim", () => {
    const doc = parse('@hdr T { a = 1\n b = "x" }\nrest = 0\n');
    expect(doc.directives[0]!.hasBody).toBe(true);
    expect(doc.directives[0]!.body).toContain("a = 1");
    expect(doc.directives[0]!.body).toContain('b = "x"');
    expect(doc.directives[0]!.body).not.toContain("}");
  });

  it("nested braces in body counted correctly", () => {
    const doc = parse("@nested T { inner { a = 1 } }\n");
    expect(doc.directives[0]!.hasBody).toBe(true);
    expect(doc.directives[0]!.body).toContain("inner { a = 1 }");
  });

  it("braces inside strings not counted", () => {
    const doc = parse('@s T { a = "}{" }\n');
    expect(doc.directives[0]!.hasBody).toBe(true);
  });

  it("line / block comments inside body do not close it", () => {
    const doc = parse("@h T { a = 1 # trailing } comment\n  b = 2\n}\n");
    expect(doc.directives[0]!.hasBody).toBe(true);
  });

  it("@type without IDENT rejected", () => {
    expect(() => parse("@type =\n")).toThrow(/expected type name after @type/);
  });

  it("bare @ is illegal", () => {
    expect(() => parse("@\n")).toThrow();
  });
});

describe("Table", () => {
  it("basic two-column two-row", () => {
    const doc = parse(`@dataset trades.v1.Trade ( px, qty )
( 100, 5 )
( 101, 7 )
`);
    expect(doc.datasets).toHaveLength(1);
    const t = doc.datasets[0]!;
    expect(t.type).toBe("trades.v1.Trade");
    expect(t.columns).toEqual(["px", "qty"]);
    expect(t.rows).toHaveLength(2);
    expect(t.rows[0]!.cells).toHaveLength(2);
  });

  it("empty cell means absent field", () => {
    const doc = parse("@dataset x.Row ( a, b, c )\n( 1, , 3 )\n");
    const row = doc.datasets[0]!.rows[0]!;
    expect(row.cells[0]).not.toBeNull();
    expect(row.cells[1]).toBeNull(); // absent
    expect(row.cells[2]).not.toBeNull();
  });

  it("null cell means present-but-null", () => {
    const doc = parse("@dataset x.Row ( a, b )\n( 1, null )\n");
    const row = doc.datasets[0]!.rows[0]!;
    expect(row.cells[1]).not.toBeNull();
    expect(row.cells[1]!.kind).toBe("null");
  });

  it("zero rows is valid", () => {
    const doc = parse("@dataset x.Row ( a, b )\n");
    expect(doc.datasets).toHaveLength(1);
    expect(doc.datasets[0]!.rows).toHaveLength(0);
  });

  it("arity mismatch rejected", () => {
    expect(() => parse("@dataset x.Row ( a, b )\n( 1, 2, 3 )\n")).toThrow(
      /3 cells, expected 2/,
    );
  });

  it("dotted column rejected", () => {
    expect(() => parse("@dataset x.Row ( a.b )\n")).toThrow(/dotted column/);
  });

  it("list cell rejected", () => {
    expect(() => parse("@dataset x.Row ( a )\n( [1, 2] )\n")).toThrow(/list values/);
  });

  it("block cell rejected", () => {
    expect(() => parse("@dataset x.Row ( a )\n( { x = 1 } )\n")).toThrow(/block values/);
  });

  it("standalone constraint: rejects coexisting @type", () => {
    expect(() => parse("@type other\n@dataset x.Row ( a )\n( 1 )\n")).toThrow(
      /cannot coexist with @type/,
    );
  });

  it("standalone constraint: rejects @type after @dataset", () => {
    expect(() => parse("@dataset x.Row ( a )\n@type other\n")).toThrow(
      /cannot coexist with @type/,
    );
  });

  it("standalone constraint: rejects coexisting body entries", () => {
    expect(() => parse("@dataset x.Row ( a )\n( 1 )\nextra = 5\n")).toThrow(
      /cannot coexist with top-level field entries/,
    );
  });

  it("missing type is permissive (anonymous binding deferred to a preceding @proto)", () => {
    // Type is optional in the AST; binding-time validation handles the
    // "no preceding anonymous @proto" case.
    const doc = parse("@dataset ( a )\n");
    expect(doc.datasets).toHaveLength(1);
    expect(doc.datasets[0]!.type).toBe("");
  });

  it("missing '(' rejected", () => {
    expect(() => parse("@dataset x.Row a, b\n")).toThrow(/expected '\(' to start/);
  });

  it("empty column list rejected", () => {
    expect(() => parse("@dataset x.Row ( )\n")).toThrow(/at least one field name/);
  });

  it("bad column token rejected", () => {
    expect(() => parse("@dataset x.Row ( a, 123 )\n")).toThrow(
      /expected column field name/,
    );
  });

  it("missing ',' or ')' in column list rejected", () => {
    expect(() => parse("@dataset x.Row ( a b )\n")).toThrow(
      /expected ',' or '\)' in @dataset column list/,
    );
  });

  it("missing ',' or ')' in row rejected", () => {
    expect(() => parse("@dataset x.Row ( a, b )\n( 1 2 )\n")).toThrow(
      /expected ',' or '\)' in @dataset row/,
    );
  });
});
