/**
 * Schema-bound PXF decoder.
 * Mirrors the AST-based path of `protowire/encoding/pxf/decode_fast.go`,
 * without the fused single-pass perf optimizations.
 *
 * Slice D4 scope: D3 plus `unmarshalFull` returning Result, `pxf.required` /
 * `pxf.default` annotations, and the `_null` FieldMask null-survival channel.
 */

import {
  type DescField,
  type DescMessage,
  type DescOneof,
  type MessageShape,
  type Registry,
  ScalarType,
  create,
  toBinary,
} from "@bufbuild/protobuf";
import {
  type ReflectList,
  type ReflectMap,
  type ReflectMessage,
  reflect,
} from "@bufbuild/protobuf/reflect";

import { findNullMaskField, getDefault, isRequired } from "./annotations.js";
import {
  findFieldByProtoName,
  isAny,
  isDuration,
  isTimestamp,
  isWrapperType,
} from "./descriptor.js";
import { PxfError } from "./errors.js";
import { Lexer } from "./lexer.js";
import { Result } from "./result.js";
import { type Position, type Token, TokenKind, tokenKindName } from "./token.js";

/**
 * Resolves google.protobuf.Any type URLs to message descriptors. Mirrors the
 * Go interface of the same name. Pass a `Registry` directly (the URL prefix
 * is stripped automatically) or implement this interface for custom lookup
 * (e.g. lazy loading, alternative URL conventions).
 */
export interface TypeResolver {
  findMessageByURL(url: string): DescMessage | undefined;
}

/**
 * Wrap a protobuf-es `Registry` as a `TypeResolver`. Strips the URL prefix
 * (everything up to and including the last `/`) before lookup, matching the
 * `type.googleapis.com/<typeName>` convention used by `anyPack`.
 */
export function registryAsTypeResolver(registry: Registry): TypeResolver {
  return {
    findMessageByURL(url) {
      const slash = url.lastIndexOf("/");
      const name = slash >= 0 ? url.substring(slash + 1) : url;
      return registry.getMessage(name);
    },
  };
}

export interface UnmarshalOptions {
  /** Silently skip fields not declared in the schema instead of erroring. */
  discardUnknown?: boolean;
  /**
   * Resolves type URLs for `google.protobuf.Any` fields. When set, Any
   * fields use sugar syntax (`@type = "..."` plus inline fields). When
   * absent, Any fields decode as regular messages with `type_url` and
   * `value` fields.
   */
  typeResolver?: TypeResolver;
}

export function unmarshal<Desc extends DescMessage>(
  data: string,
  schema: Desc,
  options?: UnmarshalOptions,
): MessageShape<Desc> {
  const msg = create(schema);
  const root = reflect(schema, msg);
  new Decoder(
    data,
    options?.discardUnknown ?? false,
    options?.typeResolver,
    null,
  ).decodeRoot(root);
  return msg;
}

/**
 * Decode PXF data into a fresh message and return field-presence metadata.
 *
 * Unlike `unmarshal`, this:
 * - tracks which fields were explicitly set, set to null, or absent;
 * - validates `(pxf.required) = true` fields and errors on absence;
 * - applies `(pxf.default) = "..."` defaults to absent (non-null) fields;
 * - mirrors null state into a top-level `_null` FieldMask field if present.
 */
export function unmarshalFull<Desc extends DescMessage>(
  data: string,
  schema: Desc,
  options?: UnmarshalOptions,
): { message: MessageShape<Desc>; result: Result } {
  const msg = create(schema);
  const root = reflect(schema, msg);
  const result = new Result();
  const decoder = new Decoder(
    data,
    options?.discardUnknown ?? false,
    options?.typeResolver,
    result,
  );
  decoder.decodeRoot(root);
  postDecode(root, result, decoder.nullMaskFor(root.desc), "");
  return { message: msg, result };
}

/**
 * Maximum allowed nesting depth for PXF decoding. Bounds CPU/stack costs on
 * adversarial input — see HARDENING.md § Recursion. Mirrors the cap used by
 * sibling protowire ports.
 */
const MAX_NESTING_DEPTH = 100;

class Decoder {
  private readonly lex: Lexer;
  private current!: Token;
  private rootRefl: ReflectMessage | null = null;
  private rootNullMaskFd: DescField | undefined = undefined;
  private pathPrefix = "";
  private depth = 0;

  constructor(
    input: string,
    private readonly discardUnknown: boolean,
    private readonly typeResolver: TypeResolver | undefined,
    private readonly result: Result | null,
  ) {
    this.lex = new Lexer(input);
    this.advance();
  }

  private enter(pos: Position): void {
    this.depth++;
    if (this.depth > MAX_NESTING_DEPTH) {
      throw this.err(
        pos,
        `nesting depth exceeds maximum of ${MAX_NESTING_DEPTH}`,
      );
    }
  }

  private leave(): void {
    this.depth--;
  }

