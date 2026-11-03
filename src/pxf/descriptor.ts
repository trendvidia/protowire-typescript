// SPDX-License-Identifier: MIT
// Copyright (c) 2026 TrendVidia, LLC.
/**
 * Tiny adapter helpers over `@bufbuild/protobuf` descriptors.
 *
 * protobuf-es v2 already exposes a clean discriminated-union DescField
 * (fieldKind: "scalar" | "list" | "message" | "enum" | "map") and ScalarType
 * enum, so we only need a few helpers. The most important one is lookup by
 * proto source name: DescMessage.field is keyed by JS-idiomatic localName,
 * but PXF text uses the proto source name (e.g. "string_field" not
 * "stringField").
 */

import { type DescField, type DescMessage, ScalarType } from "@bufbuild/protobuf";

/**
 * Find a field by its proto source name (e.g. "string_field").
 * Returns undefined if no such field exists.
 */
export function findFieldByProtoName(
  desc: DescMessage,
  name: string,
): DescField | undefined {
  for (const f of desc.fields) {
    if (f.name === name) return f;
  }
  return undefined;
}

const wrapperTypes = new Set([
  "google.protobuf.BoolValue",
  "google.protobuf.BytesValue",
  "google.protobuf.DoubleValue",
  "google.protobuf.FloatValue",
  "google.protobuf.Int32Value",
  "google.protobuf.Int64Value",
  "google.protobuf.StringValue",
  "google.protobuf.UInt32Value",
  "google.protobuf.UInt64Value",
]);

export function isWrapperType(desc: DescMessage): boolean {
  return wrapperTypes.has(desc.typeName) && hasKnownShape(desc);
}

export function isTimestamp(desc: DescMessage): boolean {
  return desc.typeName === "google.protobuf.Timestamp" && hasKnownShape(desc);
}

export function isDuration(desc: DescMessage): boolean {
  return desc.typeName === "google.protobuf.Duration" && hasKnownShape(desc);
}

export function isAny(desc: DescMessage): boolean {
  return desc.typeName === "google.protobuf.Any" && hasKnownShape(desc);
}

export function isFieldMask(desc: DescMessage): boolean {
  return desc.typeName === "google.protobuf.FieldMask";
}

/** `pxf.BigFloat`, by its shape as well as its name. */
export function isBigFloat(desc: DescMessage): boolean {
  return desc.typeName === "pxf.BigFloat" && hasKnownShape(desc);
}

interface WktField {
  readonly name: string;
  readonly scalar: ScalarType;
  readonly repeated?: boolean;
  /** May be undeclared; when declared it must still match. */
  readonly optional?: boolean;
}

const SECONDS_NANOS: readonly WktField[] = [
  { name: "seconds", scalar: ScalarType.INT64 },
  { name: "nanos", scalar: ScalarType.INT32 },
];

const value = (scalar: ScalarType): readonly WktField[] => [{ name: "value", scalar }];

/** Draft -01 §wkt-shapes: the fields a message must declare to be treated as
 * the type its name says. Field numbers are not here: PXF binds by name. */
