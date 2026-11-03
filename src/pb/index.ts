// SPDX-License-Identifier: MIT
// Copyright (c) 2026 TrendVidia, LLC.
export { Reader, Writer, WireType } from "./wire.js";
export {
  BigFloatCodec,
  BigFloatValueCodec,
  BigIntValueCodec,
  DecimalCodec,
  DecimalValueCodec,
  defineMessage,
  marshal,
  MAX_BIG_FLOAT_EXPONENT,
  MAX_NESTING_DEPTH,
  unmarshal,
} from "./codec.js";
export { BigFloat, Decimal } from "./bignum.js";
export type { BigFloatParts } from "./bignum.js";
export type {
  BigFloatValue,
  CodecBase,
  DefineMessageOpts,
  FieldSpec,
  MarshalOptions,
  UnmarshalOptions,
  Kind,
  MapKeyKind,
  MessageCodec,
  ScalarKind,
} from "./codec.js";
