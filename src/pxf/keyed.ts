// SPDX-License-Identifier: MIT
// Copyright (c) 2026 TrendVidia, LLC.
/**
 * Keyed repeated fields (draft-trendvidia-protowire-01 §3.13, protowire#116):
 * a `repeated <Message>` field carrying `(pxf.key)` may be written as a block
 * of named blocks, entry name = key-field value, entry order = list order.
 *
 * This file holds what the decoder, the encoder and tooling share: the
 * entry-name spelling rule, the decode-error wording, and the schema-aware
 * fmt canonicalizer. The descriptor helper `keyField` is in annotations.ts,
 * the decode loop in decode.ts, keyed emission in encode.ts, and the
 * placement check in schema.ts. Mirrors `protowire/encoding/pxf/keyed.go`.
 */

import { type DescField, type DescMessage } from "@bufbuild/protobuf";

import { keyField } from "./annotations.js";
import {
  type Assignment,
  type Block,
  type BlockVal,
  type Comment,
  type Document,
  type Entry,
  type ListVal,
} from "./ast.js";
import { findFieldByProtoName } from "./descriptor.js";
import { PxfError } from "./errors.js";
import { type Position } from "./token.js";

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_.]*$/;

/**
 * Whether `s` can be written as an unquoted entry name: it matches the
 * identifier production (dots included) and is not one of the value keywords
 * `null` / `true` / `false`. Canonical form emits unquoted names exactly when
 * this holds (draft -01 §3.13).
 */
export function identSafeEntryName(s: string): boolean {
  return IDENT_RE.test(s) && s !== "true" && s !== "false" && s !== "null";
}

export function keyedEmptyNameError(pos: Position, field: string): PxfError {
  return new PxfError(
    pos,
    `empty entry name in keyed field ${JSON.stringify(field)}: the empty string is not a valid key`,
  );
}

export function keyedDuplicateKeyError(pos: Position, field: string, key: string): PxfError {
  return new PxfError(
    pos,
    `duplicate key ${JSON.stringify(key)} in keyed field ${JSON.stringify(field)}`,
  );
}

export function quotedNameUnkeyedError(pos: Position, name: string): PxfError {
  return new PxfError(
    pos,
    `quoted entry name ${JSON.stringify(name)} is only valid inside a keyed repeated field's block (draft -01 §3.13)`,
  );
}

/**
 * The key-field checks for the immediate body of one element of a keyed
 * repeated field: an explicit assignment to the key field must not be empty,
 * and in the named (keyed-block) form must agree with the entry name.
 */
export interface KeyedElemState {
  /** The keyed repeated field's PXF name. */
  readonly field: string;
  /** The element message's key field name. */
  readonly keyName: string;
  /** The entry name; undefined for an anonymous list element. */
  readonly entryName?: string;
}

export function checkExplicitKey(ke: KeyedElemState, value: string, pos: Position): void {
  if (value === "") {
    throw new PxfError(
      pos,
      `explicit empty-string assignment to key field ${JSON.stringify(ke.keyName)} of keyed field ${JSON.stringify(ke.field)}: the empty string is not a valid key`,
    );
  }
  if (ke.entryName !== undefined && value !== ke.entryName) {
    throw new PxfError(
      pos,
      `key field ${JSON.stringify(ke.keyName)} = ${JSON.stringify(value)} conflicts with entry name ${JSON.stringify(ke.entryName)} in keyed field ${JSON.stringify(ke.field)}`,
    );
  }
}

/**
 * Return `doc` in the canonical keyed form of draft -01 §3.13, using `desc` as
 * the document's message schema. `doc` itself is not changed. Per keyed
 * repeated field binding this:
 *
 *  - converts an eligible anonymous list binding (every element with exactly
 *    one non-empty, distinct explicit key assignment) to the keyed block form,
 *    removing the now-implicit key assignments;
 *  - normalizes `name = { ... }` entry spellings to `name { ... }`;
 *  - unquotes quoted entry names that are identifier-safe;
 *  - drops redundant (agreeing) explicit key-field assignments inside named
 *    entries.
 *
 * Ineligible bindings (duplicate, absent or empty keys) stay anonymous, and
 * entries that don't resolve against the schema are left alone, so formatting
 * an invalid document never destroys information. Follow with `format`; the
 * pair is the `pxf fmt` pipeline.
 */
export function canonicalizeKeyed(doc: Document, desc: DescMessage): Document {
  return { ...doc, entries: canonEntries(doc.entries, desc) };
}

function canonEntries(entries: readonly Entry[], desc: DescMessage): Entry[] {
  return entries.map((e) => {
    if (e.kind === "mapEntry") return e;
    if (e.kind === "assignment") {
      if (e.keyQuoted) return e; // invalid outside keyed blocks; leave untouched
      const fd = findFieldByProtoName(desc, e.key);
      return fd ? canonAssignment(e, fd) : e;
    }
    if (e.nameQuoted) return e;
    const fd = findFieldByProtoName(desc, e.name);
    if (!fd) return e;
    const keyFd = keyField(fd);
    if (keyFd) return canonKeyedBlock(e, fd, keyFd);
    if (fd.fieldKind === "message") {
      return { ...e, entries: canonEntries(e.entries, fd.message) };
    }
    return e;
  });
}

