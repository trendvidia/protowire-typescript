// SPDX-License-Identifier: MIT
// Copyright (c) 2026 TrendVidia, LLC.
/**
 * Holds this port to protowire-go on the spec corpus. `testdata/corpus/` is
 * vendored verbatim from the spec repository. `reference.json` records what
 * the pinned protowire-go does with each fixture: accepted or not on each
 * leg, and the protobuf bytes it bound. `scripts/go-reference` writes it, and
 * CI regenerates it to prove it is current.
 *
 * `GAPS` lists fixtures this port does not meet yet, each with its issue. A
 * listed fixture must still diverge, so the fix that closes one fails here
 * until its line is removed.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createFileRegistry, equals, fromBinary, type DescMessage, type Message } from "@bufbuild/protobuf";
import { FileDescriptorSetSchema } from "@bufbuild/protobuf/wkt";
import { describe, expect, it } from "vitest";

import { bindRow, DatasetReader } from "./dataset_reader.js";
import { unmarshal, type UnmarshalOptions } from "./decode.js";
import { marshal } from "./encode.js";
import { format } from "./format.js";
import { parse } from "./parser.js";
import { validateFile } from "./schema.js";

interface Leg {
  accept: boolean;
  hex?: string[];
}
interface FixtureRecord {
  parse: boolean;
  format?: string;
  decode: Leg;
  marshal?: string;
  stream?: Leg;
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "testdata/corpus");
const record = JSON.parse(readFileSync(resolve(root, "reference.json"), "utf8")) as {
  fixtures: Record<string, FixtureRecord>;
  violations: Record<string, unknown[]>;
};
const reference = record.fixtures;

const GAPS: Record<string, number> = {
  "any/assignment.pxf": 48,
  "any/block.pxf": 48,
  "any/list-element.pxf": 48,
  "any/map-value.pxf": 48,
  "any/url-verbatim.pxf": 48,
  "dataset/block-cell.pxf": 47,
  "dataset/cell-framing.pxf": 47,
  "dataset/dotted-bad-header-no-rows.pxf": 49,
  "dataset/dotted-column.pxf": 49,
  "dataset/dotted-grouping.pxf": 49,
  "dataset/dotted-into-any.pxf": 49,
  "dataset/dotted-into-secret.pxf": 49,
  "dataset/dotted-null-leaf.pxf": 49,
  "dataset/dotted-oneof.pxf": 49,
  "dataset/dotted-required.pxf": 49,
  "dataset/dotted-with-value-cells.pxf": 49,
  "dataset/duplicate-column.pxf": 49,
  "dataset/list-cell.pxf": 47,
  "dataset/nested-cells.pxf": 47,
  "any/err-not-any.pxf": 48,
  "any/err-unresolved.pxf": 48,
  "dataset/block-on-scalar.pxf": 47,
  "dataset/dotted-bad-header-empty-row.pxf": 49,
  "dataset/dotted-into-bignum.pxf": 49,
  "dataset/dotted-into-duration.pxf": 49,
  "dataset/dotted-into-timestamp.pxf": 49,
  "dataset/dotted-into-wrapper.pxf": 49,
  "dataset/dotted-oneof-two-members.pxf": 49,
  "dataset/dotted-required-missing.pxf": 49,
  "dataset/dotted-through-map.pxf": 49,
  "dataset/dotted-through-repeated.pxf": 49,
  "dataset/dotted-through-scalar.pxf": 49,
  "dataset/dotted-unknown-segment.pxf": 49,
};

function registryFor(dir: string) {
  const bytes = new Uint8Array(readFileSync(resolve(root, dir, `${dir}.binpb`)));
  return createFileRegistry(fromBinary(FileDescriptorSetSchema, bytes));
}

function typeName(text: string): string {
  const m = /^@(?:type|dataset)\s+([\w.]+)/m.exec(text);
  if (!m) throw new Error("fixture names no type");
  return m[1]!;
}

function decodeLeg(text: string, desc: DescMessage, options: UnmarshalOptions): Message[] {
  const doc = parse(text);
  if (doc.datasets.length === 0) return [unmarshal(text, desc, options)];
  return doc.datasets.flatMap((ds) => ds.rows.map((row) => bindRow(desc, ds.columns, row)));
}

function streamLeg(text: string, desc: DescMessage): Message[] {
  const reader = DatasetReader.fromString(text);
  const rows: Message[] = [];
  for (const row of reader) rows.push(bindRow(desc, reader.columns, row));
  return rows;
}

/** Why `run` differs from the reference's leg, or null when it does not. */
function compare(leg: string, want: Leg, desc: DescMessage, run: () => Message[]): string | null {
  let got: Message[];
  try {
    got = run();
  } catch (err) {
    return want.accept ? `${leg}: rejected: ${String(err)}` : null;
  }
  if (!want.accept) return `${leg}: accepted, the reference rejects`;
  const hex = want.hex ?? [];
  if (got.length !== hex.length) return `${leg}: ${got.length} messages, the reference bound ${hex.length}`;
  for (let i = 0; i < hex.length; i++) {
    const bytes = Uint8Array.from(Buffer.from(hex[i]!, "hex"));
    if (!equals(desc, got[i]!, fromBinary(desc, bytes))) return `${leg}: message ${i} differs from the reference`;
  }
  return null;
}

