// SPDX-License-Identifier: MIT
// Copyright (c) 2026 TrendVidia, LLC.
/**
 * PXF schema-level conformance checks. Two families, both reported as
 * {@link Violation}:
 *
 *   - Reserved names (draft §3.13). A protobuf schema bound for PXF use
 *     MUST NOT declare a message field, oneof, or enum value whose name
 *     is case-sensitively equal to a PXF value keyword (`null` / `true`
 *     / `false`) — such a name lexes as the keyword, so the declared
 *     element is unreachable from PXF surface syntax.
 *   - `(pxf.required)` with `(pxf.default)` on one field (draft -01
 *     "Required and Default"). A document omitting the field would have
 *     no single meaning.
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

import { getDefault, isRequired } from "./annotations.js";

/**
 * What a schema element breaks: a reserved PXF value keyword as its name
 * (`field`, `oneof`, `enumValue`), or an invalid `(pxf.required)`
 * (`requiredOption`).
 */
export type ViolationKind = "field" | "oneof" | "enumValue" | "requiredOption";

/** A schema element that breaks a bind-time check. */
export interface Violation {
  /** .proto file path the offending element is declared in. */
  readonly file: string;
  /** Fully-qualified protobuf name (e.g. "trades.v1.Side.null"). */
  readonly element: string;
  /** Bare reserved identifier ("null" / "true" / "false"), or the field's name. */
  readonly name: string;
  readonly kind: ViolationKind;
  /** Explanation; set for `requiredOption`, absent for the reserved-name kinds. */
  readonly detail?: string;
}

/** Human-readable one-line description of `v`. */
export function violationString(v: Violation): string {
  if (v.kind === "requiredOption") {
    return `${v.file}: field "${v.element}": invalid (pxf.required): ${v.detail} (draft -01 §annotation-extensions)`;
  }
  const kindLabel =
    v.kind === "field" ? "message field" : v.kind === "oneof" ? "oneof" : "enum value";
  return `${v.file}: ${kindLabel} "${v.element}" uses PXF-reserved name "${v.name}" (draft §3.13)`;
}

/**
 * Walks the file containing `desc` and returns every bind-time
 * violation in it: reserved-name collisions among messages, oneofs, and
 * enum values, and `(pxf.required)` with `(pxf.default)` on one field.
 * The returned array is sorted by element fully-qualified name for
 * stable output. An empty array means the schema is conformant.
 *
 * The reserved-name check is case-sensitive: identifiers such as "NULL"
 * or "True" lex as ordinary identifiers and are accepted.
 * `(pxf.required) = false` requires nothing, so a default beside it
 * stands.
 */
export function validateDescriptor(desc: DescMessage | null | undefined): Violation[] {
  if (!desc) return [];
  return validateFile(desc.file);
}

/**
 * Walks `fd` and returns every bind-time violation in the file.
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

/**
 * Directive names the spec reserves for future allocation (draft §3.4.6).
 * v1 decoders MUST reject these as unknown reserved directives so
 * applications cannot squat the names before the spec allocates
 * semantics to them.
 *
 * The names with their own production (`type`, `dataset`, `proto`) don't
 * appear here — they're handled directly by the lexer. The spec-
 * registered `entry` doesn't appear either — it's a valid named-directive
 * with documented shape (draft §3.4.3).
 */
export const FUTURE_RESERVED_DIRECTIVES: ReadonlySet<string> = new Set([
  "table",
  "datasource",
  "view",
  "procedure",
  "function",
  "permissions",
]);

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
    // An empty default is still a default, so this tests for presence.
    if (isRequired(f) && getDefault(f) !== undefined) {
      out.push({
        file: path,
        element: `${md.typeName}.${f.name}`,
        name: f.name,
        kind: "requiredOption",
        detail:
          "(pxf.required) and (pxf.default) are exclusive on one field: the first rejects a document where the field is absent, and the second treats it as supplied",
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
  return "PXF schema violations:\n" + lines.join("\n");
}
