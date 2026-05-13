// SPDX-License-Identifier: MIT
// Copyright (c) 2026 TrendVidia, LLC.
/**
 * Tests for DatasetReader (streaming @dataset consumption) and bindRow
 * (per-row proto binding). PR 4 of the v0.72-v0.75 TypeScript catch-up.
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

import { DatasetReader, bindRow } from "./dataset_reader.js";

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

describe("DatasetReader.fromString — header parsing", () => {
  it("reads header and exposes type and columns", () => {
    const tr = DatasetReader.fromString(
      "@dataset trades.v1.Trade ( px, qty )\n( 100, 5 )\n( 101, 7 )\n",
    );
    expect(tr.type).toBe("trades.v1.Trade");
    expect(tr.columns).toEqual(["px", "qty"]);
    expect(tr.directives).toEqual([]);
  });

  it("rejects input with no @dataset", () => {
    expect(() => DatasetReader.fromString('@type foo.Msg\nname = "x"\n')).toThrow(
      /no @dataset directive/,
    );
  });

  it("rejects empty input", () => {
    expect(() => DatasetReader.fromString("")).toThrow(/no @dataset/);
  });

  it("leading directives preserved", () => {
    const tr = DatasetReader.fromString(
      `@header pkg.Hdr { id = "h" }
@frob alpha
@dataset trades.v1.Trade ( px, qty )
( 1, 2 )
`,
    );
    expect(tr.directives).toHaveLength(2);
    expect(tr.directives[0]!.name).toBe("header");
    expect(tr.directives[1]!.name).toBe("frob");
  });

  it("oversize header rejected", () => {
    const big = "@frob " + "x ".repeat(35000) + "\n@dataset x.Row ( a )\n";
    expect(() => DatasetReader.fromString(big)).toThrow(/header exceeds/);
  });
});

describe("DatasetReader — iteration", () => {
  it("yields rows in order via for-of", () => {
    const tr = DatasetReader.fromString(
      "@dataset x.Row ( a, b )\n( 1, 2 )\n( 3, 4 )\n( 5, 6 )\n",
    );
    const rows = [...tr];
    expect(rows).toHaveLength(3);
    expect(tr.done).toBe(true);
  });

  it("zero rows reports done immediately", () => {
    const tr = DatasetReader.fromString("@dataset x.Row ( a )\n");
    const rows = [...tr];
    expect(rows).toEqual([]);
    expect(tr.done).toBe(true);
  });

  it("cell shapes match the three-state grammar", () => {
    const tr = DatasetReader.fromString(
      `@dataset x.Row ( a, b, c, d, e )
( 42, "hi", true, null, )
`,
    );
    const [row] = [...tr];
    expect(row!.cells[0]).toMatchObject({ kind: "int", raw: "42" });
    expect(row!.cells[1]).toMatchObject({ kind: "string", value: "hi" });
    expect(row!.cells[2]).toMatchObject({ kind: "bool", value: true });
    expect(row!.cells[3]).toMatchObject({ kind: "null" });
    expect(row!.cells[4]).toBeNull(); // absent (empty cell at end)
  });

  it("arity mismatch surfaces and is sticky-ish", () => {
    const tr = DatasetReader.fromString(
      "@dataset x.Row ( a, b )\n( 1, 2, 3 )\n( 4, 5 )\n",
    );
    expect(() => tr.next()).toThrow(/3 cells, expected 2/);
  });

  it("parens inside strings not mistaken for row boundary", () => {
    const tr = DatasetReader.fromString(
      '@dataset x.Row ( a )\n( "hi ) there" )\n( "next" )\n',
    );
    const rows = [...tr];
    expect(rows).toHaveLength(2);
    expect((rows[0]!.cells[0] as { value: string }).value).toBe("hi ) there");
    expect((rows[1]!.cells[0] as { value: string }).value).toBe("next");
  });

  it("comments between rows ignored", () => {
    const tr = DatasetReader.fromString(
      `@dataset x.Row ( a )
# leading
( 1 )
// mid
( 2 )
/* block
  comment */
