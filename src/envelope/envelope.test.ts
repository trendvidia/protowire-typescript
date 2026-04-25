import { describe, it, expect } from "vitest";
import { Envelope, AppError, FieldError, newAppError } from "./envelope.js";

describe("Envelope.ok", () => {
  it("is OK and has no errors", () => {
    const e = Envelope.ok(200, new Uint8Array([1, 2, 3]));
    expect(e.status).toBe(200);
    expect(e.data).toEqual(new Uint8Array([1, 2, 3]));
    expect(e.transportError).toBe("");
    expect(e.error).toBeNull();
    expect(e.isOk()).toBe(true);
    expect(e.isTransportError()).toBe(false);
    expect(e.isAppError()).toBe(false);
    expect(e.errorCode()).toBe("");
  });
});

describe("Envelope.err", () => {
  it("carries an app error and is not OK", () => {
    const e = Envelope.err(400, "INVALID", "bad input", "name", "too short");
    expect(e.status).toBe(400);
    expect(e.error).not.toBeNull();
    expect(e.error?.code).toBe("INVALID");
    expect(e.error?.message).toBe("bad input");
    expect(e.error?.args).toEqual(["name", "too short"]);
    expect(e.isOk()).toBe(false);
    expect(e.isTransportError()).toBe(false);
    expect(e.isAppError()).toBe(true);
    expect(e.errorCode()).toBe("INVALID");
  });

  it("works without args", () => {
    const e = Envelope.err(500, "OOPS");
    expect(e.error?.code).toBe("OOPS");
    expect(e.error?.message).toBe("");
    expect(e.error?.args).toEqual([]);
  });
});

describe("Envelope.transportErr", () => {
  it("carries a transport error and is not an app error", () => {
    const e = Envelope.transportErr("connection refused");
    expect(e.transportError).toBe("connection refused");
    expect(e.error).toBeNull();
    expect(e.isOk()).toBe(false);
    expect(e.isTransportError()).toBe(true);
    expect(e.isAppError()).toBe(false);
    expect(e.errorCode()).toBe("");
  });
});

describe("AppError chaining", () => {
  it("withField appends FieldError details and returns the same instance", () => {
    const ae = newAppError("VALIDATION", "fields invalid");
    const ret = ae
      .withField("email", "FORMAT", "invalid email", "user@bad")
      .withField("age", "RANGE", "must be positive");
    expect(ret).toBe(ae);
    expect(ae.details).toHaveLength(2);
    expect(ae.details[0]).toBeInstanceOf(FieldError);
    expect(ae.details[0]?.field).toBe("email");
    expect(ae.details[0]?.args).toEqual(["user@bad"]);
    expect(ae.details[1]?.field).toBe("age");
    expect(ae.details[1]?.args).toEqual([]);
  });

  it("withMeta sets metadata entries and returns the same instance", () => {
    const ae = newAppError("X").withMeta("region", "us-east").withMeta("tier", "free");
    expect(ae.metadata).toEqual({ region: "us-east", tier: "free" });
  });
});

describe("Envelope.fieldErrors", () => {
  it("returns null when there is no app error", () => {
    expect(Envelope.ok(200, new Uint8Array()).fieldErrors()).toBeNull();
    expect(Envelope.transportErr("nope").fieldErrors()).toBeNull();
  });

  it("returns null when the app error has no details", () => {
    expect(Envelope.err(400, "BAD").fieldErrors()).toBeNull();
  });

  it("indexes details by field name", () => {
    const ae = newAppError("VALIDATION").withField("email", "FORMAT").withField("age", "RANGE");
    const e = new Envelope({ status: 400, error: ae });
    const idx = e.fieldErrors();
    expect(idx).not.toBeNull();
    expect(Object.keys(idx!).sort()).toEqual(["age", "email"]);
    expect(idx!.email?.code).toBe("FORMAT");
    expect(idx!.age?.code).toBe("RANGE");
  });
});

describe("default construction", () => {
  it("produces an OK-equivalent zero envelope", () => {
    const e = new Envelope();
    expect(e.status).toBe(0);
    expect(e.transportError).toBe("");
    expect(e.data).toEqual(new Uint8Array());
    expect(e.error).toBeNull();
    expect(e.isOk()).toBe(true);
  });

  it("AppError defaults to empty message, args, details, metadata", () => {
    const ae = new AppError("CODE");
    expect(ae.message).toBe("");
    expect(ae.args).toEqual([]);
    expect(ae.details).toEqual([]);
    expect(ae.metadata).toEqual({});
  });
});
