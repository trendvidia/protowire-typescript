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
 * Placement of `(pxf.key)` and `(pxf.default)`, and the oneof rules, are
 * checked here too, and every check covers the bound file's import closure
 * (draft -01 "Scope of Bind-Time Checks").
 *
 * Mirrors `protowire/encoding/pxf/schema.go`.
 */

import {
  type DescEnum,
  type DescExtension,
  type DescField,
  type DescFile,
  type DescMessage,
  type DescOneof,
  ScalarType,
} from "@bufbuild/protobuf";

import { type AnnotationSurface, fieldOptions, getKeyName } from "./annotations.js";
import { wktShapeProblem } from "./descriptor.js";
import { walkRetired } from "./retired.js";

/**
 * What a schema element breaks: a reserved PXF value keyword as its name
 * (`field`, `oneof`, `enumValue`), an invalid `(pxf.required)`
 * (`requiredOption`), a misplaced `(pxf.key)` (`keyOption`), or an invalid
 * `(pxf.default)` (`defaultOption`), an option at a retired extension number
 * (`retiredNumber`), or a message redefining a well-known type with the wrong
 * shape (`wellKnownShape`).
 */
export type ViolationKind =
  | "field"
  | "oneof"
  | "enumValue"
  | "requiredOption"
  | "keyOption"
  | "defaultOption"
  | "retiredNumber"
  | "wellKnownShape";

/** A schema element that breaks a bind-time check. */
export interface Violation {
  /** .proto file path the offending element is declared in. */
  readonly file: string;
  /** Fully-qualified protobuf name (e.g. "trades.v1.Side.null"). */
  readonly element: string;
  /** Bare reserved identifier ("null" / "true" / "false"), the `(pxf.key)`
   * annotation value for a `keyOption` violation, or the `(pxf.default)`
   * literal for a `defaultOption` violation. For a `requiredOption` violation,
   * the containing oneof's name for one on a oneof member, otherwise the
   * `(pxf.default)` literal. */
  readonly name: string;
  readonly kind: ViolationKind;
  /** Explanation; set for `requiredOption`, `keyOption` and `defaultOption`,
   * absent for the reserved-name kinds. */
  readonly detail?: string;
  /** Which spelling the annotation used, when it was not the bracket form. */
  readonly surface?: AnnotationSurface;
}

/** Human-readable one-line description of `v`. */
export function violationString(v: Violation): string {
  if (v.kind === "keyOption") {
    return `${v.file}: field "${v.element}": invalid (pxf.key) = "${v.name}": ${v.detail ?? ""} (draft -01 §3.13)`;
  }
  if (v.kind === "requiredOption") {
    const label = v.surface === "carrier" ? "@required" : "(pxf.required)";
    return `${v.file}: field "${v.element}": invalid ${label}: ${v.detail} (draft -01 §annotation-extensions)`;
  }
  if (v.kind === "retiredNumber") {
    return `${v.file}: "${v.element}": ${v.detail} (STABILITY.md promise 3)`;
  }
  if (v.kind === "wellKnownShape") {
    return `${v.file}: message "${v.element}" redefines a well-known type: ${v.detail} (draft -01 §wkt-shapes)`;
  }
  if (v.kind === "defaultOption") {
    const label = v.surface === "carrier" ? "@default" : "(pxf.default)";
    const value = v.name === "" ? "" : ` = "${v.name}"`;
    return `${v.file}: field "${v.element}": invalid ${label}${value}: ${v.detail} (draft -01 §annotation-extensions)`;
  }
  const kindLabel =
    v.kind === "field" ? "message field" : v.kind === "oneof" ? "oneof" : "enum value";
  return `${v.file}: ${kindLabel} "${v.element}" uses PXF-reserved name "${v.name}" (draft §3.13)`;
}

/**
 * Walks the file containing `desc` and its transitive imports and returns every
 * bind-time violation in that closure (draft -01 "Scope of Bind-Time Checks"):
 * reserved-name collisions, misplaced `(pxf.key)` and `(pxf.default)`, the two
 * oneof rules, and `(pxf.required)` with `(pxf.default)` on one field. Each
 * violation names the file that declares the element. The returned array is
 * sorted by file and then element fully-qualified name, and an empty array
 * means the schema is conformant.
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

/** Per-file and per-closure results: `unmarshal` re-validates on every call,
 * and the closure always reaches descriptor.proto. Keyed on the descriptor,
 * since two registries can hold different files at one path, and weak, so an
 * entry does not pin a descriptor graph. */
const fileCache = new WeakMap<DescFile, readonly Violation[]>();
const closureCache = new WeakMap<DescFile, readonly Violation[]>();

