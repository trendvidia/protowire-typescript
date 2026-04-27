// Cross-port SBE microbench: TypeScript implementation.
//
// Loads `<testdata>/sbe-bench.binpb` (FileDescriptorSet), populates a
// canonical `bench.v1.Order` (10 scalars + 2-entry Fill group), and
// times marshal + unmarshal for at least `--seconds` (default 3).
// Prints one JSON line per op.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";

import {
  type DescMessage,
  type Registry,
  create,
  createFileRegistry,
  fromBinary,
} from "@bufbuild/protobuf";
import { type ReflectList, reflect } from "@bufbuild/protobuf/reflect";
import { FileDescriptorSetSchema } from "@bufbuild/protobuf/wkt";

import { Codec, marshal, unmarshal } from "../src/sbe/index.js";

let seconds = 3.0;
let testdata = `${process.cwd()}/testdata`;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  if (a === "--seconds") seconds = Number(argv[++i]);
  else if (a === "--testdata") testdata = argv[++i]!;
  else {
    console.error(`bench-sbe: unknown arg ${JSON.stringify(a)}`);
    process.exit(2);
  }
}

const fdsBytes = readFileSync(resolve(testdata, "sbe-bench.binpb"));
const registry: Registry = createFileRegistry(
  fromBinary(FileDescriptorSetSchema, new Uint8Array(fdsBytes)),
);
const file = registry.getFile("sbe-bench.proto");
if (!file) throw new Error("sbe-bench.proto not in registry");
const codec = Codec.fromFiles(file);

const orderDesc = registry.getMessage("bench.v1.Order")!;
const fillDesc = registry.getMessage("bench.v1.Order.Fill")!;
if (!orderDesc || !fillDesc) throw new Error("missing Order/Fill descriptors");

function buildOrder(): unknown {
  const msg = create(orderDesc);
  const r = reflect(orderDesc, msg);
  const set = (name: string, value: unknown) => {
    const fd = orderDesc.fields.find((f) => f.name === name);
    if (!fd) throw new Error(`field ${name} not found`);
    r.set(fd, value);
  };
  set("order_id", 1001n);
  set("symbol", "AAPL");
  set("price", 19150n);
  set("quantity", 100);
  set("side", 1);
  set("active", true);
  set("weight", 0.85);
  set("score", Math.fround(2.5));
  const fillsFd = orderDesc.fields.find((f) => f.name === "fills")!;
  const fills = r.get(fillsFd) as ReflectList<unknown>;
  for (const [price, qty, id] of [
    [19155n, 25, 5001n],
    [19160n, 50, 5002n],
  ] as const) {
    const f = reflect(fillDesc);
    f.set(fillDesc.fields.find((fd) => fd.name === "fill_price")!, price);
    f.set(fillDesc.fields.find((fd) => fd.name === "fill_qty")!, qty);
    f.set(fillDesc.fields.find((fd) => fd.name === "fill_id")!, id);
    fills.add(f);
  }
  return msg;
}

function timeLoop(secs: number, fn: () => void): { iters: number; elapsedMs: number } {
  const targetMs = secs * 1000;
  const start = performance.now();
  let iters = 0;
  for (;;) {
    for (let i = 0; i < 64; i++) fn();
    iters += 64;
    if (performance.now() - start >= targetMs) break;
  }
  return { iters, elapsedMs: performance.now() - start };
}

const order = buildOrder();
const wireBytes = marshal(codec, orderDesc, order as never);
const n = wireBytes.length;

{
  const { iters, elapsedMs } = timeLoop(seconds, () => {
    marshal(codec, orderDesc, order as never);
  });
  process.stdout.write(
    JSON.stringify({
      port: "ts",
      op: "sbe-marshal",
      ns_per_op: Math.round((elapsedMs * 1e6) / iters),
      iterations: iters,
      bytes: n,
    }) + "\n",
  );
}

{
  const { iters, elapsedMs } = timeLoop(seconds, () => {
    const out = create(orderDesc);
    unmarshal(codec, orderDesc, out as never, wireBytes);
  });
  const totalBytes = n * iters;
  const mibPerSec = totalBytes / (1024 * 1024) / (elapsedMs / 1000);
  process.stdout.write(
    JSON.stringify({
      port: "ts",
      op: "sbe-unmarshal",
      ns_per_op: Math.round((elapsedMs * 1e6) / iters),
      mib_per_sec: mibPerSec,
      iterations: iters,
      bytes: n,
    }) + "\n",
  );
}
