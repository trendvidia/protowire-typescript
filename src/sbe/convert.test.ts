// SPDX-License-Identifier: MIT
// Copyright (c) 2026 TrendVidia, LLC.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { type DescFile, createFileRegistry, fromBinary } from "@bufbuild/protobuf";
import { type ReflectMessage, reflect } from "@bufbuild/protobuf/reflect";
import { FileDescriptorSetSchema } from "@bufbuild/protobuf/wkt";
import { describe, expect, it } from "vitest";

import {
  Codec,
  camelToScreamingSnake,
  camelToSnake,
  parseXMLSchema,
  protoToXml,
  screamingSnakeToPascal,
  singularPascal,
  snakeToCamel,
  stripEnumPrefix,
  marshal,
  unmarshal,
  xmlToProto,
} from "./index.js";

const here = dirname(fileURLToPath(import.meta.url));
const fdsBytes = readFileSync(resolve(here, "testdata/sbe-test.binpb"));
const registry = createFileRegistry(
  fromBinary(FileDescriptorSetSchema, new Uint8Array(fdsBytes)),
);
const file = registry.getFile("sbe-test.proto")!;

const TEST_XML = `<?xml version="1.0" encoding="UTF-8"?>
<sbe:messageSchema xmlns:sbe="http://fixprotocol.io/2016/sbe"
                   package="test.v1"
                   id="1"
                   version="0"
                   byteOrder="littleEndian">
    <types>
        <composite name="messageHeader">
            <type name="blockLength" primitiveType="uint16"/>
            <type name="templateId" primitiveType="uint16"/>
            <type name="schemaId" primitiveType="uint16"/>
            <type name="version" primitiveType="uint16"/>
        </composite>
        <composite name="groupSizeEncoding">
            <type name="blockLength" primitiveType="uint16"/>
            <type name="numInGroup" primitiveType="uint16"/>
        </composite>
        <enum name="Side" encodingType="uint8">
            <validValue name="Buy">0</validValue>
            <validValue name="Sell">1</validValue>
        </enum>
        <type name="str8" primitiveType="char" length="8"/>
        <composite name="Inner">
            <type name="x" primitiveType="int64"/>
            <type name="y" primitiveType="int64"/>
        </composite>
    </types>
    <sbe:message name="Order" id="1">
        <field name="orderId" id="1" type="uint64"/>
        <field name="symbol" id="2" type="str8"/>
        <field name="price" id="3" type="int64"/>
        <field name="quantity" id="4" type="uint32"/>
        <field name="side" id="5" type="Side"/>
        <field name="active" id="6" type="uint8"/>
        <field name="weight" id="7" type="double"/>
        <field name="score" id="8" type="float"/>
        <group name="fills" id="9">
            <field name="fillPrice" id="1" type="int64"/>
            <field name="fillQty" id="2" type="uint32"/>
            <field name="fillId" id="3" type="uint64"/>
        </group>
    </sbe:message>
    <sbe:message name="Simple" id="2">
        <field name="id" id="1" type="uint32"/>
        <field name="value" id="2" type="int32"/>
    </sbe:message>
    <sbe:message name="WithComposite" id="3">
        <field name="id" id="1" type="uint64"/>
        <field name="inner" id="2" type="Inner"/>
        <field name="code" id="3" type="int32"/>
    </sbe:message>
    <sbe:message name="WithNarrow" id="4">
        <field name="status" id="1" type="uint8"/>
        <field name="port" id="2" type="uint16"/>
        <field name="delta" id="3" type="int16"/>
    </sbe:message>
</sbe:messageSchema>`;

