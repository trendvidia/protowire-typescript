// SPDX-License-Identifier: MIT
// Copyright (c) 2026 TrendVidia, LLC.
/**
 * Field-level presence metadata from PXF decoding.
 * Mirrors `protowire/encoding/pxf/result.go`.
 *
 * Fields are identified by dotted paths (e.g., "name", "nested.value").
 */

export class Result {
  private readonly nullFields = new Set<string>();
  private readonly presentFields = new Set<string>();

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
}
