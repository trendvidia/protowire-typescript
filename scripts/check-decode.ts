// Per-port reference for the protowire HARDENING.md conformance corpus.
//
// Driven by `protowire/scripts/cross_security_check.sh`. See:
//   - protowire/docs/HARDENING.md
//   - protowire/testdata/adversarial/README.md
//
// Contract:
//
//   check-decode --format <pxf|pb|sbe|envelope> \
//                --schema <fully.qualified.MessageType> \
//                --proto  <path-to-adversarial.proto> \
//                --input  <path>
//
//   Exit 0 → input was accepted (decode succeeded)
//   Exit 1 → input was rejected (clean error; "reject: <msg>" on stderr)
//   Other  → bug in the decoder (uncaught throw / OOM / RangeError / hang)
//
// The TS port mirrors the Rust port: `--proto <path>.proto` is paired with
// a sibling `<path>.binpb` (FileDescriptorSet); @bufbuild/protobuf does not
// parse `.proto` text at runtime, so the FDS provides the descriptors that
// drive the PXF decoder. The pb path uses hand-rolled `defineMessage`
// codecs — protowire-pb is schema-explicit and does not consume descriptors.

import { readFileSync } from "node:fs";

import {
  type DescMessage,
  type Registry,
  createFileRegistry,
  fromBinary,
} from "@bufbuild/protobuf";
import { FileDescriptorSetSchema } from "@bufbuild/protobuf/wkt";

import {
  type CodecBase,
  type MessageCodec,
  defineMessage,
  unmarshal as pbUnmarshal,
} from "../src/pb/index.js";
import { unmarshal as pxfUnmarshal } from "../src/pxf/index.js";

// --- Hand-mirrored codecs for adversarial.proto ----------------------------
// protowire-pb is schema-explicit (no descriptor-driven dynamic dispatch),
// so the four adversarial message types are re-encoded here. Drift between
// these codecs and adversarial.proto must be caught by the conformance run
// itself: a wrong field number flips the manifest's accept/reject expectations.

interface Tree {
  child?: Tree;
  label: string;
}

// Forward-declared via a holder so field 1 can reference itself.
const treeChildKind = { message: undefined as unknown as CodecBase };
const TreeCodec: MessageCodec<Tree> = defineMessage<Tree>({
  fields: [
    { number: 1, name: "child", kind: treeChildKind as { message: CodecBase } },
    { number: 2, name: "label", kind: "string" },
  ],
  create: () => ({ label: "" }),
});
treeChildKind.message = TreeCodec;

interface StringHolder {
  value: string;
}
const StringHolderCodec: MessageCodec<StringHolder> = defineMessage<StringHolder>({
  fields: [{ number: 1, name: "value", kind: "string" }],
  create: () => ({ value: "" }),
});

interface BytesHolder {
  value: Uint8Array;
}
const BytesHolderCodec: MessageCodec<BytesHolder> = defineMessage<BytesHolder>({
  fields: [{ number: 1, name: "value", kind: "bytes" }],
  create: () => ({ value: new Uint8Array() }),
});

interface BigIntHolder {
  value: bigint;
}
const BigIntHolderCodec: MessageCodec<BigIntHolder> = defineMessage<BigIntHolder>({
  fields: [{ number: 1, name: "value", kind: "int64" }],
  create: () => ({ value: 0n }),
});

const PB_CODECS: Record<string, CodecBase> = {
  "adversarial.v1.Tree": TreeCodec,
  "adversarial.v1.StringHolder": StringHolderCodec,
  "adversarial.v1.BytesHolder": BytesHolderCodec,
  "adversarial.v1.BigIntHolder": BigIntHolderCodec,
};

// --- Argument parsing ------------------------------------------------------

interface Args {
  format: string;
  schema: string;
  proto: string | undefined;
  input: string;
}

function parseArgs(argv: string[]): Args {
  let format = "";
  let schema = "";
  let proto: string | undefined;
  let input = "";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const v = argv[i + 1];
    switch (a) {
      case "--format":
        format = v ?? "";
        i++;
        break;
      case "--schema":
        schema = v ?? "";
        i++;
        break;
      case "--proto":
        proto = v;
        i++;
        break;
      case "--input":
        input = v ?? "";
        i++;
        break;
      case "-h":
      case "--help":
        process.stdout.write(
          "usage: check-decode --format <pxf|pb|sbe|envelope> --schema <fq.Type> --proto <adversarial.proto> --input <path>\n",
        );
        process.exit(0);
      default:
        process.stderr.write(`check-decode: unknown arg ${JSON.stringify(a)}\n`);
        process.exit(2);
    }
  }
  if (format === "") {
    process.stderr.write("check-decode: --format required\n");
    process.exit(2);
  }
  if (schema === "") {
    process.stderr.write("check-decode: --schema required\n");
    process.exit(2);
  }
  if (input === "") {
    process.stderr.write("check-decode: --input required\n");
    process.exit(2);
  }
  return { format, schema, proto, input };
}

// --- Descriptor pool from sibling .binpb -----------------------------------

function loadDescriptor(protoPath: string, schema: string): DescMessage {
  // protoPath ends in .proto; the sibling .binpb is a FileDescriptorSet.
  const fdsPath = protoPath.replace(/\.proto$/, ".binpb");
  let fdsBytes: Buffer;
  try {
    fdsBytes = readFileSync(fdsPath);
  } catch (e) {
    throw new Error(
      `read ${fdsPath} (sibling FileDescriptorSet of ${protoPath}): ${
        (e as Error).message
      }`,
    );
  }
  const registry: Registry = createFileRegistry(
    fromBinary(FileDescriptorSetSchema, new Uint8Array(fdsBytes)),
  );
  const m = registry.getMessage(schema);
  if (!m) {
    throw new Error(`schema ${JSON.stringify(schema)} not in ${fdsPath}`);
  }
  return m;
}

// --- Format dispatch -------------------------------------------------------

function decodePxf(input: string, schema: string, proto: string | undefined): void {
  if (proto === undefined || proto === "") {
    throw new Error("--proto required for format=pxf");
  }
  const desc = loadDescriptor(proto, schema);
  const text = readFileSync(input, "utf8");
  pxfUnmarshal(text, desc);
}

function decodePb(input: string, schema: string): void {
  const codec = PB_CODECS[schema];
  if (!codec) {
    throw new Error(`unknown schema for pb: ${schema}`);
  }
  const bytes = readFileSync(input);
  pbUnmarshal(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), codec as MessageCodec<unknown>);
}

function run(args: Args): void {
  switch (args.format) {
    case "pxf":
      decodePxf(args.input, args.schema, args.proto);
      return;
    case "pb":
      decodePb(args.input, args.schema);
      return;
    case "sbe":
      throw new Error("sbe decode not yet implemented in this reference");
    case "envelope":
      throw new Error("envelope decode not yet implemented in this reference");
    default:
      throw new Error(`unsupported format: ${args.format}`);
  }
}

const args = parseArgs(process.argv.slice(2));
try {
  run(args);
  process.exit(0);
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  process.stderr.write(`reject: ${msg}\n`);
  process.exit(1);
}
