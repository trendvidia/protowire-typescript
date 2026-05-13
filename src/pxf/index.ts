// SPDX-License-Identifier: MIT
// Copyright (c) 2026 TrendVidia, LLC.
export {
  TokenKind,
  tokenKindName,
  positionString,
  type Position,
  type Token,
} from "./token.js";
export { PxfError } from "./errors.js";
export { Lexer } from "./lexer.js";
export { parse } from "./parser.js";
export { format, type FormatOptions } from "./format.js";
export {
  unmarshal,
  unmarshalFull,
  registryAsTypeResolver,
  type TypeResolver,
  type UnmarshalOptions,
} from "./decode.js";
export { marshal, type MarshalOptions } from "./encode.js";
export { Result } from "./result.js";
export {
  validateDescriptor,
  validateFile,
  violationString,
  type Violation,
  type ViolationKind,
} from "./schema.js";
export {
  DatasetReader,
  bindRow,
  DEFAULT_HEADER_MAX_BYTES,
} from "./dataset_reader.js";
export {
  findFieldByProtoName,
  isWrapperType,
  isTimestamp,
  isDuration,
  isAny,
  isFieldMask,
} from "./descriptor.js";
export type {
  Assignment,
  Block,
  BlockVal,
  BoolVal,
  BytesVal,
  Comment,
  Directive,
  Document,
  DurationVal,
  Entry,
  FloatVal,
  IdentVal,
  IntVal,
  ListVal,
  MapEntry,
  NullVal,
  StringVal,
  DatasetDirective,
  DatasetRow,
  TimestampVal,
  Value,
} from "./ast.js";
