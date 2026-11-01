// SPDX-License-Identifier: MIT
// Copyright (c) 2026 TrendVidia, LLC.
/**
 * An entry name of a keyed block populates the element's key field (draft -01
 * §3.13), so it counts as the document supplying that field
 * (protowire-go#214). Mirrors the reference's
 * `keyed_entry_name_presence_test.go`.
 *
 * This port's `postDecode` does not walk list elements yet (#58), so a default
 * or a required check on an element's field cannot misfire today. The value
 * checks below pin the answer the reference gives for when it does. The oneof
 * rows also need the sibling check of #31 by then.
 * `keyed-entry-name-test.binpb` comes from `npm run gen:testdata:keyed:buf`.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { type DescMessage, createFileRegistry, fromBinary } from "@bufbuild/protobuf";
import { FileDescriptorSetSchema } from "@bufbuild/protobuf/wkt";
import { describe, expect, it } from "vitest";

import { unmarshal, unmarshalFull } from "./decode.js";

const here = dirname(fileURLToPath(import.meta.url));
const registry = createFileRegistry(
  fromBinary(
    FileDescriptorSetSchema,
    new Uint8Array(readFileSync(resolve(here, "testdata/keyed-entry-name-test.binpb"))),
  ),
);

function message(name: string): DescMessage {
  const m = registry.getMessage(name);
  if (!m) throw new Error(`missing descriptor for ${name}`);
  return m;
}

const P = message("keyedname.v1.P");
const Nests = message("keyedname.v1.Nests");

interface Entry {
  name: string;
  inner?: Entry[];
  pick?: { case: string | undefined; value?: string };
}
type Doc = Record<"kd" | "kr" | "ko" | "kn", Entry[]>;

describe("a keyed entry's name supplies the key field", () => {
  const read = (m: Doc) => ({
    kd: (i: number) => m.kd[i]?.name,
    kr: (i: number) => m.kr[i]?.name,
    ko: (i: number) => m.ko[i]?.pick?.value,
    kn: () => m.kn[0]?.inner?.[0]?.name,
  });

  it.each<[string, (r: ReturnType<typeof read>) => string | undefined, string, string]>([
    ["kd { alpha {} }", (r) => r.kd(0), "alpha", "kd[0].name"],
    ['kd { "not ident" {} }', (r) => r.kd(0), "not ident", "kd[0].name"],
    ["kd { alpha = {} }", (r) => r.kd(0), "alpha", "kd[0].name"],
    ["kd = { alpha {} }", (r) => r.kd(0), "alpha", "kd[0].name"],
    ["kd { a {} alpha {} }", (r) => r.kd(1), "alpha", "kd[1].name"],
    ['kd { alpha { name = "alpha" } }', (r) => r.kd(0), "alpha", "kd[0].name"],
    ["kr { alpha {} }", (r) => r.kr(0), "alpha", "kr[0].name"],
    ["ko { alpha {} }", (r) => r.ko(0), "alpha", "ko[0].name"],
    ["kn { a { inner { alpha {} } } }", (r) => r.kn(), "alpha", "kn[0].inner[0].name"],
  ])("%s", (doc, value, want, mark) => {
    const { message: m, result } = unmarshalFull(doc, P);
    expect(value(read(m as unknown as Doc))).toBe(want);
    expect(result.isSet(mark)).toBe(true);
    expect(result.isAbsent(mark)).toBe(false);
  });

  it("marks the entry's own index, not the next one", () => {
    const { result } = unmarshalFull("kd { a {} b {} }", P);
    expect(result.isSet("kd[0].name")).toBe(true);
    expect(result.isSet("kd[1].name")).toBe(true);
    expect(result.isAbsent("kd[2].name")).toBe(true);
  });

  it("does not record the key against the enclosing message", () => {
    const { result } = unmarshalFull("kd { alpha {} }", P);
    expect(result.isAbsent("name")).toBe(true);
  });

  // Only an entry name counts as supplying the key.
  it("leaves an anonymous element's key absent", () => {
    expect(unmarshalFull("kd = [{}]", P).result.isAbsent("kd[0].name")).toBe(true);
  });

  // The other members of the key's oneof see the key as chosen.
  it("keeps the key when a oneof sibling has a default", () => {
    const { message: m } = unmarshalFull("ko { alpha {} }", P);
    expect((m as unknown as Doc).ko[0]?.pick).toEqual({ case: "name", value: "alpha" });
  });

  it("populates the key in an Any body", () => {
    const typeResolver = { findMessageByURL: (url: string) => registry.getMessage(url) };
    const doc = 'payload { @type = "keyedname.v1.Nests" inner { alpha {} } }';
    const { message: m } = unmarshalFull(doc, P, { typeResolver });
    const payload = (m as unknown as { payload: { value: Uint8Array } }).payload;
    const inner = fromBinary(Nests, payload.value) as unknown as { inner: Entry[] };
    expect(inner.inner[0]?.name).toBe("alpha");
  });

  it("leaves unmarshal, which records no presence, decoding the key", () => {
    const m = unmarshal("kd { alpha {} }", P) as unknown as Doc;
    expect(m.kd[0]?.name).toBe("alpha");
  });
});
