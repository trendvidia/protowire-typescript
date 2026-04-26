/**
 * SBE View: read-only access into an SBE-encoded buffer with no message
 * allocation. Mirrors `protowire/encoding/sbe/view.go`.
 *
 * Strings still allocate (JavaScript has no `unsafe.String` equivalent), but
 * Bytes() returns a zero-copy `Uint8Array` subarray and Composite() just
 * returns a new View over the same underlying buffer.
 */

import { GROUP_HEADER_SIZE, HEADER_SIZE, type Codec } from "./sbe.js";
import type { FieldTemplate, MessageTemplate } from "./template.js";

export interface ViewSchema {
  fields: Map<string, FieldTemplate>;
  groups: ViewGroupInfo[];
}

interface ViewGroupInfo {
  name: string;
  schema: ViewSchema;
}

export function buildViewSchema(tmpl: MessageTemplate): ViewSchema {
  const fields = new Map<string, FieldTemplate>();
  for (const ft of tmpl.fields) {
    fields.set(ft.fd.name, ft);
    if (ft.composite.length > 0) {
      ft.compositeView = buildFieldsView(ft.composite);
    }
  }
  const groups: ViewGroupInfo[] = [];
  for (const gt of tmpl.groups) {
    groups.push({
      name: gt.fd.name,
      schema: buildFieldsView(gt.fields),
    });
  }
  return { fields, groups };
}

function buildFieldsView(fields: FieldTemplate[]): ViewSchema {
  const map = new Map<string, FieldTemplate>();
  for (const ft of fields) {
    map.set(ft.fd.name, ft);
    if (ft.composite.length > 0) {
      ft.compositeView = buildFieldsView(ft.composite);
    }
  }
  return { fields: map, groups: [] };
}

/**
 * View provides allocation-free read access to SBE-encoded data. Field
 * accessors decode primitives directly from the underlying buffer.
 */
export class View {
  /** Full SBE message buffer — needed to walk groups past the root block. */
  private readonly data: Uint8Array;
  /** Current block (root, group entry, or composite). */
  private readonly block: Uint8Array;
  private readonly view: DataView;
  private readonly schema: ViewSchema;
  /** Offset of the first group header (end of root block) in `data`. */
  private readonly groupsStart: number;

  constructor(data: Uint8Array, block: Uint8Array, schema: ViewSchema, groupsStart: number) {
    this.data = data;
    this.block = block;
    this.view = new DataView(block.buffer, block.byteOffset, block.byteLength);
    this.schema = schema;
    this.groupsStart = groupsStart;
  }

  static fromCodec(codec: Codec, data: Uint8Array): View {
    if (data.length < HEADER_SIZE) {
      throw new Error("sbe: data too short for header");
    }
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const blockLength = dv.getUint16(0, true);
    const templateId = dv.getUint16(2, true);
    const tmpl = codec.templateById(templateId);
    const end = HEADER_SIZE + blockLength;
    if (data.length < end) {
      throw new Error("sbe: data too short for root block");
    }
    if (!tmpl.view) tmpl.view = buildViewSchema(tmpl);
    return new View(data, data.subarray(HEADER_SIZE, end), tmpl.view, end);
  }

  private field(name: string): FieldTemplate {
    const ft = this.schema.fields.get(name);
    if (!ft) throw new Error(`sbe: unknown field: ${name}`);
    return ft;
  }

  int(name: string): number | bigint {
    const ft = this.field(name);
    switch (ft.encoding) {
      case "int8":
        return this.view.getInt8(ft.offset);
      case "int16":
        return this.view.getInt16(ft.offset, true);
      case "int32":
        return this.view.getInt32(ft.offset, true);
      case "int64":
        return this.view.getBigInt64(ft.offset, true);
      default:
        throw new Error(`sbe: field ${name} is not a signed integer`);
    }
  }

  uint(name: string): number | bigint {
    const ft = this.field(name);
    switch (ft.encoding) {
      case "uint8":
        return this.view.getUint8(ft.offset);
      case "uint16":
        return this.view.getUint16(ft.offset, true);
      case "uint32":
        return this.view.getUint32(ft.offset, true);
      case "uint64":
        return this.view.getBigUint64(ft.offset, true);
      default:
        throw new Error(`sbe: field ${name} is not an unsigned integer`);
    }
  }

  float(name: string): number {
    const ft = this.field(name);
    switch (ft.encoding) {
      case "float":
        return this.view.getFloat32(ft.offset, true);
      case "double":
        return this.view.getFloat64(ft.offset, true);
      default:
        throw new Error(`sbe: field ${name} is not a float`);
    }
  }

  bool(name: string): boolean {
    return this.view.getUint8(this.field(name).offset) !== 0;
  }

  enum(name: string): number {
    const ft = this.field(name);
    switch (ft.encoding) {
      case "uint8":
        return this.view.getUint8(ft.offset);
      case "uint16":
        return this.view.getUint16(ft.offset, true);
      default:
        throw new Error(`sbe: field ${name} has unsupported enum encoding`);
    }
  }

  /** Trims trailing NUL padding. */
  string(name: string): string {
    const ft = this.field(name);
    const slice = this.block.subarray(ft.offset, ft.offset + ft.size);
    let n = slice.length;
    while (n > 0 && slice[n - 1] === 0) n--;
    return new TextDecoder().decode(slice.subarray(0, n));
  }

  /** Zero-copy subarray view over the field's bytes. */
  bytes(name: string): Uint8Array {
    const ft = this.field(name);
    return this.block.subarray(ft.offset, ft.offset + ft.size);
  }

  composite(name: string): View {
    const ft = this.field(name);
    if (!ft.compositeView) {
      throw new Error(`sbe: field ${name} is not a composite`);
    }
    const block = this.block.subarray(ft.offset, ft.offset + ft.size);
    // Composites cannot contain groups, so groupsStart is irrelevant — pass 0.
    return new View(this.data, block, ft.compositeView, 0);
  }

  group(name: string): GroupView {
    let pos = this.groupsStart;
    for (const gi of this.schema.groups) {
      const dv = new DataView(this.data.buffer, this.data.byteOffset, this.data.byteLength);
      const blockLength = dv.getUint16(pos, true);
      const count = dv.getUint16(pos + 2, true);
      if (gi.name === name) {
        return new GroupView(this.data, pos, blockLength, count, gi.schema);
      }
      pos += GROUP_HEADER_SIZE + count * blockLength;
    }
    throw new Error(`sbe: unknown group: ${name}`);
  }
}

export class GroupView {
  private readonly data: Uint8Array;
  /** Offset in `data` of this group's header. */
  private readonly base: number;
  private readonly blockLength: number;
  private readonly count: number;
  private readonly schema: ViewSchema;

  constructor(
    data: Uint8Array,
    base: number,
    blockLength: number,
    count: number,
    schema: ViewSchema,
  ) {
    this.data = data;
    this.base = base;
    this.blockLength = blockLength;
    this.count = count;
    this.schema = schema;
  }

  get length(): number {
    return this.count;
  }

  entry(i: number): View {
    if (i < 0 || i >= this.count) {
      throw new RangeError(`sbe: group entry ${i} out of range [0, ${this.count})`);
    }
    const start = this.base + GROUP_HEADER_SIZE + i * this.blockLength;
    const block = this.data.subarray(start, start + this.blockLength);
    return new View(this.data, block, this.schema, 0);
  }
}
