// SPDX-License-Identifier: MIT
// Copyright (c) 2026 TrendVidia, LLC.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  type DescMessage,
  type MessageShape,
  createFileRegistry,
  fromBinary,
} from "@bufbuild/protobuf";
import { type ReflectList, type ReflectMessage, reflect } from "@bufbuild/protobuf/reflect";
import { FileDescriptorSetSchema } from "@bufbuild/protobuf/wkt";
import { describe, expect, it } from "vitest";

import { Codec, marshal, unmarshal } from "./index.js";

const here = dirname(fileURLToPath(import.meta.url));
const fdsBytes = readFileSync(resolve(here, "testdata/sbe-test.binpb"));
const registry = createFileRegistry(
  fromBinary(FileDescriptorSetSchema, new Uint8Array(fdsBytes)),
);
const file = registry.getFile("sbe-test.proto")!;
const codec = Codec.fromFiles(file);

function descOf(name: string): DescMessage {
  const d = registry.getMessage(name);
  if (!d) throw new Error(`unknown message ${name}`);
  return d;
}

function emptyMsg<Desc extends DescMessage>(desc: Desc): MessageShape<Desc> {
  return reflect(desc).message as MessageShape<Desc>;
}

function set(refl: ReflectMessage, name: string, value: unknown): void {
  const fd = refl.desc.fields.find((f) => f.name === name);
  if (!fd) throw new Error(`unknown field ${name} on ${refl.desc.typeName}`);
  refl.set(fd, value);
}

function get(refl: ReflectMessage, name: string): unknown {
  const fd = refl.desc.fields.find((f) => f.name === name);
  if (!fd) throw new Error(`unknown field ${name} on ${refl.desc.typeName}`);
  const v = refl.get(fd);
  return v;
}

