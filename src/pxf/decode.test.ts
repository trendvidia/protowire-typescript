/**
 * Slice D1+D2+D3+D4 round-trip tests for the schema-bound PXF decoder.
 * Covers plain scalars, enums, nested messages, repeated fields, oneof
 * conflict detection, maps, well-known types (Timestamp, Duration,
 * wrappers), google.protobuf.Any sugar, and the Result-tracking
 * `unmarshalFull` (required/default annotations, `_null` FieldMask).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  type DescMessage,
  type Registry,
  createFileRegistry,
  fromBinary,
} from "@bufbuild/protobuf";
import { FileDescriptorSetSchema } from "@bufbuild/protobuf/wkt";
import { reflect } from "@bufbuild/protobuf/reflect";
import { describe, expect, it } from "vitest";

import { registryAsTypeResolver, unmarshal, unmarshalFull } from "./decode.js";
import { PxfError } from "./errors.js";

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

function getMessage(typeName: string): DescMessage {
  const m = registry.getMessage(typeName);
  if (!m) throw new Error(`missing descriptor for ${typeName}`);
  return m;
}

const AllTypes = getMessage("test.v1.AllTypes");
const Nested = getMessage("test.v1.Nested");

function field(desc: DescMessage, name: string) {
  const f = desc.fields.find((x) => x.name === name);
  if (!f) throw new Error(`no field ${name} on ${desc.typeName}`);
  return f;
}

function get(msg: object, desc: DescMessage, name: string): unknown {
  // If msg is a ReflectMessage (returned from a prior get() on a message field
  // or a list element), unwrap its underlying Message before reflecting again.
  const raw =
    msg && "message" in msg && "desc" in msg
      ? (msg as { message: object }).message
      : msg;
  const v = reflect(desc, raw as never).get(field(desc, name));
  // Auto-unwrap ReflectMessage results so callers can chain get() calls.
  if (v && typeof v === "object" && "message" in v && "desc" in v) {
    return (v as { message: object }).message;
  }
  return v;
}

describe("pxf.unmarshal — scalars", () => {
  it("string field", () => {
    const m = unmarshal(`string_field = "hello world"`, AllTypes);
    expect(get(m, AllTypes, "string_field")).toBe("hello world");
  });

  it("int32 / sint32 / sfixed32 share INT lex token", () => {
    const m = unmarshal(`int32_field = -42`, AllTypes);
    expect(get(m, AllTypes, "int32_field")).toBe(-42);
  });

  it("int64 returns bigint", () => {
    const m = unmarshal(`int64_field = 9007199254740993`, AllTypes);
    expect(get(m, AllTypes, "int64_field")).toBe(9007199254740993n);
  });

  it("uint32", () => {
    const m = unmarshal(`uint32_field = 4294967295`, AllTypes);
    expect(get(m, AllTypes, "uint32_field")).toBe(4294967295);
  });

  it("uint64 returns bigint", () => {
    const m = unmarshal(`uint64_field = 18446744073709551615`, AllTypes);
    expect(get(m, AllTypes, "uint64_field")).toBe(18446744073709551615n);
  });

  it("float field", () => {
    const m = unmarshal(`float_field = 1.5`, AllTypes);
    expect(get(m, AllTypes, "float_field")).toBe(1.5);
  });

  it("double field", () => {
    const m = unmarshal(`double_field = 3.14159265358979`, AllTypes);
    expect(get(m, AllTypes, "double_field")).toBeCloseTo(3.14159265358979, 12);
  });

  it("bool field", () => {
    const m = unmarshal(`bool_field = true`, AllTypes);
    expect(get(m, AllTypes, "bool_field")).toBe(true);
  });

  it("bytes field decodes base64", () => {
    const m = unmarshal(`bytes_field = b"3q2+7w=="`, AllTypes);
    const v = get(m, AllTypes, "bytes_field") as Uint8Array;
    expect([...v]).toEqual([0xde, 0xad, 0xbe, 0xef]);
  });

  it("rejects out-of-range int32", () => {
    expect(() =>
      unmarshal(`int32_field = 99999999999`, AllTypes),
    ).toThrow(PxfError);
  });

  it("rejects type mismatch", () => {
    expect(() => unmarshal(`int32_field = "nope"`, AllTypes)).toThrow(PxfError);
  });
});

describe("pxf.unmarshal — enums", () => {
  it("by name", () => {
    const m = unmarshal(`enum_field = STATUS_ACTIVE`, AllTypes);
    expect(get(m, AllTypes, "enum_field")).toBe(1);
  });

  it("by number", () => {
    const m = unmarshal(`enum_field = 2`, AllTypes);
    expect(get(m, AllTypes, "enum_field")).toBe(2);
  });

  it("rejects unknown enum name", () => {
    expect(() =>
      unmarshal(`enum_field = STATUS_BOGUS`, AllTypes),
    ).toThrow(/unknown enum value/);
  });
});

describe("pxf.unmarshal — nested messages", () => {
  it("block syntax", () => {
    const m = unmarshal(
      `nested_field {
         name = "alice"
         value = 42
       }`,
      AllTypes,
    );
    const sub = get(m, AllTypes, "nested_field") as object;
    expect(get(sub, Nested, "name")).toBe("alice");
    expect(get(sub, Nested, "value")).toBe(42);
  });

  it("assignment + block (= { ... })", () => {
    const m = unmarshal(`nested_field = { name = "bob" value = 7 }`, AllTypes);
    const sub = get(m, AllTypes, "nested_field") as object;
    expect(get(sub, Nested, "name")).toBe("bob");
    expect(get(sub, Nested, "value")).toBe(7);
  });

  it("rejects scalar block on scalar field", () => {
    expect(() => unmarshal(`int32_field { x = 1 }`, AllTypes)).toThrow(
      /not a message type/,
    );
  });
});

describe("pxf.unmarshal — repeated", () => {
  it("repeated string", () => {
    const m = unmarshal(`repeated_string = ["a", "b", "c"]`, AllTypes);
    const list = get(m, AllTypes, "repeated_string") as Iterable<string>;
    expect([...list]).toEqual(["a", "b", "c"]);
  });

  it("repeated string with trailing comma", () => {
    const m = unmarshal(`repeated_string = ["a", "b",]`, AllTypes);
    const list = get(m, AllTypes, "repeated_string") as Iterable<string>;
    expect([...list]).toEqual(["a", "b"]);
  });

  it("repeated nested", () => {
    const m = unmarshal(
      `repeated_nested = [
         { name = "x" value = 1 },
         { name = "y" value = 2 }
       ]`,
      AllTypes,
    );
    const list = [
      ...(get(m, AllTypes, "repeated_nested") as Iterable<object>),
    ];
    expect(list.length).toBe(2);
    expect(get(list[0]!, Nested, "name")).toBe("x");
    expect(get(list[1]!, Nested, "value")).toBe(2);
  });

  it("rejects null in repeated", () => {
    expect(() =>
      unmarshal(`repeated_string = ["a", null]`, AllTypes),
    ).toThrow(/null is not allowed/);
  });

  it("rejects block syntax on repeated", () => {
    expect(() =>
      unmarshal(`repeated_string { x = 1 }`, AllTypes),
    ).toThrow(/list syntax/);
  });
});

describe("pxf.unmarshal — oneof", () => {
  it("single oneof member sets cleanly", () => {
    const m = unmarshal(`text_choice = "x"`, AllTypes);
    expect(get(m, AllTypes, "text_choice")).toBe("x");
  });

  it("conflicting members in same oneof error", () => {
    expect(() =>
      unmarshal(`text_choice = "x"\nnumber_choice = 1`, AllTypes),
    ).toThrow(/oneof "choice".*conflicts/);
  });
});

describe("pxf.unmarshal — unknown fields", () => {
  it("errors by default", () => {
    expect(() =>
      unmarshal(`bogus_field = 1`, AllTypes),
    ).toThrow(/unknown field "bogus_field"/);
  });

  it("discardUnknown skips scalar values", () => {
    const m = unmarshal(`bogus_field = 1\nstring_field = "ok"`, AllTypes, {
      discardUnknown: true,
    });
    expect(get(m, AllTypes, "string_field")).toBe("ok");
  });

  it("discardUnknown skips block values", () => {
    const m = unmarshal(
      `bogus_block { a = 1 b { c = 2 } }\nstring_field = "ok"`,
      AllTypes,
      { discardUnknown: true },
    );
    expect(get(m, AllTypes, "string_field")).toBe("ok");
  });

  it("discardUnknown skips list values", () => {
    const m = unmarshal(
      `bogus_list = [1, 2, 3]\nstring_field = "ok"`,
      AllTypes,
      { discardUnknown: true },
    );
    expect(get(m, AllTypes, "string_field")).toBe("ok");
  });
});

describe("pxf.unmarshal — maps", () => {
  it("map<string,string>", () => {
    const m = unmarshal(
      `string_map = { foo: "bar" baz: "qux" }`,
      AllTypes,
    );
    const map = get(m, AllTypes, "string_map") as ReadonlyMap<string, string>;
    expect(map.get("foo")).toBe("bar");
    expect(map.get("baz")).toBe("qux");
  });

  it("map<int32,string> with integer keys", () => {
    const m = unmarshal(
      `int_map = { 1: "one" 2: "two" }`,
      AllTypes,
    );
    const map = get(m, AllTypes, "int_map") as ReadonlyMap<number, string>;
    expect(map.get(1)).toBe("one");
    expect(map.get(2)).toBe("two");
  });

  it("map<string,Nested> with message values", () => {
    const m = unmarshal(
      `nested_map = {
         alpha: { name = "a" value = 1 }
         beta: { name = "b" value = 2 }
       }`,
      AllTypes,
    );
    const map = get(m, AllTypes, "nested_map") as ReadonlyMap<string, object>;
    const a = map.get("alpha") as { message: object };
    expect(get(a.message, Nested, "name")).toBe("a");
    expect(get(a.message, Nested, "value")).toBe(1);
    const b = map.get("beta") as { message: object };
    expect(get(b.message, Nested, "value")).toBe(2);
  });

  it("string keys via STRING token", () => {
    const m = unmarshal(
      `string_map = { "with space": "value" }`,
      AllTypes,
    );
    const map = get(m, AllTypes, "string_map") as ReadonlyMap<string, string>;
    expect(map.get("with space")).toBe("value");
  });

  it("rejects '=' inside map", () => {
    expect(() =>
      unmarshal(`string_map = { foo = "bar" }`, AllTypes),
    ).toThrow(/use ':' for map entries/);
  });

  it("rejects null map value", () => {
    expect(() =>
      unmarshal(`string_map = { foo: null }`, AllTypes),
    ).toThrow(/null is not allowed as map value/);
  });

  it("rejects invalid int32 map key", () => {
    expect(() =>
      unmarshal(`int_map = { not_a_number: "x" }`, AllTypes),
    ).toThrow(/invalid int32 map key/);
  });

  it("empty map block", () => {
    const m = unmarshal(`string_map = { }`, AllTypes);
    const map = get(m, AllTypes, "string_map") as ReadonlyMap<string, string>;
    expect(map.size).toBe(0);
  });
});

describe("pxf.unmarshal — well-known Timestamp / Duration", () => {
  it("Timestamp with second precision", () => {
    const m = unmarshal(`ts_field = 2024-01-01T12:00:00Z`, AllTypes);
    const ts = get(m, AllTypes, "ts_field") as {
      seconds: bigint;
      nanos: number;
    };
    expect(ts.seconds).toBe(1704110400n);
    expect(ts.nanos).toBe(0);
  });

  it("Timestamp with fractional nanoseconds", () => {
    const m = unmarshal(
      `ts_field = 1970-01-01T00:00:00.123456789Z`,
      AllTypes,
    );
    const ts = get(m, AllTypes, "ts_field") as {
      seconds: bigint;
      nanos: number;
    };
    expect(ts.seconds).toBe(0n);
    expect(ts.nanos).toBe(123456789);
  });

  it("Duration with hours + minutes", () => {
    const m = unmarshal(`dur_field = 1h30m`, AllTypes);
    const d = get(m, AllTypes, "dur_field") as {
      seconds: bigint;
      nanos: number;
    };
    expect(d.seconds).toBe(5400n);
    expect(d.nanos).toBe(0);
  });

  it("Duration with sub-second precision via ms", () => {
    const m = unmarshal(`dur_field = 1500ms`, AllTypes);
    const d = get(m, AllTypes, "dur_field") as {
      seconds: bigint;
      nanos: number;
    };
    expect(d.seconds).toBe(1n);
    expect(d.nanos).toBe(500_000_000);
  });

  it("negative Duration carries sign on both fields", () => {
    const m = unmarshal(`dur_field = -2500ms`, AllTypes);
    const d = get(m, AllTypes, "dur_field") as {
      seconds: bigint;
      nanos: number;
    };
    expect(d.seconds).toBe(-2n);
    expect(d.nanos).toBe(-500_000_000);
  });

  it("Timestamp block syntax still works as fallback", () => {
    const m = unmarshal(
      `ts_field { seconds = 100 nanos = 250 }`,
      AllTypes,
    );
    const ts = get(m, AllTypes, "ts_field") as {
      seconds: bigint;
      nanos: number;
    };
    expect(ts.seconds).toBe(100n);
    expect(ts.nanos).toBe(250);
  });
});

describe("pxf.unmarshal — wrapper types", () => {
  it("StringValue takes a bare string", () => {
    const m = unmarshal(`nullable_string = "hello"`, AllTypes);
    const w = get(m, AllTypes, "nullable_string") as { value: string };
    expect(w.value).toBe("hello");
  });

  it("Int32Value takes a bare integer", () => {
    const m = unmarshal(`nullable_int = 42`, AllTypes);
    const w = get(m, AllTypes, "nullable_int") as { value: number };
    expect(w.value).toBe(42);
  });

  it("BoolValue takes a bare bool", () => {
    const m = unmarshal(`nullable_bool = true`, AllTypes);
    const w = get(m, AllTypes, "nullable_bool") as { value: boolean };
    expect(w.value).toBe(true);
  });

  it("wrapper block syntax also works", () => {
    const m = unmarshal(
      `nullable_string { value = "explicit" }`,
      AllTypes,
    );
    const w = get(m, AllTypes, "nullable_string") as { value: string };
    expect(w.value).toBe("explicit");
  });
});

describe("pxf.unmarshal — google.protobuf.Any", () => {
  const Container = anyRegistry.getMessage("any_test.v1.Container");
  const Detail = anyRegistry.getMessage("any_test.v1.Detail");
  if (!Container || !Detail) throw new Error("missing any-test descriptors");
  const resolver = registryAsTypeResolver(anyRegistry);

  it("decodes block syntax via @type lookup", () => {
    const m = unmarshal(
      `name = "test"
       payload {
         @type = "any_test.v1.Detail"
         code = 42
         reason = "not found"
       }`,
      Container,
      { typeResolver: resolver },
    );
    expect(get(m, Container, "name")).toBe("test");
    const payload = get(m, Container, "payload") as {
      typeUrl: string;
      value: Uint8Array;
    };
    expect(payload.typeUrl).toBe("any_test.v1.Detail");

    const inner = fromBinary(Detail, payload.value);
    const innerRefl = reflect(Detail, inner);
    expect(innerRefl.get(Detail.fields.find((f) => f.name === "code")!)).toBe(42);
    expect(
      innerRefl.get(Detail.fields.find((f) => f.name === "reason")!),
    ).toBe("not found");
  });

  it("decodes assignment syntax via @type lookup", () => {
    const m = unmarshal(
      `payload = { @type = "any_test.v1.Detail" code = 7 }`,
      Container,
      { typeResolver: resolver },
    );
    const payload = get(m, Container, "payload") as {
      typeUrl: string;
      value: Uint8Array;
    };
    expect(payload.typeUrl).toBe("any_test.v1.Detail");
    const inner = fromBinary(Detail, payload.value);
    expect(
      reflect(Detail, inner).get(Detail.fields.find((f) => f.name === "code")!),
    ).toBe(7);
  });

  it("strips type.googleapis.com/ prefix when looking up", () => {
    const m = unmarshal(
      `payload { @type = "type.googleapis.com/any_test.v1.Detail" code = 9 }`,
      Container,
      { typeResolver: resolver },
    );
    const payload = get(m, Container, "payload") as {
      typeUrl: string;
      value: Uint8Array;
    };
    expect(payload.typeUrl).toBe("type.googleapis.com/any_test.v1.Detail");
    const inner = fromBinary(Detail, payload.value);
    expect(
      reflect(Detail, inner).get(Detail.fields.find((f) => f.name === "code")!),
    ).toBe(9);
  });

  it("errors on unresolvable @type when resolver is set", () => {
    expect(() =>
      unmarshal(
        `payload { @type = "any_test.v1.Missing" code = 1 }`,
        Container,
        { typeResolver: resolver },
      ),
    ).toThrow(/cannot resolve Any type/);
  });

  it("without resolver, decodes Any as a plain message via type_url/value", () => {
    const m = unmarshal(
      `payload { type_url = "any_test.v1.Detail" value = b"" }`,
      Container,
    );
    const payload = get(m, Container, "payload") as {
      typeUrl: string;
      value: Uint8Array;
    };
    expect(payload.typeUrl).toBe("any_test.v1.Detail");
    expect(payload.value.length).toBe(0);
  });
});

describe("pxf.unmarshal — empty / @type", () => {
  it("empty input yields empty message", () => {
    const m = unmarshal(``, AllTypes);
    expect(get(m, AllTypes, "string_field")).toBe("");
  });

  it("leading @type is consumed", () => {
    const m = unmarshal(
      `@type test.v1.AllTypes\nstring_field = "yes"`,
      AllTypes,
    );
    expect(get(m, AllTypes, "string_field")).toBe("yes");
  });
});

describe("pxf.unmarshalFull — Result presence tracking", () => {
  it("marks set, null, and absent fields", () => {
    const { result } = unmarshalFull(
      `string_field = "hi"\nnullable_int = null`,
      AllTypes,
    );
    expect(result.isSet("string_field")).toBe(true);
    expect(result.isNull("string_field")).toBe(false);
    expect(result.isNull("nullable_int")).toBe(true);
    expect(result.isAbsent("int32_field")).toBe(true);
  });

  it("tracks dotted paths into nested messages", () => {
    const { result } = unmarshalFull(
      `nested_field { name = "alice" }`,
      AllTypes,
    );
    expect(result.isSet("nested_field")).toBe(true);
    expect(result.isSet("nested_field.name")).toBe(true);
    expect(result.isAbsent("nested_field.value")).toBe(true);
  });
});

describe("pxf.unmarshalFull — pxf.required annotation", () => {
  const WithRequired = d4Registry.getMessage("d4_test.v1.WithRequired");
  if (!WithRequired) throw new Error("missing WithRequired descriptor");

  it("errors when required field is absent", () => {
    expect(() => unmarshalFull(`value = 1`, WithRequired)).toThrow(
      /required field "name" is absent/,
    );
  });

  it("passes when required field is set", () => {
    const { message } = unmarshalFull(`name = "ok"`, WithRequired);
    expect(get(message, WithRequired, "name")).toBe("ok");
  });

  it("treats null as present (does not trigger required error)", () => {
    const { result } = unmarshalFull(`name = null`, WithRequired);
    expect(result.isNull("name")).toBe(true);
    expect(result.isAbsent("name")).toBe(false);
  });
});

describe("pxf.unmarshalFull — pxf.default annotation", () => {
  const WithDefault = d4Registry.getMessage("d4_test.v1.WithDefault");
  const Outer = d4Registry.getMessage("d4_test.v1.Outer");
  const Inner = d4Registry.getMessage("d4_test.v1.Inner");
  if (!WithDefault || !Outer || !Inner) throw new Error("missing D4 descriptors");

  it("applies string default when field is absent", () => {
    const { message } = unmarshalFull(`count = 9`, WithDefault);
    expect(get(message, WithDefault, "name")).toBe("anonymous");
    expect(get(message, WithDefault, "count")).toBe(9);
  });

  it("applies int default when field is absent", () => {
    const { message } = unmarshalFull(`name = "x"`, WithDefault);
    expect(get(message, WithDefault, "count")).toBe(5);
  });

  it("applies bool default when field is absent", () => {
    const { message } = unmarshalFull(``, WithDefault);
    expect(get(message, WithDefault, "active")).toBe(true);
  });

  it("does NOT apply default when field is null", () => {
    const { message, result } = unmarshalFull(`name = null`, WithDefault);
    expect(result.isNull("name")).toBe(true);
    expect(get(message, WithDefault, "name")).toBe("");
  });

  it("does not apply default when field is set explicitly", () => {
    const { message } = unmarshalFull(`name = "explicit"`, WithDefault);
    expect(get(message, WithDefault, "name")).toBe("explicit");
  });

  it("recurses into nested messages to apply defaults", () => {
    const { message } = unmarshalFull(`inner { num = 7 }`, Outer);
    const inner = get(message, Outer, "inner") as object;
    expect(get(inner, Inner, "label")).toBe("fallback");
    expect(get(inner, Inner, "num")).toBe(7);
  });
});

describe("pxf.unmarshalFull — _null FieldMask", () => {
  const WithNullMask = d4Registry.getMessage("d4_test.v1.WithNullMask");
  if (!WithNullMask) throw new Error("missing WithNullMask descriptor");

  it("appends paths of null-set fields to _null.paths", () => {
    const { message, result } = unmarshalFull(
      `name = "alice"\nvalue = null`,
      WithNullMask,
    );
    expect(result.isNull("value")).toBe(true);
    const nullField = get(message, WithNullMask, "_null") as {
      paths: string[];
    };
    expect(nullField.paths).toEqual(["value"]);
  });

  it("leaves _null untouched when no field is null", () => {
    const { message } = unmarshalFull(
      `name = "ok"\nvalue = 1`,
      WithNullMask,
    );
    const nullField = get(message, WithNullMask, "_null") as {
      paths: string[];
    };
    // FieldMask was never mutated; either undefined or empty paths is fine.
    expect(nullField?.paths ?? []).toEqual([]);
  });
});
