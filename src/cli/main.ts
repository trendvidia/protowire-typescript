/**
 * `protowire` CLI — TypeScript port of `protowire/cmd/protowire/main.go`.
 *
 * Subcommands: encode, decode, validate, fmt. The schema source is a
 * pre-compiled FileDescriptorSet binary (`-d <file.binpb>`), produced by
 * e.g. `protoc --include_imports --descriptor_set_out=schema.binpb`. The
 * Go CLI's `--proto` (compile from sources) and `--server` (protoregistry
 * gRPC client) modes are out of scope for this port.
 *
 * `run(argv, readFile)` returns `{ stdout, stderr, exit }` rather than
 * touching process I/O directly, so tests can drive it as a pure
 * function. The thin `bin/protowire.js` wrapper streams the result.
 */

import { parseArgs } from "node:util";

import {
  type DescMessage,
  type Registry,
  createFileRegistry,
  fromBinary,
  toBinary,
} from "@bufbuild/protobuf";
import { FileDescriptorSetSchema } from "@bufbuild/protobuf/wkt";

import { marshal } from "../pxf/encode.js";
import { unmarshal } from "../pxf/decode.js";

export interface CliResult {
  stdout: Uint8Array;
  stderr: string;
  exit: number;
}

const USAGE = `usage: protowire <command> -d <descriptor.binpb> -m <message-name> [args...]

commands:
  encode <file.pxf>     PXF text  -> protobuf binary (stdout)
  decode <file.pb>      protobuf binary -> PXF text (stdout)
  validate <file.pxf>   parse PXF and report success / error
  fmt <file.pxf>        round-trip PXF (decode + encode) and write to stdout

flags:
  -d, --descriptor-set <file>  binary FileDescriptorSet (FDSet) produced by
                                protoc --descriptor_set_out
  -m, --message <name>         fully-qualified message name (e.g. test.v1.AllTypes)
`;

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

export async function run(
  argv: string[],
  readFile: (path: string) => Promise<Uint8Array>,
): Promise<CliResult> {
  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") {
    return { stdout: empty(), stderr: USAGE, exit: argv.length === 0 ? 1 : 0 };
  }

  const [cmd, ...rest] = argv;
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      options: {
        "descriptor-set": { type: "string", short: "d" },
        message: { type: "string", short: "m" },
        help: { type: "boolean", short: "h" },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (e) {
    return fail(`error: ${(e as Error).message}\n\n${USAGE}`);
  }

  if (parsed.values.help) {
    return { stdout: empty(), stderr: USAGE, exit: 0 };
  }

  const descPath = parsed.values["descriptor-set"];
  const msgName = parsed.values.message;
  if (!descPath) return fail("error: -d/--descriptor-set is required\n");
  if (!msgName) return fail("error: -m/--message is required\n");

  if (parsed.positionals.length !== 1) {
    return fail(`error: ${cmd} expects exactly one input file argument\n`);
  }
  const inputPath = parsed.positionals[0]!;

  let registry: Registry;
  let target: DescMessage;
  try {
    const fdsBytes = await readFile(descPath);
    registry = createFileRegistry(fromBinary(FileDescriptorSetSchema, fdsBytes));
    const m = registry.getMessage(msgName);
    if (!m) return fail(`error: message ${msgName} not found in descriptor set\n`);
    target = m;
  } catch (e) {
    return fail(`error: load descriptor: ${(e as Error).message}\n`);
  }

  let inputData: Uint8Array;
  try {
    inputData = await readFile(inputPath);
  } catch (e) {
    return fail(`error: read ${inputPath}: ${(e as Error).message}\n`);
  }

  switch (cmd) {
    case "encode":
      return runEncode(inputData, target);
    case "decode":
      return runDecode(inputData, target);
    case "validate":
      return runValidate(inputData, target);
    case "fmt":
      return runFmt(inputData, target, msgName);
    default:
      return fail(`error: unknown command ${JSON.stringify(cmd)}\n\n${USAGE}`);
  }
}

function runEncode(input: Uint8Array, target: DescMessage): CliResult {
  try {
    const msg = unmarshal(DECODER.decode(input), target);
    return { stdout: toBinary(target, msg), stderr: "", exit: 0 };
  } catch (e) {
    return fail(`error: ${(e as Error).message}\n`);
  }
}

function runDecode(input: Uint8Array, target: DescMessage): CliResult {
  try {
    const msg = fromBinary(target, input);
    return {
      stdout: ENCODER.encode(marshal(msg, target)),
      stderr: "",
      exit: 0,
    };
  } catch (e) {
    return fail(`error: ${(e as Error).message}\n`);
  }
}

function runValidate(input: Uint8Array, target: DescMessage): CliResult {
  try {
    unmarshal(DECODER.decode(input), target);
    return { stdout: empty(), stderr: "valid\n", exit: 0 };
  } catch (e) {
    return fail(`error: ${(e as Error).message}\n`);
  }
}

function runFmt(
  input: Uint8Array,
  target: DescMessage,
  typeURL: string,
): CliResult {
  try {
    const msg = unmarshal(DECODER.decode(input), target);
    return {
      stdout: ENCODER.encode(marshal(msg, target, { typeURL })),
      stderr: "",
      exit: 0,
    };
  } catch (e) {
    return fail(`error: ${(e as Error).message}\n`);
  }
}

function empty(): Uint8Array {
  return new Uint8Array(0);
}

function fail(stderr: string): CliResult {
  return { stdout: empty(), stderr, exit: 1 };
}
