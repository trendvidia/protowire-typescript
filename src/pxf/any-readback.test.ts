// SPDX-License-Identifier: MIT
// Copyright (c) 2026 TrendVidia, LLC.
/**
 * An Any is written as a type entry and body only when decoding the body gives
 * exactly the stored value bytes, and as type_url and value otherwise
 * (protowire#501). Each case is one the reference measured as differing.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { create, createFileRegistry, equals, fromBinary, toBinary } from "@bufbuild/protobuf";
import { AnySchema, FileDescriptorSetSchema } from "@bufbuild/protobuf/wkt";
import { describe, expect, it } from "vitest";

import { unmarshal } from "./decode.js";
import { marshal } from "./encode.js";

const here = dirname(fileURLToPath(import.meta.url));
const reg = createFileRegistry(
  fromBinary(FileDescriptorSetSchema, new Uint8Array(readFileSync(resolve(here, "testdata/any-readback-test.binpb")))),
);
const Holder = reg.getMessage("anyreadback.v1.Holder")!;
const typeResolver = { findMessageByURL: (u: string) => reg.getMessage(u.slice(u.lastIndexOf("/") + 1)) };

function holding(type: string, value: number[]) {
  const payload = create(AnySchema, { typeUrl: `type.googleapis.com/anyreadback.v1.${type}`, value: Uint8Array.from(value) });
  return create(Holder, { payload } as never);
}

function roundTrip(type: string, value: number[]): { text: string; same: boolean } {
  const msg = holding(type, value);
  const text = marshal(msg, Holder, { typeResolver });
  const back = unmarshal(text, Holder, { typeResolver });
  return { text, same: equals(Holder, back, msg) };
}

describe("an Any body that would not read back is written raw", () => {
  it.each([
    ["an unknown field", "Inner", [0x0a, 0x01, 0x78, 0xf8, 0x06, 0x01]],
    ["fields out of order", "Inner", [0x10, 0x02, 0x0a, 0x01, 0x78]],
    ["map entries out of key order", "Inner", [0x1a, 0x05, 0x0a, 0x01, 0x7a, 0x10, 0x01, 0x1a, 0x05, 0x0a, 0x01, 0x61, 0x10, 0x02]],
    ["an explicitly written zero", "Inner", [0x10, 0x00]],
    ["a Timestamp no literal holds", "Inner", [0x22, 0x0b, 0x08, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f, 0x10, 0x01]],
    ["an unset default", "WithDefault", []],
    ["an unset required field", "WithRequired", []],
  ])("%s", (_, type, value) => {
    const { text, same } = roundTrip(type as string, value as number[]);
    expect(text).toContain("type_url = ");
    expect(text).not.toContain("@type = ");
    expect(same).toBe(true);
  });
});

describe("an Any body that reads back is written as a body", () => {
  it("in canonical order", () => {
    const value = toBinary(reg.getMessage("anyreadback.v1.Inner")!, create(reg.getMessage("anyreadback.v1.Inner")!, { a: "x", b: 2 } as never));
    const { text, same } = roundTrip("Inner", [...value]);
    expect(text).toContain('@type = "type.googleapis.com/anyreadback.v1.Inner"');
    expect(same).toBe(true);
  });
});
