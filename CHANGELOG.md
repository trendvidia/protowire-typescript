# Changelog

All notable changes to `@trendvidia/protowire` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The version number is kept aligned with the rest of the `protowire-*`
stack — releases bump in lockstep across language ports when the wire
format changes.

> **Note on the version number.** Earlier internal builds used
> `0.0.0` / `0.1.0`; the renumbering to `0.70.0` is a one-time
> realignment with the rest of the protowire-* stack ahead of the first
> coordinated public release. No published artifacts are affected (the
> earlier numbers were never tagged on the npm registry).

## [Unreleased]

### Added

- **PXF schema reserved-name validator (draft §3.13).** Rejects
  protobuf schemas that declare a message field, oneof, or enum value
  whose name is case-sensitively equal to a PXF value keyword
  (`null` / `true` / `false`) — such a name lexes as the keyword and
  the declared element is unreachable from PXF surface syntax. New
  exports from `src/pxf/schema.ts`:
  - `validateDescriptor(desc)` / `validateFile(fd)` return a sorted
    list of `Violation { file, element, name, kind }`.
  - `violationString(v)` renders one-line human-readable text.
  - `UnmarshalOptions` gains `skipValidate?: boolean` for consumers
    that validate once at registry-load time and don't want the
    per-call recheck cost.
  - `unmarshal` and `unmarshalFull` invoke the validator before
    decode; violations come back as a `PxfError` with a multi-line
    message (one `violationString` line per offender).
  - Synthetic oneofs from proto3 `optional` fields are filtered
    automatically (bufbuild's `DescMessage.oneofs` already excludes
    them — matching Go's `IsSynthetic()` filter).

- **PXF parser-side `@<name>` / `@entry` / `@table` directive grammar**
  (draft §3.4.2 – §3.4.4). The AST `Document` now carries `directives`
  (generic `@<name> *(prefix) [{ ... }]` entries) and `tables`
  (`@table <type> ( cols ) row*` entries) alongside `typeUrl` and
  `entries`. `Directive.body` preserves the raw bytes between `{` and
  `}`; `Directive.type` keeps the legacy single-prefix shape for
  v0.72.0-era consumers. `Document.bodyOffset` marks the byte right
  after the last directive (used by chameleon for hashing the
  schema-typed payload).

  Both the AST parser and the direct decoder consume the new forms;
  runtime semantics (Result accessors, TableReader streaming, per-row
  Scan / bindRow) follow in subsequent PRs of the v0.72-v0.75
  catch-up. The decoder discards directive contents for now and
  enforces the standalone constraint (draft §3.4.4): a document
  containing any `@table` directive MUST NOT also carry `@type` or
  top-level field entries.

  `Position` gains an `offset` field (byte offset into the lexer's
  input) so directive body extraction can slice raw bytes; existing
  callers that read only line / column are unaffected.

## [0.70.0]

Initial public release. The version number aligns this port with the rest
of the `protowire-*` stack, which targets the 0.70.x series for the first
coordinated public release. The protowire VS Code extension
(`editors/vscode/`) bundles this package; refresh its vendored copy via
`bash scripts/refresh_vscode_parser_pkg.sh` after the 0.70.0 release is
cut on npm.

### Changed (breaking)

- **PXF parser stricter on key forms**, mirroring the upstream grammar
  tightening in
  [`trendvidia/protowire@8262bbb`](https://github.com/trendvidia/protowire/commit/8262bbb)
  (`docs/grammar.ebnf`, `docs/draft-trendvidia-protowire-00.txt`):
  - `=` (field assignment) and `{ … }` (submessage) now require an
    identifier key. Inputs like `123 = 234` or `child { 123 = 123 }`
    are now parse errors with
    `"field assignment with '=' requires an identifier key, got integer
    (\"123\"); use ':' for map entries"`.
  - `:` (map entry) is rejected at document top level — the document
    represents a proto message, never a `map<K,V>`. Use `=` for
    top-level field assignments. Map literals (`field = { 1: "x" }`)
    still work because `:` remains valid inside `{ … }` blocks.
