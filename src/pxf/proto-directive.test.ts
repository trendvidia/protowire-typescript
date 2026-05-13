// SPDX-License-Identifier: MIT
// Copyright (c) 2026 TrendVidia, LLC.

/**
 * Parser tests for the @proto directive (draft §3.4.5).
 *
 * Four body shapes lexically distinguished: anonymous, named, source,
 * descriptor. Plus reserved-directive-name rejection (draft §3.4.6).
 */

import { describe, expect, it } from "vitest";

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

describe("Reserved directive names (draft §3.4.6)", () => {
  for (const name of ["table", "datasource", "view", "procedure", "function", "permissions"]) {
    it(`rejects @${name}`, () => {
      expect(() => parse(`@${name} { x = 1 }`)).toThrow(/spec-reserved/);
    });
  }
});
