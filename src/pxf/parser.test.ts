// SPDX-License-Identifier: MIT
// Copyright (c) 2026 TrendVidia, LLC.
import { describe, it, expect } from "vitest";
import { parse } from "./parser.js";
import { PxfError } from "./errors.js";
import type { Assignment, Block, BlockVal, ListVal, MapEntry } from "./ast.js";

describe("parse: empty / whitespace", () => {
  it("empty input → empty document", () => {
    const doc = parse("");
    expect(doc.typeUrl).toBe("");
    expect(doc.entries).toEqual([]);
    expect(doc.leadingComments).toEqual([]);
  });

  it("whitespace only → empty document", () => {
    const doc = parse("\n\n   \n\t\n");
    expect(doc.entries).toEqual([]);
  });
});

describe("@type directive", () => {
  it("captures the type name", () => {
    const doc = parse("@type infra.v1.ServerConfig");
    expect(doc.typeUrl).toBe("infra.v1.ServerConfig");
    expect(doc.entries).toEqual([]);
  });

  it("@type then entries", () => {
    const doc = parse('@type pkg.M\nname = "x"');
    expect(doc.typeUrl).toBe("pkg.M");
    expect(doc.entries).toHaveLength(1);
    const a = doc.entries[0] as Assignment;
    expect(a.kind).toBe("assignment");
    expect(a.key).toBe("name");
  });

  it("missing identifier after @type → PxfError", () => {
    expect(() => parse("@type =")).toThrow(PxfError);
  });
});

describe("scalar assignments", () => {
  it("string", () => {
    const doc = parse('hostname = "web-01"');
    const a = doc.entries[0] as Assignment;
    expect(a.kind).toBe("assignment");
    expect(a.key).toBe("hostname");
    expect(a.value).toEqual(expect.objectContaining({ kind: "string", value: "web-01" }));
  });

  it("int", () => {
    const a = parse("port = 8443").entries[0] as Assignment;
    expect(a.value).toEqual(expect.objectContaining({ kind: "int", raw: "8443" }));
  });

  it("negative int", () => {
    const a = parse("delta = -42").entries[0] as Assignment;
    expect(a.value).toEqual(expect.objectContaining({ kind: "int", raw: "-42" }));
  });

  it("float", () => {
    const a = parse("ratio = 0.85").entries[0] as Assignment;
    expect(a.value).toEqual(expect.objectContaining({ kind: "float", raw: "0.85" }));
  });

  it("bool", () => {
    const t = parse("enabled = true").entries[0] as Assignment;
    expect(t.value).toEqual(expect.objectContaining({ kind: "bool", value: true }));
    const f = parse("enabled = false").entries[0] as Assignment;
    expect(f.value).toEqual(expect.objectContaining({ kind: "bool", value: false }));
  });

  it("null", () => {
    const a = parse("email = null").entries[0] as Assignment;
    expect(a.value.kind).toBe("null");
  });

  it("ident (enum value)", () => {
    const a = parse("status = STATUS_SERVING").entries[0] as Assignment;
    expect(a.value).toEqual(
      expect.objectContaining({ kind: "ident", name: "STATUS_SERVING" }),
    );
  });

  it("timestamp keeps raw text", () => {
    const a = parse("created_at = 2024-01-15T10:30:00Z").entries[0] as Assignment;
    expect(a.value).toEqual(
      expect.objectContaining({ kind: "timestamp", raw: "2024-01-15T10:30:00Z" }),
    );
  });

  it("duration keeps raw text", () => {
    const a = parse("timeout = 1h30m").entries[0] as Assignment;
    expect(a.value).toEqual(expect.objectContaining({ kind: "duration", raw: "1h30m" }));
  });
});

describe("bytes literals", () => {
  it("base64 decodes to Uint8Array", () => {
    const a = parse('raw = b"SGVsbG8="').entries[0] as Assignment;
    expect(a.value.kind).toBe("bytes");
    if (a.value.kind === "bytes") {
      expect(Array.from(a.value.value)).toEqual([72, 101, 108, 108, 111]); // "Hello"
    }
  });

  it("raw (unpadded) base64 decodes correctly", () => {
    const a = parse('raw = b"SGVsbG8"').entries[0] as Assignment;
    expect(a.value.kind).toBe("bytes");
    if (a.value.kind === "bytes") {
      expect(Array.from(a.value.value)).toEqual([72, 101, 108, 108, 111]);
    }
  });
});

describe("nested blocks (messages)", () => {
  it("parses a tls block with assignments", () => {
    const src = `tls {
  cert_file = "/etc/ssl/cert.pem"
  verify    = true
}`;
    const doc = parse(src);
    expect(doc.entries).toHaveLength(1);
    const b = doc.entries[0] as Block;
    expect(b.kind).toBe("block");
    expect(b.name).toBe("tls");
    expect(b.entries).toHaveLength(2);
    expect((b.entries[0] as Assignment).key).toBe("cert_file");
  });

  it("nested two levels", () => {
    const src = `outer {
  inner {
    leaf = 1
  }
}`;
    const doc = parse(src);
    const outer = doc.entries[0] as Block;
    const inner = outer.entries[0] as Block;
    expect(inner.kind).toBe("block");
    expect(inner.name).toBe("inner");
    expect((inner.entries[0] as Assignment).key).toBe("leaf");
  });
});

