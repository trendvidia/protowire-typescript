// SPDX-License-Identifier: MIT
// Copyright (c) 2026 TrendVidia, LLC.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createFileRegistry, fromBinary } from "@bufbuild/protobuf";
import { FileDescriptorSetSchema } from "@bufbuild/protobuf/wkt";
import { describe, expect, it } from "vitest";

import { Codec } from "./sbe.js";

const here = dirname(fileURLToPath(import.meta.url));
const fdsBytes = readFileSync(resolve(here, "testdata/sbe-test.binpb"));

function loadCodec(): Codec {
  const reg = createFileRegistry(
    fromBinary(FileDescriptorSetSchema, new Uint8Array(fdsBytes)),
  );
  const file = reg.getFile("sbe-test.proto");
  if (!file) throw new Error("sbe-test.proto not in registry");
  return Codec.fromFiles(file);
}

describe("Codec.fromFiles", () => {
  it("registers messages with template_id", () => {
    const codec = loadCodec();
    expect(codec.byName.has("test.v1.Order")).toBe(true);
    expect(codec.byName.has("test.v1.Simple")).toBe(true);
    expect(codec.byName.has("test.v1.WithComposite")).toBe(true);
    expect(codec.byName.has("test.v1.WithNarrow")).toBe(true);
    // Inner has no template_id and is only referenced as a composite.
    expect(codec.byName.has("test.v1.Inner")).toBe(false);
  });

  it("computes Simple block length", () => {
    const codec = loadCodec();
    const t = codec.template("test.v1.Simple");
    // id:uint32(4) + value:int32(4) = 8
    expect(t.blockLength).toBe(8);
    expect(t.templateId).toBe(2);
    expect(t.schemaId).toBe(1);
    expect(t.version).toBe(0);
    expect(t.groups).toHaveLength(0);
  });

  it("computes Order block length and group", () => {
    const codec = loadCodec();
    const t = codec.template("test.v1.Order");
    // order_id(8)+symbol(8)+price(8)+quantity(4)+side(1)+active(1)+weight(8)+score(4) = 42
    expect(t.blockLength).toBe(42);
    expect(t.groups).toHaveLength(1);
    expect(t.groups[0]!.blockLength).toBe(20); // fill_price(8)+fill_qty(4)+fill_id(8)
  });

  it("computes WithComposite block length", () => {
    const codec = loadCodec();
    const t = codec.template("test.v1.WithComposite");
    // id(8) + inner:x(8)+y(8)=16 + code(4) = 28
    expect(t.blockLength).toBe(28);
    const inner = t.fields.find((f) => f.fd.name === "inner");
    expect(inner?.composite.map((c) => c.fd.name)).toEqual(["x", "y"]);
  });

  it("respects (sbe.encoding) overrides", () => {
    const codec = loadCodec();
    const t = codec.template("test.v1.WithNarrow");
    // status:uint8(1) + port:uint16(2) + delta:int16(2) = 5
    expect(t.blockLength).toBe(5);
    expect(t.fields.map((f) => [f.fd.name, f.encoding, f.size])).toEqual([
      ["status", "uint8", 1],
      ["port", "uint16", 2],
      ["delta", "int16", 2],
    ]);
  });

  it("looks up by template ID", () => {
    const codec = loadCodec();
    expect(codec.templateById(1).desc.typeName).toBe("test.v1.Order");
    expect(codec.templateById(2).desc.typeName).toBe("test.v1.Simple");
    expect(codec.templateById(3).desc.typeName).toBe("test.v1.WithComposite");
    expect(codec.templateById(4).desc.typeName).toBe("test.v1.WithNarrow");
  });
});