  /** Cache the `_null` FieldMask descriptor for `desc`, if any. */
  nullMaskFor(desc: DescMessage): DescField | undefined {
    return findNullMaskField(desc);
  }

  private advance(): void {
    for (;;) {
      this.current = this.lex.next();
      if (
        this.current.kind !== TokenKind.COMMENT &&
        this.current.kind !== TokenKind.NEWLINE
      ) {
        return;
      }
    }
  }

  /**
   * Returns the current token kind as the full union, defeating control-flow
   * narrowing that would otherwise carry across calls to `advance()`.
   */
  private peek(): TokenKind {
    return this.current.kind;
  }

  private err(pos: Position, msg: string): PxfError {
    return new PxfError(pos, msg);
  }

  decodeRoot(root: ReflectMessage): void {
    this.rootRefl = root;
    this.rootNullMaskFd = findNullMaskField(root.desc);
    if (this.peek() === TokenKind.AT_TYPE) {
      this.advance();
      if (this.peek() !== TokenKind.IDENT) {
        throw this.err(
          this.current.pos,
          `expected type name after @type, got ${tokenKindName(this.peek())}`,
        );
      }
      this.advance();
    }
    this.decodeFields(root, false);
  }

  private decodeFields(parent: ReflectMessage, inBlock: boolean): void {
    this.enter(this.current.pos);
    try {
      this.decodeFieldsInner(parent, inBlock);
    } finally {
      this.leave();
    }
  }

  private decodeFieldsInner(parent: ReflectMessage, inBlock: boolean): void {
    const desc = parent.desc;
    const setOneofs = new Map<string, string>();

    for (;;) {
      if (inBlock && this.peek() === TokenKind.RBRACE) {
        this.advance();
        return;
      }
      if (this.peek() === TokenKind.EOF) {
        if (inBlock) throw this.err(this.current.pos, "expected '}', got EOF");
        return;
      }

      const pos = this.current.pos;
      const keyKind = this.peek();
      if (
        keyKind !== TokenKind.IDENT &&
        keyKind !== TokenKind.STRING &&
        keyKind !== TokenKind.INT
      ) {
        throw this.err(
          pos,
          `expected identifier, string, or integer, got ${tokenKindName(keyKind)} (${JSON.stringify(this.current.value)})`,
        );
      }
      const key = this.current.value;
      this.advance();

      switch (this.peek()) {
        case TokenKind.EQUALS: {
          this.advance();
          const fd = findFieldByProtoName(desc, key);
          if (!fd) {
            if (this.discardUnknown) {
              this.skipValue();
              continue;
            }
            throw this.err(pos, `unknown field ${JSON.stringify(key)} in ${desc.typeName}`);
          }
          this.checkOneof(fd, setOneofs, pos);
          if (this.peek() === TokenKind.NULL) {
            this.markNull(fd);
            this.advance();
            continue;
          }
          this.markPresent(fd);
          if (fd.fieldKind === "message" && this.result) {
            this.decodeMessageWithPath(parent, fd);
          } else {
            this.decodeFieldValue(parent, fd);
          }
          break;
        }
        case TokenKind.LBRACE: {
          this.advance();
          const fd = findFieldByProtoName(desc, key);
          if (!fd) {
            if (this.discardUnknown) {
              this.skipBraced();
              continue;
            }
            throw this.err(pos, `unknown field ${JSON.stringify(key)} in ${desc.typeName}`);
          }
          if (fd.fieldKind !== "message") {
            if (fd.fieldKind === "list") {
              throw this.err(
                pos,
                `repeated field ${JSON.stringify(key)} must use list syntax: ${key} = [...]`,
              );
            }
            if (fd.fieldKind === "map") {
              throw this.err(
                pos,
                `map field ${JSON.stringify(key)} must use assignment syntax: ${key} = { ... }`,
              );
            }
            throw this.err(
              pos,
              `field ${JSON.stringify(key)} is not a message type, cannot use block syntax`,
            );
          }
          this.checkOneof(fd, setOneofs, pos);
          this.markPresent(fd);
          const sub = create(fd.message);
          const subRefl = reflect(fd.message, sub);
          if (
            isAny(fd.message) &&
            this.typeResolver &&
            this.peek() === TokenKind.AT_TYPE
          ) {
            this.decodeAnyInner(subRefl);
          } else {
            const saved = this.pathPrefix;
            if (this.result) this.pathPrefix = saved + fd.name + ".";
            this.decodeFields(subRefl, true);
            this.pathPrefix = saved;
          }
          parent.set(fd, subRefl);
          break;
        }
        case TokenKind.COLON:
          throw this.err(
            pos,
            "unexpected ':' in message context, use '=' for field assignments",
          );
        default:
          throw this.err(
            this.current.pos,
            `expected '=', ':', or '{' after ${JSON.stringify(key)}, got ${tokenKindName(this.peek())}`,
          );
      }
    }
  }