describe("SBE codec round-trip", () => {
  it("Simple round-trips through 16 bytes", () => {
    const desc = descOf("test.v1.Simple");
    const msg = emptyMsg(desc);
    const refl = reflect(desc, msg);
    set(refl, "id", 42);
    set(refl, "value", -100);

    const data = marshal(codec, desc, msg);
    expect(data.length).toBe(16); // header(8) + id(4) + value(4)

    const got = emptyMsg(desc);
    unmarshal(codec, desc, got, data);
    const gotRefl = reflect(desc, got);
    expect(get(gotRefl, "id")).toBe(42);
    expect(get(gotRefl, "value")).toBe(-100);
  });

  it("Order with fills round-trips through 94 bytes", () => {
    const desc = descOf("test.v1.Order");
    const fillDesc = descOf("test.v1.Order.Fill");
    const msg = emptyMsg(desc);
    const refl = reflect(desc, msg);
    set(refl, "order_id", 1001n);
    set(refl, "symbol", "AAPL");
    set(refl, "price", 19150n);
    set(refl, "quantity", 100);
    set(refl, "side", 1); // SELL
    set(refl, "active", true);
    set(refl, "weight", 0.85);
    set(refl, "score", Math.fround(3.14));

    const fillsFd = desc.fields.find((f) => f.name === "fills")!;
    const fills = refl.get(fillsFd) as ReflectList<unknown>;
    for (const [price, qty, id] of [
      [19155n, 25, 5001n],
      [19160n, 50, 5002n],
    ] as const) {
      const f = reflect(fillDesc);
      set(f, "fill_price", price);
      set(f, "fill_qty", qty);
      set(f, "fill_id", id);
      fills.add(f);
    }

    const data = marshal(codec, desc, msg);
    // header(8) + root(42) + group_header(4) + 2*fill(20) = 94
    expect(data.length).toBe(94);

    const got = emptyMsg(desc);
    unmarshal(codec, desc, got, data);
    const g = reflect(desc, got);
    expect(get(g, "order_id")).toBe(1001n);
    expect(get(g, "symbol")).toBe("AAPL");
    expect(get(g, "price")).toBe(19150n);
    expect(get(g, "quantity")).toBe(100);
    expect(get(g, "side")).toBe(1);
    expect(get(g, "active")).toBe(true);
    expect(get(g, "weight")).toBeCloseTo(0.85, 10);
    expect(get(g, "score") as number).toBeCloseTo(3.14, 5);

    const gotFills = g.get(fillsFd) as ReflectList<unknown>;
    expect(gotFills.size).toBe(2);
    const f0 = gotFills.get(0) as ReflectMessage;
    expect(get(f0, "fill_price")).toBe(19155n);
    expect(get(f0, "fill_qty")).toBe(25);
    expect(get(f0, "fill_id")).toBe(5001n);
    const f1 = gotFills.get(1) as ReflectMessage;
    expect(get(f1, "fill_price")).toBe(19160n);
    expect(get(f1, "fill_qty")).toBe(50);
    expect(get(f1, "fill_id")).toBe(5002n);
  });

  it("Composite round-trips through 36 bytes", () => {
    const desc = descOf("test.v1.WithComposite");
    const innerDesc = descOf("test.v1.Inner");
    const msg = emptyMsg(desc);
    const refl = reflect(desc, msg);
    set(refl, "id", 99n);

    const innerFd = desc.fields.find((f) => f.name === "inner")!;
    const inner = reflect(innerDesc);
    set(inner, "x", 100n);
    set(inner, "y", -200n);
    refl.set(innerFd, inner);

    set(refl, "code", 42);

    const data = marshal(codec, desc, msg);
    // header(8) + id(8) + inner(x+y=16) + code(4) = 36
    expect(data.length).toBe(36);

    const got = emptyMsg(desc);
    unmarshal(codec, desc, got, data);
    const g = reflect(desc, got);
    expect(get(g, "id")).toBe(99n);
    expect(get(g, "code")).toBe(42);
    const gotInner = g.get(innerFd) as ReflectMessage;
    expect(get(gotInner, "x")).toBe(100n);
    expect(get(gotInner, "y")).toBe(-200n);
  });

  it("strings longer than (sbe.length) are truncated on marshal", () => {
    const desc = descOf("test.v1.Order");
    const msg = emptyMsg(desc);
    const refl = reflect(desc, msg);
    set(refl, "symbol", "LONGERTHAN8");

    const data = marshal(codec, desc, msg);
    const got = emptyMsg(desc);
    unmarshal(codec, desc, got, data);
    const g = reflect(desc, got);
    expect(get(g, "symbol")).toBe("LONGERTH"); // 8 chars
  });

  it("empty group emits group header only", () => {
    const desc = descOf("test.v1.Order");
    const msg = emptyMsg(desc);
    const refl = reflect(desc, msg);
    set(refl, "order_id", 1n);

    const data = marshal(codec, desc, msg);
    // header(8) + root(42) + group_header(4) = 54
    expect(data.length).toBe(54);

    const got = emptyMsg(desc);
    unmarshal(codec, desc, got, data);
    const g = reflect(desc, got);
    expect(get(g, "order_id")).toBe(1n);
    const fillsFd = desc.fields.find((f) => f.name === "fills")!;
    expect((g.get(fillsFd) as ReflectList<unknown>).size).toBe(0);
  });

  it("(sbe.encoding) overrides change wire size", () => {
    const desc = descOf("test.v1.WithNarrow");
    const msg = emptyMsg(desc);
    const refl = reflect(desc, msg);
    set(refl, "status", 200);
    set(refl, "port", 8080);
    set(refl, "delta", -1234);

    const data = marshal(codec, desc, msg);
    // header(8) + status(1) + port(2) + delta(2) = 13
    expect(data.length).toBe(13);

    const got = emptyMsg(desc);
    unmarshal(codec, desc, got, data);
    const g = reflect(desc, got);
    expect(get(g, "status")).toBe(200);
    expect(get(g, "port")).toBe(8080);
    expect(get(g, "delta")).toBe(-1234);
  });

  it("zero-value Simple round-trips", () => {
    const desc = descOf("test.v1.Simple");
    const msg = emptyMsg(desc);
    const data = marshal(codec, desc, msg);
    expect(data.length).toBe(16);

    const got = emptyMsg(desc);
    unmarshal(codec, desc, got, data);
    const g = reflect(desc, got);
    expect(get(g, "id")).toBe(0);
    expect(get(g, "value")).toBe(0);
  });

  it("large negative int64 round-trips", () => {
    const desc = descOf("test.v1.Order");
    const msg = emptyMsg(desc);
    const refl = reflect(desc, msg);
    set(refl, "price", -99999n);

    const data = marshal(codec, desc, msg);
    const got = emptyMsg(desc);
    unmarshal(codec, desc, got, data);
    expect(get(reflect(desc, got), "price")).toBe(-99999n);
  });

  it("templateId mismatch errors on unmarshal", () => {
    const order = descOf("test.v1.Order");
    const simple = descOf("test.v1.Simple");
    const data = marshal(codec, simple, emptyMsg(simple));
    expect(() => unmarshal(codec, order, emptyMsg(order), data)).toThrow(/template ID mismatch/);
  });
});