/** See {@link validateDescriptor}. Returns a fresh array. */
export function validateFile(fd: DescFile | null | undefined): Violation[] {
  if (!fd) return [];
  let cached = closureCache.get(fd);
  if (!cached) {
    const out = importClosure(fd).flatMap((file) => fileViolations(file));
    out.sort(
      (a, b) =>
        (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) ||
        (a.element < b.element ? -1 : a.element > b.element ? 1 : 0),
    );
    cached = out;
    closureCache.set(fd, cached);
  }
  return [...cached];
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

function fileViolations(file: DescFile): readonly Violation[] {
  const cached = fileCache.get(file);
  if (cached) return cached;
  const out: Violation[] = [];
  const path = file.proto.name; // DescFile.name drops the ".proto"
  for (const msg of file.messages) walkMessage(path, msg, out);
  for (const en of file.enums) walkEnum(path, en, out);
  for (const ext of file.extensions) checkKeyOption(path, ext, out);
  for (const msg of file.messages) walkKeyOptions(path, msg, out);
  walkRetired(file, out);
  fileCache.set(file, out);
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
  const shape = wktShapeProblem(md);
  if (shape) out.push({ file: path, element: md.typeName, name: "", kind: "wellKnownShape", detail: shape });
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
    checkAnnotations(path, md, f, out);
  }
  checkOneofDefaultCap(path, md, out);
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

/** A proto3 `optional` field's synthetic oneof is not a oneof here. */
function realOneof(f: DescField): DescOneof | undefined {
  return f.fieldKind === "scalar" || f.fieldKind === "enum" || f.fieldKind === "message"
    ? f.oneof
    : undefined;
}

function checkAnnotations(path: string, md: DescMessage, f: DescField, out: Violation[]): void {
  const element = `${md.typeName}.${f.name}`;
  const opts = fieldOptions(f);
  const requiredLabel = opts.requiredSurface === "carrier" ? "@required" : "(pxf.required)";
  const defaultLabel = opts.defSurface === "carrier" ? "@default" : "(pxf.default)";
  const surface = (s: AnnotationSurface): { surface?: AnnotationSurface } =>
    s === "carrier" ? { surface: s } : {};
  if (opts.defProblem !== undefined) {
    out.push({ file: path, element, name: "", kind: "defaultOption", detail: opts.defProblem, ...surface(opts.defSurface) });
  }
  // An empty default is still a default, so this tests for presence.
  if (opts.def !== undefined) {
    const detail = defaultPlacementProblem(f, defaultLabel);
    if (detail) out.push({ file: path, element, name: opts.def, kind: "defaultOption", detail, ...surface(opts.defSurface) });
    if (opts.required) {
      out.push({
        file: path,
        element,
        name: opts.def,
        kind: "requiredOption",
        detail: `${requiredLabel} and ${defaultLabel} are exclusive on one field: the first rejects a document where the field is absent, and the second treats it as supplied`,
        ...surface(opts.requiredSurface),
      });
    }
  }
  const oo = realOneof(f);
  if (oo && opts.required) {
    out.push({
      file: path,
      element,
      name: oo.name,
      kind: "requiredOption",
      detail: `${requiredLabel} is not valid on a member of oneof "${oo.name}": read per field it demands that one arm always be chosen, which makes every other arm undecodable`,
      ...surface(opts.requiredSurface),
    });
  }
}

/** Draft -01 "Default Placement": only where one literal can denote the field. */
function defaultPlacementProblem(f: DescField, label: string): string | undefined {
  if (f.fieldKind === "map") return `${label} is not valid on map fields: one literal cannot denote a map`;
  if (f.fieldKind === "list") return `${label} is not valid on repeated fields: one literal cannot denote a list`;
  if (f.fieldKind === "message") {
    if (f.delimitedEncoding) return `${label} is not valid on group fields`;
    if (!DEFAULTABLE_MESSAGES.has(f.message.typeName)) {
      return `${label} is not valid on message type ${f.message.typeName}: no PXF literal denotes it`;
    }
  }
  return undefined;
}

const DEFAULTABLE_MESSAGES = new Set([
  "google.protobuf.Timestamp",
  "google.protobuf.Duration",
  "google.protobuf.BoolValue",
  "google.protobuf.BytesValue",
  "google.protobuf.DoubleValue",
  "google.protobuf.FloatValue",
  "google.protobuf.Int32Value",
  "google.protobuf.Int64Value",
  "google.protobuf.StringValue",
  "google.protobuf.UInt32Value",
  "google.protobuf.UInt64Value",
  "pxf.BigInt",
  "pxf.Decimal",
  "pxf.BigFloat",
]);

/** Draft -01 "Oneof Members": at most one member may carry a default. */
function checkOneofDefaultCap(path: string, md: DescMessage, out: Violation[]): void {
  for (const oo of md.oneofs) {
    const members = oo.fields.filter((f) => fieldOptions(f).def !== undefined);
    if (members.length < 2) continue;
    const names = members.map((f) => f.name).join(", ");
    for (const f of members) {
      const opts = fieldOptions(f);
      out.push({
        file: path,
        element: `${md.typeName}.${f.name}`,
        name: opts.def!,
        kind: "defaultOption",
        detail: `at most one member of oneof "${oo.name}" may carry a default; ${members.length} do (${names})`,
        ...(opts.defSurface === "carrier" ? { surface: opts.defSurface } : {}),
      });
    }
  }
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