  private markPresent(fd: DescField): void {
    if (!this.result) return;
    this.result.markPresent(this.pathPrefix + fd.name);
  }

  private markNull(fd: DescField): void {
    if (!this.result) return;
    const path = this.pathPrefix + fd.name;
    this.result.markNull(path);
    if (this.rootRefl && this.rootNullMaskFd) {
      const fmRefl = this.rootRefl.get(this.rootNullMaskFd) as ReflectMessage;
      const pathsFd = findFieldByProtoName(fmRefl.desc, "paths");
      if (pathsFd) {
        const list = fmRefl.get(pathsFd) as ReflectList;
        list.add(path);
      }
      this.rootRefl.set(this.rootNullMaskFd, fmRefl);
    }
  }

  /**
   * Like the regular EQUALS-message branch, but extends `pathPrefix` so the
   * Result captures dotted paths for nested fields. Only used when a Result
   * is in play — the cheap path stays in `decodeFieldValue`.
   */
  private decodeMessageWithPath(parent: ReflectMessage, fd: DescField): void {
    if (fd.fieldKind !== "message") {
      throw this.err(this.current.pos, "internal: decodeMessageWithPath on non-message field");
    }
    const sub = create(fd.message);
    const subRefl = reflect(fd.message, sub);
    if (this.tryDecodeWkt(subRefl)) {
      parent.set(fd, subRefl);
      return;
    }
    if (this.peek() !== TokenKind.LBRACE) {
      throw this.err(
        this.current.pos,
        `expected '{' for message field ${JSON.stringify(fd.name)}`,
      );
    }
    this.advance();
    if (
      isAny(fd.message) &&
      this.typeResolver &&
      this.peek() === TokenKind.AT_TYPE
    ) {
      this.decodeAnyInner(subRefl);
    } else {
      const saved = this.pathPrefix;
      this.pathPrefix = saved + fd.name + ".";
      this.decodeFields(subRefl, true);
      this.pathPrefix = saved;
    }
    parent.set(fd, subRefl);
  }

  private checkOneof(
    fd: DescField,
    setOneofs: Map<string, string>,
    pos: Position,
  ): void {
    const oo: DescOneof | undefined =
      fd.fieldKind === "scalar" ||
      fd.fieldKind === "message" ||
      fd.fieldKind === "enum"
        ? fd.oneof
        : undefined;
    if (!oo) return;
    const prev = setOneofs.get(oo.name);
    if (prev !== undefined) {
      throw this.err(
        pos,
        `oneof ${JSON.stringify(oo.name)}: field ${JSON.stringify(fd.name)} conflicts with already-set field ${JSON.stringify(prev)}`,
      );
    }
    setOneofs.set(oo.name, fd.name);
  }

  private decodeFieldValue(parent: ReflectMessage, fd: DescField): void {
    if (fd.fieldKind === "list") {
      this.decodeListInline(parent, fd);
      return;
    }
    if (fd.fieldKind === "map") {
      this.decodeMapInline(parent, fd);
      return;
    }
    if (fd.fieldKind === "message") {
      const sub = create(fd.message);
      const subRefl = reflect(fd.message, sub);
      if (this.tryDecodeWkt(subRefl)) {
        parent.set(fd, subRefl);
        return;
      }
      if (this.peek() !== TokenKind.LBRACE) {
        throw this.err(
          this.current.pos,
          `expected '{' for message field ${JSON.stringify(fd.name)}`,
        );
      }
      this.advance();
      if (
        isAny(fd.message) &&
        this.typeResolver &&
        this.peek() === TokenKind.AT_TYPE
      ) {
        this.decodeAnyInner(subRefl);
      } else {
        this.decodeFields(subRefl, true);
      }
      parent.set(fd, subRefl);
      return;
    }
    if (fd.fieldKind === "enum") {
      const v = this.consumeEnum(fd);
      parent.set(fd, v);
      return;
    }
    // scalar
    const v = this.consumeScalar(fd, fd.scalar);
    parent.set(fd, v);
  }

  /**
   * Try to decode a Timestamp/Duration/wrapper sugar value into `target`.
   * Returns true if a WKT shortcut matched and was consumed; false to fall
   * through to the regular `{ ... }` block decode.
   */
  private tryDecodeWkt(target: ReflectMessage): boolean {
    const mdesc = target.desc;
    if (isTimestamp(mdesc) && this.peek() === TokenKind.TIMESTAMP) {
      const { seconds, nanos } = parseRfc3339(this.current.value);
      setSecondsNanos(target, seconds, nanos);
      this.advance();
      return true;
    }
    if (isDuration(mdesc) && this.peek() === TokenKind.DURATION) {
      const { seconds, nanos } = parseGoDuration(this.current.value);
      setSecondsNanos(target, seconds, nanos);
      this.advance();
      return true;
    }
    if (isWrapperType(mdesc) && this.peek() !== TokenKind.LBRACE) {
      const innerFd = findFieldByProtoName(mdesc, "value");
      if (!innerFd || innerFd.fieldKind !== "scalar") {
        throw this.err(
          this.current.pos,
          `internal: wrapper ${mdesc.typeName} missing scalar 'value' field`,
        );
      }
      const v = this.consumeScalar(innerFd, innerFd.scalar);
      target.set(innerFd, v);
      return true;
    }
    return false;
  }

