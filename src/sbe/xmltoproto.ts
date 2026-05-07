// SPDX-License-Identifier: MIT
// Copyright (c) 2026 TrendVidia, LLC.
/**
 * Convert an SBE XML schema into proto3 source with sbe annotations.
 * Mirrors `protowire/encoding/sbe/xmltoproto.go`.
 */

import {
  type XMLComposite,
  type XMLEnum,
  type XMLField,
  type XMLGroup,
  type XMLMessage,
  type XMLSchema,
  type XMLType,
  camelToScreamingSnake,
  camelToSnake,
  parseXMLSchema,
  singularPascal,
} from "./xmlschema.js";

const BUILTINS = [
  "int8",
  "int16",
  "int32",
  "int64",
  "uint8",
  "uint16",
  "uint32",
  "uint64",
  "float",
  "double",
  "char",
] as const;

export function xmlToProto(xml: string): string {
  const schema = parseXMLSchema(xml);
  return generateProto(schema);
}

function generateProto(schema: XMLSchema): string {
  // Build type-resolution maps (built-ins seeded first).
  const typeMap = new Map<string, XMLType>();
  for (const name of BUILTINS) {
    typeMap.set(name, { name, primitiveType: name });
  }
  for (const t of schema.types.types) typeMap.set(t.name, t);

  const compositeMap = new Map<string, XMLComposite>();
  for (const c of schema.types.composites) compositeMap.set(c.name, c);

  const enumMap = new Map<string, XMLEnum>();
  for (const e of schema.types.enums) enumMap.set(e.name, e);

  let out = "";
  out += `syntax = "proto3";\n\n`;
  if (schema.package !== "") out += `package ${schema.package};\n\n`;
  out += `import "sbe/annotations.proto";\n\n`;
  out += `option (sbe.schema_id) = ${schema.id};\n`;
  out += `option (sbe.version) = ${schema.version};\n\n`;

  for (const e of schema.types.enums) out += writeProtoEnum(e);
  for (const c of schema.types.composites) {
    if (c.name === "messageHeader" || c.name === "groupSizeEncoding") continue;
    out += writeProtoComposite(c);
  }
  for (const m of schema.messages) {
    out += writeProtoMessage(m, typeMap, compositeMap, enumMap);
  }

  return out;
}

function writeProtoEnum(e: XMLEnum): string {
  let out = `enum ${e.name} {\n`;
  const prefix = camelToScreamingSnake(e.name);
  for (const v of e.validValues) {
    const name = `${prefix}_${camelToScreamingSnake(v.name)}`;
    out += `  ${name} = ${v.value};\n`;
  }
  out += `}\n\n`;
  return out;
}

function writeProtoComposite(c: XMLComposite): string {
  let out = `message ${c.name} {\n`;
  let fieldNum = 1;
  for (const t of c.types) {
    const [protoType, opts] = resolveTypeToProto(t.primitiveType, t.length ?? 0);
    const name = camelToSnake(t.name);
    out +=
      opts !== ""
        ? `  ${protoType} ${name} = ${fieldNum} [${opts}];\n`
        : `  ${protoType} ${name} = ${fieldNum};\n`;
    fieldNum++;
  }
  for (const r of c.refs) {
    const name = camelToSnake(r.name);
    out += `  ${r.type} ${name} = ${fieldNum};\n`;
    fieldNum++;
  }
  out += `}\n\n`;
  return out;
}

function writeProtoMessage(
  msg: XMLMessage,
  typeMap: Map<string, XMLType>,
  compositeMap: Map<string, XMLComposite>,
  enumMap: Map<string, XMLEnum>,
): string {
  let out = `message ${msg.name} {\n`;
  out += `  option (sbe.template_id) = ${msg.id};\n`;
  for (const f of msg.fields) {
    out += writeProtoField(f, typeMap, compositeMap, enumMap, "  ");
  }
  for (const g of msg.groups) {
    out += writeProtoGroup(g, typeMap, compositeMap, enumMap, "  ");
  }
  out += `}\n\n`;
  return out;
}

function writeProtoField(
  f: XMLField,
  typeMap: Map<string, XMLType>,
  compositeMap: Map<string, XMLComposite>,
  enumMap: Map<string, XMLEnum>,
  indent: string,
): string {
  const name = camelToSnake(f.name);

  if (enumMap.has(f.type)) {
    return `${indent}${f.type} ${name} = ${f.id};\n`;
  }
  if (compositeMap.has(f.type)) {
    return `${indent}${f.type} ${name} = ${f.id};\n`;
  }
  const t = typeMap.get(f.type);
  if (t) {
    const [protoType, opts] = resolveTypeToProto(t.primitiveType, t.length ?? 0);
    return opts !== ""
      ? `${indent}${protoType} ${name} = ${f.id} [${opts}];\n`
      : `${indent}${protoType} ${name} = ${f.id};\n`;
  }
  // Unknown type — pass through as-is so the user's protoc surfaces the error.
  return `${indent}${f.type} ${name} = ${f.id};\n`;
}

function writeProtoGroup(
  g: XMLGroup,
  typeMap: Map<string, XMLType>,
  compositeMap: Map<string, XMLComposite>,
  enumMap: Map<string, XMLEnum>,
  indent: string,
): string {
  const msgName = singularPascal(g.name);
  let out = `${indent}message ${msgName} {\n`;
  for (const f of g.fields) {
    out += writeProtoField(f, typeMap, compositeMap, enumMap, indent + "  ");
  }
  out += `${indent}}\n`;
  const fieldName = camelToSnake(g.name);
  out += `${indent}repeated ${msgName} ${fieldName} = ${g.id};\n`;
  return out;
}

function resolveTypeToProto(primitiveType: string, length: number): [string, string] {
  switch (primitiveType) {
    case "int8":
      return ["int32", `(sbe.encoding) = "int8"`];
    case "int16":
      return ["int32", `(sbe.encoding) = "int16"`];
    case "int32":
      return ["int32", ""];
    case "int64":
      return ["int64", ""];
    case "uint8":
      return ["uint32", `(sbe.encoding) = "uint8"`];
    case "uint16":
      return ["uint32", `(sbe.encoding) = "uint16"`];
    case "uint32":
      return ["uint32", ""];
    case "uint64":
      return ["uint64", ""];
    case "float":
      return ["float", ""];
    case "double":
      return ["double", ""];
    case "char":
      if (length > 0) return ["string", `(sbe.length) = ${length}`];
      return ["string", `(sbe.length) = 1`];
    default:
      return [primitiveType, ""];
  }
}