describe("lists", () => {
  it("scalar list with commas", () => {
    const a = parse('tags = ["a", "b", "c"]').entries[0] as Assignment;
    expect(a.value.kind).toBe("list");
    const list = a.value as ListVal;
    expect(list.elements).toHaveLength(3);
    expect(list.elements.map((v) => (v.kind === "string" ? v.value : null))).toEqual(["a", "b", "c"]);
  });

  it("scalar list, commas optional (newline-separated)", () => {
    const src = `tags = [
  "a"
  "b"
  "c"
]`;
    const a = parse(src).entries[0] as Assignment;
    expect((a.value as ListVal).elements).toHaveLength(3);
  });

  it("list of inline blocks", () => {
    const src = `endpoints = [
  { path = "/api" }
  { path = "/health" }
]`;
    const a = parse(src).entries[0] as Assignment;
    const list = a.value as ListVal;
    expect(list.elements).toHaveLength(2);
    expect(list.elements[0]?.kind).toBe("blockVal");
  });
});

describe("maps", () => {
  it("string-keyed map", () => {
    const src = `labels = {
  env: "prod"
  team: "platform"
}`;
    const a = parse(src).entries[0] as Assignment;
    expect(a.value.kind).toBe("blockVal");
    const block = a.value as BlockVal;
    expect(block.entries).toHaveLength(2);
    const m0 = block.entries[0] as MapEntry;
    expect(m0.kind).toBe("mapEntry");
    expect(m0.key).toBe("env");
    expect((m0.value as { kind: string }).kind).toBe("string");
  });

  it("quoted-string keys", () => {
    const src = `labels = {
  "key with space": "v"
}`;
    const block = (parse(src).entries[0] as Assignment).value as BlockVal;
    expect((block.entries[0] as MapEntry).key).toBe("key with space");
  });

  it("int-keyed map", () => {
    const src = `codes = {
  404: "Not Found"
  500: "Internal"
}`;
    const block = (parse(src).entries[0] as Assignment).value as BlockVal;
    expect((block.entries[0] as MapEntry).key).toBe("404");
    expect((block.entries[1] as MapEntry).key).toBe("500");
  });
});

describe("comment attachment", () => {
  it("comments at the very top of the document attach to doc.leadingComments", () => {
    // Matches Go's behavior: anything before the first entry (and before
    // any @type) lands on the document, not on the first entry.
    const src = `# leading 1
# leading 2
name = "x"`;
    const doc = parse(src);
    expect(doc.leadingComments).toHaveLength(2);
    expect(doc.leadingComments[0]?.text).toBe("# leading 1");
    const a = doc.entries[0] as Assignment;
    expect(a.leadingComments).toEqual([]);
  });

  it("comments after @type but before the first entry attach to that entry", () => {
    const src = `@type pkg.M
# header comment
name = "x"`;
    const doc = parse(src);
    expect(doc.leadingComments).toEqual([]);
    const a = doc.entries[0] as Assignment;
    expect(a.leadingComments).toHaveLength(1);
    expect(a.leadingComments[0]?.text).toBe("# header comment");
  });

  it("comments before @type land in document.leadingComments", () => {
    const src = `# top of file
@type pkg.M
name = "x"`;
    const doc = parse(src);
    expect(doc.leadingComments).toHaveLength(1);
    expect(doc.leadingComments[0]?.text).toBe("# top of file");
  });

  it("comments inside a block attach to the next entry inside it", () => {
    const src = `outer {
  # before leaf
  leaf = 1
}`;
    const outer = parse(src).entries[0] as Block;
    const leaf = outer.entries[0] as Assignment;
    expect(leaf.leadingComments).toHaveLength(1);
  });
});

describe("error positions", () => {
  it("expected '=', ':', or '{' after key", () => {
    expect(() => parse("name xyz")).toThrow(/expected '=', ':', or '\{'/);
  });

  it("missing closing brace", () => {
    expect(() => parse("outer {\n  leaf = 1\n")).toThrow(/expected '\}'/);
  });

  it("missing closing bracket", () => {
    expect(() => parse("tags = [1, 2")).toThrow(/expected '\]'/);
  });

  it("error includes line:col", () => {
    try {
      parse("\n\nname xyz");
    } catch (e) {
      expect((e as PxfError).message).toMatch(/^3:/);
      return;
    }
    expect.fail("expected throw");
  });
});

describe("end-to-end PXF README sample", () => {
  it("parses without error", () => {
    const src = `@type infra.v1.ServerConfig

hostname = "web-01.prod.example.com"
port     = 8443
enabled  = true
status   = STATUS_SERVING

# Well-known type literals
created_at = 2024-01-15T10:30:00Z
timeout    = 30s

# Nested messages use block syntax
tls {
  cert_file = "/etc/ssl/cert.pem"
  key_file  = "/etc/ssl/key.pem"
  verify    = true
}

# Repeated fields use list syntax
tags = ["production", "us-east", "frontend"]

# Maps use : for key-value pairs
labels = {
  env: "production"
  team: "platform"
  "hello world": "quoted keys supported"
}

# Repeated messages
endpoints = [
  {
    path = "/api/v1/users"
    method = "GET"
  }
  {
    path = "/health"
    method = "GET"
  }
]

# Wrapper type sugar
nullable_name = "present"
`;
    const doc = parse(src);
    expect(doc.typeUrl).toBe("infra.v1.ServerConfig");
    expect(doc.entries.length).toBeGreaterThan(5);
    // Spot checks
    const byKey: Record<string, Assignment | Block> = {};
    for (const e of doc.entries) {
      if (e.kind === "assignment") byKey[e.key] = e;
      if (e.kind === "block") byKey[e.name] = e;
    }
    expect(byKey.hostname?.kind).toBe("assignment");
    expect(byKey.tls?.kind).toBe("block");
    expect((byKey.tags as Assignment).value.kind).toBe("list");
    expect((byKey.labels as Assignment).value.kind).toBe("blockVal");
  });
});
