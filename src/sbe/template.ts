/**
 * SBE wire-layout templates derived from proto descriptors.
 * Mirrors `protowire/encoding/sbe/template.go`.
 */

import { type DescField, type DescMessage, ScalarType } from "@bufbuild/protobuf";

import {
  EXT_ENCODING,
  EXT_LENGTH,
  EXT_TEMPLATE_ID,
  getFieldString,
  getFieldUint32,
  getMessageUint32,
} from "./annotations.js";
import type { ViewSchema } from "./view.js";

export type SbeEncoding =
  | "int8"
  | "int16"
  | "int32"
  | "int64"
  | "uint8"
  | "uint16"
  | "uint32"
  | "uint64"
  | "float"
  | "double"
  | "char";

export interface FieldTemplate {
  fd: DescField;
  offset: number;
  size: number;
  /** Empty string for composite fields. */
  encoding: SbeEncoding | "";
  /** Non-empty for composite (nested message) fields. */
  composite: FieldTemplate[];
  /** Lazily populated by view.buildViewSchema for composite fields. */
  compositeView?: ViewSchema;
}

export interface GroupTemplate {
  fd: DescField;
  blockLength: number;
  fields: FieldTemplate[];
}

export interface MessageTemplate {
  desc: DescMessage;
  templateId: number;
  schemaId: number;
  version: number;
  blockLength: number;
  fields: FieldTemplate[];
  groups: GroupTemplate[];
  /** Lazily populated by View.fromCodec on first use. */
  view?: ViewSchema;
}

export function buildTemplate(
  desc: DescMessage,
  schemaId: number,
  version: number,
): MessageTemplate {
  const tid = getMessageUint32(desc, EXT_TEMPLATE_ID);
  if (tid === undefined) {
    throw new Error(`sbe: message ${desc.typeName} missing (sbe.template_id)`);
  }

  const tmpl: MessageTemplate = {
    desc,
    templateId: tid,
    schemaId,
    version,
    blockLength: 0,
    fields: [],
    groups: [],
  };

  let offset = 0;
  for (const fd of sortedFields(desc)) {
    if (fd.fieldKind === "map") {
      throw new Error(`sbe: map field ${desc.typeName}.${fd.name} not supported`);
    }
    if (fd.oneof !== undefined) {
      throw new Error(`sbe: oneof field ${desc.typeName}.${fd.name} not supported`);
    }

    if (fd.fieldKind === "list" && fd.listKind === "message") {
      tmpl.groups.push(buildGroupTemplate(fd));
      continue;
    }
    if (fd.fieldKind === "list") {
      throw new Error(
        `sbe: repeated scalar field ${desc.typeName}.${fd.name} not supported; wrap in a message`,
      );
    }

    if (fd.fieldKind === "message") {
      const [size, sub] = buildCompositeFields(fd.message);
      tmpl.fields.push({ fd, offset, size, encoding: "", composite: sub });
      offset += size;
      continue;
    }

    const [enc, size] = fieldEncodingSize(fd);
    tmpl.fields.push({ fd, offset, size, encoding: enc, composite: [] });
    offset += size;
  }

  tmpl.blockLength = offset;
  return tmpl;
}

function buildGroupTemplate(fd: DescField & { fieldKind: "list" }): GroupTemplate {
  if (fd.listKind !== "message") {
    throw new Error(`sbe: group field ${fd.name} must be a repeated message`);
  }
  const md = fd.message;
  const gt: GroupTemplate = { fd, blockLength: 0, fields: [] };
  let offset = 0;
  for (const f of sortedFields(md)) {
    if (f.fieldKind === "map") {
      throw new Error(`sbe: map field in group ${md.typeName} not supported`);
    }
    if (f.fieldKind === "list") {
      throw new Error(`sbe: nested repeated field in group ${md.typeName} not supported`);
    }
    if (f.fieldKind === "message") {
      const [size, sub] = buildCompositeFields(f.message);
      gt.fields.push({ fd: f, offset, size, encoding: "", composite: sub });
      offset += size;
      continue;
    }
    const [enc, size] = fieldEncodingSize(f);
    gt.fields.push({ fd: f, offset, size, encoding: enc, composite: [] });
    offset += size;
  }
  gt.blockLength = offset;
  return gt;
}

function buildCompositeFields(md: DescMessage): [number, FieldTemplate[]] {
  const out: FieldTemplate[] = [];
  let offset = 0;
  for (const fd of sortedFields(md)) {
    if (fd.fieldKind === "list" || fd.fieldKind === "map") {
      throw new Error(`sbe: composite ${md.typeName} contains list/map field ${fd.name}`);
    }
    if (fd.oneof !== undefined) {
      throw new Error(`sbe: composite ${md.typeName} contains oneof field ${fd.name}`);
    }
    if (fd.fieldKind === "message") {
      const [size, sub] = buildCompositeFields(fd.message);
      out.push({ fd, offset, size, encoding: "", composite: sub });
      offset += size;
      continue;
    }
    const [enc, size] = fieldEncodingSize(fd);
    out.push({ fd, offset, size, encoding: enc, composite: [] });
    offset += size;
  }
  return [offset, out];
}

export function fieldEncodingSize(fd: DescField): [SbeEncoding, number] {
  const explicit = getFieldString(fd, EXT_ENCODING);
  if (explicit !== undefined) {
    switch (explicit) {
      case "int8":
      case "uint8":
        return [explicit, 1];
      case "int16":
      case "uint16":
        return [explicit, 2];
      case "int32":
      case "uint32":
      case "float":
        return [explicit, 4];
      case "int64":
      case "uint64":
      case "double":
        return [explicit, 8];
      default:
        throw new Error(`sbe: unknown encoding ${JSON.stringify(explicit)} on ${fd.name}`);
    }
  }

  if (fd.fieldKind === "enum") return ["uint8", 1];
  if (fd.fieldKind !== "scalar") {
    throw new Error(`sbe: unsupported field kind ${fd.fieldKind} on ${fd.name}`);
  }

  switch (fd.scalar) {
    case ScalarType.BOOL:
      return ["uint8", 1];
    case ScalarType.INT32:
    case ScalarType.SINT32:
    case ScalarType.SFIXED32:
      return ["int32", 4];
    case ScalarType.INT64:
    case ScalarType.SINT64:
    case ScalarType.SFIXED64:
      return ["int64", 8];
    case ScalarType.UINT32:
    case ScalarType.FIXED32:
      return ["uint32", 4];
    case ScalarType.UINT64:
    case ScalarType.FIXED64:
      return ["uint64", 8];
    case ScalarType.FLOAT:
      return ["float", 4];
    case ScalarType.DOUBLE:
      return ["double", 8];
    case ScalarType.STRING:
    case ScalarType.BYTES: {
      const len = getFieldUint32(fd, EXT_LENGTH);
      if (len === undefined) {
        const kind = fd.scalar === ScalarType.STRING ? "string" : "bytes";
        throw new Error(`sbe: ${kind} field ${fd.name} requires (sbe.length) annotation`);
      }
      return ["char", len];
    }
  }
}

function sortedFields(desc: DescMessage): DescField[] {
  return [...desc.fields].sort((a, b) => a.number - b.number);
}