  /**
   * Decode `google.protobuf.Any` sugar, with the opening `{` already consumed.
   * Expects the body `@type = "url"` followed by inline fields of the
   * resolved inner message, terminated by `}`. Pack the inner message to
   * binary and store it as `Any.type_url` + `Any.value`.
   */
  private decodeAnyInner(target: ReflectMessage): void {
    const resolver = this.typeResolver;
    if (!resolver) {
      throw this.err(this.current.pos, "internal: decodeAnyInner without resolver");
    }
    if (this.peek() !== TokenKind.AT_TYPE) {
      throw this.err(this.current.pos, "Any field requires @type as first entry");
    }
    this.advance();
    if (this.peek() !== TokenKind.EQUALS) {
      throw this.err(this.current.pos, "expected '=' after @type");
    }
    this.advance();
    if (this.peek() !== TokenKind.STRING) {
      throw this.err(this.current.pos, "expected string type URL after @type =");
    }
    const typeURL = this.current.value;
    const urlPos = this.current.pos;
    this.advance();

    const innerDesc = resolver.findMessageByURL(typeURL);
    if (!innerDesc) {
      throw this.err(urlPos, `cannot resolve Any type ${JSON.stringify(typeURL)}`);
    }

    const inner = create(innerDesc);
    const innerRefl = reflect(innerDesc, inner);
    this.decodeFields(innerRefl, true);

    const packed = toBinary(innerDesc, inner);

    const typeUrlFd = findFieldByProtoName(target.desc, "type_url");
    const valueFd = findFieldByProtoName(target.desc, "value");
    if (!typeUrlFd || !valueFd) {
      throw this.err(
        urlPos,
        `internal: ${target.desc.typeName} missing type_url/value fields`,
      );
    }
    target.set(typeUrlFd, typeURL);
    target.set(valueFd, packed);
  }

  private decodeListInline(parent: ReflectMessage, fd: DescField): void {
    if (fd.fieldKind !== "list") {
      throw this.err(this.current.pos, "internal: decodeListInline called on non-list field");
    }
    if (this.peek() !== TokenKind.LBRACKET) {
      throw this.err(
        this.current.pos,
        `expected '[' for repeated field ${JSON.stringify(fd.name)}`,
      );
    }
    this.advance();

    const list = parent.get(fd) as ReflectList;

    while (this.peek() !== TokenKind.RBRACKET && this.peek() !== TokenKind.EOF) {
      if (this.peek() === TokenKind.NULL) {
        throw this.err(
          this.current.pos,
          `null is not allowed in repeated field ${JSON.stringify(fd.name)}`,
        );
      }
      if (fd.listKind === "message") {
        const elem = create(fd.message);
        const elemRefl = reflect(fd.message, elem);
        if (!this.tryDecodeWkt(elemRefl)) {
          if (this.peek() !== TokenKind.LBRACE) {
            throw this.err(this.current.pos, "expected '{' for repeated message element");
          }
          this.advance();
          this.decodeFields(elemRefl, true);
        }
        list.add(elemRefl);
      } else if (fd.listKind === "enum") {
        list.add(this.consumeEnum(fd));
      } else {
        list.add(this.consumeScalar(fd, fd.scalar));
      }
      if (this.peek() === TokenKind.COMMA) this.advance();
    }

    if (this.peek() !== TokenKind.RBRACKET) {
      throw this.err(
        this.current.pos,
        `expected ']', got ${tokenKindName(this.peek())}`,
      );
    }
    this.advance();
  }

