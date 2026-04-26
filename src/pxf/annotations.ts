/**
 * Read PXF field annotations (`pxf.required`, `pxf.default`) and discover the
 * `_null` FieldMask. Mirrors `protowire/encoding/pxf/annotations.go`.
 *
 * The `pxf/annotations.proto` extensions are NOT registered with protobuf-es
 * here; the values land in `FieldOptions.$unknown`. We parse those raw
 * varint / length-delimited bytes directly, matching the Go fallback path.
 */

import { type DescField, type DescMessage } from "@bufbuild/protobuf";

const EXT_REQUIRED = 50_000;
const EXT_DEFAULT = 50_001;

export function isRequired(fd: DescField): boolean {
  const ufs = fd.proto.options?.$unknown;
  if (!ufs) return false;
  for (const uf of ufs) {
    if (uf.no === EXT_REQUIRED && uf.wireType === 0) {
      // Varint payload — interpret as bool.
      return readVarint(uf.data) !== 0n;
    }
  }
  return false;
}

export function getDefault(fd: DescField): string | undefined {
  const ufs = fd.proto.options?.$unknown;
  if (!ufs) return undefined;
  for (const uf of ufs) {
    if (uf.no === EXT_DEFAULT && uf.wireType === 2) {
      // LengthDelimited payload: data starts with a length varint, then the
      // string bytes. protobuf-es records the full prefixed payload here.
      const [len, off] = readVarintWithLength(uf.data);
      return new TextDecoder().decode(uf.data.subarray(off, off + Number(len)));
    }
  }
  return undefined;
}

/**
 * Returns the `_null` field on `desc` if it exists and is a
 * `google.protobuf.FieldMask`. Returns undefined otherwise.
 */
export function findNullMaskField(desc: DescMessage): DescField | undefined {
  for (const f of desc.fields) {
    if (
      f.name === "_null" &&
      f.fieldKind === "message" &&
      f.message.typeName === "google.protobuf.FieldMask"
    ) {
      return f;
    }
  }
  return undefined;
}

function readVarint(data: Uint8Array): bigint {
  let result = 0n;
  let shift = 0n;
  for (let i = 0; i < data.length && i < 10; i++) {
    const byte = data[i]!;
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return result;
    shift += 7n;
  }
  throw new Error("invalid varint in field options");
}

function readVarintWithLength(data: Uint8Array): [bigint, number] {
  let result = 0n;
  let shift = 0n;
  for (let i = 0; i < data.length && i < 10; i++) {
    const byte = data[i]!;
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return [result, i + 1];
    shift += 7n;
  }
  throw new Error("invalid varint in field options");
}
