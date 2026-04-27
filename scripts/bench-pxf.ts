// Cross-port PXF microbench: TypeScript implementation.
//
// Reads `<testdata>/bench-test.binpb` (FileDescriptorSet) and
// `<testdata>/bench-test.pxf` (text payload), times unmarshal +
// marshal of `bench.v1.Config` for at least `--seconds` (default 3),
// and prints one JSON line per op. The other ports' bench-pxf
// binaries print the same shape; the
// `protowire/scripts/cross_pxf_bench.sh` runner aggregates them.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";

import {
  type DescMessage,
  type Registry,
  createFileRegistry,
  fromBinary,
} from "@bufbuild/protobuf";
import { FileDescriptorSetSchema } from "@bufbuild/protobuf/wkt";

import { marshal, unmarshal } from "../src/pxf/index.js";

interface Args {
  seconds: number;
  testdata: string;
}

function parseArgs(argv: string[]): Args {
  let seconds = 3.0;
  let testdata = `${process.cwd()}/testdata`;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--seconds") {
      seconds = Number(argv[++i]);
    } else if (a === "--testdata") {
      testdata = argv[++i]!;
    } else {
      console.error(`bench-pxf: unknown arg ${JSON.stringify(a)}`);
      process.exit(2);
    }
  }
  return { seconds, testdata };
}

function loadConfigDescriptor(fdsBytes: Uint8Array): DescMessage {
  const registry: Registry = createFileRegistry(
    fromBinary(FileDescriptorSetSchema, fdsBytes),
  );
  const m = registry.getMessage("bench.v1.Config");
  if (!m) throw new Error("missing bench.v1.Config");
  return m;
}

function timeLoop(seconds: number, fn: () => void): { iters: number; elapsedMs: number } {
  const targetMs = seconds * 1000;
  const start = performance.now();
  let iters = 0;
  for (;;) {
    // Run in batches of 64 to keep timer overhead in the noise.
    for (let i = 0; i < 64; i++) fn();
    iters += 64;
    if (performance.now() - start >= targetMs) break;
  }
  return { iters, elapsedMs: performance.now() - start };
}

const args = parseArgs(process.argv.slice(2));
const fdsBytes = readFileSync(resolve(args.testdata, "bench-test.binpb"));
const pxfText = readFileSync(resolve(args.testdata, "bench-test.pxf"), "utf8");
const desc = loadConfigDescriptor(new Uint8Array(fdsBytes));

// Warm-up.
unmarshal(pxfText, desc);

{
  const { iters, elapsedMs } = timeLoop(args.seconds, () => {
    unmarshal(pxfText, desc);
  });
  const nsPerOp = Math.round((elapsedMs * 1e6) / iters);
  const totalBytes = pxfText.length * iters;
  const mibPerSec = totalBytes / (1024 * 1024) / (elapsedMs / 1000);
  process.stdout.write(
    JSON.stringify({
      port: "ts",
      op: "unmarshal",
      ns_per_op: nsPerOp,
      mib_per_sec: mibPerSec,
      iterations: iters,
      bytes: pxfText.length,
    }) + "\n",
  );
}

{
  const msg = unmarshal(pxfText, desc);
  const { iters, elapsedMs } = timeLoop(args.seconds, () => {
    marshal(msg, desc);
  });
  const nsPerOp = Math.round((elapsedMs * 1e6) / iters);
  process.stdout.write(
    JSON.stringify({
      port: "ts",
      op: "marshal",
      ns_per_op: nsPerOp,
      iterations: iters,
    }) + "\n",
  );
}