  private decodeMapInline(parent: ReflectMessage, fd: DescField): void {
    if (fd.fieldKind !== "map") {
      throw this.err(this.current.pos, "internal: decodeMapInline called on non-map field");
    }
    if (this.peek() !== TokenKind.LBRACE) {
      throw this.err(
        this.current.pos,
        `expected '{' for map field ${JSON.stringify(fd.name)}`,
      );
    }
    this.advance();

    const map = parent.get(fd) as ReflectMap;
    const keyKind = fd.mapKey;

    while (this.peek() !== TokenKind.RBRACE && this.peek() !== TokenKind.EOF) {
      const pos = this.current.pos;
      const tk = this.peek();
      if (
        tk !== TokenKind.IDENT &&
        tk !== TokenKind.STRING &&
        tk !== TokenKind.INT &&
        tk !== TokenKind.BOOL
      ) {
        throw this.err(pos, `expected map key, got ${tokenKindName(tk)}`);
      }
      const keyStr = this.current.value;
      this.advance();

      switch (this.peek()) {
        case TokenKind.COLON:
          this.advance();
          break;
        case TokenKind.EQUALS:
          throw this.err(
            this.current.pos,
            "unexpected '=' in map, use ':' for map entries",
          );
        default:
          throw this.err(
            this.current.pos,
            `expected ':' after map key, got ${tokenKindName(this.peek())}`,
          );
      }

      const k = decodeMapKey(keyKind, keyStr, pos);

      if (this.peek() === TokenKind.NULL) {
        throw this.err(
          this.current.pos,
          `null is not allowed as map value in field ${JSON.stringify(fd.name)}`,
        );
      }

      let v: unknown;
      if (fd.mapKind === "message") {
        const elem = create(fd.message);
        const elemRefl = reflect(fd.message, elem);
        if (!this.tryDecodeWkt(elemRefl)) {
          if (this.peek() !== TokenKind.LBRACE) {
            throw this.err(this.current.pos, "expected '{' for map message value");
          }
          this.advance();
          this.decodeFields(elemRefl, true);
        }
        v = elemRefl;
      } else if (fd.mapKind === "enum") {
        v = this.consumeEnum(fd);
      } else {
        v = this.consumeScalar(fd, fd.scalar);
      }

      (map as ReflectMap<unknown, unknown>).set(k, v);
    }

    if (this.peek() !== TokenKind.RBRACE) {
      throw this.err(
        this.current.pos,
        `expected '}', got ${tokenKindName(this.peek())}`,
      );
    }
    this.advance();
  }

  private consumeScalar(fd: DescField, kind: ScalarType): unknown {
    const pos = this.current.pos;

    const tk = this.peek();
    switch (kind) {
      case ScalarType.STRING: {
        if (tk !== TokenKind.STRING) {
          throw this.err(pos, `expected string for field ${JSON.stringify(fd.name)}`);
        }
        const v = this.current.value;
        this.advance();
        return v;
      }
      case ScalarType.BOOL: {
        if (tk !== TokenKind.BOOL) {
          throw this.err(pos, `expected bool for field ${JSON.stringify(fd.name)}`);
        }
        const v = this.current.value === "true";
        this.advance();
        return v;
      }
      case ScalarType.INT32:
      case ScalarType.SINT32:
      case ScalarType.SFIXED32: {
        if (tk !== TokenKind.INT) {
          throw this.err(pos, `expected integer for field ${JSON.stringify(fd.name)}`);
        }
        const n = parseSignedInt32(this.current.value);
        if (n === null) {
          throw this.err(pos, `invalid int32: ${this.current.value}`);
        }
        this.advance();
        return n;
      }
      case ScalarType.UINT32:
      case ScalarType.FIXED32: {
        if (tk !== TokenKind.INT) {
          throw this.err(pos, `expected integer for field ${JSON.stringify(fd.name)}`);
        }
        const n = parseUnsignedInt32(this.current.value);
        if (n === null) {
          throw this.err(pos, `invalid uint32: ${this.current.value}`);
        }
        this.advance();
        return n;
      }
      case ScalarType.INT64:
      case ScalarType.SINT64:
      case ScalarType.SFIXED64: {
        if (tk !== TokenKind.INT) {
          throw this.err(pos, `expected integer for field ${JSON.stringify(fd.name)}`);
        }
        const v = parseInt64(this.current.value);
        if (v === null) {
          throw this.err(pos, `invalid int64: ${this.current.value}`);
        }
        this.advance();
        return v;
      }
      case ScalarType.UINT64:
      case ScalarType.FIXED64: {
        if (tk !== TokenKind.INT) {
          throw this.err(pos, `expected integer for field ${JSON.stringify(fd.name)}`);
        }
        const v = parseUint64(this.current.value);
        if (v === null) {
          throw this.err(pos, `invalid uint64: ${this.current.value}`);
        }
        this.advance();
        return v;
      }
      case ScalarType.FLOAT: {
        if (tk !== TokenKind.FLOAT && tk !== TokenKind.INT) {
          throw this.err(pos, `expected number for field ${JSON.stringify(fd.name)}`);
        }
        const f = Number(this.current.value);
        if (Number.isNaN(f) && this.current.value !== "NaN") {
          throw this.err(pos, `invalid float: ${this.current.value}`);
        }
        this.advance();
        return Math.fround(f);
      }
      case ScalarType.DOUBLE: {
        if (tk !== TokenKind.FLOAT && tk !== TokenKind.INT) {
          throw this.err(pos, `expected number for field ${JSON.stringify(fd.name)}`);
        }
        const f = Number(this.current.value);
        if (Number.isNaN(f) && this.current.value !== "NaN") {
          throw this.err(pos, `invalid double: ${this.current.value}`);
        }
        this.advance();
        return f;
      }
      case ScalarType.BYTES: {
        if (tk !== TokenKind.BYTES) {
          throw this.err(pos, `expected bytes for field ${JSON.stringify(fd.name)}`);
        }
        const v = decodeBase64(this.current.value);
        this.advance();
        return v;
      }
      default:
        throw this.err(pos, `unsupported scalar kind ${kind} for field ${JSON.stringify(fd.name)}`);
    }
  }