describe("parseXMLSchema", () => {
  it("parses package, id, version, types, and messages", () => {
    const schema = parseXMLSchema(TEST_XML);
    expect(schema.package).toBe("test.v1");
    expect(schema.id).toBe(1);
    expect(schema.version).toBe(0);
    expect(schema.types.enums).toHaveLength(1);
    expect(schema.types.enums[0]!.name).toBe("Side");
    expect(schema.types.enums[0]!.validValues).toEqual([
      { name: "Buy", value: "0" },
      { name: "Sell", value: "1" },
    ]);
    expect(schema.messages).toHaveLength(4);

    const order = schema.messages.find((m) => m.name === "Order")!;
    expect(order.id).toBe(1);
    expect(order.fields).toHaveLength(8);
    expect(order.groups).toHaveLength(1);
    expect(order.groups[0]!.name).toBe("fills");
  });

  it("parses XML without namespace prefix", () => {
    const xml = TEST_XML.replaceAll("sbe:message", "message").replaceAll(
      "sbe:messageSchema",
      "messageSchema",
    );
    const schema = parseXMLSchema(xml);
    expect(schema.package).toBe("test.v1");
    expect(schema.messages).toHaveLength(4);
  });
});

describe("xmlToProto", () => {
  it("emits expected proto fragments", () => {
    const proto = xmlToProto(TEST_XML);
    expect(proto).toContain(`option (sbe.schema_id) = 1;`);
    expect(proto).toContain(`option (sbe.version) = 0;`);
    expect(proto).toContain(`option (sbe.template_id) = 1;`);
    expect(proto).toContain(`string symbol = 2 [(sbe.length) = 8];`);
    expect(proto).toContain(`Side side = 5;`);
    expect(proto).toContain(`Inner inner = 2;`);
    expect(proto).toContain(`repeated Fill fills = 9;`);
    expect(proto).toContain(`(sbe.encoding) = "uint8"`);
  });

  it("converts camelCase XML field names to snake_case proto names", () => {
    const proto = xmlToProto(TEST_XML);
    expect(proto).toContain(`uint64 order_id = 1;`);
    expect(proto).toContain(`int64 fill_price = 1;`);
    expect(proto).toContain(`uint32 fill_qty = 2;`);
  });

  it("singularizes group names → message Pascal name", () => {
    const proto = xmlToProto(TEST_XML);
    expect(proto).toContain(`message Fill {`);
    expect(proto).toContain(`repeated Fill fills = 9;`);
  });

  it("re-prefixes enum value names with screaming-snake enum prefix", () => {
    const proto = xmlToProto(TEST_XML);
    expect(proto).toContain("SIDE_BUY = 0;");
    expect(proto).toContain("SIDE_SELL = 1;");
  });
});

describe("protoToXml", () => {
  it("emits a schema header and message sections", () => {
    const xml = protoToXml(file);
    expect(xml).toContain(`package="test.v1"`);
    expect(xml).toContain(`id="1"`);
    expect(xml).toContain(`<sbe:message name="Order" id="1">`);
    expect(xml).toContain(`<sbe:message name="Simple" id="2">`);
    expect(xml).toContain(`<enum name="Side"`);
    expect(xml).toContain(`<composite name="Inner">`);
    expect(xml).toContain(`<group name="fills"`);
  });

  it("strips proto enum prefix from validValue names", () => {
    const xml = protoToXml(file);
    expect(xml).toContain(`<validValue name="Buy">0</validValue>`);
    expect(xml).toContain(`<validValue name="Sell">1</validValue>`);
  });

  it("output round-trips back through parseXMLSchema", () => {
    const xml = protoToXml(file);
    const schema = parseXMLSchema(xml);
    expect(schema.package).toBe("test.v1");
    expect(schema.id).toBe(1);
    expect(schema.messages).toHaveLength(5);
    const order = schema.messages.find((m) => m.name === "Order")!;
    expect(order.id).toBe(1);
    expect(order.groups).toHaveLength(1);
    expect(order.groups[0]!.name).toBe("fills");
  });

  it("output also round-trips through xmlToProto and back", () => {
    const xmlA = protoToXml(file);
    const protoSrc = xmlToProto(xmlA);
    // The regenerated proto contains the same SBE schema/template IDs.
    expect(protoSrc).toContain(`option (sbe.schema_id) = 1;`);
    expect(protoSrc).toContain(`option (sbe.template_id) = 1;`); // Order
    expect(protoSrc).toContain(`option (sbe.template_id) = 2;`); // Simple
    expect(protoSrc).toContain(`option (sbe.template_id) = 3;`); // WithComposite
    expect(protoSrc).toContain(`option (sbe.template_id) = 4;`); // WithNarrow
  });
});

