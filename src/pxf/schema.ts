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
 * `(pxf.key)` placement (draft -01 §3.13) is checked here too, over the
 * import closure of the bound file (draft -01 "Scope of Bind-Time Checks").
 * The reserved-name check still covers the declaring file only.
 *
 * Mirrors `protowire/encoding/pxf/schema.go`.
 */

import {
  type DescEnum,
  type DescExtension,
  type DescField,
  type DescFile,
  type DescMessage,
  ScalarType,
} from "@bufbuild/protobuf";

import { getKeyName } from "./annotations.js";

/** Which kind of schema element violates a PXF bind-time check. */
export type ViolationKind = "field" | "oneof" | "enumValue" | "keyOption";

/** A schema element that violates a PXF bind-time check. */
export interface Violation {
  /** .proto file path the offending element is declared in. */
  readonly file: string;
  /** Fully-qualified protobuf name (e.g. "trades.v1.Side.null"). */
  readonly element: string;
  /** Bare reserved identifier ("null" / "true" / "false"), or the
   * `(pxf.key)` annotation value for a `keyOption` violation. */
  readonly name: string;
  readonly kind: ViolationKind;
  /** What is wrong; set for `keyOption`, absent for the reserved-name kinds. */
  readonly detail?: string;
}

/** Human-readable one-line description of `v`. */
export function violationString(v: Violation): string {
  if (v.kind === "keyOption") {
    return `${v.file}: field "${v.element}": invalid (pxf.key) = "${v.name}": ${v.detail ?? ""} (draft -01 §3.13)`;
  }
  const kindLabel =
    v.kind === "field" ? "message field" : v.kind === "oneof" ? "oneof" : "enum value";
  return `${v.file}: ${kindLabel} "${v.element}" uses PXF-reserved name "${v.name}" (draft §3.13)`;
}

/**
 * Walks the file containing `desc` and returns every reserved-name
 * collision among messages, oneofs, and enum values reachable from
 * that file, plus every misplaced `(pxf.key)` in that file's import
 * closure. The returned array is sorted by element fully-qualified
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
 * Walks `fd` and returns every reserved-name collision in the file and
 * every misplaced `(pxf.key)` in its import closure. See
 * {@link validateDescriptor} for the rule and semantics.
 */
export function validateFile(fd: DescFile | null | undefined): Violation[] {
  if (!fd) return [];
  const path = fd.name;
  const out: Violation[] = [];
  for (const msg of fd.messages) walkMessage(path, msg, out);
  for (const en of fd.enums) walkEnum(path, en, out);
  for (const file of importClosure(fd)) out.push(...keyViolations(file));
  out.sort((a, b) => (a.element < b.element ? -1 : a.element > b.element ? 1 : 0));
  return out;
}

/** `fd` and its transitive imports, each file once. */
function importClosure(fd: DescFile): DescFile[] {
  const seen = new Set<DescFile>();
  const visit = (file: DescFile): void => {
    if (seen.has(file)) return;
    seen.add(file);
    file.dependencies.forEach(visit);
  };
  visit(fd);
  return [...seen];
}

/** Per-file results: `unmarshal` re-validates on every call, and the
 * closure always reaches descriptor.proto. */
const keyViolationCache = new WeakMap<DescFile, readonly Violation[]>();

function keyViolations(file: DescFile): readonly Violation[] {
  let out = keyViolationCache.get(file) as Violation[] | undefined;
  if (out) return out;
  out = [];
  const path = file.proto.name; // DescFile.name drops the ".proto"
  for (const ext of file.extensions) checkKeyOption(path, ext, out);
  for (const msg of file.messages) walkKeyOptions(path, msg, out);
  keyViolationCache.set(file, out);
  return out;
}

function walkKeyOptions(path: string, md: DescMessage, out: Violation[]): void {
  for (const f of md.fields) checkKeyOption(path, f, out);
  for (const ext of md.nestedExtensions) checkKeyOption(path, ext, out);
  for (const inner of md.nestedMessages) walkKeyOptions(path, inner, out);
}

/**
 * Placement of a `(pxf.key)` annotation (draft -01 §3.13): the annotated
 * field is a repeated message-typed field, and the value names a singular
 * string field of the element message.
 */
function checkKeyOption(path: string, f: DescField | DescExtension, out: Violation[]): void {
  const name = getKeyName(f as DescField);
  if (name === undefined) return;
  const violation = (detail: string): void => {
    const element = f.kind === "extension" ? f.typeName : `${f.parent.typeName}.${f.name}`;
    out.push({ file: path, element, name, kind: "keyOption", detail });
  };
  if (f.fieldKind !== "list" || f.listKind !== "message") {
    violation("(pxf.key) is valid only on repeated message-typed fields");
    return;
  }
  const kf = f.message.fields.find((x) => x.name === name);
  if (!kf) {
    violation(`element message ${f.message.typeName} has no field "${name}"`);
    return;
  }
  if (kf.fieldKind !== "scalar" || kf.scalar !== ScalarType.STRING) {
    violation(`key field ${f.message.typeName}.${kf.name} must be a singular string field`);
  }
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
  const header = vs.every((v) => v.kind === "keyOption")
    ? "PXF schema (pxf.key) violations:\n"
    : "PXF schema reserved-name violations:\n";
  return header + lines.join("\n");
}