const WKT_SHAPES = new Map<string, readonly WktField[]>([
  ["google.protobuf.Timestamp", SECONDS_NANOS],
  ["google.protobuf.Duration", SECONDS_NANOS],
  [
    "google.protobuf.Any",
    [
      { name: "type_url", scalar: ScalarType.STRING },
      { name: "value", scalar: ScalarType.BYTES },
    ],
  ],
  ["google.protobuf.FieldMask", [{ name: "paths", scalar: ScalarType.STRING, repeated: true }]],
  [
    "pxf.BigInt",
    [
      { name: "abs", scalar: ScalarType.BYTES },
      { name: "negative", scalar: ScalarType.BOOL },
    ],
  ],
  [
    "pxf.Decimal",
    [
      { name: "unscaled", scalar: ScalarType.BYTES },
      { name: "scale", scalar: ScalarType.INT32 },
      { name: "negative", scalar: ScalarType.BOOL },
    ],
  ],
  [
    "pxf.BigFloat",
    [
      { name: "mantissa", scalar: ScalarType.BYTES },
      { name: "exponent", scalar: ScalarType.INT32 },
      { name: "prec", scalar: ScalarType.UINT32 },
      { name: "negative", scalar: ScalarType.BOOL },
    ],
  ],
  [
    "pxf.Secret",
    [
      { name: "value", scalar: ScalarType.STRING },
      { name: "hint", scalar: ScalarType.STRING, optional: true },
      { name: "fingerprint", scalar: ScalarType.STRING, optional: true },
    ],
  ],
  ["google.protobuf.DoubleValue", value(ScalarType.DOUBLE)],
  ["google.protobuf.FloatValue", value(ScalarType.FLOAT)],
  ["google.protobuf.Int64Value", value(ScalarType.INT64)],
  ["google.protobuf.UInt64Value", value(ScalarType.UINT64)],
  ["google.protobuf.Int32Value", value(ScalarType.INT32)],
  ["google.protobuf.UInt32Value", value(ScalarType.UINT32)],
  ["google.protobuf.BoolValue", value(ScalarType.BOOL)],
  ["google.protobuf.StringValue", value(ScalarType.STRING)],
  ["google.protobuf.BytesValue", value(ScalarType.BYTES)],
]);

function fieldProblem(fd: DescField, f: WktField): string | undefined {
  if (fd.fieldKind === "map") return `field "${f.name}" has the wrong cardinality`;
  const repeated = fd.fieldKind === "list";
  const scalar = fd.fieldKind === "scalar" || (repeated && fd.listKind === "scalar") ? fd.scalar : undefined;
  if (scalar !== f.scalar) return `field "${f.name}" is ${fieldTypeName(fd)}, and must be ${ScalarType[f.scalar]!.toLowerCase()}`;
  if (repeated !== (f.repeated ?? false)) return `field "${f.name}" has the wrong cardinality`;
  return undefined;
}

function fieldTypeName(fd: DescField): string {
  if ((fd.fieldKind === "scalar" || fd.fieldKind === "list") && fd.scalar !== undefined) {
    return ScalarType[fd.scalar]!.toLowerCase();
  }
  return fd.fieldKind;
}

/** What stops `desc` having the shape its name needs, if anything. */
export function wktShapeProblem(desc: DescMessage): string | undefined {
  for (const f of WKT_SHAPES.get(desc.typeName) ?? []) {
    const fd = findFieldByProtoName(desc, f.name);
    if (!fd) {
      if (f.optional) continue;
      return `it has no field "${f.name}"`;
    }
    const problem = fieldProblem(fd, f);
    if (problem) return problem;
  }
  return undefined;
}

const shapeCache = new WeakMap<DescMessage, boolean>();

/** One with the wrong shape is an ordinary message: bind-time validation
 * refuses it, and this holds on the paths that do not validate. */
function hasKnownShape(desc: DescMessage): boolean {
  let ok = shapeCache.get(desc);
  if (ok === undefined) {
    ok = wktShapeProblem(desc) === undefined;
    shapeCache.set(desc, ok);
  }
  return ok;
}

/** `pxf.BigInt`, by its shape as well as its name. */
export function isBigInt(desc: DescMessage): boolean {
  return desc.typeName === "pxf.BigInt" && findFieldByProtoName(desc, "abs")?.fieldKind === "scalar";
}

/** `pxf.Decimal`, by its shape as well as its name. */
export function isDecimal(desc: DescMessage): boolean {
  return desc.typeName === "pxf.Decimal" && findFieldByProtoName(desc, "unscaled")?.fieldKind === "scalar";
}

/** A type written as a number literal. */
export function isBigNumber(desc: DescMessage): boolean {
  return isBigInt(desc) || isDecimal(desc) || isBigFloat(desc);
}