describe("name conversions", () => {
  it("camelToSnake handles examples from the Go suite", () => {
    expect(camelToSnake("orderId")).toBe("order_id");
    expect(camelToSnake("fillPrice")).toBe("fill_price");
    expect(camelToSnake("id")).toBe("id");
    expect(camelToSnake("x")).toBe("x");
    expect(camelToSnake("orderID")).toBe("order_id");
  });

  it("snakeToCamel handles examples from the Go suite", () => {
    expect(snakeToCamel("order_id")).toBe("orderId");
    expect(snakeToCamel("fill_price")).toBe("fillPrice");
    expect(snakeToCamel("id")).toBe("id");
  });

  it("camelToScreamingSnake adds underscores at lower→upper boundaries", () => {
    expect(camelToScreamingSnake("Side")).toBe("SIDE");
    expect(camelToScreamingSnake("OrderType")).toBe("ORDER_TYPE");
  });

  it("screamingSnakeToPascal collapses underscores", () => {
    expect(screamingSnakeToPascal("BUY")).toBe("Buy");
    expect(screamingSnakeToPascal("ORDER_TYPE")).toBe("OrderType");
  });

  it("stripEnumPrefix peels the SCREAMING_SNAKE prefix", () => {
    expect(stripEnumPrefix("SIDE_BUY", "Side")).toBe("Buy");
    expect(stripEnumPrefix("SIDE_SELL", "Side")).toBe("Sell");
    expect(stripEnumPrefix("OTHER", "Side")).toBe("Other");
  });

  it("singularPascal handles common plural endings", () => {
    expect(singularPascal("fills")).toBe("Fill");
    expect(singularPascal("orders")).toBe("Order");
    expect(singularPascal("entries")).toBe("Entry");
    expect(singularPascal("class")).toBe("Class");
  });
});

describe("xmlToProto and characterEncoding (#100)", () => {
  const xml = (enc: string) => `<?xml version="1.0" encoding="UTF-8"?>
<sbe:messageSchema xmlns:sbe="http://fixprotocol.io/2016/sbe" package="enc.v1" id="7" version="0">
  <types>
    <type name="text" primitiveType="char" length="8"${enc}/>
    <composite name="Pair">
      <type name="inner" primitiveType="char" length="4"${enc}/>
    </composite>
  </types>
  <sbe:message name="Note" id="1">
    <field name="body" id="1" type="text"/>
    <field name="pair" id="2" type="Pair"/>
  </sbe:message>
</sbe:messageSchema>`;

  it.each([
    ["absent", ""],
    ["ASCII", ' characterEncoding="ASCII"'],
    ["US-ASCII", ' characterEncoding="US-ASCII"'],
    ["UTF-8", ' characterEncoding="UTF-8"'],
    ["utf_8, punctuation and case ignored", ' characterEncoding="utf_8"'],
  ])("%s is a string", (_, enc) => {
    const proto = xmlToProto(xml(enc));
    expect(proto).toContain("string body = 1 [(sbe.length) = 8];");
    expect(proto).toContain("string inner = 1 [(sbe.length) = 4];");
  });

  it("ISO-8859-1 is bytes, inside a composite too, with a note", () => {
    const proto = xmlToProto(xml(' characterEncoding="ISO-8859-1"'));
    expect(proto).toContain("bytes body = 1 [(sbe.length) = 8];");
    expect(proto).toContain("bytes inner = 1 [(sbe.length) = 4];");
    expect(proto).toContain('// SBE characterEncoding "ISO-8859-1" is not UTF-8 compatible, so this field is bytes.');
  });
});

