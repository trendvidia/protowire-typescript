import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createFileRegistry, fromBinary } from "@bufbuild/protobuf";
import { FileDescriptorSetSchema } from "@bufbuild/protobuf/wkt";
import { describe, expect, it } from "vitest";

import {
  camelToScreamingSnake,
  camelToSnake,
  parseXMLSchema,
  protoToXml,
  screamingSnakeToPascal,
  singularPascal,
  snakeToCamel,
  stripEnumPrefix,
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
    expect(schema.messages).toHaveLength(4);
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
