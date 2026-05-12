// SPDX-License-Identifier: MIT
// Copyright (c) 2026 TrendVidia, LLC.
/**
 * Tests for the PXF schema reserved-name validator (draft §3.13) and
 * the Unmarshal-time gate.
 *
 * Note on scope: `validateDescriptor(desc)` walks the FILE the
 * descriptor lives in (matching Go's `protoreflect.MessageDescriptor.
 * ParentFile()` behavior), so a single call returns every violation
 * declared in `schema-test.proto`. Tests filter by element FQN prefix
 * to isolate the specific case under test.
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
import { validateDescriptor, violationString, type Violation } from "./schema.js";

const here = dirname(fileURLToPath(import.meta.url));
const fdsBytes = readFileSync(resolve(here, "testdata/schema-test.binpb"));
const registry: Registry = createFileRegistry(
  fromBinary(FileDescriptorSetSchema, new Uint8Array(fdsBytes)),
);

function getMessage(typeName: string): DescMessage {
  const m = registry.getMessage(typeName);
  if (!m) throw new Error(`missing descriptor for ${typeName}`);
  return m;
}

/** All violations declared in schema-test.proto, sorted by element FQN. */
const allViolations: Violation[] = validateDescriptor(getMessage("schema.test.v1.Conformant"));

function under(prefix: string): Violation[] {
  return allViolations.filter(
    (v) => v.element === prefix || v.element.startsWith(prefix + "."),
  );
}

describe("validateDescriptor", () => {
  it("null / undefined descriptor returns empty", () => {
    expect(validateDescriptor(null)).toEqual([]);
    expect(validateDescriptor(undefined)).toEqual([]);
  });

  it("field named null caught", () => {
    const vs = under("schema.test.v1.FieldNull");
    expect(vs).toHaveLength(1);
    expect(vs[0]).toEqual<Violation>({
      // bufbuild's DescFile.name omits the `.proto` extension.
      file: "schema-test",
      element: "schema.test.v1.FieldNull.null",
      name: "null",
      kind: "field",
    });
    expect(violationString(vs[0]!)).toContain('PXF-reserved name "null"');
  });

  it("oneof named true caught", () => {
    const vs = under("schema.test.v1.OneofTrue");
    expect(vs).toHaveLength(1);
    expect(vs[0]!.kind).toBe("oneof");
    expect(vs[0]!.element).toBe("schema.test.v1.OneofTrue.true");
  });

  it("file-level enum value named false caught", () => {
    // proto3 places file-level enum values at the FILE package scope:
    // `enum SideFalse { false = 1; }` → "schema.test.v1.false".
    const fileLevel = allViolations.filter((v) => v.element === "schema.test.v1.false");
    expect(fileLevel).toHaveLength(1);
    expect(fileLevel[0]!.kind).toBe("enumValue");
  });

  it("nested enum value caught", () => {
    const vs = under("schema.test.v1.OuterWithNestedEnum");
    expect(vs).toHaveLength(1);
    expect(vs[0]!.kind).toBe("enumValue");
    // Nested enum values live at the enclosing message's scope.
    expect(vs[0]!.element).toBe("schema.test.v1.OuterWithNestedEnum.null");
  });

  it("nested message field caught", () => {
    const vs = under("schema.test.v1.OuterWithNestedMsg");
    const fields = vs.filter((v) => v.kind === "field");
    expect(fields).toHaveLength(1);
    expect(fields[0]!.element).toBe("schema.test.v1.OuterWithNestedMsg.Inner.true");
  });

  it("case-sensitive: NULL / True don't trip the validator", () => {
    expect(under("schema.test.v1.CaseInsensitiveOK")).toEqual([]);
  });

  it("multi-violation sort: stable by element FQN", () => {
    const vs = under("schema.test.v1.MultiViolations");
    expect(vs.map((v) => v.element)).toEqual([
      "schema.test.v1.MultiViolations.false",
      "schema.test.v1.MultiViolations.null",
    ]);
  });

  it("synthetic oneof from proto3 optional is filtered", () => {
    // `optional int64 null = 1;` produces both a field named `null`
    // and a synthetic oneof — but bufbuild's DescMessage.oneofs filters
    // synthetic oneofs, so we expect exactly ONE violation (the field).
    const vs = under("schema.test.v1.SyntheticOneof");
    expect(vs).toHaveLength(1);
    expect(vs[0]!.kind).toBe("field");
  });
});

describe("unmarshal-time gate", () => {
  it("unmarshal rejects non-conformant schema", () => {
    expect(() =>
      unmarshal("a = 1\n", getMessage("schema.test.v1.FieldNull")),
    ).toThrow(/PXF schema reserved-name violations/);
  });

  it("unmarshalFull is also gated", () => {
    expect(() =>
      unmarshalFull("a = 1\n", getMessage("schema.test.v1.FieldNull")),
    ).toThrow(/PXF schema reserved-name violations/);
  });

  it("skipValidate bypasses the check", () => {
    // Body doesn't reference the reserved-name field, so decode succeeds
    // once the gate is skipped.
    const msg = unmarshal("a = 1\n", getMessage("schema.test.v1.FieldNull"), {
      skipValidate: true,
    });
    expect((msg as unknown as { a: bigint }).a).toBe(1n);
  });
});
