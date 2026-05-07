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

import { type DescField, type DescMessage } from "@bufbuild/protobuf";

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
  return wrapperTypes.has(desc.typeName);
}

export function isTimestamp(desc: DescMessage): boolean {
  return desc.typeName === "google.protobuf.Timestamp";
}

export function isDuration(desc: DescMessage): boolean {
  return desc.typeName === "google.protobuf.Duration";
}

export function isAny(desc: DescMessage): boolean {
  return desc.typeName === "google.protobuf.Any";
}

export function isFieldMask(desc: DescMessage): boolean {
  return desc.typeName === "google.protobuf.FieldMask";
}
