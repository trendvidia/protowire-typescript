// SPDX-License-Identifier: MIT
// Copyright (c) 2026 TrendVidia, LLC.
/**
 * SBE XML schema model + parser. Mirrors the data shape of
 * `protowire/encoding/sbe/xmlschema.go`.
 *
 * Also exports the name-conversion helpers shared between XMLToProto and
 * ProtoToXML.
 */

import { type SaxHandler, parseXml } from "./saxlite.js";

export interface XMLSchema {
  package: string;
  id: number;
  version: number;
  byteOrder: string;
  description: string;
  types: XMLTypes;
  messages: XMLMessage[];
}

export interface XMLTypes {
  types: XMLType[];
  composites: XMLComposite[];
  enums: XMLEnum[];
}

export interface XMLType {
  name: string;
  primitiveType: string;
  length?: number;
  description?: string;
}

export interface XMLComposite {
  name: string;
  description?: string;
  types: XMLType[];
  refs: XMLRef[];
}

export interface XMLRef {
  name: string;
  type: string;
}

export interface XMLEnum {
  name: string;
  encodingType: string;
  description?: string;
  validValues: XMLValidValue[];
}

export interface XMLValidValue {
  name: string;
  value: string;
}

export interface XMLMessage {
  name: string;
  id: number;
  description?: string;
  fields: XMLField[];
  groups: XMLGroup[];
}

export interface XMLField {
  name: string;
  id: number;
  type: string;
}

export interface XMLGroup {
  name: string;
  id: number;
  fields: XMLField[];
}

export function parseXMLSchema(xml: string): XMLSchema {
  const schema: XMLSchema = {
    package: "",
    id: 0,
    version: 0,
    byteOrder: "",
    description: "",
    types: { types: [], composites: [], enums: [] },
    messages: [],
  };

  // Stack-based builder. The element names are stripped of their `sbe:`
  // namespace prefix by the SAX layer, so context decisions key off plain
  // names like "messageSchema", "message", "group", etc.
  const stack: string[] = [];
  let currentComposite: XMLComposite | null = null;
  let currentEnum: XMLEnum | null = null;
  let currentValidValue: XMLValidValue | null = null;
  let currentMessage: XMLMessage | null = null;
  let currentGroup: XMLGroup | null = null;
  let textBuf = "";

  const handler: SaxHandler = {
    onOpen(name, attrs) {
      const parent = stack[stack.length - 1];
      stack.push(name);

      switch (name) {
        case "messageSchema":
          schema.package = attrs.package ?? "";
          schema.id = parseUint(attrs.id);
          schema.version = parseUint(attrs.version);
          schema.byteOrder = attrs.byteOrder ?? "";
          schema.description = attrs.description ?? "";
          return;

        case "types":
          return;

        case "type": {
          const t: XMLType = {
            name: attrs.name ?? "",
            primitiveType: attrs.primitiveType ?? "",
          };
          if (attrs.length !== undefined) t.length = parseUint(attrs.length);
          if (attrs.description !== undefined) t.description = attrs.description;
          if (parent === "composite" && currentComposite) {
            currentComposite.types.push(t);
          } else {
            schema.types.types.push(t);
          }
          return;
        }

        case "ref":
          if (currentComposite) {
            currentComposite.refs.push({
              name: attrs.name ?? "",
              type: attrs.type ?? "",
            });
          }
          return;

        case "composite":
          currentComposite = {
            name: attrs.name ?? "",
            types: [],
            refs: [],
          };
          if (attrs.description !== undefined) currentComposite.description = attrs.description;
          schema.types.composites.push(currentComposite);
          return;

        case "enum":
          currentEnum = {
            name: attrs.name ?? "",
            encodingType: attrs.encodingType ?? "",
            validValues: [],
          };
          if (attrs.description !== undefined) currentEnum.description = attrs.description;
          schema.types.enums.push(currentEnum);
          return;

        case "validValue":
          currentValidValue = { name: attrs.name ?? "", value: "" };
          textBuf = "";
          if (currentEnum) currentEnum.validValues.push(currentValidValue);
          return;

        case "message":
          currentMessage = {
            name: attrs.name ?? "",
            id: parseUint(attrs.id),
            fields: [],
            groups: [],
          };
          if (attrs.description !== undefined) currentMessage.description = attrs.description;
          schema.messages.push(currentMessage);
          return;

        case "group":
          currentGroup = {
            name: attrs.name ?? "",
            id: parseUint(attrs.id),
            fields: [],
          };
          if (currentMessage) currentMessage.groups.push(currentGroup);
          return;

        case "field": {
          const f: XMLField = {
            name: attrs.name ?? "",
            id: parseUint(attrs.id),
            type: attrs.type ?? "",
          };
          if (currentGroup) {
            currentGroup.fields.push(f);
          } else if (currentMessage) {
            currentMessage.fields.push(f);
          }
          return;
        }
      }
    },

    onText(text) {
      // Only validValue cares about char data; everything else is whitespace
      // between elements that we deliberately drop.
      if (stack[stack.length - 1] === "validValue") {
        textBuf += text;
      }
    },

    onClose(name) {
      const popped = stack.pop();
      if (popped !== name) {
        throw new Error(`sbe-xml: close mismatch: got </${name}>, expected </${popped}>`);
      }
      switch (name) {
        case "validValue":
          if (currentValidValue) currentValidValue.value = textBuf.trim();
          currentValidValue = null;
          textBuf = "";
          return;
        case "enum":
          currentEnum = null;
          return;
        case "composite":
          currentComposite = null;
          return;
        case "group":
          currentGroup = null;
          return;
        case "message":
          currentMessage = null;
          return;
      }
    },
  };

  parseXml(xml, handler);

  if (stack.length > 0) {
    throw new Error(`sbe-xml: unclosed elements: ${stack.join(" > ")}`);
  }
  return schema;
}

