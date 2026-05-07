// SPDX-License-Identifier: MIT
// Copyright (c) 2026 TrendVidia, LLC.
/**
 * Convert proto file descriptors with SBE annotations to an SBE XML schema.
 * Mirrors `protowire/encoding/sbe/prototoxml.go`.
 */

import {
  type DescEnum,
  type DescField,
  type DescFile,
  type DescMessage,
  ScalarType,
} from "@bufbuild/protobuf";

import {
  EXT_ENCODING,
  EXT_LENGTH,
  EXT_SCHEMA_ID,
  EXT_TEMPLATE_ID,
  EXT_VERSION,
  getFieldString,
  getFieldUint32,
  getFileUint32,
  getMessageUint32,
} from "./annotations.js";
import { snakeToCamel, stripEnumPrefix } from "./xmlschema.js";

interface SbeTypeInfo {
  primitiveType: string;
  xmlType: string;
  length: number;
}

export function protoToXml(file: DescFile): string {
  const schemaId = getFileUint32(file, EXT_SCHEMA_ID);
  if (schemaId === undefined) {
    throw new Error(`sbe: file ${file.name} missing (sbe.schema_id)`);
  }
  const version = getFileUint32(file, EXT_VERSION) ?? 0;

  // Pre-collect types referenced by template messages.
  const strLengths = new Set<number>();
  const composites: DescMessage[] = [];
  const compositesSeen = new Set<string>();
  const enums: DescEnum[] = [];
  const enumsSeen = new Set<string>();

  for (const ed of file.enums) {
    enums.push(ed);
    enumsSeen.add(ed.typeName);
  }

  for (const md of file.messages) {
    if (getMessageUint32(md, EXT_TEMPLATE_ID) !== undefined) {
      collectTypes(md, strLengths, composites, compositesSeen, enums, enumsSeen);
    } else if (!compositesSeen.has(md.typeName)) {
      compositesSeen.add(md.typeName);
      composites.push(md);
    }
  }

  const lengths = [...strLengths].sort((a, b) => a - b);

  let out = "";
  out += `<?xml version="1.0" encoding="UTF-8"?>\n`;
  out += `<sbe:messageSchema xmlns:sbe="http://fixprotocol.io/2016/sbe"\n`;
  out += `                   package="${file.proto.package ?? ""}"\n`;
  out += `                   id="${schemaId}"\n`;
  out += `                   version="${version}"\n`;
  out += `                   byteOrder="littleEndian">\n`;

  out += `    <types>\n`;
  out += `        <composite name="messageHeader">\n`;
  out += `            <type name="blockLength" primitiveType="uint16"/>\n`;
  out += `            <type name="templateId" primitiveType="uint16"/>\n`;
  out += `            <type name="schemaId" primitiveType="uint16"/>\n`;
  out += `            <type name="version" primitiveType="uint16"/>\n`;
  out += `        </composite>\n`;
  out += `        <composite name="groupSizeEncoding">\n`;
  out += `            <type name="blockLength" primitiveType="uint16"/>\n`;
  out += `            <type name="numInGroup" primitiveType="uint16"/>\n`;
  out += `        </composite>\n`;

  for (const l of lengths) {
    out += `        <type name="str${l}" primitiveType="char" length="${l}"/>\n`;
  }
  for (const e of enums) out += writeEnum(e);
  for (const md of composites) out += writeComposite(md);

  out += `    </types>\n`;

  for (const md of file.messages) {
    const tid = getMessageUint32(md, EXT_TEMPLATE_ID);
    if (tid !== undefined) out += writeMessage(md, tid);
  }

  out += `</sbe:messageSchema>\n`;
  return out;
}

function collectTypes(
  md: DescMessage,
  strLengths: Set<number>,
  composites: DescMessage[],
  compositesSeen: Set<string>,
  enums: DescEnum[],
  enumsSeen: Set<string>,
): void {
  for (const ed of md.nestedEnums) {
    if (!enumsSeen.has(ed.typeName)) {
      enumsSeen.add(ed.typeName);
      enums.push(ed);
    }
  }

  for (const f of md.fields) {
    if (f.fieldKind === "scalar" && (f.scalar === ScalarType.STRING || f.scalar === ScalarType.BYTES)) {
      const len = getFieldUint32(f, EXT_LENGTH);
      if (len !== undefined) strLengths.add(len);
    }
    if (f.fieldKind === "enum") {
      const ed = f.enum;
      if (!enumsSeen.has(ed.typeName)) {
        enumsSeen.add(ed.typeName);
        enums.push(ed);
      }
    }
    if (f.fieldKind === "message") {
      const sub = f.message;
      if (!compositesSeen.has(sub.typeName)) {
        compositesSeen.add(sub.typeName);
        composites.push(sub);
        collectTypes(sub, strLengths, composites, compositesSeen, enums, enumsSeen);
      }
    }
    if (f.fieldKind === "list" && f.listKind === "message") {
      collectTypes(f.message, strLengths, composites, compositesSeen, enums, enumsSeen);
    }
  }
}

