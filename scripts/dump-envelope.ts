// SPDX-License-Identifier: MIT
// Copyright (c) 2026 TrendVidia, LLC.
// Cross-port wire-compatibility dumper, driven by protowire's
// scripts/cross_envelope_check.sh. Every port carries the same program and
// the script compares their output byte for byte. Mirrors
// protowire-go/scripts/dump_envelope.
//
//   dump-envelope                        canonical Envelope → pb hex
//   dump-envelope --pb  FDS MESSAGE DOC  PXF DOC decoded against MESSAGE in FDS → pb hex
//   dump-envelope --sbe FDS MESSAGE DOC  same → SBE hex
//
// The fixture modes apply the PXF annotations the descriptor carries, which
// is how the gate proves this port reads (pxf.required) = 1314,
// (pxf.default) = 1315 and the SBE numbers 1319–1323 from a descriptor it did
// not compile itself (STABILITY.md promise 3, protowire#244). A port looking
// for the wrong number decodes to different bytes, or accepts a document it
// must reject.
//
// Exit 0 with hex on stdout; 1 with "reject: <reason>" on stderr when the
// schema rejects DOC; 2 for anything that is the harness's fault.

import { readFileSync } from "node:fs";

import {
  type DescMessage,
  type Message,
  type Registry,
  createFileRegistry,
  fromBinary,
  toBinary,
} from "@bufbuild/protobuf";
import { FileDescriptorSetSchema } from "@bufbuild/protobuf/wkt";

import { Envelope, EnvelopePb, newAppError } from "../src/envelope/index.js";
import { unmarshalFull } from "../src/pxf/decode.js";
import { Codec, marshal as sbeMarshal } from "../src/sbe/index.js";

function hex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function fatal(code: number, msg: string): never {
  console.error(`dump-envelope: ${msg}`);
  process.exit(code);
}

function dumpEnvelope(): void {
  const ae = newAppError("INSUFFICIENT_FUNDS", "balance too low", "$3.50", "$10.00")
    .withField("amount", "MIN_VALUE", "below minimum", "10.00")
    .withMeta("request_id", "req-123");

  const env = new Envelope({
    status: 402,
    data: new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
    error: ae,
  });

  console.log(hex(EnvelopePb.marshal(env)));
}

function dumpFixture(mode: string, fdsPath: string, message: string, docPath: string): void {
  let desc: DescMessage | undefined;
  let doc = "";
  try {
    const registry: Registry = createFileRegistry(
      fromBinary(FileDescriptorSetSchema, new Uint8Array(readFileSync(fdsPath))),
    );
    desc = registry.getMessage(message);
    doc = readFileSync(docPath, "utf8");
  } catch (e) {
    fatal(2, e instanceof Error ? e.message : String(e));
  }
  if (!desc) fatal(2, `${fdsPath}: ${message} not found`);

  // The full decode is the one that validates (pxf.required) and applies
  // (pxf.default); plain unmarshal leaves both to the caller.
  let msg: Message;
  try {
    msg = unmarshalFull(doc, desc).message;
  } catch (e) {
    console.error(`reject: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }

  let out: Uint8Array;
  try {
    out =
      mode === "--pb"
        ? toBinary(desc, msg)
        : sbeMarshal(Codec.fromFiles(desc.file), desc, msg);
  } catch (e) {
    fatal(2, e instanceof Error ? e.message : String(e));
  }
  console.log(hex(out));
}

const argv = process.argv.slice(2);
if (argv.length === 0) {
  dumpEnvelope();
} else if (argv.length === 4 && (argv[0] === "--pb" || argv[0] === "--sbe")) {
  dumpFixture(argv[0], argv[1]!, argv[2]!, argv[3]!);
} else {
  fatal(2, "usage: dump-envelope [--pb|--sbe FDS MESSAGE DOC]");
}
