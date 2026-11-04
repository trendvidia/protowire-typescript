// SPDX-License-Identifier: MIT
// Copyright (c) 2026 TrendVidia, LLC.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";
import { parse } from "./parser.js";
import { format } from "./format.js";

function roundTrip(src: string): string {
  return format(parse(src));
}

describe("scalar values", () => {
  it("string", () => {
    expect(roundTrip('name = "Alice"')).toBe('name = "Alice"\n');
  });

  it("escape sequences are re-emitted", () => {
    const src = 'msg = "line1\\nline2\\t\\"q\\""';
    const out = format(parse(src));
    expect(out).toBe('msg = "line1\\nline2\\t\\"q\\""\n');
  });

  it("int / negative int / float", () => {
    expect(roundTrip("port = 8443")).toBe("port = 8443\n");
    expect(roundTrip("delta = -42")).toBe("delta = -42\n");
    expect(roundTrip("ratio = 0.85")).toBe("ratio = 0.85\n");
  });

  it("bool / null / ident", () => {
    expect(roundTrip("enabled = true")).toBe("enabled = true\n");
    expect(roundTrip("email = null")).toBe("email = null\n");
    expect(roundTrip("status = STATUS_SERVING")).toBe("status = STATUS_SERVING\n");
  });

  it("timestamp / duration use raw lexeme", () => {
    expect(roundTrip("created_at = 2024-01-15T10:30:00Z")).toBe(
      "created_at = 2024-01-15T10:30:00Z\n",
    );
    expect(roundTrip("timeout = 1h30m")).toBe("timeout = 1h30m\n");
  });

  it("bytes encode back to standard base64 with padding", () => {
    // "Hello" → SGVsbG8= regardless of whether the input was raw or padded.
    expect(roundTrip('raw = b"SGVsbG8"')).toBe('raw = b"SGVsbG8="\n');
    expect(roundTrip('raw = b"SGVsbG8="')).toBe('raw = b"SGVsbG8="\n');
  });
});

describe("@type directive and document leading comments", () => {
  it("@type appears at the top with a blank line after", () => {
    const out = format(parse("@type pkg.M\nname = \"x\""));
    expect(out).toBe('@type pkg.M\n\nname = "x"\n');
  });

  it("doc-level leading comments are emitted before entries", () => {
    const src = `# top of file
@type pkg.M
name = "x"`;
    const out = format(parse(src));
    expect(out).toBe('@type pkg.M\n\n# top of file\nname = "x"\n');
  });
});

describe("blocks (nested messages)", () => {
  it("indents two spaces by default", () => {
    const src = `tls {
  cert_file = "/etc/ssl/cert.pem"
  verify    = true
}`;
    const out = format(parse(src));
    expect(out).toBe(
      'tls {\n  cert_file = "/etc/ssl/cert.pem"\n  verify = true\n}\n',
    );
  });

  it("custom indent option (4-space)", () => {
    const src = `tls { verify = true }`;
    const out = format(parse(src), { indent: "    " });
    expect(out).toBe("tls {\n    verify = true\n}\n");
  });

  it("nested blocks", () => {
    const out = format(parse("a { b { c = 1 } }"));
    expect(out).toBe("a {\n  b {\n    c = 1\n  }\n}\n");
  });
});

describe("lists", () => {
  it("scalar list emits commas between elements (none after last)", () => {
    const out = format(parse('tags = ["a", "b", "c"]'));
    expect(out).toBe('tags = [\n  "a",\n  "b",\n  "c"\n]\n');
  });

  it("normalizes commaless input into comma-separated output", () => {
    const src = `tags = [
  "a"
  "b"
]`;
    expect(format(parse(src))).toBe('tags = [\n  "a",\n  "b"\n]\n');
  });

  it("list of inline blocks", () => {
    const src = `endpoints = [
  { path = "/api" }
  { path = "/health" }
]`;
    const out = format(parse(src));
    expect(out).toBe(
      'endpoints = [\n  {\n    path = "/api"\n  },\n  {\n    path = "/health"\n  }\n]\n',
    );
  });
});

describe("maps", () => {
  it("string-keyed map", () => {
    const src = `labels = {
  env: "prod"
  team: "platform"
}`;
    expect(format(parse(src))).toBe(
      'labels = {\n  env: "prod"\n  team: "platform"\n}\n',
    );
  });

  it("keys with non-ident chars get quoted", () => {
    const src = `labels = {
  "key with space": "v"
}`;
    expect(format(parse(src))).toBe('labels = {\n  "key with space": "v"\n}\n');
  });

  it("a bare integer key stays bare (protowire#306)", () => {
    const src = `codes = {
  404: "Not Found"
  500: "Internal"
}`;
    const out = format(parse(src));
    expect(out).toBe(
      'codes = {\n  404: "Not Found"\n  500: "Internal"\n}\n',
    );
  });
});

describe("comment preservation", () => {
  it("leading comments on entries are preserved", () => {
    const src = `# explain this
name = "x"`;
    expect(format(parse(src))).toBe('# explain this\nname = "x"\n');
  });

  it("comments inside a block stay inside", () => {
    const src = `tls {
  # cert path
  cert_file = "/etc/cert.pem"
}`;
    expect(format(parse(src))).toBe(
      'tls {\n  # cert path\n  cert_file = "/etc/cert.pem"\n}\n',
    );
  });

  it("// and /* */ comment styles round-trip verbatim", () => {
    const src = `// slash comment
/* block comment */
name = "x"`;
    const out = format(parse(src));
    expect(out).toBe('// slash comment\n/* block comment */\nname = "x"\n');
  });
});