// fixedArraySchema has the two fixed-length arrays that are not text: a char
// in a non-UTF-8 encoding and a uint8 array, each followed by a field whose
// offset moves if the array's length is lost (#102). It is protowire-go's
// schema of the same name.
const fixedArraySchema = `<?xml version="1.0" encoding="UTF-8"?>
<sbe:messageSchema xmlns:sbe="http://fixprotocol.io/2016/sbe"
                   package="arr.v1" id="3" version="0" byteOrder="littleEndian">
    <types>
        <type name="Latin1" primitiveType="char" length="4" characterEncoding="ISO-8859-1"/>
        <type name="Uuid" primitiveType="uint8" length="16"/>
        <type name="Signed" primitiveType="int8" length="3"/>
        <composite name="Key">
            <type name="raw" primitiveType="uint8" length="6"/>
            <type name="seq" primitiveType="uint32"/>
        </composite>
    </types>
    <sbe:message name="Record" id="1">
        <field name="name" id="1" type="Latin1"/>
        <field name="uuid" id="2" type="Uuid"/>
        <field name="signed" id="3" type="Signed"/>
        <field name="key" id="4" type="Key"/>
        <field name="tail" id="5" type="uint32"/>
    </sbe:message>
</sbe:messageSchema>`;

/** A testdata proto's source and its compiled descriptor, built by buf. */
function fixture(name: string): { source: string; file: DescFile } {
  const source = readFileSync(resolve(here, `testdata/${name}.proto`), "utf8");
  const bytes = readFileSync(resolve(here, `testdata/${name}.binpb`));
  const reg = createFileRegistry(fromBinary(FileDescriptorSetSchema, new Uint8Array(bytes)));
  return { source, file: reg.getFile(`${name}.proto`)! };
}

/** A proto source without comments or blank lines: what decides the descriptor. */
function declarations(source: string): string {
  return source
    .split("\n")
    .filter((l) => l.trim() !== "" && !l.trim().startsWith("//"))
    .join("\n");
}

function setField(m: ReflectMessage, name: string, value: unknown): void {
  m.set(m.desc.fields.find((f) => f.name === name)!, value);
}

function getField(m: ReflectMessage, name: string): unknown {
  return m.get(m.desc.fields.find((f) => f.name === name)!);
}

