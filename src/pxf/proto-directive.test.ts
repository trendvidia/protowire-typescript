// SPDX-License-Identifier: MIT
// Copyright (c) 2026 TrendVidia, LLC.

/**
 * Parser tests for the @proto directive (draft §3.4.5).
 *
 * Four body shapes lexically distinguished: anonymous, named, source,
 * descriptor. Plus reserved-directive-name rejection (draft §3.4.6).
 */

import { EmptySchema } from "@bufbuild/protobuf/wkt";
import { describe, expect, it } from "vitest";

import type { Document } from "./ast.js";
import { DatasetReader } from "./dataset_reader.js";
import { unmarshal, unmarshalFull } from "./decode.js";
import { format } from "./format.js";
import { parse } from "./parser.js";

const dec = new TextDecoder();

describe("ProtoDirective", () => {
  it("anonymous body", () => {
    const doc = parse(`@proto {
  string symbol = 1;
  double price = 2;
}`);
    expect(doc.protos).toHaveLength(1);
    const pd = doc.protos[0]!;
    expect(pd.shape).toBe("anonymous");
    expect(pd.typeName).toBe("");
    const body = dec.decode(pd.body);
    expect(body).toContain("string symbol = 1;");
    expect(body).toContain("double price = 2;");
  });

  it("named body", () => {
    const doc = parse(`@proto trades.v1.Trade {
  string symbol = 1;
  double price = 2;
}`);
    const pd = doc.protos[0]!;
    expect(pd.shape).toBe("named");
    expect(pd.typeName).toBe("trades.v1.Trade");
    expect(dec.decode(pd.body)).toContain("string symbol = 1;");
  });

  it("source body", () => {
    const doc = parse(`@proto """
syntax = "proto3";
package trades.v1;
message Trade { string symbol = 1; }
"""`);
    const pd = doc.protos[0]!;
    expect(pd.shape).toBe("source");
    const body = dec.decode(pd.body);
    expect(body).toContain(`syntax = "proto3"`);
    expect(body).toContain("message Trade");
  });

  it("descriptor body", () => {
    const raw = new Uint8Array([0x0a, 0x05, 0x68, 0x65, 0x6c, 0x6c, 0x6f]); // "hello"
    const b64 = btoa(String.fromCharCode(...raw));
    const doc = parse(`@proto b"${b64}"`);
    const pd = doc.protos[0]!;
    expect(pd.shape).toBe("descriptor");
    expect(Array.from(pd.body)).toEqual(Array.from(raw));
  });

  it("multiple @proto directives", () => {
    const doc = parse(`@proto trades.v1.Trade { string symbol = 1; }
@proto orders.v1.Order { string id = 1; }`);
    expect(doc.protos).toHaveLength(2);
    expect(doc.protos[0]!.typeName).toBe("trades.v1.Trade");
    expect(doc.protos[1]!.typeName).toBe("orders.v1.Order");
  });

  it("anonymous @proto followed by untyped @dataset (one-shot binding)", () => {
    const doc = parse(`@proto {
  string symbol = 1;
  double price = 2;
}
@dataset (symbol, price)
("AAPL", 192.34)
("MSFT", 410.10)`);
    expect(doc.protos).toHaveLength(1);
    expect(doc.protos[0]!.shape).toBe("anonymous");
    expect(doc.datasets[0]!.type).toBe("");
    expect(doc.datasets[0]!.rows).toHaveLength(2);
  });

  it("captures nested braces in body", () => {
    const doc = parse(`@proto {
  message Side {
    string label = 1;
  }
  Side side = 1;
}`);
    const body = dec.decode(doc.protos[0]!.body);
    expect(body).toContain("message Side");
    expect(body).toContain("Side side = 1;");
  });

  it("rejects bad shape", () => {
    expect(() => parse(`@proto 42`)).toThrow(/after @proto/);
  });

  it("rejects named form missing brace", () => {
    expect(() => parse(`@proto trades.v1.Trade 42`)).toThrow(/'\{'/);
  });

  it("rejects anonymous unmatched brace", () => {
    expect(() => parse(`@proto { string symbol = 1;`)).toThrow(/unmatched/);
  });

  it("coexists with @type", () => {
    const doc = parse(`@type some.pkg.Foo
@proto some.pkg.Foo {
  string name = 1;
}`);
    expect(doc.typeUrl).toBe("some.pkg.Foo");
    expect(doc.protos).toHaveLength(1);
    expect(doc.protos[0]!.shape).toBe("named");
  });
});

