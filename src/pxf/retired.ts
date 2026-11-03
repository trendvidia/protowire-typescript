// SPDX-License-Identifier: MIT
// Copyright (c) 2026 TrendVidia, LLC.
/**
 * Retired option numbers. Before protowire v1.12.0 the family's extensions sat
 * in an unregistered 50000-59999 range. Without this check a descriptor from
 * then fails silently: `(pxf.required)` stops being enforced and the schema
 * binds documents it should reject. Mirrors the reference's `retired.go`.
 *
 * It is scoped two ways, because 50000 and up is where any unregistered project
 * puts its numbers: a number counts only on the options kind the retired
 * allocation used, and only in a file importing protowire's own annotations.
 */

import type { DescFile, DescMessage } from "@bufbuild/protobuf";

import type { Violation } from "./schema.js";

type Retired = readonly [was: string, now: number, file: string];

const SBE = "sbe/annotations.proto";
const PXF = "pxf/annotations.proto";
const DESCRIPTOR = "protowire/schema/v1/descriptor.proto";
const PROTOCHECK = "protocheck's annotations";

const FILE_OPTIONS = new Map<number, Retired>([
  [50100, ["(sbe.schema_id)", 1319, SBE]],
  [50101, ["(sbe.version)", 1320, SBE]],
  [50400, ["the file_annotations carrier", 1327, DESCRIPTOR]],
  [50401, ["the functions carrier", 1328, DESCRIPTOR]],
  [50402, ["the annotation_decls carrier", 1329, DESCRIPTOR]],
  [50403, ["the type_decls carrier", 1330, DESCRIPTOR]],
  [50404, ["the source_map carrier", 1331, DESCRIPTOR]],
]);

const MESSAGE_OPTIONS = new Map<number, Retired>([
  [50200, ["(sbe.template_id)", 1321, SBE]],
  [50400, ["the message_annotations carrier", 1327, DESCRIPTOR]],
  [51001, ["a protocheck message constraint", 1348, PROTOCHECK]],
]);

const FIELD_OPTIONS = new Map<number, Retired>([
  [50000, ["(pxf.required)", 1314, PXF]],
  [50001, ["(pxf.default)", 1315, PXF]],
  [50002, ["(pxf.key)", 1316, PXF]],
  [50300, ["(sbe.length)", 1322, SBE]],
  [50301, ["(sbe.encoding)", 1323, SBE]],
  [50400, ["the field_annotations carrier", 1327, DESCRIPTOR]],
  [51000, ["a protocheck field constraint", 1347, PROTOCHECK]],
]);

const ONEOF_OPTIONS = new Map<number, Retired>([
  [50400, ["the oneof_annotations carrier", 1327, DESCRIPTOR]],
  [51002, ["a protocheck oneof constraint", 1349, PROTOCHECK]],
]);

const CARRIER_ONLY = new Map<number, Retired>([[50400, ["the *_annotations carrier", 1327, DESCRIPTOR]]]);

const PROTOWIRE_FILES = new Set([
  "pxf/annotations.proto",
  "sbe/annotations.proto",
  "protowire/schema/v1/annotations.proto",
  "protowire/schema/v1/descriptor.proto",
]);

interface Options {
  readonly $unknown?: readonly { readonly no: number }[] | undefined;
}

function scan(
  path: string,
  element: string,
  kind: string,
  options: Options | undefined,
  table: ReadonlyMap<number, Retired>,
  out: Violation[],
): void {
  for (const uf of options?.$unknown ?? []) {
    const hit = table.get(uf.no);
    if (!hit) continue;
    const [was, now, file] = hit;
    out.push({
      file: path,
      element,
      name: String(uf.no),
      kind: "retiredNumber",
      detail: `option number ${uf.no} on ${kind} was ${was} before protowire v1.12.0 and is ${now} now; the descriptor predates the registered extension block and must be recompiled against the current ${file}`,
    });
  }
}

function walkEnums(path: string, enums: DescFile["enums"], out: Violation[]): void {
  for (const e of enums) {
    scan(path, e.typeName, "EnumOptions", e.proto.options, CARRIER_ONLY, out);
    const scope = e.parent ? e.parent.typeName : e.file.proto.package;
    for (const v of e.values) {
      const element = scope ? `${scope}.${v.name}` : v.name;
      scan(path, element, "EnumValueOptions", v.proto.options, CARRIER_ONLY, out);
    }
  }
}

function walkMessages(path: string, messages: readonly DescMessage[], out: Violation[]): void {
  for (const m of messages) {
    scan(path, m.typeName, "MessageOptions", m.proto.options, MESSAGE_OPTIONS, out);
    for (const f of m.fields) {
      scan(path, `${m.typeName}.${f.name}`, "FieldOptions", f.proto.options, FIELD_OPTIONS, out);
    }
    for (const o of m.oneofs) {
      scan(path, `${m.typeName}.${o.name}`, "OneofOptions", o.proto.options, ONEOF_OPTIONS, out);
    }
    walkMessages(path, m.nestedMessages, out);
    walkEnums(path, m.nestedEnums, out);
  }
}

/** Appends a violation for every retired number `file`'s elements carry. */
export function walkRetired(file: DescFile, out: Violation[]): void {
  if (!file.proto.dependency.some((d) => PROTOWIRE_FILES.has(d))) return;
  const path = file.proto.name;
  scan(path, path, "FileOptions", file.proto.options, FILE_OPTIONS, out);
  walkMessages(path, file.messages, out);
  walkEnums(path, file.enums, out);
  for (const s of file.services) {
    scan(path, s.typeName, "ServiceOptions", s.proto.options, CARRIER_ONLY, out);
    for (const m of s.methods) {
      scan(path, `${s.typeName}.${m.name}`, "MethodOptions", m.proto.options, CARRIER_ONLY, out);
    }
  }
}
