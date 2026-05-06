/**
 * Low-level protobuf wire-format primitives: varint, zigzag, fixed32/64,
 * length-delimited bytes, and tag (field-number + wire-type) encoding.
 *
 * Mirrors `google.golang.org/protobuf/encoding/protowire` at the call sites
 * used by the schema-free `pb` codec.
 */

export const enum WireType {
  Varint = 0,
  Fixed64 = 1,
  LengthDelimited = 2,
  StartGroup = 3,
  EndGroup = 4,
  Fixed32 = 5,
}

const textEncoder = new TextEncoder();
// proto3 strings must be valid UTF-8 (HARDENING.md § UTF-8). `fatal: true`
// makes TextDecoder throw on invalid sequences instead of substituting U+FFFD,
// so adversarial payloads surface as a clean reject rather than silent data loss.
const textDecoder = new TextDecoder("utf-8", { fatal: true });

export class Writer {
  private buf: Uint8Array;
  private pos = 0;

  constructor(initialCapacity = 64) {
    this.buf = new Uint8Array(initialCapacity);
  }

  private grow(n: number): void {
    if (this.pos + n <= this.buf.length) return;
    let next = this.buf.length * 2;
    while (next < this.pos + n) next *= 2;
    const nb = new Uint8Array(next);
    nb.set(this.buf.subarray(0, this.pos));
    this.buf = nb;
  }

  /** Length so far. */
  get length(): number {
    return this.pos;
  }

  finish(): Uint8Array {
    return this.buf.slice(0, this.pos);
  }

  /** Append a single byte. */
  byte(b: number): void {
    this.grow(1);
    this.buf[this.pos++] = b & 0xff;
  }

  /** Append raw bytes (without a length prefix). */
  raw(bytes: Uint8Array): void {
    this.grow(bytes.length);
    this.buf.set(bytes, this.pos);
    this.pos += bytes.length;
  }

  /**
   * Write an unsigned varint. Accepts a JS number for values up to 2^53,
   * or a bigint for the full uint64 range.
   */
  varint(value: number | bigint): void {
    if (typeof value === "bigint") {
      this.varintBig(value);
      return;
    }
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError(`varint requires a non-negative finite number, got ${value}`);
    }
    if (value > Number.MAX_SAFE_INTEGER) {
      this.varintBig(BigInt(value));
      return;
    }
    this.grow(10);
    // For values <= 2^28, plain shifts work. Beyond that, use Math.floor division
    // because JS bitwise operators truncate to int32.
    let lo = value;
    while (lo >= 0x80) {
      this.buf[this.pos++] = (lo & 0x7f) | 0x80;
      lo = Math.floor(lo / 128);
    }
    this.buf[this.pos++] = lo & 0x7f;
  }

  private varintBig(value: bigint): void {
    if (value < 0n) {
      // For negative values, encode as 2's complement uint64 (10-byte varint).
      value = BigInt.asUintN(64, value);
    }
    this.grow(10);
    while (value >= 0x80n) {
      this.buf[this.pos++] = Number(value & 0x7fn) | 0x80;
      value >>= 7n;
    }
    this.buf[this.pos++] = Number(value);
  }

  /** Write a signed varint with zigzag encoding (number variant). */
  zigzag32(value: number): void {
    const v = ((value << 1) ^ (value >> 31)) >>> 0;
    this.varint(v);
  }

  /** Write a signed varint with zigzag encoding (bigint variant). */
  zigzag64(value: bigint): void {
    const v = BigInt.asUintN(64, (value << 1n) ^ (value >> 63n));
    this.varintBig(v);
  }

  /** Little-endian fixed 32-bit unsigned integer. */
  fixed32(value: number): void {
    this.grow(4);
    const v = value >>> 0;
    this.buf[this.pos++] = v & 0xff;
    this.buf[this.pos++] = (v >>> 8) & 0xff;
    this.buf[this.pos++] = (v >>> 16) & 0xff;
    this.buf[this.pos++] = (v >>> 24) & 0xff;
  }

  /** Little-endian fixed 64-bit unsigned integer. */
  fixed64(value: bigint): void {
    this.grow(8);
    const v = BigInt.asUintN(64, value);
    const lo = Number(v & 0xffff_ffffn);
    const hi = Number((v >> 32n) & 0xffff_ffffn);
    this.buf[this.pos++] = lo & 0xff;
    this.buf[this.pos++] = (lo >>> 8) & 0xff;
    this.buf[this.pos++] = (lo >>> 16) & 0xff;
    this.buf[this.pos++] = (lo >>> 24) & 0xff;
    this.buf[this.pos++] = hi & 0xff;
    this.buf[this.pos++] = (hi >>> 8) & 0xff;
    this.buf[this.pos++] = (hi >>> 16) & 0xff;
    this.buf[this.pos++] = (hi >>> 24) & 0xff;
  }

  /** IEEE 754 32-bit float, little-endian. */
  float(value: number): void {
    this.grow(4);
    const dv = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 4);
    dv.setFloat32(0, value, true);
    this.pos += 4;
  }

  /** IEEE 754 64-bit double, little-endian. */
  double(value: number): void {
    this.grow(8);
    const dv = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 8);
    dv.setFloat64(0, value, true);
    this.pos += 8;
  }

  /** UTF-8 length-prefixed string. */
  string(value: string): void {
    const enc = textEncoder.encode(value);
    this.varint(enc.length);
    this.raw(enc);
  }

  /** Length-prefixed byte sequence. */
  bytes(value: Uint8Array): void {
    this.varint(value.length);
    this.raw(value);
  }

  /** Tag = field_number << 3 | wire_type (encoded as varint). */
  tag(fieldNumber: number, wireType: WireType): void {
    if (fieldNumber < 1 || fieldNumber > 0x1fff_ffff) {
      throw new RangeError(`field number out of range: ${fieldNumber}`);
    }
    this.varint(fieldNumber * 8 + wireType);
  }
}