function parseUint(v: string | undefined): number {
  if (v === undefined || v === "") return 0;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
    throw new Error(`sbe-xml: invalid uint value ${JSON.stringify(v)}`);
  }
  return n;
}

// ---------- name conversion helpers (shared with proto↔xml converters) ----------

export function camelToSnake(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (isUpper(ch)) {
      if (i > 0) {
        const prev = s[i - 1]!;
        if (isLower(prev)) {
          out += "_";
        } else if (i + 1 < s.length && isLower(s[i + 1]!)) {
          out += "_";
        }
      }
      out += ch.toLowerCase();
    } else {
      out += ch;
    }
  }
  return out;
}

export function snakeToCamel(s: string): string {
  const parts = s.split("_");
  let out = "";
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    if (p === "") continue;
    if (i === 0) {
      out += p;
    } else {
      out += p.charAt(0).toUpperCase() + p.substring(1);
    }
  }
  return out;
}

export function camelToScreamingSnake(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (isUpper(ch) && i > 0 && isLower(s[i - 1]!)) {
      out += "_";
    }
    out += ch.toUpperCase();
  }
  return out;
}

export function screamingSnakeToPascal(s: string): string {
  const parts = s.toLowerCase().split("_");
  let out = "";
  for (const p of parts) {
    if (p === "") continue;
    out += p.charAt(0).toUpperCase() + p.substring(1);
  }
  return out;
}

export function stripEnumPrefix(valueName: string, enumName: string): string {
  const prefix = camelToScreamingSnake(enumName) + "_";
  if (valueName.startsWith(prefix)) {
    return screamingSnakeToPascal(valueName.substring(prefix.length));
  }
  return screamingSnakeToPascal(valueName);
}

export function singularPascal(s: string): string {
  if (s === "") return s;
  let out = s;
  if (out.endsWith("ies") && out.length > 3) {
    out = out.substring(0, out.length - 3) + "y";
  } else if (out.endsWith("s") && !out.endsWith("ss") && out.length > 1) {
    out = out.substring(0, out.length - 1);
  }
  return out.charAt(0).toUpperCase() + out.substring(1);
}

function isUpper(ch: string): boolean {
  return ch >= "A" && ch <= "Z";
}

function isLower(ch: string): boolean {
  return ch >= "a" && ch <= "z";
}
