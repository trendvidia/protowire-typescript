/**
 * Slice E tests for the schema-bound PXF encoder.
 * Covers scalars, enums, nested messages, repeated lists, sorted maps,
 * WKT shortcuts (Timestamp, Duration, wrappers), Any sugar via a resolver,
 * `_null` FieldMask emission, and a round-trip property: decode→encode→decode
 * preserves the message.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  type DescMessage,
  type Registry,
  create,
  createFileRegistry,
  fromBinary,
  toBinary,
} from "@bufbuild/protobuf";
import { FileDescriptorSetSchema } from "@bufbuild/protobuf/wkt";
import { reflect } from "@bufbuild/protobuf/reflect";
import { describe, expect, it } from "vitest";

import {
  registryAsTypeResolver,
  unmarshal,
  unmarshalFull,
} from "./decode.js";
import { marshal } from "./encode.js";
import { Result } from "./result.js";

const here = dirname(fileURLToPath(import.meta.url));
const fdsBytes = readFileSync(resolve(here, "testdata/test.binpb"));
const registry: Registry = createFileRegistry(
  fromBinary(FileDescriptorSetSchema, new Uint8Array(fdsBytes)),
);
const anyFdsBytes = readFileSync(resolve(here, "testdata/any-test.binpb"));
const anyRegistry: Registry = createFileRegistry(
  fromBinary(FileDescriptorSetSchema, new Uint8Array(anyFdsBytes)),
);
const d4FdsBytes = readFileSync(resolve(here, "testdata/d4-test.binpb"));
const d4Registry: Registry = createFileRegistry(
  fromBinary(FileDescriptorSetSchema, new Uint8Array(d4FdsBytes)),
);

function getMessage(reg: Registry, name: string): DescMessage {
  const m = reg.getMessage(name);
  if (!m) throw new Error(`missing descriptor for ${name}`);
  return m;
}

const AllTypes = getMessage(registry, "test.v1.AllTypes");

describe("pxf.marshal — scalars", () => {
  it("emits set string and skips proto3 zero scalars", () => {
    const m = unmarshal(`string_field = "hello"`, AllTypes);
    const out = marshal(m, AllTypes);
    expect(out).toBe(`string_field = "hello"\n`);
  });

  it("emits zero scalars when emitDefaults is set", () => {
    const m = unmarshal(``, AllTypes);
    const out = marshal(m, AllTypes, { emitDefaults: true });
    expect(out).toContain(`string_field = ""`);
    expect(out).toContain(`int32_field = 0`);
    expect(out).toContain(`bool_field = false`);
  });

  it("escapes control chars and quotes in strings", () => {
    const m = unmarshal(`string_field = "a\\nb\\"c"`, AllTypes);
    const out = marshal(m, AllTypes);
    expect(out).toBe(`string_field = "a\\nb\\"c"\n`);
  });

  it("encodes bytes as base64", () => {
    const m = unmarshal(`bytes_field = b"3q2+7w=="`, AllTypes);
    const out = marshal(m, AllTypes);
    expect(out).toBe(`bytes_field = b"3q2+7w=="\n`);
  });
});

describe("pxf.marshal — enums and oneofs", () => {
  it("emits enum by name when known", () => {
    const m = unmarshal(`enum_field = STATUS_ACTIVE`, AllTypes);
    expect(marshal(m, AllTypes)).toBe(`enum_field = STATUS_ACTIVE\n`);
  });

  it("emits selected oneof member only", () => {
    const m = unmarshal(`text_choice = "x"`, AllTypes);
    const out = marshal(m, AllTypes);
    expect(out).toContain(`text_choice = "x"`);
    expect(out).not.toContain("number_choice");
  });
});

describe("pxf.marshal — messages and repeated", () => {
  it("emits nested message in block syntax", () => {
    const m = unmarshal(
      `nested_field { name = "alice" value = 7 }`,
      AllTypes,
    );
    const out = marshal(m, AllTypes);
    expect(out).toBe(
      `nested_field {\n  name = "alice"\n  value = 7\n}\n`,
    );
  });

  it("emits repeated scalar list", () => {
    const m = unmarshal(`repeated_string = ["a", "b", "c"]`, AllTypes);
    const out = marshal(m, AllTypes);
    expect(out).toBe(
      `repeated_string = [\n  "a",\n  "b",\n  "c"\n]\n`,
    );
  });

  it("emits repeated message list with block elements", () => {
    const m = unmarshal(
      `repeated_nested = [
         { name = "x" value = 1 },
         { name = "y" value = 2 }
       ]`,
      AllTypes,
    );
    const out = marshal(m, AllTypes);
    expect(out).toBe(
      `repeated_nested = [\n` +
        `  {\n    name = "x"\n    value = 1\n  },\n` +
        `  {\n    name = "y"\n    value = 2\n  }\n` +
        `]\n`,
    );
  });
});

describe("pxf.marshal — maps", () => {
  it("emits map<string,string> sorted by key", () => {
    const m = unmarshal(
      `string_map = { foo: "1" bar: "2" zed: "3" }`,
      AllTypes,
    );
    const out = marshal(m, AllTypes);
    expect(out).toBe(
      `string_map = {\n  bar: "2"\n  foo: "1"\n  zed: "3"\n}\n`,
    );
  });

  it("emits map<int32,string> sorted by stringified key", () => {
    const m = unmarshal(`int_map = { 10: "ten" 2: "two" }`, AllTypes);
    const out = marshal(m, AllTypes);
    // Lexicographic on numeric keys (Go does the same).
    expect(out).toBe(
      `int_map = {\n  10: "ten"\n  2: "two"\n}\n`,
    );
  });

  it("quotes non-identifier string keys", () => {
    const m = unmarshal(
      `string_map = { "with space": "v" }`,
      AllTypes,
    );
    const out = marshal(m, AllTypes);
    expect(out).toBe(
      `string_map = {\n  "with space": "v"\n}\n`,
    );
  });

  it("emits message-valued map entries as blocks", () => {
    const m = unmarshal(
      `nested_map = { a: { name = "alice" value = 1 } }`,
      AllTypes,
    );
    const out = marshal(m, AllTypes);
    expect(out).toBe(
      `nested_map = {\n  a: {\n    name = "alice"\n    value = 1\n  }\n}\n`,
    );
  });
});

describe("pxf.marshal — well-known types", () => {
  it("Timestamp without fractional seconds", () => {
    const m = unmarshal(`ts_field = 2024-01-01T12:00:00Z`, AllTypes);
    expect(marshal(m, AllTypes)).toBe(
      `ts_field = 2024-01-01T12:00:00Z\n`,
    );
  });

  it("Timestamp with nanoseconds prints trimmed fraction", () => {
    const m = unmarshal(
      `ts_field = 1970-01-01T00:00:00.123456789Z`,
      AllTypes,
    );
    expect(marshal(m, AllTypes)).toBe(
      `ts_field = 1970-01-01T00:00:00.123456789Z\n`,
    );
  });

  it("Duration: hour + minute composition", () => {
    const m = unmarshal(`dur_field = 1h30m`, AllTypes);
    expect(marshal(m, AllTypes)).toBe(`dur_field = 1h30m0s\n`);
  });

  it("Duration: sub-millisecond uses µs", () => {
    // 1 second + 500 nanos = 1.0000005s. Just exercise the µs path with a
    // pure-µs value: 500 µs = 500_000 nanos.
    const m = unmarshal(`dur_field = 500us`, AllTypes);
    expect(marshal(m, AllTypes)).toBe(`dur_field = 500µs\n`);
  });

  it("Duration: explicit zero prints 0s", () => {
    // An explicitly-set zero Duration (vs. an unset one) round-trips as 0s.
    const m = unmarshal(`dur_field = 0s`, AllTypes);
    expect(marshal(m, AllTypes)).toBe(`dur_field = 0s\n`);
  });

  it("StringValue wrapper emits as bare scalar", () => {
    const m = unmarshal(`nullable_string = "hi"`, AllTypes);
    expect(marshal(m, AllTypes)).toBe(`nullable_string = "hi"\n`);
  });

  it("Int32Value wrapper emits as bare integer", () => {
    const m = unmarshal(`nullable_int = 7`, AllTypes);
    expect(marshal(m, AllTypes)).toBe(`nullable_int = 7\n`);
  });
});

describe("pxf.marshal — Any sugar", () => {
  const Container = getMessage(anyRegistry, "any_test.v1.Container");
  const Detail = getMessage(anyRegistry, "any_test.v1.Detail");
  const resolver = registryAsTypeResolver(anyRegistry);

  it("emits @type + inline fields when resolver finds the URL", () => {
    const detail = create(Detail);
    const dr = reflect(Detail, detail);
    dr.set(Detail.fields.find((f) => f.name === "code")!, 42);
    dr.set(Detail.fields.find((f) => f.name === "reason")!, "boom");
    const packed = toBinary(Detail, detail);

    const container = create(Container);
    const cr = reflect(Container, container);
    cr.set(Container.fields.find((f) => f.name === "name")!, "test");
    const anyFd = Container.fields.find((f) => f.name === "payload")!;
    if (anyFd.fieldKind !== "message") throw new Error("expected message");
    const anyMsg = create(anyFd.message);
    const ar = reflect(anyFd.message, anyMsg);
    ar.set(anyFd.message.fields.find((f) => f.name === "type_url")!, "any_test.v1.Detail");
    ar.set(anyFd.message.fields.find((f) => f.name === "value")!, packed);
    cr.set(anyFd, ar);

    const out = marshal(container, Container, { typeResolver: resolver });
    expect(out).toContain(`payload {`);
    expect(out).toContain(`@type = "any_test.v1.Detail"`);
    expect(out).toContain(`code = 42`);
    expect(out).toContain(`reason = "boom"`);
  });

  it("falls back to plain block when no resolver supplied", () => {
    const container = create(Container);
    const cr = reflect(Container, container);
    const anyFd = Container.fields.find((f) => f.name === "payload")!;
    if (anyFd.fieldKind !== "message") throw new Error("expected message");
    const anyMsg = create(anyFd.message);
    const ar = reflect(anyFd.message, anyMsg);
    ar.set(anyFd.message.fields.find((f) => f.name === "type_url")!, "any_test.v1.Detail");
    ar.set(anyFd.message.fields.find((f) => f.name === "value")!, new Uint8Array([1, 2, 3]));
    cr.set(anyFd, ar);

    const out = marshal(container, Container);
    expect(out).toContain(`type_url = "any_test.v1.Detail"`);
    expect(out).toContain(`value = b"`);
  });
});

describe("pxf.marshal — null emission", () => {
  const WithNullMask = getMessage(d4Registry, "d4_test.v1.WithNullMask");

  it("reads null paths from the in-message _null FieldMask", () => {
    const { message } = unmarshalFull(
      `name = "n"\nvalue = null`,
      WithNullMask,
    );
    const out = marshal(message, WithNullMask);
    expect(out).toContain(`value = null`);
    expect(out).not.toContain(`_null`);
  });

  it("uses MarshalOptions.nullFields when no _null mask is present", () => {
    const m = unmarshal(`string_field = "x"`, AllTypes);
    const r = new Result();
    r.markNull("nullable_string");
    const out = marshal(m, AllTypes, { nullFields: r });
    expect(out).toContain(`nullable_string = null`);
  });
});

describe("pxf.marshal — typeURL prefix", () => {
  it("prepends @type and a blank line when typeURL is set", () => {
    const m = unmarshal(`int32_field = 1`, AllTypes);
    const out = marshal(m, AllTypes, { typeURL: "test.v1.AllTypes" });
    expect(out.startsWith("@type test.v1.AllTypes\n\n")).toBe(true);
  });
});

describe("pxf.marshal — round-trip", () => {
  it("decode → encode → decode preserves a representative message", () => {
    const input = `string_field = "hello"
int32_field = -7
int64_field = 9007199254740993
uint32_field = 100
float_field = 1.5
bool_field = true
bytes_field = b"3q2+7w=="
enum_field = STATUS_ACTIVE
nested_field { name = "n" value = 3 }
repeated_string = ["a", "b"]
string_map = { foo: "1" }
ts_field = 2024-01-01T12:00:00Z
dur_field = 5s
nullable_string = "hi"
text_choice = "pick"
`;
    const m1 = unmarshal(input, AllTypes);
    const text = marshal(m1, AllTypes);
    const m2 = unmarshal(text, AllTypes);
    // Compare via wire-level binary equivalence (doesn't depend on field order).
    expect(toBinary(AllTypes, m2)).toEqual(toBinary(AllTypes, m1));
  });
});