function canonAssignment(a: Assignment, fd: DescField): Entry {
  const v = a.value;
  if (fd.fieldKind === "map") {
    if (v.kind !== "blockVal" || fd.mapKind !== "message") return a;
    const message = fd.message;
    const entries = v.entries.map((e) => {
      if (e.kind !== "mapEntry" || e.value.kind !== "blockVal") return e;
      const inner: BlockVal = { ...e.value, entries: canonEntries(e.value.entries, message) };
      return { ...e, value: inner };
    });
    return { ...a, value: { ...v, entries } };
  }
  if (fd.fieldKind === "list") {
    if (fd.listKind !== "message") return a;
    const keyFd = keyField(fd);
    if (v.kind === "list") {
      if (keyFd) return canonAnonymousKeyed(a, v, fd.message, keyFd);
      return { ...a, value: canonElements(v, fd.message) };
    }
    if (v.kind === "blockVal" && keyFd) {
      // `children = { ... }` → `children { ... }`.
      const blk: Block = {
        kind: "block",
        pos: a.pos,
        name: a.key,
        entries: v.entries,
        leadingComments: a.leadingComments,
      };
      return canonKeyedBlock(blk, fd, keyFd);
    }
    return a;
  }
  if (fd.fieldKind === "message" && v.kind === "blockVal") {
    return { ...a, value: { ...v, entries: canonEntries(v.entries, fd.message) } };
  }
  return a;
}

function canonElements(lv: ListVal, elem: DescMessage): ListVal {
  const elements = lv.elements.map((v) =>
    v.kind === "blockVal" ? { ...v, entries: canonEntries(v.entries, elem) } : v,
  );
  return { ...lv, elements };
}

/**
 * Normalize the entries of a keyed block: assignment-spelled entries become
 * blocks, identifier-safe quoted names are unquoted, redundant agreeing key
 * assignments are dropped, and entry bodies are canonicalized recursively.
 */
function canonKeyedBlock(b: Block, fd: DescField, keyFd: DescField): Block {
  if (fd.fieldKind !== "list" || fd.listKind !== "message") return b;
  const elem = fd.message;
  const entries = b.entries.map((e): Entry => {
    let eb: Block;
    if (e.kind === "block") {
      eb = e;
    } else if (e.kind === "assignment" && e.value.kind === "blockVal") {
      eb = {
        kind: "block",
        pos: e.pos,
        name: e.key,
        nameQuoted: e.keyQuoted ?? false,
        entries: e.value.entries,
        leadingComments: e.leadingComments,
      };
    } else {
      return e; // malformed entry; leave untouched
    }
    const body = dropKeyAssignments(eb.entries, keyFd.name, eb.name);
    return {
      ...eb,
      nameQuoted: (eb.nameQuoted ?? false) && !identSafeEntryName(eb.name),
      entries: canonEntries(body, elem),
    };
  });
  return { ...b, entries };
}

/**
 * Remove `keyName = "entryName"` assignments, the redundant agreeing spelling
 * of an entry's key. Disagreeing or non-string assignments are kept: the
 * document is invalid, and formatting must not change what it means. Leading
 * comments of a dropped assignment move to the next surviving entry.
 */
function dropKeyAssignments(entries: readonly Entry[], keyName: string, entryName: string): Entry[] {
  let pending: Comment[] = [];
  const out: Entry[] = [];
  for (const e of entries) {
    if (
      e.kind === "assignment" &&
      !e.keyQuoted &&
      e.key === keyName &&
      e.value.kind === "string" &&
      e.value.value === entryName
    ) {
      pending.push(...e.leadingComments);
      continue;
    }
    if (pending.length > 0) {
      out.push({ ...e, leadingComments: [...pending, ...e.leadingComments] });
      pending = [];
    } else {
      out.push(e);
    }
  }
  return out;
}

/**
 * Convert an eligible anonymous list binding of a keyed repeated field to the
 * keyed block form. Ineligible bindings (non-block elements, absent / empty /
 * duplicate / non-string keys) stay anonymous; their element bodies are still
 * canonicalized.
 */
function canonAnonymousKeyed(
  a: Assignment,
  lv: ListVal,
  elem: DescMessage,
  keyFd: DescField,
): Entry {
  const named: { key: string; bv: BlockVal }[] = [];
  const seen = new Set<string>();
  for (const v of lv.elements) {
    const key = v.kind === "blockVal" ? explicitKeyOf(v.entries, keyFd.name) : undefined;
    if (v.kind !== "blockVal" || !key || seen.has(key)) {
      return { ...a, value: canonElements(lv, elem) };
    }
    seen.add(key);
    named.push({ key, bv: v });
  }
  const entries = named.map(({ key, bv }): Block => ({
    kind: "block",
    pos: bv.pos,
    name: key,
    nameQuoted: !identSafeEntryName(key),
    entries: canonEntries(dropKeyAssignments(bv.entries, keyFd.name, key), elem),
    leadingComments: [],
  }));
  return { kind: "block", pos: a.pos, name: a.key, entries, leadingComments: a.leadingComments };
}

/**
 * The value of the single explicit string assignment to `keyName` among
 * `entries`. Undefined when there is no such assignment, more than one, a
 * quoted-key spelling, or a non-string value.
 */
function explicitKeyOf(entries: readonly Entry[], keyName: string): string | undefined {
  let found: string | undefined;
  for (const e of entries) {
    if (e.kind !== "assignment" || e.key !== keyName) continue;
    if (e.value.kind !== "string" || e.keyQuoted || found !== undefined) return undefined;
    found = e.value.value;
  }
  return found;
}