  private consumeEnum(fd: DescField): number {
    const pos = this.current.pos;
    const enumDesc = fd.enum;
    if (!enumDesc) {
      throw this.err(pos, `internal: missing enum descriptor for field ${JSON.stringify(fd.name)}`);
    }
    const tk = this.peek();
    if (tk === TokenKind.IDENT) {
      const found = enumDesc.values.find((ev) => ev.name === this.current.value);
      if (!found) {
        throw this.err(
          pos,
          `unknown enum value ${JSON.stringify(this.current.value)} for ${enumDesc.typeName}`,
        );
      }
      this.advance();
      return found.number;
    }
    if (tk === TokenKind.INT) {
      const n = parseSignedInt32(this.current.value);
      if (n === null) {
        throw this.err(pos, `invalid enum number: ${this.current.value}`);
      }
      this.advance();
      return n;
    }
    throw this.err(pos, `expected enum name or number for field ${JSON.stringify(fd.name)}`);
  }

  private skipValue(): void {
    const tk = this.peek();
    if (tk === TokenKind.LBRACE) {
      this.advance();
      this.skipBraced();
      return;
    }
    if (tk === TokenKind.LBRACKET) {
      this.advance();
      this.skipBracketed();
      return;
    }
    this.advance();
  }

  private skipBraced(): void {
    let depth = 1;
    while (depth > 0 && this.peek() !== TokenKind.EOF) {
      const tk = this.peek();
      if (tk === TokenKind.LBRACE) depth++;
      else if (tk === TokenKind.RBRACE) depth--;
      this.advance();
    }
  }

  private skipBracketed(): void {
    let depth = 1;
    while (depth > 0 && this.peek() !== TokenKind.EOF) {
      const tk = this.peek();
      if (tk === TokenKind.LBRACKET) depth++;
      else if (tk === TokenKind.RBRACKET) depth--;
      this.advance();
    }
  }
}

function parseSignedInt32(s: string): number | null {
  if (!/^-?\d+$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isInteger(n) || n < -2147483648 || n > 2147483647) return null;
  return n;
}

function parseUnsignedInt32(s: string): number | null {
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isInteger(n) || n < 0 || n > 4294967295) return null;
  return n;
}

function parseInt64(s: string): bigint | null {
  if (!/^-?\d+$/.test(s)) return null;
  try {
    const v = BigInt(s);
    if (v < -(1n << 63n) || v > (1n << 63n) - 1n) return null;
    return v;
  } catch {
    return null;
  }
}

function parseUint64(s: string): bigint | null {
  if (!/^\d+$/.test(s)) return null;
  try {
    const v = BigInt(s);
    if (v < 0n || v > (1n << 64n) - 1n) return null;
    return v;
  } catch {
    return null;
  }
}

function decodeBase64(s: string): Uint8Array {
  const buf = Buffer.from(s, "base64");
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

const RFC3339_FRAC_RE =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Parse an RFC 3339 timestamp into seconds-since-epoch and a non-negative
 * nanos remainder (matching the proto Timestamp invariant). The lexer has
 * already validated the syntax; here we just split out fractional seconds at
 * full nanosecond precision, which `Date.parse` cannot supply directly.
 */
function parseRfc3339(s: string): { seconds: bigint; nanos: number } {
  const m = RFC3339_FRAC_RE.exec(s);
  if (!m) throw new Error(`invalid RFC 3339 timestamp: ${s}`);
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) throw new Error(`invalid RFC 3339 timestamp: ${s}`);
  let nanos = 0;
  const frac = m[2];
  if (frac) {
    let digits = frac.slice(1);
    if (digits.length > 9) digits = digits.slice(0, 9);
    while (digits.length < 9) digits += "0";
    nanos = Number(digits);
  }
  // Floor toward -∞ so `nanos` stays in [0, 1e9), matching proto Timestamp.
  const seconds = BigInt(Math.floor(ms / 1000));
  return { seconds, nanos };
}

const GO_DURATION_PART_RE = /^(\d+)(\.\d+)?(ns|us|µs|ms|s|m|h)/;

const GO_DURATION_UNIT_NANOS: Record<string, bigint> = {
  ns: 1n,
  us: 1_000n,
  "µs": 1_000n,
  ms: 1_000_000n,
  s: 1_000_000_000n,
  m: 60_000_000_000n,
  h: 3_600_000_000_000n,
};

/**
 * Parse a Go-style duration (e.g. `1h30m`, `-2.5s`, `100ms`) into proto
 * Duration seconds + nanos. Both parts share the overall sign.
 */
