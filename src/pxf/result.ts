// SPDX-License-Identifier: MIT
// Copyright (c) 2026 TrendVidia, LLC.
/**
 * Field-level presence metadata from PXF decoding.
 * Mirrors `protowire/encoding/pxf/result.go`.
 *
 * Fields are identified by dotted paths (e.g., "name", "nested.value").
 *
 * Result also surfaces the document-root directives the decoder saw:
 *   - `directives()` — generic `@<name> *(prefix) [{ ... }]` blocks,
 *     in source order, excluding the spec-defined directives
 *     (`@type`, `@dataset`, `@proto`, `@entry`).
 *   - `datasets()` — `@dataset <type> ( cols ) row*` directives, in
 *     source order. A document with any `@dataset` has no body entries,
 *     so the rows are the document's payload — consumers walk
 *     `DatasetDirective.rows` and bind each row's cells to a fresh
 *     instance of `DatasetDirective.type` via their own schema.
 *   - `protos()` — `@proto <body>` directives (draft §3.4.5), in
 *     source order. Each carries one of four body shapes (anonymous,
 *     named, source, descriptor).
 */

import { type Directive, type DatasetDirective, type ProtoDirective } from "./ast.js";

export class Result {
  private readonly nullFields = new Set<string>();
  private readonly presentFields = new Set<string>();
  private readonly directivesList: Directive[] = [];
  private readonly datasetsList: DatasetDirective[] = [];
  private readonly protosList: ProtoDirective[] = [];

  markNull(path: string): void {
    this.nullFields.add(path);
    this.presentFields.add(path);
  }

  markPresent(path: string): void {
    this.presentFields.add(path);
  }

  /** True if the field at `path` was explicitly set to null. */
  isNull(path: string): boolean {
    return this.nullFields.has(path);
  }

  /** True if the field at `path` was not mentioned in the input. */
  isAbsent(path: string): boolean {
    return !this.presentFields.has(path);
  }

  /** True if the field at `path` was set to a concrete (non-null) value. */
  isSet(path: string): boolean {
    return this.presentFields.has(path) && !this.nullFields.has(path);
  }

  /** Paths of all fields explicitly set to null. */
  nullPaths(): string[] {
    return [...this.nullFields];
  }

  // Directive accessors (PXF v0.72+).

  directives(): readonly Directive[] {
    return this.directivesList;
  }

  datasets(): readonly DatasetDirective[] {
    return this.datasetsList;
  }

  protos(): readonly ProtoDirective[] {
    return this.protosList;
  }

  addDirective(d: Directive): void {
    this.directivesList.push(d);
  }

  addDataset(t: DatasetDirective): void {
    this.datasetsList.push(t);
  }

  addProto(p: ProtoDirective): void {
    this.protosList.push(p);
  }
}
