// SPDX-License-Identifier: MIT
// Copyright (c) 2026 TrendVidia, LLC.
/**
 * Bind-time checks over the import closure (#33), the path a violation names
 * (#32), the oneof default rule at decode time (#31) and the `@required` /
 * `@default` carrier (#62). `testdata/annotations/` is vendored from the spec
 * repository: `settings_annotated.binpb` is its compiler's image, carrying only
 * extension 1327.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createFileRegistry, fromBinary, toBinary, type DescMessage } from "@bufbuild/protobuf";
import { FileDescriptorSetSchema } from "@bufbuild/protobuf/wkt";
import { describe, expect, it } from "vitest";

import { unmarshal, unmarshalFull } from "./decode.js";
import { fieldOptions } from "./annotations.js";
import { validateDescriptor, violationString } from "./schema.js";

const here = dirname(fileURLToPath(import.meta.url));

function registry(path: string) {
  const bytes = new Uint8Array(readFileSync(resolve(here, "testdata", path)));
  return createFileRegistry(fromBinary(FileDescriptorSetSchema, bytes));
}

const checks = registry("bind-checks-test.binpb");

function get(reg: ReturnType<typeof registry>, name: string): DescMessage {
  const m = reg.getMessage(name);
  if (!m) throw new Error(`missing ${name}`);
  return m;
}

describe("bind-time checks", () => {
  const vs = validateDescriptor(get(checks, "bindcheck.v1.BadDefaults"));
  const elements = (kind: string): string[] => vs.filter((v) => v.kind === kind).map((v) => v.element);

  it("refuses a default one literal cannot denote", () => {
    expect(elements("defaultOption")).toEqual(
      expect.arrayContaining([
        "bindcheck.v1.BadDefaults.list",
        "bindcheck.v1.BadDefaults.map",
        "bindcheck.v1.BadDefaults.msg",
      ]),
    );
  });

  it("leaves a default on a type a literal denotes", () => {
    expect(elements("defaultOption")).not.toContain("bindcheck.v1.BadDefaults.ok_ts");
    expect(elements("defaultOption")).not.toContain("bindcheck.v1.BadDefaults.ok_wrap");
  });

  it("refuses two defaults in one oneof, on each member", () => {
    expect(elements("defaultOption")).toEqual(
      expect.arrayContaining(["bindcheck.v1.TwoOneofDefaults.a", "bindcheck.v1.TwoOneofDefaults.b"]),
    );
  });

  it("refuses required on a oneof member, naming the oneof", () => {
    const v = vs.find((x) => x.element === "bindcheck.v1.RequiredMember.a");
    expect(v?.kind).toBe("requiredOption");
    expect(v?.name).toBe("choice");
  });

  it("reports an imported file's violation against that file, with its extension", () => {
    const v = vs.find((x) => x.element === "bindcheck.v1.Imported.null");
    expect(v).toMatchObject({ file: "bind-imported-test.proto", kind: "field", name: "null" });
  });

  it("names the descriptor's path for the bound file too", () => {
    expect(vs.find((x) => x.element === "bindcheck.v1.BadDefaults.list")?.file).toBe("bind-checks-test.proto");
  });

  it("renders a default violation", () => {
    const v = vs.find((x) => x.element === "bindcheck.v1.BadDefaults.msg")!;
    expect(violationString(v)).toContain('invalid (pxf.default) = "x"');
  });

  it("fails the decode", () => {
    expect(() => unmarshal("", get(checks, "bindcheck.v1.BadDefaults"))).toThrow(/schema violations/);
  });

  it("returns a fresh array", () => {
    const desc = get(checks, "bindcheck.v1.BadDefaults");
    expect(validateDescriptor(desc)).not.toBe(validateDescriptor(desc));
  });
});

describe("a default on a oneof member (#31)", () => {
  const OneDefault = get(registry("bind-oneof-test.binpb"), "bindoneof.v1.OneDefault");
  const decode = (doc: string) =>
    unmarshalFull(doc, OneDefault).message as unknown as {
      choice: { case?: string; value?: string };
      kept: string;
    };

  it("keeps the arm the document chose", () => {
    expect(decode('a = "written"').choice).toEqual({ case: "a", value: "written" });
  });

  it("applies when no member is present", () => {
    expect(decode("").choice).toEqual({ case: "b", value: "bbb" });
  });

  it("a null member counts as present", () => {
    expect(decode("a = null").choice.case).toBeUndefined();
  });

  it("does not treat proto3 optional as a oneof", () => {
    expect(decode('a = "x"').kept).toBe("kkk");
  });
});

describe("the annotation carrier (#62)", () => {
  const ok = readFileSync(resolve(here, "testdata/annotations/ok.pxf"), "utf8");
  const missing = readFileSync(resolve(here, "testdata/annotations/missing-required.pxf"), "utf8");
  const golden = readFileSync(resolve(here, "testdata/annotations/ok.expected.hex"), "utf8").trim();

  const spellings: [string, string, string][] = [
    ["bracket", "settings.binpb", "settings.v1.Settings"],
    ["annotation", "settings_annotated.binpb", "settings.annotated.v1.Settings"],
  ];

  it.each(spellings)("%s: gives the golden bytes", (_, file, name) => {
    const desc = get(registry(`annotations/${file}`), name);
    const { message } = unmarshalFull(ok, desc);
    expect(Buffer.from(toBinary(desc, message)).toString("hex")).toBe(golden);
  });

  it.each(spellings)("%s: rejects a missing required field", (_, file, name) => {
    expect(() => unmarshalFull(missing, get(registry(`annotations/${file}`), name))).toThrow(/required field "name"/);
  });

  it("reads the carrier, not the bracket numbers", () => {
    const desc = get(registry("annotations/settings_annotated.binpb"), "settings.annotated.v1.Settings");
    const retries = desc.fields.find((f) => f.name === "retries")!;
    expect(fieldOptions(retries)).toMatchObject({ def: "3", defSurface: "carrier" });
    expect(fieldOptions(desc.fields.find((f) => f.name === "name")!)).toMatchObject({
      required: true,
      requiredSurface: "carrier",
    });
  });
});

describe("a message with the wrong shape (#79)", () => {
  it("is an ordinary message where nothing validates", () => {
    const Timestamp = get(registry("bind-wkt-google-test.binpb"), "google.protobuf.Timestamp");
    const msg = unmarshal('seconds = "x"', Timestamp, { skipValidate: true });
    expect((msg as unknown as { seconds: string }).seconds).toBe("x");
  });

  it("fails the decode when validated", () => {
    const Timestamp = get(registry("bind-wkt-google-test.binpb"), "google.protobuf.Timestamp");
    expect(() => unmarshal("nanos = 1", Timestamp)).toThrow(/redefines a well-known type/);
  });
});

describe("retired option numbers (#79)", () => {
  it("fail the decode, saying what to recompile against", () => {
    const Old = get(registry("bind-retired-test.binpb"), "bindretired.v1.Old");
    expect(() => unmarshal("", Old)).toThrow(/option number 50000 on FieldOptions was \(pxf\.required\)/);
  });

  it("are not this port's business in a file that never imported protowire", () => {
    const Unrelated = get(registry("bind-unrelated-test.binpb"), "bindretired.v1.Unrelated");
    expect(validateDescriptor(Unrelated)).toEqual([]);
  });
});