function parseGoDuration(s: string): { seconds: bigint; nanos: number } {
  if (s === "0") return { seconds: 0n, nanos: 0 };
  let neg = false;
  if (s.startsWith("-") || s.startsWith("+")) {
    neg = s[0] === "-";
    s = s.slice(1);
  }
  if (s === "") throw new Error("invalid duration");
  let totalNanos = 0n;
  while (s.length > 0) {
    const m = GO_DURATION_PART_RE.exec(s);
    if (!m) throw new Error(`invalid duration: ${s}`);
    const intPart = m[1]!;
    const fracPart = m[2] ?? "";
    const unit = m[3]!;
    const unitNanos = GO_DURATION_UNIT_NANOS[unit];
    if (unitNanos === undefined) throw new Error(`unknown duration unit: ${unit}`);
    totalNanos += BigInt(intPart) * unitNanos;
    if (fracPart) {
      const fracDigits = fracPart.slice(1);
      const fracInt = BigInt(fracDigits);
      const denom = 10n ** BigInt(fracDigits.length);
      totalNanos += (fracInt * unitNanos) / denom;
    }
    s = s.slice(m[0].length);
  }
  if (neg) totalNanos = -totalNanos;
  const sign = totalNanos < 0n ? -1n : 1n;
  const abs = sign * totalNanos;
  const secondsAbs = abs / 1_000_000_000n;
  const nanosAbs = abs % 1_000_000_000n;
  return {
    seconds: sign * secondsAbs,
    nanos: Number(sign * nanosAbs),
  };
}

function setSecondsNanos(target: ReflectMessage, seconds: bigint, nanos: number): void {
  const sf = findFieldByProtoName(target.desc, "seconds");
  const nf = findFieldByProtoName(target.desc, "nanos");
  if (!sf || !nf) {
    throw new Error(`${target.desc.typeName} missing seconds/nanos fields`);
  }
  target.set(sf, seconds);
  target.set(nf, nanos);
}

function decodeMapKey(kind: ScalarType, key: string, pos: Position): unknown {
  switch (kind) {
    case ScalarType.STRING:
      return key;
    case ScalarType.INT32:
    case ScalarType.SINT32:
    case ScalarType.SFIXED32: {
      const n = parseSignedInt32(key);
      if (n === null) throw new PxfError(pos, `invalid int32 map key: ${key}`);
      return n;
    }
    case ScalarType.UINT32:
    case ScalarType.FIXED32: {
      const n = parseUnsignedInt32(key);
      if (n === null) throw new PxfError(pos, `invalid uint32 map key: ${key}`);
      return n;
    }
    case ScalarType.INT64:
    case ScalarType.SINT64:
    case ScalarType.SFIXED64: {
      const v = parseInt64(key);
      if (v === null) throw new PxfError(pos, `invalid int64 map key: ${key}`);
      return v;
    }
    case ScalarType.UINT64:
    case ScalarType.FIXED64: {
      const v = parseUint64(key);
      if (v === null) throw new PxfError(pos, `invalid uint64 map key: ${key}`);
      return v;
    }
    case ScalarType.BOOL:
      if (key === "true") return true;
      if (key === "false") return false;
      throw new PxfError(pos, `invalid bool map key: ${key}`);
    default:
      throw new PxfError(pos, `unsupported map key kind: ${kind}`);
  }
}

/**
 * Validate `(pxf.required) = true` annotations and apply `(pxf.default)`
 * values to absent fields. Recurses into present, non-null nested messages,
 * matching the Go reference's `postDecode`. The `_null` field itself is
 * skipped since it's metadata, not user data.
 */
function postDecode(
  parent: ReflectMessage,
  result: Result,
  nullMaskFd: DescField | undefined,
  pathPrefix: string,
): void {
  for (const fd of parent.desc.fields) {
    if (nullMaskFd && fd.number === nullMaskFd.number) continue;
    const path = pathPrefix + fd.name;
    if (result.isAbsent(path)) {
      if (isRequired(fd)) {
        throw new PxfError({ line: 1, column: 1 }, `required field ${JSON.stringify(path)} is absent`);
      }
      const def = getDefault(fd);
      if (def !== undefined) {
        applyDefault(parent, fd, def);
      }
      continue;
    }
    // Field is present. Skip nulls (don't recurse into a null subtree).
    if (result.isNull(path)) continue;
    if (
      fd.fieldKind === "message" &&
      parent.isSet(fd) &&
      !isTimestamp(fd.message) &&
      !isDuration(fd.message) &&
      !isWrapperType(fd.message) &&
      !isAny(fd.message)
    ) {
      const sub = parent.get(fd) as ReflectMessage;
      postDecode(sub, result, undefined, path + ".");
    }
  }
}

