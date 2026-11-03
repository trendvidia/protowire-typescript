// SPDX-License-Identifier: MIT
// Copyright (c) 2026 TrendVidia, LLC.
// HARDENING conformance harness, driven by protowire's
// scripts/cross_security_check.sh. Mirrors protowire-go/scripts/check_decode.
//
//   check-decode --format <pxf|pb|pb-render|sbe> --schema <message>
//                --proto <path/adversarial.proto> --input <path>
//                [--limit NAME=VALUE]...
//
// Exit 0 when the input is accepted, 1 when it is rejected with a clean error,
// and 2 for a fault in the harness. Anything else is a bug in the decoder.
//
// This port cannot compile a .proto at run time, so --proto locates the
// descriptor set that sits beside it, adversarial.binpb.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { type Registry, create, createFileRegistry, fromBinary } from "@bufbuild/protobuf";
import { FileDescriptorSetSchema } from "@bufbuild/protobuf/wkt";

import { type MessageCodec, defineMessage, unmarshal as pbUnmarshal } from "../src/pb/index.js";
import { unmarshal as pxfUnmarshal } from "../src/pxf/decode.js";
import { marshal as pxfMarshal } from "../src/pxf/encode.js";
import { Codec, unmarshal as sbeUnmarshal } from "../src/sbe/index.js";

interface Args {
  format: string;
  schema: string;
  proto: string;
  input: string;
}

function usage(msg: string): never {
  console.error(`check-decode: ${msg}`);
  process.exit(2);
}

function parseArgs(argv: string[]): Args {
  const args: Partial<Args> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i];
    const value = argv[i + 1];
    if (value === undefined) usage(`${name} wants a value`);
    switch (name) {
      case "--format":
      case "--schema":
      case "--proto":
      case "--input":
        args[name.slice(2) as keyof Args] = value;
        break;
      case "--limit":
        // The decoders take no lowered limits yet. Failing the row is the
        // contract for a port without this, and the manifest lists this port
        // in those rows' skip.
        usage(`--limit ${value}: this port cannot lower a limit`);
        break;
      default:
        usage(`unknown flag ${name}`);
    }
  }
  if (!args.format || !args.schema || !args.input) usage("--format, --schema and --input are required");
  return args as Args;
}

// Hand-mirrored adversarial.proto: the pb codec takes declared fields, not
// descriptors. Drift fails the corpus. Without branches = 4 and tags = 5 the
// codec would skip those fields as unknown and the map rows would test nothing.
interface Tree {
  child?: Tree;
  label: string;
  children: Tree[];
  branches: Map<string, Tree>;
  tags: Map<string, string>;
}

const TreePb: MessageCodec<Tree> = defineMessage<Tree>({
  fields: [
    { number: 1, name: "child", get kind() { return { message: TreePb }; } },
    { number: 2, name: "label", kind: "string" },
    { number: 3, name: "children", repeated: true, get kind() { return { message: TreePb }; } },
    { number: 4, name: "branches", mapKey: "string", get kind() { return { message: TreePb }; } },
    { number: 5, name: "tags", mapKey: "string", kind: "string" },
  ],
  create: () => ({ label: "", children: [], branches: new Map(), tags: new Map() }),
});

const StringHolderPb = defineMessage<{ value: string }>({
  fields: [{ number: 1, name: "value", kind: "string" }],
  create: () => ({ value: "" }),
});

const BytesHolderPb = defineMessage<{ value: Uint8Array }>({
  fields: [{ number: 1, name: "value", kind: "bytes" }],
  create: () => ({ value: new Uint8Array() }),
});

const BigIntHolderPb = defineMessage<{ value: bigint }>({
  fields: [{ number: 1, name: "value", kind: "int64" }],
  create: () => ({ value: 0n }),
});

const ListHolderPb = defineMessage<{ values: number[] }>({
  fields: [{ number: 1, name: "values", kind: "int32", repeated: true }],
  create: () => ({ values: [] }),
});

const PB_CODECS: Record<string, MessageCodec<never>> = {
  "adversarial.v1.Tree": TreePb as unknown as MessageCodec<never>,
  "adversarial.v1.StringHolder": StringHolderPb as unknown as MessageCodec<never>,
  "adversarial.v1.BytesHolder": BytesHolderPb as unknown as MessageCodec<never>,
  "adversarial.v1.BigIntHolder": BigIntHolderPb as unknown as MessageCodec<never>,
  "adversarial.v1.ListHolder": ListHolderPb as unknown as MessageCodec<never>,
};

function registry(protoPath: string): Registry {
  const set = join(dirname(protoPath), "adversarial.binpb");
  return createFileRegistry(fromBinary(FileDescriptorSetSchema, new Uint8Array(readFileSync(set))));
}

function decode(args: Args, data: Uint8Array): void {
  if (args.format === "pb") {
    const codec = PB_CODECS[args.schema];
    if (!codec) usage(`unknown schema for pb: ${args.schema}`);
    pbUnmarshal(data, codec);
    return;
  }
  if (!args.proto) usage(`--proto is required for format=${args.format}`);
  const desc = registry(args.proto).getMessage(args.schema);
  if (!desc) usage(`schema ${args.schema} not found`);
  switch (args.format) {
    case "pxf":
      pxfUnmarshal(new TextDecoder("utf-8", { fatal: true }).decode(data), desc);
      return;
    case "pb-render":
      pxfMarshal(fromBinary(desc, data), desc);
      return;
    case "sbe":
      sbeUnmarshal(Codec.fromFiles(desc.file), desc, create(desc), data);
      return;
    default:
      usage(`unsupported format: ${args.format}`);
  }
}

const args = parseArgs(process.argv.slice(2));
const data = new Uint8Array(readFileSync(args.input));
try {
  decode(args, data);
} catch (e) {
  console.error(`reject: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
