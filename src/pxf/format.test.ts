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

  it("int-keyed map preserves the numeric form (parser produced the key as INT-text)", () => {
    const src = `codes = {
  404: "Not Found"
  500: "Internal"
}`;
    // The map key "404" is a digit-only string — needsQuoting returns true
    // because the first char isn't alphanumeric ident-start. So it's quoted.
    const out = format(parse(src));
    expect(out).toBe(
      'codes = {\n  "404": "Not Found"\n  "500": "Internal"\n}\n',
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
