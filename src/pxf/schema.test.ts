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
  create,
  createFileRegistry,
  fromBinary,
} from "@bufbuild/protobuf";
import {
  FieldDescriptorProto_Label,
  FieldDescriptorProto_Type,
  FieldOptionsSchema,
  FileDescriptorProtoSchema,
  FileDescriptorSetSchema,
} from "@bufbuild/protobuf/wkt";
import { describe, expect, it } from "vitest";

import { WireType, Writer } from "../pb/wire.js";
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
    ).toThrow(/PXF schema violations/);
  });

  it("unmarshalFull is also gated", () => {
    expect(() =>
      unmarshalFull("a = 1\n", getMessage("schema.test.v1.FieldNull")),
    ).toThrow(/PXF schema violations/);
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

// The options are raw bytes, parsed the way a compiled descriptor's are, so
// these keep running once a compiler rejects the pair too.
function fieldOptionsBytes(required: boolean | undefined, def: string | undefined): Uint8Array {
  const w = new Writer();
  if (required !== undefined) {
    w.tag(1314, WireType.Varint);
    w.varint(required ? 1 : 0);
  }
  if (def !== undefined) {
    w.tag(1315, WireType.LengthDelimited);
    w.string(def);
  }
  return w.finish();
}

function annotatedMessage(required: boolean | undefined, def: string | undefined): DescMessage {
  const fileProto = create(FileDescriptorProtoSchema, {
    name: "requireddefault.proto",
    package: "requireddefault.test.v1",
    syntax: "proto3",
    messageType: [
      {
        name: "M",
        field: [
          {
            name: "f",
            number: 1,
            jsonName: "f",
            label: FieldDescriptorProto_Label.OPTIONAL,
            type: FieldDescriptorProto_Type.STRING,
            options: fromBinary(FieldOptionsSchema, fieldOptionsBytes(required, def)),
          },
        ],
        nestedType: [
          {
            name: "Inner",
            field: [
              {
                name: "g",
                number: 1,
                jsonName: "g",
                label: FieldDescriptorProto_Label.OPTIONAL,
                type: FieldDescriptorProto_Type.STRING,
                options: fromBinary(FieldOptionsSchema, fieldOptionsBytes(required, def)),
              },
            ],
          },
        ],
      },
    ],
  });
  const m = createFileRegistry(fileProto, () => undefined).getMessage("requireddefault.test.v1.M");
  if (!m) throw new Error("missing descriptor for M");
  return m;
}

describe("(pxf.required) with (pxf.default)", () => {
  it("is refused on one field, in a nested message too", () => {
    const vs = validateDescriptor(annotatedMessage(true, "x"));
    expect(vs.map((v) => [v.element, v.kind])).toEqual([
      ["requireddefault.test.v1.M.Inner.g", "requiredOption"],
      ["requireddefault.test.v1.M.f", "requiredOption"],
    ]);
    expect(violationString(vs[1]!)).toContain(
      'field "requireddefault.test.v1.M.f": invalid (pxf.required): ' +
        "(pxf.required) and (pxf.default) are exclusive on one field: the first rejects a document " +
        "where the field is absent, and the second treats it as supplied (draft -01 §annotation-extensions)",
    );
  });

  it("is refused when the default is the empty string", () => {
    expect(validateDescriptor(annotatedMessage(true, ""))).toHaveLength(2);
  });

  it("is accepted with (pxf.required) = false beside a default", () => {
    expect(validateDescriptor(annotatedMessage(false, "x"))).toEqual([]);
  });

  it("is accepted with either option alone", () => {
    expect(validateDescriptor(annotatedMessage(true, undefined))).toEqual([]);
    expect(validateDescriptor(annotatedMessage(undefined, "x"))).toEqual([]);
  });

  it("fails the bind whether or not the document has the field", () => {
    const m = annotatedMessage(true, "x");
    const msg = /\(pxf\.required\) and \(pxf\.default\) are exclusive on one field/;
    expect(() => unmarshal('f = "present"', m)).toThrow(msg);
    expect(() => unmarshalFull('f = "present"', m)).toThrow(msg);
    expect(() => unmarshalFull("", m)).toThrow(msg);
  });

  it("lets a default beside (pxf.required) = false apply to an absent field", () => {
    const m = annotatedMessage(false, "x");
    const { message } = unmarshalFull("", m);
    expect((message as unknown as { f: string }).f).toBe("x");
  });

  it("skipValidate bypasses the check", () => {
    const m = annotatedMessage(true, "x");
    expect(() => unmarshal('f = "present"', m, { skipValidate: true })).not.toThrow();
  });
});