( 3 )
`,
    );
    expect([...tr]).toHaveLength(3);
  });
});

describe("DatasetReader.tail", () => {
  it("chains to a second table", () => {
    const src = `@dataset a.Row ( x )
( 1 )
( 2 )
@dataset b.Row ( y )
( "p" )
( "q" )
`;
    const tr1 = DatasetReader.fromString(src);
    expect(tr1.type).toBe("a.Row");
    expect([...tr1]).toHaveLength(2);

    const tr2 = DatasetReader.fromString(tr1.tail());
    expect(tr2.type).toBe("b.Row");
    expect([...tr2]).toHaveLength(2);
  });
});

describe("bindRow + scan", () => {
  it("binds fields by column name", () => {
    const tr = DatasetReader.fromString(
      '@dataset test.v1.AllTypes ( string_field, int32_field )\n( "alpha", 42 )\n',
    );
    const [row] = [...tr];
    const msg = bindRow(AllTypes, tr.columns, row!);
    expect((msg as unknown as { stringField: string }).stringField).toBe("alpha");
    expect((msg as unknown as { int32Field: number }).int32Field).toBe(42);
  });

  it("scan() is equivalent to next + bindRow", () => {
    const tr = DatasetReader.fromString(
      '@dataset test.v1.AllTypes ( string_field )\n( "row1" )\n( "row2" )\n',
    );
    const seen: string[] = [];
    for (;;) {
      const m = tr.scan(AllTypes);
      if (m === null) break;
      seen.push((m as unknown as { stringField: string }).stringField);
    }
    expect(seen).toEqual(["row1", "row2"]);
  });

  it("absent cell leaves field at default", () => {
    const tr = DatasetReader.fromString(
      `@dataset test.v1.AllTypes ( string_field, int32_field )
( , 7 )
`,
    );
    const [row] = [...tr];
    const msg = bindRow(AllTypes, tr.columns, row!);
    expect((msg as unknown as { stringField: string }).stringField).toBe("");
    expect((msg as unknown as { int32Field: number }).int32Field).toBe(7);
  });

  it("null cell clears wrapper field", () => {
    // `null` on a StringValue wrapper field clears it (draft §3.9).
    const tr = DatasetReader.fromString(
      "@dataset test.v1.AllTypes ( nullable_string )\n( null )\n",
    );
    const [row] = [...tr];
    const msg = bindRow(AllTypes, tr.columns, row!);
    expect((msg as unknown as { nullableString?: unknown }).nullableString).toBeUndefined();
  });

  it("bytes cell round-trip", () => {
    const tr = DatasetReader.fromString(
      '@dataset test.v1.AllTypes ( bytes_field )\n( b"YWJj" )\n', // "abc"
    );
    const [row] = [...tr];
    const msg = bindRow(AllTypes, tr.columns, row!);
    const bytes = (msg as unknown as { bytesField: Uint8Array }).bytesField;
    expect(Array.from(bytes)).toEqual([97, 98, 99]);
  });

  it("column / cell length mismatch errors", () => {
    expect(() =>
      bindRow(AllTypes, ["string_field"], {
        pos: { line: 1, column: 1, offset: 0 },
        cells: [null, null],
      }),
    ).toThrow(/1 columns vs 2 cells/);
  });

  it("unknown column errors", () => {
    const tr = DatasetReader.fromString(
      '@dataset test.v1.AllTypes ( not_a_field )\n( "x" )\n',
    );
    expect(() => tr.scan(AllTypes)).toThrow();
  });

  it("string escape round-trips", () => {
    const tr = DatasetReader.fromString(
      '@dataset test.v1.AllTypes ( string_field )\n( "she said \\"hi\\"" )\n',
    );
    const [row] = [...tr];
    const msg = bindRow(AllTypes, tr.columns, row!);
    expect((msg as unknown as { stringField: string }).stringField).toBe('she said "hi"');
  });
});
