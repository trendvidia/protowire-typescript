/**
 * Tests for the protowire CLI dispatcher. Drives `run()` directly with a
 * stub `readFile` so we can fold the on-disk testdata fixtures (.binpb)
 * back through the CLI without spawning a subprocess.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  type Registry,
  create,
  createFileRegistry,
  fromBinary,
  toBinary,
} from "@bufbuild/protobuf";
import { reflect } from "@bufbuild/protobuf/reflect";
import { FileDescriptorSetSchema } from "@bufbuild/protobuf/wkt";
import { describe, expect, it } from "vitest";

import { run } from "./main.js";

const here = dirname(fileURLToPath(import.meta.url));
const fdsPath = resolve(here, "../pxf/testdata/test.binpb");
const fdsBytes = readFileSync(fdsPath);
const registry: Registry = createFileRegistry(
  fromBinary(FileDescriptorSetSchema, new Uint8Array(fdsBytes)),
);
const AllTypes = registry.getMessage("test.v1.AllTypes")!;

const TEXT = new TextDecoder();
const ENC = new TextEncoder();

/**
 * Build a `readFile` stub backed by an in-memory map. Falls back to disk
 * for the descriptor fixture so we don't have to re-read it for every test.
 */
function makeReadFile(files: Record<string, Uint8Array | string>) {
  return async (path: string): Promise<Uint8Array> => {
    if (path === "schema.binpb") return new Uint8Array(fdsBytes);
    const v = files[path];
    if (v === undefined) throw new Error(`ENOENT: ${path}`);
    return typeof v === "string" ? ENC.encode(v) : v;
  };
}

const baseArgs = ["-d", "schema.binpb", "-m", "test.v1.AllTypes"];

describe("cli — argument handling", () => {
  it("prints usage on no args (exit 1)", async () => {
    const r = await run([], async () => {
      throw new Error("should not read");
    });
    expect(r.exit).toBe(1);
    expect(r.stderr).toContain("usage: protowire");
  });

  it("prints usage on --help (exit 0)", async () => {
    const r = await run(["--help"], async () => new Uint8Array());
    expect(r.exit).toBe(0);
    expect(r.stderr).toContain("usage: protowire");
  });

  it("requires --descriptor-set", async () => {
    const r = await run(
      ["encode", "-m", "test.v1.AllTypes", "in.pxf"],
      makeReadFile({ "in.pxf": "" }),
    );
    expect(r.exit).toBe(1);
    expect(r.stderr).toContain("--descriptor-set is required");
  });

  it("requires --message", async () => {
    const r = await run(
      ["encode", "-d", "schema.binpb", "in.pxf"],
      makeReadFile({ "in.pxf": "" }),
    );
    expect(r.exit).toBe(1);
    expect(r.stderr).toContain("--message is required");
  });

  it("errors on unknown command", async () => {
    const r = await run(
      ["bogus", ...baseArgs, "in.pxf"],
      makeReadFile({ "in.pxf": "" }),
    );
    expect(r.exit).toBe(1);
    expect(r.stderr).toMatch(/unknown command "bogus"/);
  });

  it("errors when message name is unknown", async () => {
    const r = await run(
      ["encode", "-d", "schema.binpb", "-m", "test.v1.NoSuch", "in.pxf"],
      makeReadFile({ "in.pxf": "" }),
    );
    expect(r.exit).toBe(1);
    expect(r.stderr).toContain("not found in descriptor set");
  });

  it("errors when input file is missing", async () => {
    const r = await run(
      ["encode", ...baseArgs, "missing.pxf"],
      makeReadFile({}),
    );
    expect(r.exit).toBe(1);
    expect(r.stderr).toContain("read missing.pxf");
  });
});

describe("cli — encode", () => {
  it("encodes PXF text to protobuf binary", async () => {
    const r = await run(
      ["encode", ...baseArgs, "in.pxf"],
      makeReadFile({ "in.pxf": `string_field = "hi"\nint32_field = 42` }),
    );
    expect(r.exit).toBe(0);
    expect(r.stderr).toBe("");
    // Decode the result via reflect and check field values.
    const msg = fromBinary(AllTypes, r.stdout);
    const ref = reflect(AllTypes, msg);
    expect(ref.get(AllTypes.fields.find((f) => f.name === "string_field")!)).toBe("hi");
    expect(ref.get(AllTypes.fields.find((f) => f.name === "int32_field")!)).toBe(42);
  });

  it("reports decode errors with exit 1", async () => {
    const r = await run(
      ["encode", ...baseArgs, "in.pxf"],
      makeReadFile({ "in.pxf": `bogus_field = 1` }),
    );
    expect(r.exit).toBe(1);
    expect(r.stderr).toContain("unknown field");
  });
});

describe("cli — decode", () => {
  it("decodes protobuf binary to PXF text", async () => {
    // Build a known message via reflect, marshal to binary, then run decode.
    const msg = create(AllTypes);
    const r0 = reflect(AllTypes, msg);
    r0.set(AllTypes.fields.find((f) => f.name === "string_field")!, "world");
    r0.set(AllTypes.fields.find((f) => f.name === "int32_field")!, 7);
    const bin = toBinary(AllTypes, msg);
    const r = await run(
      ["decode", ...baseArgs, "in.pb"],
      makeReadFile({ "in.pb": bin }),
    );
    expect(r.exit).toBe(0);
    const text = TEXT.decode(r.stdout);
    expect(text).toContain(`string_field = "world"`);
    expect(text).toContain(`int32_field = 7`);
  });
});

describe("cli — validate", () => {
  it("prints 'valid' on stderr for well-formed input", async () => {
    const r = await run(
      ["validate", ...baseArgs, "in.pxf"],
      makeReadFile({ "in.pxf": `string_field = "ok"` }),
    );
    expect(r.exit).toBe(0);
    expect(r.stdout.length).toBe(0);
    expect(r.stderr).toBe("valid\n");
  });

  it("reports parse errors with non-zero exit", async () => {
    const r = await run(
      ["validate", ...baseArgs, "in.pxf"],
      makeReadFile({ "in.pxf": `int32_field = "not a number"` }),
    );
    expect(r.exit).toBe(1);
    expect(r.stderr).toContain("expected integer");
  });
});

describe("cli — fmt", () => {
  it("normalizes PXF (decode + re-encode) and prepends @type", async () => {
    const r = await run(
      ["fmt", ...baseArgs, "in.pxf"],
      makeReadFile({
        "in.pxf": `int32_field=42\nstring_field="hi"`,
      }),
    );
    expect(r.exit).toBe(0);
    const out = TEXT.decode(r.stdout);
    expect(out.startsWith("@type test.v1.AllTypes\n\n")).toBe(true);
    expect(out).toContain(`string_field = "hi"`);
    expect(out).toContain(`int32_field = 42`);
  });
});