const dirs = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);

describe("corpus reference record", () => {
  it("covers every vendored directory", () => {
    expect(new Set(Object.keys(reference).map((k) => k.split("/")[0]))).toEqual(new Set(dirs));
  });
});

for (const dir of dirs) {
  describe(`corpus ${dir}`, () => {
    const registry = registryFor(dir);
    const typeResolver = {
      findMessageByURL: (url: string) => registry.getMessage(url.slice(url.lastIndexOf("/") + 1)),
    };
    for (const key of Object.keys(reference).filter((k) => k.startsWith(`${dir}/`))) {
      it(key, () => {
        const want = reference[key]!;
        const text = readFileSync(resolve(root, key), "utf8");
        const name = typeName(text);
        const desc = registry.getMessage(name);
        if (!desc) throw new Error(`no descriptor for ${name}`);
        const failures: string[] = [];
        let parsed = true;
        try {
          const formatted = format(parse(text));
          if (want.format !== undefined && formatted !== want.format) failures.push("format: text differs from the reference");
        } catch {
          parsed = false;
        }
        if (parsed !== want.parse) failures.push(`parse: ${parsed ? "accepted" : "rejected"}, the reference did not`);
        const decode = compare("decode", want.decode, desc, () => decodeLeg(text, desc, { typeResolver }));
        if (decode) failures.push(decode);
        if (!decode && want.marshal !== undefined && marshal(unmarshal(text, desc, { typeResolver }), desc, { typeResolver }) !== want.marshal) {
          failures.push("marshal: text differs from the reference");
        }
        if (want.stream) {
          const stream = compare("stream", want.stream, desc, () => streamLeg(text, desc));
          if (stream) failures.push(stream);
        }
        if (GAPS[key] !== undefined) {
          expect(failures, `${key} now conforms: remove its GAPS line (#${GAPS[key]})`).not.toEqual([]);
        } else {
          expect(failures.join("\n")).toBe("");
        }
      });
    }
  });
}

describe("corpus map-keys spelling", () => {
  const dir = resolve(root, "map-keys");
  const registry = registryFor("map-keys");
  for (const stem of ["fmt-bare-keys", "fmt-dotted-keys", "fmt-keyword-keys"]) {
    const input = readFileSync(resolve(dir, `${stem}.pxf`), "utf8");
    const expected = readFileSync(resolve(dir, `${stem}.expected.pxf`), "utf8");
    it(`${stem} formats to its expected file, a fixed point`, () => {
      expect(format(parse(input))).toBe(expected);
      expect(format(parse(expected))).toBe(expected);
    });
    it(`${stem} binds the same before and after`, () => {
      const desc = registry.getMessage(typeName(input))!;
      expect(equals(desc, unmarshal(input, desc), unmarshal(expected, desc))).toBe(true);
    });
  }
  it("marshal spells dotted keys as the expected file does", () => {
    const expected = readFileSync(resolve(dir, "fmt-dotted-keys.expected.pxf"), "utf8");
    const desc = registry.getMessage(typeName(expected))!;
    const out = marshal(unmarshal(expected, desc), desc);
    for (const key of ["a.b:", "c.d:", '".e":', '"1.5":']) expect(out).toContain(key);
  });
});

describe("bind-time violations", () => {
  const files = readdirSync(resolve(root, "..")).filter((f) => /^bind-.*-test\.binpb$/.test(f));
  for (const set of files) {
    const registry = createFileRegistry(
      fromBinary(FileDescriptorSetSchema, new Uint8Array(readFileSync(resolve(root, "..", set)))),
    );
    for (const file of registry.files) {
      if (!file.proto.name.startsWith("bind-")) continue;
      it(`${file.proto.name} matches the reference`, () => {
        const got = validateFile(file).map(({ file: f, element, kind, name }) => ({ file: f, element, kind, name }));
        expect(got).toEqual(record.violations[file.proto.name]);
      });
    }
  }
});

