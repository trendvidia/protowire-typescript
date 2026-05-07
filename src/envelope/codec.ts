// SPDX-License-Identifier: MIT
// Copyright (c) 2026 TrendVidia, LLC.
/**
 * Binary protobuf codecs for Envelope/AppError/FieldError, driven by the
 * schema-free `pb` module.
 *
 * Field numbers and types match `proto/envelope/v1/envelope.proto` from the
 * canonical Go module. One wire-format caveat: `pb` encodes signed integer
 * fields with zigzag varint (proto3 `sint32` semantics), not plain varint
 * (proto3 `int32`). For non-negative values like HTTP status codes the bytes
 * are identical, so this matters only for negative integers — which the
 * envelope shape does not use.
 */

import { defineMessage, type MessageCodec } from "../pb/codec.js";
import { AppError, Envelope, FieldError } from "./envelope.js";

export const FieldErrorPb: MessageCodec<FieldError> = defineMessage<FieldError>({
  fields: [
    { number: 1, name: "field", kind: "string" },
    { number: 2, name: "code", kind: "string" },
    { number: 3, name: "message", kind: "string" },
    { number: 4, name: "args", kind: "string", repeated: true },
  ],
  create: () => new FieldError("", ""),
});

export const AppErrorPb: MessageCodec<AppError> = defineMessage<AppError>({
  fields: [
    { number: 1, name: "code", kind: "string" },
    { number: 2, name: "message", kind: "string" },
    { number: 3, name: "args", kind: "string", repeated: true },
    { number: 4, name: "details", kind: { message: FieldErrorPb }, repeated: true },
    { number: 5, name: "metadata", kind: "string", mapKey: "string" },
  ],
  create: () => new AppError(""),
});

export const EnvelopePb: MessageCodec<Envelope> = defineMessage<Envelope>({
  fields: [
    { number: 1, name: "status", kind: "int32" },
    { number: 2, name: "transportError", kind: "string" },
    { number: 3, name: "data", kind: "bytes" },
    { number: 4, name: "error", kind: { message: AppErrorPb } },
  ],
  create: () => new Envelope(),
});