export class Reader {
  public pos = 0;
  /**
   * Current message-nesting depth. Bumped by `readNestedMessage` and similar
   * recursive-descent helpers to enforce HARDENING.md § Recursion's
   * MaxNestingDepth cap. Lives on the Reader so `CodecBase.unmarshalFrom`
   * stays a 3-arg interface.
   */
  public depth = 0;
  private dv: DataView;

  constructor(public readonly data: Uint8Array, start = 0, end?: number) {
    this.pos = start;
    if (end !== undefined && end !== data.length) {
      this.data = data.subarray(0, end);
    }
    this.dv = new DataView(this.data.buffer, this.data.byteOffset, this.data.byteLength);
  }

  eof(): boolean {
    return this.pos >= this.data.length;
  }

  remaining(): number {
    return this.data.length - this.pos;
  }

  /** Read an unsigned varint as bigint (always — caller narrows). */
  varintBig(): bigint {
    let result = 0n;
    let shift = 0n;
    for (let i = 0; i < 10; i++) {
      if (this.pos >= this.data.length) throw new Error("truncated varint");
      const byte = this.data[this.pos++]!;
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7n;
    }
    throw new Error("varint exceeds 10 bytes");
  }

  /** Read an unsigned varint as a JS number. Throws if value > 2^53 - 1. */
  varint(): number {
    // Fast path for small values.
    if (this.pos >= this.data.length) throw new Error("truncated varint");
    const b0 = this.data[this.pos]!;
    if ((b0 & 0x80) === 0) {
      this.pos++;
      return b0;
    }
    const big = this.varintBig();
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new RangeError(`varint ${big} exceeds Number.MAX_SAFE_INTEGER`);
    }
    return Number(big);
  }

  /** Read a signed zigzag varint as a JS number (32-bit). */
  zigzag32(): number {
    const u = this.varint();
    return (u >>> 1) ^ -(u & 1);
  }

  /** Read a signed zigzag varint as a bigint (64-bit). */
  zigzag64(): bigint {
    const u = this.varintBig();
    return (u >> 1n) ^ -(u & 1n);
  }

  /** Read 4 bytes little-endian as unsigned 32-bit. */
  fixed32(): number {
    if (this.pos + 4 > this.data.length) throw new Error("truncated fixed32");
    const v = this.dv.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }

  /** Read 8 bytes little-endian as bigint (uint64). */
  fixed64(): bigint {
    if (this.pos + 8 > this.data.length) throw new Error("truncated fixed64");
    const v = this.dv.getBigUint64(this.pos, true);
    this.pos += 8;
    return v;
  }

  float(): number {
    if (this.pos + 4 > this.data.length) throw new Error("truncated float");
    const v = this.dv.getFloat32(this.pos, true);
    this.pos += 4;
    return v;
  }

  double(): number {
    if (this.pos + 8 > this.data.length) throw new Error("truncated double");
    const v = this.dv.getFloat64(this.pos, true);
    this.pos += 8;
    return v;
  }

  /** Length-prefixed bytes — returns a copy. */
  bytes(): Uint8Array {
    const len = this.varint();
    if (this.pos + len > this.data.length) throw new Error("truncated bytes");
    const out = this.data.slice(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }

  /** Length-prefixed bytes — returns a view into the underlying buffer (no copy). */
  bytesView(): Uint8Array {
    const len = this.varint();
    if (this.pos + len > this.data.length) throw new Error("truncated bytes");
    const view = this.data.subarray(this.pos, this.pos + len);
    this.pos += len;
    return view;
  }

  /** UTF-8 length-prefixed string. */
  string(): string {
    return textDecoder.decode(this.bytesView());
  }

  /** Decode a tag varint into { fieldNumber, wireType }. */
  tag(): { fieldNumber: number; wireType: WireType } {
    const t = this.varint();
    const wireType = (t & 0x7) as WireType;
    const fieldNumber = t >>> 3;
    if (fieldNumber === 0) throw new Error(`invalid tag (field 0) at offset ${this.pos}`);
    return { fieldNumber, wireType };
  }

  /** Skip the value of a field with the given wire type. */
  skip(wireType: WireType): void {
    switch (wireType) {
      case WireType.Varint:
        this.varintBig();
        return;
      case WireType.Fixed64:
        this.pos += 8;
        if (this.pos > this.data.length) throw new Error("truncated fixed64 (skip)");
        return;
      case WireType.LengthDelimited: {
        const len = this.varint();
        this.pos += len;
        if (this.pos > this.data.length) throw new Error("truncated length-delim (skip)");
        return;
      }
      case WireType.Fixed32:
        this.pos += 4;
        if (this.pos > this.data.length) throw new Error("truncated fixed32 (skip)");
        return;
      case WireType.StartGroup:
      case WireType.EndGroup:
        throw new Error("group wire types are not supported");
      default:
        throw new Error(`unknown wire type ${wireType}`);
    }
  }
}
