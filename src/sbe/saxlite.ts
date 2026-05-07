// SPDX-License-Identifier: MIT
// Copyright (c) 2026 TrendVidia, LLC.
/**
 * Tiny SAX-style XML parser, sized for SBE schemas only.
 *
 * Handles: prolog (`<?xml ...?>`), comments, DOCTYPE (skipped), open / close /
 * self-closing tags, attributes (single- or double-quoted), char data, the
 * five named entities, and namespace prefixes (stripped, with xmlns:*
 * attributes silently dropped).
 *
 * Does NOT handle: CDATA sections, processing instructions other than the
 * prolog, numeric character references, custom entities, or DTDs. The SBE
 * schema vocabulary doesn't need any of those.
 */

export interface SaxHandler {
  onOpen(name: string, attrs: Record<string, string>): void;
  onClose(name: string): void;
  /** Called with raw character data between tags. May be all whitespace. */
  onText(text: string): void;
}

export class SaxError extends Error {
  constructor(
    message: string,
    public readonly offset: number,
  ) {
    super(`sbe-sax: ${message} at offset ${offset}`);
  }
}

export function parseXml(input: string, handler: SaxHandler): void {
  const len = input.length;
  let i = 0;

  while (i < len) {
    const ch = input[i]!;
    if (ch !== "<") {
      // Char data up to the next '<'.
      const start = i;
      while (i < len && input[i] !== "<") i++;
      handler.onText(decodeEntities(input.substring(start, i)));
      continue;
    }

    // ch === '<' — figure out which markup token.
    if (input.startsWith("<!--", i)) {
      const end = input.indexOf("-->", i + 4);
      if (end < 0) throw new SaxError("unterminated comment", i);
      i = end + 3;
      continue;
    }
    if (input.startsWith("<?", i)) {
      const end = input.indexOf("?>", i + 2);
      if (end < 0) throw new SaxError("unterminated processing instruction", i);
      i = end + 2;
      continue;
    }
    if (input.startsWith("<!", i)) {
      // DOCTYPE or other declaration — skip to matching '>'.
      const end = input.indexOf(">", i + 2);
      if (end < 0) throw new SaxError("unterminated declaration", i);
      i = end + 1;
      continue;
    }

    if (input[i + 1] === "/") {
      // Close tag: </name>
      i += 2;
      const nameEnd = findTagNameEnd(input, i);
      const rawName = input.substring(i, nameEnd);
      i = nameEnd;
      i = skipSpace(input, i);
      if (input[i] !== ">") throw new SaxError("expected '>' to end close tag", i);
      i++;
      handler.onClose(stripNamespace(rawName));
      continue;
    }

    // Open or self-closing tag: <name attr="v" .../> or <name ...>
    i++; // past '<'
    const nameEnd = findTagNameEnd(input, i);
    if (nameEnd === i) throw new SaxError("expected tag name after '<'", i);
    const rawName = input.substring(i, nameEnd);
    i = nameEnd;

    const attrs: Record<string, string> = {};
    let selfClose = false;
    while (true) {
      i = skipSpace(input, i);
      if (i >= len) throw new SaxError("unterminated tag", i);
      const c = input[i]!;
      if (c === ">") {
        i++;
        break;
      }
      if (c === "/" && input[i + 1] === ">") {
        selfClose = true;
        i += 2;
        break;
      }

      // Attribute: name="value" or name='value'
      const attrNameStart = i;
      while (i < len && !isAttrNameTerminator(input[i]!)) i++;
      if (i === attrNameStart) throw new SaxError("expected attribute name", i);
      const attrName = input.substring(attrNameStart, i);

      i = skipSpace(input, i);
      if (input[i] !== "=") throw new SaxError(`expected '=' after attribute ${attrName}`, i);
      i++;
      i = skipSpace(input, i);

      const quote = input[i];
      if (quote !== '"' && quote !== "'") {
        throw new SaxError(`expected quoted value for attribute ${attrName}`, i);
      }
      i++;
      const valStart = i;
      while (i < len && input[i] !== quote) i++;
      if (i >= len) throw new SaxError("unterminated attribute value", valStart);
      const rawValue = input.substring(valStart, i);
      i++; // past closing quote

      // Drop xmlns declarations; the caller handles namespaces uniformly via
      // stripNamespace on element/attribute names.
      if (attrName === "xmlns" || attrName.startsWith("xmlns:")) continue;
      attrs[stripNamespace(attrName)] = decodeEntities(rawValue);
    }

    const name = stripNamespace(rawName);
    handler.onOpen(name, attrs);
    if (selfClose) handler.onClose(name);
  }
}

function findTagNameEnd(input: string, start: number): number {
  let i = start;
  while (i < input.length && !isNameTerminator(input[i]!)) i++;
  return i;
}

function isNameTerminator(c: string): boolean {
  return c === " " || c === "\t" || c === "\n" || c === "\r" || c === ">" || c === "/";
}

function isAttrNameTerminator(c: string): boolean {
  return c === "=" || c === " " || c === "\t" || c === "\n" || c === "\r" || c === "/" || c === ">";
}

function skipSpace(input: string, i: number): number {
  while (
    i < input.length &&
    (input[i] === " " || input[i] === "\t" || input[i] === "\n" || input[i] === "\r")
  ) {
    i++;
  }
  return i;
}

function stripNamespace(name: string): string {
  const colon = name.indexOf(":");
  return colon >= 0 ? name.substring(colon + 1) : name;
}

function decodeEntities(s: string): string {
  if (s.indexOf("&") < 0) return s;
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}