describe("end-to-end idempotence", () => {
  it("formatting twice is a no-op (formatter output is its own fixed point)", () => {
    const src = `@type pkg.M

# header
name = "Alice"
port = 8443
enabled = true
tls {
  cert_file = "/etc/cert.pem"
}
tags = [
  "a",
  "b"
]
labels = {
  env: "prod"
}
`;
    const once = format(parse(src));
    const twice = format(parse(once));
    expect(twice).toBe(once);
  });

  it("PXF README sample is idempotent under format∘parse", () => {
    const src = `@type infra.v1.ServerConfig

hostname = "web-01.prod.example.com"
port = 8443
enabled = true
status = STATUS_SERVING
created_at = 2024-01-15T10:30:00Z
timeout = 30s
tls {
  cert_file = "/etc/ssl/cert.pem"
  verify = true
}
tags = [
  "production",
  "us-east"
]
labels = {
  env: "production"
}
`;
    const once = format(parse(src));
    const twice = format(parse(once));
    expect(twice).toBe(once);
  });
});

describe("quoted entry names (draft -01 §3.13)", () => {
  it("the schema-less formatter reproduces the quoting", () => {
    const blockForm = 'regions {\n  "us-east-1" {\n    replicas = 3\n  }\n  "bare" {\n  }\n}\n';
    expect(roundTrip(blockForm)).toBe(blockForm);
    const assignForm = 'regions {\n  "a\\"b" = {\n    replicas = 3\n  }\n}\n';
    expect(roundTrip(assignForm)).toBe(assignForm);
  });
});

describe("format keeps every directive, in document order (protowire fmt)", () => {
  /** The AST without positions or byte offsets, which formatting moves. */
  function shape(doc: unknown): unknown {
    return JSON.parse(
      JSON.stringify(doc, (k, v: unknown) => {
        if (k === "pos" || k === "bodyOffset") return undefined;
        if (v instanceof Uint8Array) return Array.from(v);
        if (typeof v === "bigint") return `${v}n`;
        return v;
      }),
    );
  }

  function roundTrip(src: string): string {
    const doc = parse(src);
    const out = format(doc);
    expect(shape(parse(out)), out).toEqual(shape(doc));
    expect(format(parse(out))).toBe(out);
    return out;
  }

  /** Comments by text, wherever they hang. */
  function comments(doc: unknown): string[] {
    const found: string[] = [];
    JSON.stringify(doc, (k, v: unknown) => {
      if (k === "leadingComments") for (const c of v as { text: string }[]) found.push(c.text);
      if (k === "trailingComment" && v !== "") found.push(v as string);
      return typeof v === "bigint" ? `${v}` : v;
    });
    return found.sort();
  }

  /**
   * Nothing lost: the same AST once comments and the spelling of quotes are
   * set aside (a formatter moves the first and canonicalises the second), and
   * the same comments.
   */
  function keepsEverything(src: string): void {
    const doc = parse(src);
    const out = format(doc);
    const again = parse(out);
    const bare = (d: unknown): unknown =>
      JSON.parse(JSON.stringify(shape(d), (k, v: unknown) => (k === "leadingComments" || k === "trailingComment" || k === "keyQuoted" || k === "nameQuoted" ? undefined : v)));
    expect(bare(again), out).toEqual(bare(doc));
    expect(comments(again), out).toEqual(comments(doc));
    expect(format(again)).toBe(out);
  }

  it("writes a dataset's header and rows, empty and null cells kept apart", () => {
    const out = roundTrip("@dataset trades.v1.Trade (id, px, note)\n(1, 2.5, )\n(2, , null)\n");
    expect(out).toBe("@dataset trades.v1.Trade (id, px, note)\n(1, 2.5, )\n(2, , null)\n");
  });

  it("writes @entry and a named directive with its body as written, before the body", () => {
    const out = roundTrip('@type a.v1.M\n@entry x { a = 1 }\n@header h.v1.H\n\nname = "n"\n');
    expect(out).toBe('@type a.v1.M\n@entry x { a = 1 }\n@header h.v1.H\n\nname = "n"\n');
  });

  it("keeps @proto ahead of the dataset it types, in each body shape", () => {
    roundTrip("@proto { string id = 1; }\n@dataset (id)\n(\"a\")\n");
    roundTrip("@proto a.v1.R { string id = 1; }\n@dataset a.v1.R (id)\n(\"a\")\n");
    roundTrip('@proto """syntax = "proto3"; message R { string id = 1; }"""\n@dataset R (id)\n("a")\n');
    roundTrip('@proto b"CgA="\n@type a.v1.M\n\nx = 1\n');
  });

  it("keeps a directive's comments", () => {
    const out = roundTrip("# about the rows\n@dataset t.v1.T (id)\n(1)\n# second\n@dataset t.v1.U (id)\n(2)\n");
    expect(out).toContain("# about the rows\n@dataset t.v1.T (id)");
    expect(out).toContain("# second\n@dataset t.v1.U (id)");
  });

  it("still writes a document with only @type as before", () => {
    expect(format(parse("# c\n@type a.v1.M\n\nx = 1\n"))).toBe("@type a.v1.M\n\n# c\nx = 1\n");
  });

  it("loses nothing from any corpus document with a directive", () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "testdata/corpus");
    const files = readdirSync(root, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".pxf"));
    let withDirectives = 0;
    for (const f of files) {
      let doc;
      try {
        doc = parse(readFileSync(resolve(root, f), "utf8"));
      } catch {
        continue;
      }
      if (doc.datasets.length + doc.directives.length + doc.protos.length === 0) continue;
      withDirectives++;
      keepsEverything(readFileSync(resolve(root, f), "utf8"));
    }
    // A positive count: the corpus's 29 documents with a directive were all formatted.
    expect(withDirectives).toBe(29);
  });
});