function applyDefault(parent: ReflectMessage, fd: DescField, def: string): void {
  const errPos: Position = { line: 1, column: 1 };
  if (fd.fieldKind === "scalar") {
    parent.set(fd, parseScalarDefault(fd.scalar, def, fd, errPos));
    return;
  }
  if (fd.fieldKind === "enum") {
    const ev = fd.enum.values.find((v) => v.name === def);
    if (ev) {
      parent.set(fd, ev.number);
      return;
    }
    const n = parseSignedInt32(def);
    if (n === null) {
      throw new PxfError(errPos, `invalid default enum ${JSON.stringify(def)} for field ${JSON.stringify(fd.name)}`);
    }
    parent.set(fd, n);
    return;
  }
  if (fd.fieldKind === "message") {
    applyMessageDefault(parent, fd, def, errPos);
    return;
  }
  throw new PxfError(
    errPos,
    `default values not supported for ${fd.fieldKind} field ${JSON.stringify(fd.name)}`,
  );
}

function parseScalarDefault(
  kind: ScalarType,
  def: string,
  fd: DescField,
  pos: Position,
): unknown {
  switch (kind) {
    case ScalarType.STRING:
      return def;
    case ScalarType.BOOL:
      return def === "true";
    case ScalarType.INT32:
    case ScalarType.SINT32:
    case ScalarType.SFIXED32: {
      const n = parseSignedInt32(def);
      if (n === null) throw new PxfError(pos, `invalid default int32 ${JSON.stringify(def)} for field ${JSON.stringify(fd.name)}`);
      return n;
    }
    case ScalarType.UINT32:
    case ScalarType.FIXED32: {
      const n = parseUnsignedInt32(def);
      if (n === null) throw new PxfError(pos, `invalid default uint32 ${JSON.stringify(def)} for field ${JSON.stringify(fd.name)}`);
      return n;
    }
    case ScalarType.INT64:
    case ScalarType.SINT64:
    case ScalarType.SFIXED64: {
      const v = parseInt64(def);
      if (v === null) throw new PxfError(pos, `invalid default int64 ${JSON.stringify(def)} for field ${JSON.stringify(fd.name)}`);
      return v;
    }
    case ScalarType.UINT64:
    case ScalarType.FIXED64: {
      const v = parseUint64(def);
      if (v === null) throw new PxfError(pos, `invalid default uint64 ${JSON.stringify(def)} for field ${JSON.stringify(fd.name)}`);
      return v;
    }
    case ScalarType.FLOAT: {
      const f = Number(def);
      if (Number.isNaN(f) && def !== "NaN") {
        throw new PxfError(pos, `invalid default float ${JSON.stringify(def)} for field ${JSON.stringify(fd.name)}`);
      }
      return Math.fround(f);
    }
    case ScalarType.DOUBLE: {
      const f = Number(def);
      if (Number.isNaN(f) && def !== "NaN") {
        throw new PxfError(pos, `invalid default double ${JSON.stringify(def)} for field ${JSON.stringify(fd.name)}`);
      }
      return f;
    }
    case ScalarType.BYTES:
      return decodeBase64(def);
    default:
      throw new PxfError(pos, `unsupported default scalar kind ${kind} for field ${JSON.stringify(fd.name)}`);
  }
}

function applyMessageDefault(
  parent: ReflectMessage,
  fd: DescField,
  def: string,
  pos: Position,
): void {
  if (fd.fieldKind !== "message") {
    throw new PxfError(pos, "internal: applyMessageDefault on non-message field");
  }
  const mdesc = fd.message;
  const sub = create(mdesc);
  const subRefl = reflect(mdesc, sub);

  if (isTimestamp(mdesc)) {
    const { seconds, nanos } = parseRfc3339(def);
    const sf = findFieldByProtoName(mdesc, "seconds");
    const nf = findFieldByProtoName(mdesc, "nanos");
    if (sf && nf) {
      subRefl.set(sf, seconds);
      subRefl.set(nf, nanos);
    }
    parent.set(fd, subRefl);
    return;
  }
  if (isDuration(mdesc)) {
    const { seconds, nanos } = parseGoDuration(def);
    const sf = findFieldByProtoName(mdesc, "seconds");
    const nf = findFieldByProtoName(mdesc, "nanos");
    if (sf && nf) {
      subRefl.set(sf, seconds);
      subRefl.set(nf, nanos);
    }
    parent.set(fd, subRefl);
    return;
  }
  if (isWrapperType(mdesc)) {
    const innerFd = findFieldByProtoName(mdesc, "value");
    if (!innerFd || innerFd.fieldKind !== "scalar") {
      throw new PxfError(pos, `internal: wrapper ${mdesc.typeName} missing 'value' field`);
    }
    subRefl.set(innerFd, parseScalarDefault(innerFd.scalar, def, fd, pos));
    parent.set(fd, subRefl);
    return;
  }
  throw new PxfError(
    pos,
    `default values not supported for message type ${mdesc.typeName} (field ${JSON.stringify(fd.name)})`,
  );
}
