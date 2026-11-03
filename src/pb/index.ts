// SPDX-License-Identifier: MIT
// Copyright (c) 2026 TrendVidia, LLC.
export { Reader, Writer, WireType } from "./wire.js";
export {
  BigFloatCodec,
  DecimalCodec,
  defineMessage,
  marshal,
  MAX_BIG_FLOAT_EXPONENT,
  MAX_NESTING_DEPTH,
  unmarshal,
} from "./codec.js";
export type {
  BigFloatValue,
  CodecBase,
  DefineMessageOpts,
  FieldSpec,
  UnmarshalOptions,
  Kind,
  MapKeyKind,
  MessageCodec,
  ScalarKind,
} from "./codec.js";
