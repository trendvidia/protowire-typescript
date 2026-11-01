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

### Fixed

- **`Result` reports a keyed entry's name as setting the key field** (protowire-go#214). After `kd { alpha {} }`, `isSet("kd[0].name")` is `true` and `isAbsent("kd[0].name")` is `false`; they said the opposite, although the name was in the message. Decoded values do not change. `postDecode` does not walk list elements in this port yet (#58), so the reference's other symptoms, a default replacing the name and a required key reported absent, could not occur here. New tests pin the right answer for when it does.

### Changed

- **`Violation.name` holds the `(pxf.default)` literal for `(pxf.required)` with `(pxf.default)` on one field** (protowire-go#211). It was the bare field name, which `element` already gives.

## [1.3.0] — 2026-10-31

### Added

- **Keyed repeated fields** (draft `-01` §3.13; [#29](https://github.com/trendvidia/protowire-typescript/issues/29), [trendvidia/protowire#116](https://github.com/trendvidia/protowire/issues/116)). A `repeated <Message>` field with `(pxf.key)` can be written as a block of named blocks, with the entry name as the key and entry order as list order.
  - The grammar accepts a string as an entry name (`"us-east-1" { ... }`). `Assignment.keyQuoted` and `Block.nameQuoted` record the quoting, and `format` reproduces it.
  - `(pxf.key)`, extension 1316, is back in `proto/pxf/annotations.proto`, which now matches protos v0.1.2. `validateDescriptor` reports a misplaced annotation as a `keyOption` violation, across the bound file's import closure, and `unmarshal` rejects it at bind time.
  - The decoder reads the block form, its `name = { ... }` spelling and the anonymous list form. It rejects duplicate names (compared unquoted), empty keys, a key assignment that disagrees with its entry name, and a quoted name outside a keyed block.
  - The encoder writes the keyed form whenever every key is present, non-empty and distinct, and the anonymous form otherwise.
  - `canonicalizeKeyed(doc, desc)` is the schema-aware half of fmt: follow it with `format`. `keyField` and `identSafeEntryName` are exported.
  - Elements of a keyed field get indexed `Result` paths (`children[0].type`), in the reference's form.
  - The spec repo's `testdata/keyed/` corpus is vendored under `src/pxf/testdata/keyed/` and driven by `src/pxf/keyed.test.ts`.

### Changed

- **A quoted name in message context is now an error.** `"id" = "x"` used to decode as the field `id`. Draft `-01` §3.13 requires the schema layer to reject it, because a string entry name never names a field.

- **The vendored shared schemas are re-synced with [trendvidia/protos](https://github.com/trendvidia/protos) v0.1.2** ([trendvidia/protowire#447](https://github.com/trendvidia/protowire/issues/447)). They gain protos' file options. Declarations and field numbers are unchanged, and so is this port's public API.

### Changed

- **The vendored shared schemas are re-synced with [trendvidia/protos](https://github.com/trendvidia/protos) v0.1.2** ([trendvidia/protowire#447](https://github.com/trendvidia/protowire/issues/447)). They gain protos' file options. Declarations and field numbers are unchanged, and so is this port's public API.

- **`asValidationErrorMessage`-built errors now start `PXF schema
  violations:`**, not `PXF schema reserved-name violations:`, because
  they are no longer only about names.

### Fixed

- **`(pxf.required)` with `(pxf.default)` on one field fails when the
  schema is bound** ((#59)), as draft -01 "Required and Default"
  requires (protowire#453). Such a schema used to bind, and the
  outcome for a document omitting the field depended on the engine.
  `unmarshal` and `unmarshalFull` now throw, and `validateDescriptor`
  and `validateFile` report it with the new `requiredOption` kind and
  a new optional `Violation.detail`. `(pxf.required) = false` beside a
  default stays accepted. This port reads only the bracket options,
  and checks one file, as its reserved-name check does; widening that
  to the import closure is #33.
  
### Added

- **`pxf.MAX_NESTING_DEPTH` and `pb.MAX_NESTING_DEPTH`**, both 100, and
  `Reader.depth`, which carries the count through nested PB decoders.

### Fixed

- **PXF and PB decoding enforce `MaxNestingDepth`** (protowire#449,
  HARDENING.md § Recursion). This port had no limit. Documents and
  messages nested past 100 levels used to decode, and a very deep PXF
  document failed with a stack-overflow `RangeError`. Now `parse`,
  `unmarshal`, `unmarshalFull` and `defineMessage` codecs all fail with
  `nesting depth exceeds MaxNestingDepth=100`. Every PXF `{` or `[`
  counts, including a map's own `{`, a directive block and the skipped
  text of an unknown field. Every PB submessage and map entry counts,
  whatever the entry's value type. This narrows what the decoders
  accept.

## [1.2.0] — 2026-05-14

Additive minor — no breaking changes, no wire-format change.
Internal duration codecs promoted to the public PXF surface so
consumers can convert between proto Duration `{seconds, nanos}`
and Go-style string literals (`"720h"`, `"1h30m"`, `"500µs"`)
without round-tripping through a wrapping message.

### Added

- **`parseGoDuration(s)`** — parse a Go-style duration literal
  (`"1h30m"`, `"-2.5s"`, `"100ms"`, …) into proto Duration parts.
  Throws on syntax errors; accepts leading `+`/`-`; treats the
  single-character `"0"` as zero.
- **`formatGoDuration(d, options?)`** — emit `{seconds, nanos}` as
  a Go-style duration literal. Mirrors `time.Duration.String()` by
  default; pass `{ compact: true }` to strip trailing zero h/m/s
  units (the same behavior as `MarshalOptions.compactDuration`
  from #18, now exposed at helper granularity).
- **`type DurationParts = { seconds: bigint; nanos: number }`** —
  protocol shape both functions share; compatible with
  `@bufbuild/protobuf`'s `create(DurationSchema, ...)` init shape.
- **`type FormatGoDurationOptions`** — options bag for the
  formatter.

### Refactor (no behavior change)

- Extracted shared duration logic from `decode.ts` + `encode.ts`
  into a new `src/pxf/duration.ts` module that both internal
  call sites consume. `MarshalOptions.compactDuration` still
  routes through this module — the v1.1.0 default-false byte-
  equivalence guarantee is preserved. All 403 v1.1.0 tests pass
  unchanged; 33 new tests in `src/pxf/duration.test.ts` cover
  the new public surface plus a round-trip property across
  representative inputs.

(#20)

## [1.1.0] — 2026-05-14

Additive minor — no breaking changes, no wire-format change. Byte-
equivalence with the canonical Go reference is preserved on the
default code path.

### Added

- **`MarshalOptions.compactDuration`** (default `false`). When set to
  `true`, the emitter strips trailing zero-valued h/m/s units from
  Go-style Duration literals — `720h0m0s` → `720h`, `1h30m0s` →
  `1h30m`, `30m0s` → `30m`. Internal zero units between non-zero ones
  (`1h0m30s`) are preserved per Go's structural emit rule; sub-second
  forms (`<n>ns`, `<n>µs`, `<n>ms`) and the canonical zero (`0s`) pass
  through unchanged.

  Trim-safety: the `0` being stripped must be preceded by a unit
  letter (h/m/s/µ/n), never by a digit, so `720h` is never trimmed
  to `72`.

  Default-false preserves the Go-reference byte-equivalence the
  v1.0.0 line guarantees. Use this option in consumer apps that
  hand-edit PXF config files and value compact on-disk literals
  over wire-format strictness — typical for editor UIs that
  round-trip a config through `unmarshal` → user edit → `marshal`.

  (#18)

## [1.0.0] — 2026-05-13

First major-version cut. Implements the three one-time spec changes
from the protowire v1.0 freeze line in lockstep with `protowire`,
`protowire-go`, and `protowire-java`. **Breaking** — there is no
alias period; v1.0 is itself the major bump. Published to npm as
`@trendvidia/protowire@1.0.0` via OIDC on tag push.

### v1.0 spec changes

Three one-time spec changes from the protowire v1.0 freeze line
(STABILITY.md in the spec repo). **Breaking** — there is no alias
period; v1.0 is itself the major bump.

- `@table` directive renamed to `@dataset` (draft §3.4.4). Public API
  follows: `TableDirective` → `DatasetDirective`, `TableRow` →
  `DatasetRow`, `TableReader` → `DatasetReader`, `Document.tables` →
  `Document.datasets`, `Result.tables()` → `Result.datasets()`.
  Source files `table_reader.ts` / `table_reader.test.ts` renamed
  accordingly. Decoder semantics unchanged.

- `@proto` directive added (draft §3.4.5). New `ProtoDirective`
  interface + `ProtoShape` type (`"anonymous" | "named" | "source" |
  "descriptor"`). Four body shapes lexically distinguished:
  `@proto { ... }` (anonymous), `@proto pkg.Type { ... }` (named),
  `@proto """..."""` (source), `@proto b"..."` (descriptor). Exposed
  via `Document.protos` and `Result.protos()`. Descriptor form is
  the MUST-support shape per spec; this port supports all four.

- Reserved directive names expanded from 5 to 13 (draft §3.4.6).
  Parser + decoder reject `@table`, `@datasource`, `@view`,
  `@procedure`, `@function`, `@permissions` as spec-reserved.
  `FUTURE_RESERVED_DIRECTIVES` exported from `schema.ts`.

`@dataset`'s row message type is now optional in the AST — binding
to an anonymous `@proto` per draft §3.4.4 Anonymous binding.

`Lexer.repositionTo(target: number)` added for skipping `@proto`
brace bodies whose interior is protobuf source rather than PXF.
`findMatchingBrace` and `decodeBase64` exported from `parser.ts`
for reuse by the decoder.

## [0.75.0] — 2026-05-12

First release after the v0.70.0 baseline that closes the v0.72–v0.75
gap with the rest of the `protowire-*` stack (Go, Java, cpp, python).
All four PXF v0.72-series features are now available in the TypeScript
port, in lockstep with what the sibling ports shipped over their
v0.72 → v0.74 → v0.75 cuts. The TS port skips intermediate version
numbers and lands the bundled feature set directly on v0.75.0 to
match the active wire revision.

### Added

- **`TableReader` streaming `@table` consumption + `bindRow`
  per-row binding** (draft §3.4.4). `unmarshalFull` materializes
  every row of an `@table` directive into `Result.tables()`; that
  works for small datasets and breaks for the CSV-replacement
  workload `@table` was designed for. New
  `src/pxf/table_reader.ts` exposes:
  - `TableReader.fromString(input)` — consumes leading directives
    and the `@table TYPE ( cols )` header; the reader is positioned
    at the first row. Header capped at 64 KiB
    (`DEFAULT_HEADER_MAX_BYTES`) to fail-fast on misuse.
  - `type` / `columns` / `directives` properties expose the parsed
    header.
  - Implements the iterator protocol — `for (const row of reader)`
    just works; `next()` returns `{ value, done }`. Per-row arity
    and v1 cell-grammar checks happen at consume time.
  - `scan(schema, options?)` — `next` + `bindRow` in one call;
    returns a freshly-bound message or `null` at EOF.
  - `tail()` — returns the unconsumed bytes of the input for
    chaining a second `TableReader` on multi-`@table` documents.
  - `bindRow(schema, columns, row, options?)` — exported helper for
    callers iterating `Result.tables()[i].rows` from the
    materializing path. Strategy is format-and-reparse — render
    cells as a synthetic PXF body and run through `unmarshal`,
    reusing every branch of the existing decoder. `skipValidate`
    defaults to `true` to avoid re-running the reserved-name check
    per row.

- **`Result.directives()` and `Result.tables()` accessors.** The
  direct decoder now populates the document-root directive list and
  `@table` directive list on `Result` during `unmarshalFull`, so
  consumers can read them after a decode call.
  - `Result.directives()` returns the generic
    `@<name> *(prefix) [{ ... }]` blocks in source order, with raw
    body bytes preserved verbatim for downstream re-parsing
    (chameleon's `@header T { ... }` reader, etc.). A single prefix
    populates the back-compat `type` field; two or more leave it
    empty and consumers read `prefixes` directly.
  - `Result.tables()` returns the `@table` directives with full
    column metadata and parsed cell values per row, faithful to the
    three-state cell grammar (absent / present-but-null /
    present-with-value, draft §3.4.4).
  - `unmarshal` (vs `unmarshalFull`) still passes no `Result` and
    walks directives without allocating any AST nodes — the direct
    path retains its zero-allocation contract on the hot path.

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