// A source body must be triple-quoted: the grammar's proto_source_body is a
// triple_string. A simple-quoted body could carry `"""` through its escapes,
// and no formatter can write that back (#121, protowire-go#305).
describe("@proto source body must be triple-quoted", () => {
  const msg = '@proto source body must be a triple-quoted string ("""...""")';
  const empty = (s: string) => unmarshal(s, EmptySchema, { discardUnknown: true });
  const emptyFull = (s: string) => unmarshalFull(s, EmptySchema, { discardUnknown: true });

  for (const [input, at] of [
    ['@proto "syntax = \\"proto3\\";"', "1:8"],
    ['@proto "syntax = \\"proto3\\"; // a \\"\\"\\" b"', "1:8"], // protowire-go#305's body
    ['@proto ""', "1:8"],
    ['@type adversarial.v1.StringHolder\n@proto "syntax = \\"proto3\\";"', "2:8"],
  ] as const) {
    it(`rejects ${JSON.stringify(input)} on every path`, () => {
      const want = `${at}: ${msg}`;
      expect(() => parse(input)).toThrow(want);
      // unmarshal and unmarshalFull read directives on their own path.
      expect(() => empty(input)).toThrow(want);
      expect(() => emptyFull(input)).toThrow(want);
      // So does a dataset stream's header, through parse.
      expect(() => DatasetReader.fromString(`${input}\n@dataset T (a)\n(1)\n`)).toThrow(want);
    });
  }

  for (const input of [
    '@proto """syntax = "proto3";"""\n',
    '@proto\n"""syntax = "proto3";"""\n',
    '@proto """\nsyntax = "proto3";\n"""\n',
  ]) {
    it(`accepts ${JSON.stringify(input)}`, () => {
      const doc = parse(input);
      expect(doc.protos[0]!.shape).toBe("source");
      expect(dec.decode(doc.protos[0]!.body).trimEnd()).toBe('syntax = "proto3";');
      expect(() => empty(input)).not.toThrow();
      expect(() => emptyFull(input)).not.toThrow();
    });
  }

  // The descriptor form is a bytes literal, not a string: still legal
  // (proto-descr-body = 1*WSP bytes), empty or not.
  for (const input of ['@proto b""\n', `@proto b"${btoa("\x0a\x05hello")}"\n`]) {
    it(`accepts the descriptor form ${JSON.stringify(input)}`, () => {
      const doc = parse(input);
      expect(doc.protos[0]!.shape).toBe("descriptor");
      expect(() => empty(input)).not.toThrow();
      expect(() => emptyFull(input)).not.toThrow();
    });
  }

  // A hand-built source body holding `"""` cannot be written triple-quoted,
  // so format's output for it does not parse. Parsing never yields such a
  // body; this pins what the ProtoDirective docs say.
  it("a hand-built body holding triple quotes formats to text that does not parse", () => {
    const doc: Document = {
      typeUrl: "",
      directives: [],
      datasets: [],
      protos: [
        { pos: { line: 1, column: 1, offset: 0 }, shape: "source", typeName: "", body: new TextEncoder().encode('a """ b'), leadingComments: [] },
      ],
      bodyOffset: 0,
      entries: [],
      leadingComments: [],
    };
    expect(() => parse(format(doc))).toThrow();
  });
});

describe("Reserved directive names (draft §3.4.6)", () => {
  for (const name of ["table", "datasource", "view", "procedure", "function", "permissions"]) {
    it(`rejects @${name}`, () => {
      expect(() => parse(`@${name} { x = 1 }`)).toThrow(/spec-reserved/);
    });
  }
});
