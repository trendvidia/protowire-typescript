// SPDX-License-Identifier: MIT
// Copyright (c) 2026 TrendVidia, LLC.
/**
 * SBE codec: registers proto messages by template ID and dispatches to the
 * marshal/unmarshal/view paths. Mirrors `protowire/encoding/sbe/sbe.go`.
 */

import { type DescFile, type DescMessage, type MessageShape } from "@bufbuild/protobuf";

import { EXT_SCHEMA_ID, EXT_VERSION, getFileUint32 } from "./annotations.js";
import { buildTemplate, type MessageTemplate } from "./template.js";
import { View } from "./view.js";

/** SBE message header size: blockLength(2) + templateId(2) + schemaId(2) + version(2). */
export const HEADER_SIZE = 8;

/** SBE repeating-group header size: blockLength(2) + numInGroup(2). */
export const GROUP_HEADER_SIZE = 4;

export class Codec {
  readonly byName = new Map<string, MessageTemplate>();
  readonly byId = new Map<number, MessageTemplate>();

  static fromFiles(...files: DescFile[]): Codec {
    const c = new Codec();
    for (const file of files) {
      const schemaId = getFileUint32(file, EXT_SCHEMA_ID);
      if (schemaId === undefined) {
        throw new Error(`sbe: file ${file.name} missing (sbe.schema_id) option`);
      }
      const version = getFileUint32(file, EXT_VERSION) ?? 0;
      for (const desc of file.messages) {
        c.registerMessage(desc, schemaId, version);
      }
    }
    return c;
  }

  private registerMessage(desc: DescMessage, schemaId: number, version: number): void {
    if (hasTemplateId(desc)) {
      const tmpl = buildTemplate(desc, schemaId, version);
      this.byName.set(desc.typeName, tmpl);
      this.byId.set(tmpl.templateId, tmpl);
    }
    for (const nested of desc.nestedMessages) {
      this.registerMessage(nested, schemaId, version);
    }
  }

  template(typeName: string): MessageTemplate {
    const tmpl = this.byName.get(typeName);
    if (!tmpl) throw new Error(`sbe: no template registered for ${typeName}`);
    return tmpl;
  }

  templateById(id: number): MessageTemplate {
    const tmpl = this.byId.get(id);
    if (!tmpl) throw new Error(`sbe: unknown template ID ${id}`);
    return tmpl;
  }

  /** Construct a zero-allocation reader over an SBE-encoded buffer. */
  view(data: Uint8Array): View {
    return View.fromCodec(this, data);
  }
}

function hasTemplateId(desc: DescMessage): boolean {
  const ufs = (desc.proto.options as { $unknown?: { no: number }[] } | undefined)?.$unknown;
  if (!ufs) return false;
  return ufs.some((u) => u.no === 50_200);
}

// Re-export MessageShape so consumers can type their own marshal callsites.
export type { MessageShape };
