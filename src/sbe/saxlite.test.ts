// SPDX-License-Identifier: MIT
// Copyright (c) 2026 TrendVidia, LLC.
import { describe, expect, it } from "vitest";

import { type SaxHandler, SaxError, parseXml } from "./saxlite.js";

type Event =
  | { kind: "open"; name: string; attrs: Record<string, string> }
  | { kind: "close"; name: string }
  | { kind: "text"; value: string };

function collect(xml: string): Event[] {
  const events: Event[] = [];
  const handler: SaxHandler = {
    onOpen: (name, attrs) => events.push({ kind: "open", name, attrs }),
    onClose: (name) => events.push({ kind: "close", name }),
    onText: (value) => events.push({ kind: "text", value }),
  };
  parseXml(xml, handler);
  return events;
}

describe("saxlite", () => {
  it("parses open and close tags with attributes", () => {
    const ev = collect(`<root a="1" b='two'></root>`);
    expect(ev).toEqual([
      { kind: "open", name: "root", attrs: { a: "1", b: "two" } },
      { kind: "close", name: "root" },
    ]);
  });

  it("self-closing tags emit open then close", () => {
    const ev = collect(`<x/>`);
    expect(ev).toEqual([
      { kind: "open", name: "x", attrs: {} },
      { kind: "close", name: "x" },
    ]);
  });

  it("self-closing with attributes and a slash boundary", () => {
    const ev = collect(`<type name="str8" length="8"/>`);
    expect(ev).toEqual([
      { kind: "open", name: "type", attrs: { name: "str8", length: "8" } },
      { kind: "close", name: "type" },
    ]);
  });

  it("emits char data between tags and decodes entities", () => {
    const ev = collect(`<v>1 &amp; 2 &lt;3&gt; &quot;x&quot; &apos;y&apos;</v>`);
    expect(ev).toEqual([
      { kind: "open", name: "v", attrs: {} },
      { kind: "text", value: `1 & 2 <3> "x" 'y'` },
      { kind: "close", name: "v" },
    ]);
  });

  it("skips XML prolog and comments", () => {
    const ev = collect(
      `<?xml version="1.0"?><!-- a comment --><root/>`,
    );
    expect(ev).toEqual([
      { kind: "open", name: "root", attrs: {} },
      { kind: "close", name: "root" },
    ]);
  });

  it("strips namespace prefixes on element and attribute names", () => {
    const ev = collect(
      `<sbe:root xmlns:sbe="http://x" sbe:tag="t" plain="p"></sbe:root>`,
    );
    expect(ev).toEqual([
      { kind: "open", name: "root", attrs: { tag: "t", plain: "p" } },
      { kind: "close", name: "root" },
    ]);
  });

  it("preserves whitespace text events between tags", () => {
    const ev = collect(`<a>\n  <b/>\n</a>`);
    expect(ev[0]).toEqual({ kind: "open", name: "a", attrs: {} });
    expect(ev[1]).toEqual({ kind: "text", value: "\n  " });
    expect(ev[2]).toEqual({ kind: "open", name: "b", attrs: {} });
  });

  it("rejects unterminated comment", () => {
    expect(() => collect(`<!-- oops`)).toThrow(SaxError);
  });

  it("rejects attribute without equals sign", () => {
    expect(() => collect(`<x foo "1"/>`)).toThrow(/expected '='/);
  });

  it("rejects attribute without quoted value", () => {
    expect(() => collect(`<x foo=1/>`)).toThrow(/expected quoted value/);
  });
});
