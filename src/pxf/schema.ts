// SPDX-License-Identifier: MIT
// Copyright (c) 2026 TrendVidia, LLC.
/**
 * PXF schema-level conformance check per draft §3.13. A protobuf schema
 * bound for PXF use MUST NOT declare a message field, oneof, or enum
 * value whose name is case-sensitively equal to a PXF value keyword
 * (`null` / `true` / `false`) — such a name lexes as the keyword, so
 * the declared element is unreachable from PXF surface syntax.
 *
 * Enforcement runs at descriptor-bind time inside `unmarshal` /
 * `unmarshalFull`. Callers that have already validated their
 * descriptors (typically via `validateDescriptor` in a one-time
 * codegen or registry-load pass) may set
 * `UnmarshalOptions.skipValidate` to bypass the per-call recheck.
 *
 * Mirrors `protowire/encoding/pxf/schema.go`.
 */

import { type DescEnum, type DescFile, type DescMessage } from "@bufbuild/protobuf";

/** Which kind of schema element collides with a reserved PXF value keyword. */
export type ViolationKind = "field" | "oneof" | "enumValue";

/** A schema element whose name collides with a reserved PXF keyword. */
export interface Violation {
  /** .proto file path the offending element is declared in. */
  readonly file: string;
  /** Fully-qualified protobuf name (e.g. "trades.v1.Side.null"). */
  readonly element: string;
  /** Bare reserved identifier ("null" / "true" / "false"). */
  readonly name: string;
  readonly kind: ViolationKind;
}

/** Human-readable one-line description of `v`. */
export function violationString(v: Violation): string {
  const kindLabel =
    v.kind === "field" ? "message field" : v.kind === "oneof" ? "oneof" : "enum value";
  return `${v.file}: ${kindLabel} "${v.element}" uses PXF-reserved name "${v.name}" (draft §3.13)`;
}

/**
 * Walks the file containing `desc` and returns every reserved-name
 * collision among messages, oneofs, and enum values reachable from
 * that file. The returned array is sorted by element fully-qualified
 * name for stable output. An empty array means the schema is
 * conformant.
 *
 * The check is case-sensitive: identifiers such as "NULL" or "True"
 * lex as ordinary identifiers and are accepted.
 */
export function validateDescriptor(desc: DescMessage | null | undefined): Violation[] {
  if (!desc) return [];
  return validateFile(desc.file);
}

/**
 * Walks `fd` and returns every reserved-name collision in the file.
 * See {@link validateDescriptor} for the rule and semantics.
 */
export function validateFile(fd: DescFile | null | undefined): Violation[] {
  if (!fd) return [];
  const path = fd.name;
  const out: Violation[] = [];
  for (const msg of fd.messages) walkMessage(path, msg, out);
  for (const en of fd.enums) walkEnum(path, en, out);
  out.sort((a, b) => (a.element < b.element ? -1 : a.element > b.element ? 1 : 0));
  return out;
}

const RESERVED = new Set(["null", "true", "false"]);

function walkMessage(path: string, md: DescMessage, out: Violation[]): void {
  for (const f of md.fields) {
    if (RESERVED.has(f.name)) {
      // DescField doesn't carry a typeName; build it from the parent
      // message's fully-qualified typeName and the field name.
      out.push({
        file: path,
        element: `${md.typeName}.${f.name}`,
        name: f.name,
        kind: "field",
      });
    }
  }
  // bufbuild's DescMessage.oneofs already filters synthetic oneofs
  // emitted for proto3 `optional` fields — matching Go's IsSynthetic()
  // filter — so we can iterate it directly.
  for (const o of md.oneofs) {
    if (RESERVED.has(o.name)) {
      // OneofDescriptor doesn't carry typeName directly; build it from
      // the parent message and the oneof name.
      const element = `${md.typeName}.${o.name}`;
      out.push({ file: path, element, name: o.name, kind: "oneof" });
    }
  }
  for (const inner of md.nestedMessages) walkMessage(path, inner, out);
  for (const en of md.nestedEnums) walkEnum(path, en, out);
}

function walkEnum(path: string, en: DescEnum, out: Violation[]): void {
  for (const v of en.values) {
    if (RESERVED.has(v.name)) {
      // Proto enum value names live at the enum's PARENT scope, not
      // under the enum name itself (same as cpp's behavior). bufbuild
      // doesn't expose a typeName for EnumValue, so construct it:
      // parent message typeName (if nested) / file package + value name.
      const parent = en.parent;
      const scope = parent ? parent.typeName : en.file.proto.package;
      const element = scope ? `${scope}.${v.name}` : v.name;
      out.push({ file: path, element, name: v.name, kind: "enumValue" });
    }
  }
}

/**
 * Join a list of violations into a single error message suitable for
 * throwing from a decode call. Returns `undefined` when `vs` is empty.
 */
export function asValidationErrorMessage(vs: Violation[]): string | undefined {
  if (vs.length === 0) return undefined;
  const lines = vs.map((v) => "  " + violationString(v));
  return "PXF schema reserved-name violations:\n" + lines.join("\n");
}