describe("SBE XML fixed-length arrays that are not text (#102)", () => {
  // testdata/fixed-arrays.proto is xmlToProto's output for fixedArraySchema,
  // compiled by buf; this pins that it still is, so the descriptor the
  // encoding tests use is the converter's.
  const arrays = fixture("fixed-arrays");

  it("imports a uint8 or int8 array as bytes of the same length", () => {
    const proto = xmlToProto(fixedArraySchema);
    for (const line of [
      "bytes uuid = 2 [(sbe.length) = 16];",
      "bytes signed = 3 [(sbe.length) = 3];",
      "bytes raw = 1 [(sbe.length) = 6];",
      "uint32 tail = 5;",
    ]) {
      expect(proto).toContain(line);
    }
    expect(declarations(proto)).toBe(declarations(arrays.source));
  });

  it("keeps the block layout, so the field after an array is where it was", () => {
    const codec = Codec.fromFiles(arrays.file);
    const desc = arrays.file.messages.find((m) => m.name === "Record")!;
    const msg = reflect(desc);
    const uuid = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 0xff]);
    setField(msg, "uuid", uuid);
    setField(msg, "tail", 0xa1b2c3d4);
    const data = marshal(codec, desc, msg.message);
    // Header(8) + name(4) + uuid(16) + signed(3) + key(6+4) + tail(4).
    expect(data.length).toBe(8 + 4 + 16 + 3 + 10 + 4);
    expect(data.subarray(12, 28)).toEqual(uuid);
    expect(data.subarray(data.length - 4)).toEqual(new Uint8Array([0xd4, 0xc3, 0xb2, 0xa1]));

    const got = reflect(desc);
    unmarshal(codec, desc, got.message, data);
    expect(getField(got, "uuid")).toEqual(uuid);
    expect(getField(got, "tail")).toBe(0xa1b2c3d4);
  });

  it.each([
    [
      "in a field",
      `<type name="Quad" primitiveType="int32" length="4"/>`,
      `<field name="q" id="1" type="Quad"/>`,
      `sbe: message "M": field "q": type "Quad" is an array of 4 int32, which no proto field represents`,
    ],
    [
      "in a composite",
      `<composite name="Box"><type name="sides" primitiveType="uint16" length="2"/></composite>`,
      `<field name="b" id="1" type="Box"/>`,
      `sbe: composite "Box": type "sides" is an array of 2 uint16, which no proto field represents`,
    ],
    [
      "in a group",
      `<type name="Quad" primitiveType="int32" length="4"/>`,
      `<group name="legs" id="2"><field name="q" id="1" type="Quad"/></group>`,
      `sbe: message "M": group "legs": field "q": type "Quad" is an array of 4 int32, which no proto field represents`,
    ],
  ])("refuses an array of a wider primitive %s, naming it", (_, types, body, want) => {
    const schema = `<?xml version="1.0" encoding="UTF-8"?>
<sbe:messageSchema xmlns:sbe="http://fixprotocol.io/2016/sbe" package="w" id="1" version="0" byteOrder="littleEndian">
    <types>${types}</types>
    <sbe:message name="M" id="1">${body}</sbe:message>
</sbe:messageSchema>`;
    expect(() => xmlToProto(schema)).toThrow(want);
  });

  it("refuses a uint64 array in the shared schema, with protowire-go's message", () => {
    const schema = fixedArraySchema.replace(
      `primitiveType="uint8" length="16"`,
      `primitiveType="uint64" length="2"`,
    );
    expect(() => xmlToProto(schema)).toThrow(
      new Error(`sbe: message "Record": field "uuid": type "Uuid" is an array of 2 uint64, which no proto field represents`),
    );
  });

  it("survives XML → proto → XML → proto with the same fields and bytes", () => {
    const proto1 = xmlToProto(fixedArraySchema);
    const xml2 = protoToXml(arrays.file);
    expect(xml2).toContain(`<type name="bytes16" primitiveType="uint8" length="16"/>`);
    expect(xml2).toContain(`<field name="name" id="1" type="bytes4"/>`);
    expect(xml2).toContain(`<type name="raw" primitiveType="uint8" length="6"/>`);

    // The second import declares what the first did, field for field, so it
    // compiles to the same descriptor and encodes the same bytes. Only the
    // note on the Latin-1 field is gone: the export has no encoding to carry.
    const proto2 = xmlToProto(xml2);
    expect(declarations(proto2)).toBe(declarations(proto1));
    expect(proto1).toContain("is not UTF-8 compatible");
    expect(proto2).not.toContain("is not UTF-8 compatible");

    // And those bytes are the values, at their offsets.
    const codec = Codec.fromFiles(arrays.file);
    const desc = arrays.file.messages.find((m) => m.name === "Record")!;
    const keyDesc = arrays.file.messages.find((m) => m.name === "Key")!;
    const msg = reflect(desc);
    setField(msg, "name", new Uint8Array([0x63, 0x61, 0x66, 0xe9]));
    setField(msg, "uuid", new TextEncoder().encode("0123456789abcdef"));
    setField(msg, "signed", new Uint8Array([0x80, 0x7f, 0x01]));
    const key = reflect(keyDesc);
    setField(key, "raw", new TextEncoder().encode("abcdef"));
    setField(key, "seq", 7);
    setField(msg, "key", key);
    setField(msg, "tail", 9);
    const data = marshal(codec, desc, msg.message);
    expect(Buffer.from(data.subarray(8)).toString("hex")).toBe(
      "636166e9" + Buffer.from("0123456789abcdef").toString("hex") + "807f01" +
        Buffer.from("abcdef").toString("hex") + "07000000" + "09000000",
    );
  });

  // FIX SBE reads length="1" as a single value, so a bytes field of length 1
  // comes back as uint32 narrowed to uint8: the same one byte in the block,
  // but not bytes. Pinned so a change to that reading is a decision.
  it("brings a bytes field of length 1 back as one uint8", () => {
    const one = fixture("bytes-length-one");
    const xml = protoToXml(one.file);
    expect(xml).toContain(`<type name="bytes1" primitiveType="uint8" length="1"/>`);
    expect(xmlToProto(xml)).toContain(`uint32 b = 1 [(sbe.encoding) = "uint8"];`);
  });

  it("still exports a string as a char array", () => {
    expect(protoToXml(file)).toContain(`<type name="str8" primitiveType="char" length="8"/>`);
  });
});
