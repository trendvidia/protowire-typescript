// SPDX-License-Identifier: MIT
// Copyright (c) 2026 TrendVidia, LLC.
export { Codec, HEADER_SIZE, GROUP_HEADER_SIZE } from "./sbe.js";
export { marshal } from "./marshal.js";
export { unmarshal } from "./unmarshal.js";
export { View, GroupView } from "./view.js";
export type { ViewSchema } from "./view.js";
export type { MessageTemplate, FieldTemplate, GroupTemplate, SbeEncoding } from "./template.js";
export {
  parseXMLSchema,
  camelToSnake,
  snakeToCamel,
  camelToScreamingSnake,
  screamingSnakeToPascal,
  stripEnumPrefix,
  singularPascal,
} from "./xmlschema.js";
export type {
  XMLSchema,
  XMLTypes,
  XMLType,
  XMLComposite,
  XMLRef,
  XMLEnum,
  XMLValidValue,
  XMLMessage,
  XMLField,
  XMLGroup,
} from "./xmlschema.js";
export { xmlToProto } from "./xmltoproto.js";
export { protoToXml } from "./prototoxml.js";
