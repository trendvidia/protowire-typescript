// SPDX-License-Identifier: MIT
// Copyright (c) 2026 TrendVidia, LLC.
import { describe, it, expect } from "vitest";
import { Envelope, AppError, FieldError, newAppError } from "./envelope.js";
import { EnvelopePb, AppErrorPb, FieldErrorPb } from "./codec.js";

describe("FieldErrorPb roundtrip", () => {
  it("preserves all fields including repeated args", () => {
    const fe = new FieldError("email", "FORMAT", "bad email", ["user@bad", "tld"]);
    const data = FieldErrorPb.marshal(fe);
    const got = FieldErrorPb.unmarshal(data);
    expect(got).toBeInstanceOf(FieldError);
    expect(got.field).toBe("email");
    expect(got.code).toBe("FORMAT");
    expect(got.message).toBe("bad email");
    expect(got.args).toEqual(["user@bad", "tld"]);
  });

  it("zero-value FieldError marshals to empty bytes", () => {
    const data = FieldErrorPb.marshal(new FieldError("", ""));
    expect(data.length).toBe(0);
    const got = FieldErrorPb.unmarshal(data);
    expect(got.field).toBe("");
    expect(got.code).toBe("");
    expect(got.message).toBe("");
    expect(got.args).toEqual([]);
  });
});

describe("AppErrorPb roundtrip", () => {
  it("preserves nested details and metadata map", () => {
    const ae = newAppError("VALIDATION", "fields invalid", "ctx")
      .withField("email", "FORMAT", "bad", "u@bad")
      .withField("age", "RANGE")
      .withMeta("region", "us-east")
      .withMeta("retry_after", "30");

    const data = AppErrorPb.marshal(ae);
    const got = AppErrorPb.unmarshal(data);
    expect(got).toBeInstanceOf(AppError);
    expect(got.code).toBe("VALIDATION");
    expect(got.message).toBe("fields invalid");
    expect(got.args).toEqual(["ctx"]);
    expect(got.details).toHaveLength(2);
    expect(got.details[0]).toBeInstanceOf(FieldError);
    expect(got.details[0]?.field).toBe("email");
    expect(got.details[0]?.args).toEqual(["u@bad"]);
    expect(got.details[1]?.field).toBe("age");
    expect(got.metadata).toEqual({ region: "us-east", retry_after: "30" });
  });
});

describe("EnvelopePb roundtrip", () => {
  it("OK envelope preserves data payload", () => {
    const env = Envelope.ok(200, new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
    const data = EnvelopePb.marshal(env);
    const got = EnvelopePb.unmarshal(data);
    expect(got).toBeInstanceOf(Envelope);
    expect(got.status).toBe(200);
    expect(got.data).toEqual(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
    expect(got.transportError).toBe("");
    expect(got.error).toBeNull();
    expect(got.isOk()).toBe(true);
  });

  it("error envelope preserves nested AppError with details and metadata", () => {
    const ae = newAppError("INSUFFICIENT_FUNDS", "balance too low", "$3.50", "$10.00")
      .withField("amount", "MIN_VALUE", "below minimum", "10.00")
      .withMeta("request_id", "req-123");
    const env = new Envelope({ status: 402, error: ae });

    const data = EnvelopePb.marshal(env);
    const got = EnvelopePb.unmarshal(data);

    expect(got.status).toBe(402);
    expect(got.isAppError()).toBe(true);
    expect(got.errorCode()).toBe("INSUFFICIENT_FUNDS");
    expect(got.error?.args).toEqual(["$3.50", "$10.00"]);
    expect(got.error?.details).toHaveLength(1);
    expect(got.error?.details[0]?.code).toBe("MIN_VALUE");
    expect(got.error?.metadata).toEqual({ request_id: "req-123" });
  });

  it("transport error round-trips", () => {
    const env = Envelope.transportErr("connection refused");
    const data = EnvelopePb.marshal(env);
    const got = EnvelopePb.unmarshal(data);
    expect(got.isTransportError()).toBe(true);
    expect(got.transportError).toBe("connection refused");
    expect(got.status).toBe(0);
    expect(got.error).toBeNull();
  });

  it("zero envelope marshals to empty bytes", () => {
    const data = EnvelopePb.marshal(new Envelope());
    expect(data.length).toBe(0);
    const got = EnvelopePb.unmarshal(data);
    expect(got.isOk()).toBe(true);
  });

  it("preserves data integrity across nested message boundary", () => {
    // A 1KB payload with various byte patterns to catch off-by-one errors
    // in length-prefix handling.
    const payload = new Uint8Array(1024);
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 37) & 0xff;
    const env = Envelope.ok(200, payload);
    const got = EnvelopePb.unmarshal(EnvelopePb.marshal(env));
    expect(got.data).toEqual(payload);
  });
});

describe("wire compatibility — field numbers match envelope.proto", () => {
  it("Envelope tags fields 1..4", () => {
    expect(EnvelopePb.byNumber.get(1)?.name).toBe("status");
    expect(EnvelopePb.byNumber.get(2)?.name).toBe("transportError");
    expect(EnvelopePb.byNumber.get(3)?.name).toBe("data");
    expect(EnvelopePb.byNumber.get(4)?.name).toBe("error");
  });

  it("AppError tags fields 1..5", () => {
    expect(AppErrorPb.byNumber.get(1)?.name).toBe("code");
    expect(AppErrorPb.byNumber.get(2)?.name).toBe("message");
    expect(AppErrorPb.byNumber.get(3)?.name).toBe("args");
    expect(AppErrorPb.byNumber.get(4)?.name).toBe("details");
    expect(AppErrorPb.byNumber.get(5)?.name).toBe("metadata");
  });

  it("FieldError tags fields 1..4", () => {
    expect(FieldErrorPb.byNumber.get(1)?.name).toBe("field");
    expect(FieldErrorPb.byNumber.get(2)?.name).toBe("code");
    expect(FieldErrorPb.byNumber.get(3)?.name).toBe("message");
    expect(FieldErrorPb.byNumber.get(4)?.name).toBe("args");
  });
});