function writeEnum(ed: DescEnum): string {
  let out = `        <enum name="${ed.name}" encodingType="uint8">\n`;
  for (const v of ed.values) {
    const valueName = stripEnumPrefix(v.name, ed.name);
    out += `            <validValue name="${valueName}">${v.number}</validValue>\n`;
  }
  out += `        </enum>\n`;
  return out;
}

function writeComposite(md: DescMessage): string {
  let out = `        <composite name="${md.name}">\n`;
  for (const f of sortedFields(md)) {
    const fieldName = snakeToCamel(f.name);
    const info = protoFieldToSBEType(f);
    out +=
      info.length > 0
        ? `            <type name="${fieldName}" primitiveType="${info.primitiveType}" length="${info.length}"/>\n`
        : `            <type name="${fieldName}" primitiveType="${info.primitiveType}"/>\n`;
  }
  out += `        </composite>\n`;
  return out;
}

function writeMessage(md: DescMessage, templateId: number): string {
  let out = `    <sbe:message name="${md.name}" id="${templateId}">\n`;
  for (const f of sortedFields(md)) {
    if (f.fieldKind === "list" && f.listKind === "message") {
      out += writeGroup(f, "        ");
      continue;
    }
    out += writeField(f, "        ");
  }
  out += `    </sbe:message>\n`;
  return out;
}

function writeField(fd: DescField, indent: string): string {
  const fieldName = snakeToCamel(fd.name);
  const fieldId = fd.number;
  if (fd.fieldKind === "enum") {
    return `${indent}<field name="${fieldName}" id="${fieldId}" type="${fd.enum.name}"/>\n`;
  }
  if (fd.fieldKind === "message") {
    return `${indent}<field name="${fieldName}" id="${fieldId}" type="${fd.message.name}"/>\n`;
  }
  const info = protoFieldToSBEType(fd);
  if (info.length > 0) {
    return `${indent}<field name="${fieldName}" id="${fieldId}" type="str${info.length}"/>\n`;
  }
  return `${indent}<field name="${fieldName}" id="${fieldId}" type="${info.xmlType}"/>\n`;
}

function writeGroup(fd: DescField & { fieldKind: "list" }, indent: string): string {
  if (fd.listKind !== "message") {
    throw new Error(`sbe: writeGroup on non-message-list field ${fd.name}`);
  }
  const groupName = snakeToCamel(fd.name);
  const groupId = fd.number;
  let out = `${indent}<group name="${groupName}" id="${groupId}">\n`;
  for (const f of sortedFields(fd.message)) {
    out += writeField(f, indent + "    ");
  }
  out += `${indent}</group>\n`;
  return out;
}

function protoFieldToSBEType(fd: DescField): SbeTypeInfo {
  const enc = getFieldString(fd, EXT_ENCODING);
  if (enc !== undefined) {
    return { primitiveType: enc, xmlType: enc, length: 0 };
  }
  if (fd.fieldKind === "scalar") {
    if (fd.scalar === ScalarType.STRING || fd.scalar === ScalarType.BYTES) {
      const length = getFieldUint32(fd, EXT_LENGTH) ?? 0;
      return { primitiveType: "char", xmlType: "char", length };
    }
    switch (fd.scalar) {
      case ScalarType.BOOL:
        return scalarInfo("uint8");
      case ScalarType.INT32:
      case ScalarType.SINT32:
      case ScalarType.SFIXED32:
        return scalarInfo("int32");
      case ScalarType.INT64:
      case ScalarType.SINT64:
      case ScalarType.SFIXED64:
        return scalarInfo("int64");
      case ScalarType.UINT32:
      case ScalarType.FIXED32:
        return scalarInfo("uint32");
      case ScalarType.UINT64:
      case ScalarType.FIXED64:
        return scalarInfo("uint64");
      case ScalarType.FLOAT:
        return scalarInfo("float");
      case ScalarType.DOUBLE:
        return scalarInfo("double");
    }
  }
  // Fallback (e.g. enum-typed field that doesn't go through this path).
  return scalarInfo("uint8");
}

function scalarInfo(name: string): SbeTypeInfo {
  return { primitiveType: name, xmlType: name, length: 0 };
}

function sortedFields(md: DescMessage): DescField[] {
  return [...md.fields].sort((a, b) => a.number - b.number);
}
