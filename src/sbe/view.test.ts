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

import { Codec, marshal } from "./index.js";

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
  if (!fd) throw new Error(`unknown field ${name}`);
  refl.set(fd, value);
}

function buildOrder(): Uint8Array {
  const desc = descOf("test.v1.Order");
  const fillDesc = descOf("test.v1.Order.Fill");
  const msg = emptyMsg(desc);
  const refl = reflect(desc, msg);
  set(refl, "order_id", 1001n);
  set(refl, "symbol", "AAPL");
  set(refl, "price", 19150n);
  set(refl, "quantity", 100);
  set(refl, "side", 1);
  set(refl, "active", true);
  set(refl, "weight", 0.85);
  set(refl, "score", Math.fround(3.14));

  const fillsFd = desc.fields.find((f) => f.name === "fills")!;
  const fills = refl.get(fillsFd) as ReflectList<unknown>;
  for (const [price, qty, id] of [
    [100n, 10, 7n],
    [200n, 20, 8n],
  ] as const) {
    const f = reflect(fillDesc);
    set(f, "fill_price", price);
    set(f, "fill_qty", qty);
    set(f, "fill_id", id);
    fills.add(f);
  }
  return marshal(codec, desc, msg);
}

describe("SBE View scalars", () => {
  it("reads scalars and string by name", () => {
    const desc = descOf("test.v1.Order");
    const msg = emptyMsg(desc);
    const refl = reflect(desc, msg);
    set(refl, "order_id", 1001n);
    set(refl, "symbol", "AAPL");
    set(refl, "price", 19150n);
    set(refl, "quantity", 100);
    set(refl, "side", 1);
    set(refl, "active", true);
    set(refl, "weight", 0.85);
    set(refl, "score", Math.fround(3.14));

    const data = marshal(codec, desc, msg);
    const v = codec.view(data);

    expect(v.uint("order_id")).toBe(1001n);
    expect(v.string("symbol")).toBe("AAPL");
    expect(v.int("price")).toBe(19150n);
    expect(v.uint("quantity")).toBe(100);
    expect(v.enum("side")).toBe(1);
    expect(v.bool("active")).toBe(true);
    expect(v.float("weight")).toBeCloseTo(0.85, 10);
    expect(v.float("score")).toBeCloseTo(3.14, 5);
  });
});

describe("SBE View groups", () => {
  it("reads group entries with their own field accessors", () => {
    const data = buildOrder();
    const v = codec.view(data);

    const fills = v.group("fills");
    expect(fills.length).toBe(2);

    const e0 = fills.entry(0);
    expect(e0.int("fill_price")).toBe(100n);
    expect(e0.uint("fill_qty")).toBe(10);
    expect(e0.uint("fill_id")).toBe(7n);

    const e1 = fills.entry(1);
    expect(e1.int("fill_price")).toBe(200n);
    expect(e1.uint("fill_qty")).toBe(20);
    expect(e1.uint("fill_id")).toBe(8n);
  });

  it("reports zero entries for empty group", () => {
    const desc = descOf("test.v1.Order");
    const msg = emptyMsg(desc);
    set(reflect(desc, msg), "order_id", 1n);
    const data = marshal(codec, desc, msg);

    const v = codec.view(data);
    expect(v.group("fills").length).toBe(0);
  });

  it("entry index out of range throws", () => {
    const desc = descOf("test.v1.Order");
    const msg = emptyMsg(desc);
    set(reflect(desc, msg), "order_id", 1n);
    const data = marshal(codec, desc, msg);
    expect(() => codec.view(data).group("fills").entry(0)).toThrow(/out of range/);
  });
});

describe("SBE View composites", () => {
  it("descends into composite fields via composite()", () => {
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

    const v = codec.view(marshal(codec, desc, msg));
    expect(v.uint("id")).toBe(99n);
    expect(v.int("code")).toBe(42);
    const iv = v.composite("inner");
    expect(iv.int("x")).toBe(100n);
    expect(iv.int("y")).toBe(-200n);
  });
});

describe("SBE View errors", () => {
  it("rejects unknown template ID", () => {
    const data = new Uint8Array(8); // header zeroed → templateId 0
    expect(() => codec.view(data)).toThrow(/unknown template ID/);
  });

  it("rejects buffer shorter than header", () => {
    expect(() => codec.view(new Uint8Array(4))).toThrow(/too short for header/);
  });

  it("unknown field name throws", () => {
    const data = buildOrder();
    expect(() => codec.view(data).int("nope")).toThrow(/unknown field/);
  });
});
