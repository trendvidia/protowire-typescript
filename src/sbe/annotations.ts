/**
 * Read SBE schema annotations from File / Message / Field options.
 * Mirrors `protowire/encoding/sbe/annotations.go`.
 *
 * The SBE extensions (schema_id, version, template_id, length, encoding) are
 * NOT registered with protobuf-es here — their values surface in
 * `proto.options?.$unknown`. We parse those raw bytes directly, matching the
 * Go fallback path.
 */

import { type DescField, type DescFile, type DescMessage } from "@bufbuild/protobuf";

export const EXT_SCHEMA_ID = 50_100;
export const EXT_VERSION = 50_101;
export const EXT_TEMPLATE_ID = 50_200;
export const EXT_LENGTH = 50_300;
export const EXT_ENCODING = 50_301;

interface UnknownField {
  no: number;
  wireType: number;
  data: Uint8Array;
}

function unknowns(opts: { $unknown?: UnknownField[] } | undefined): UnknownField[] | undefined {
  return opts?.$unknown;
}

export function getFileUint32(file: DescFile, no: number): number | undefined {
  return readUint32Unknown(unknowns(file.proto.options as { $unknown?: UnknownField[] } | undefined), no);
}

export function getMessageUint32(desc: DescMessage, no: number): number | undefined {
  return readUint32Unknown(unknowns(desc.proto.options as { $unknown?: UnknownField[] } | undefined), no);
}

export function getFieldUint32(fd: DescField, no: number): number | undefined {
  return readUint32Unknown(unknowns(fd.proto.options as { $unknown?: UnknownField[] } | undefined), no);
}

export function getFieldString(fd: DescField, no: number): string | undefined {
  const ufs = unknowns(fd.proto.options as { $unknown?: UnknownField[] } | undefined);
  if (!ufs) return undefined;
  for (const uf of ufs) {
    if (uf.no === no && uf.wireType === 2) {
      const [len, off] = readVarintWithLength(uf.data);
      return new TextDecoder().decode(uf.data.subarray(off, off + Number(len)));
    }
  }
  return undefined;
}

function readUint32Unknown(ufs: UnknownField[] | undefined, no: number): number | undefined {
  if (!ufs) return undefined;
  for (const uf of ufs) {
    if (uf.no === no && uf.wireType === 0) {
      return Number(readVarint(uf.data));
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
  throw new Error("sbe: invalid varint in options");
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
  throw new Error("sbe: invalid varint in options");
}
