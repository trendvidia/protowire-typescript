/**
 * Position-aware errors for PXF parse / decode.
 * Mirrors `protowire/encoding/pxf/errors.go`.
 */

import { type Position, positionString } from "./token.js";

export class PxfError extends Error {
  readonly pos: Position;

  constructor(pos: Position, msg: string) {
    super(`${positionString(pos)}: ${msg}`);
    this.name = "PxfError";
    this.pos = pos;
  }
}
