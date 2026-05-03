# protowire-typescript

TypeScript port of [protowire](https://github.com/trendvidia/protowire). Pure TypeScript on top of [`@bufbuild/protobuf`](https://github.com/bufbuild/protobuf-es) — no WASM.

## Modules

- `@trendvidia/protowire/envelope` — API response envelope (`OK`, `Err`, `TransportErr`, `AppError`, `FieldError`).
- `@trendvidia/protowire/pb` — schema-free protobuf binary marshaling driven by a TypeScript field-tag schema (mirrors the Go `encoding/pb` package's `protowire:"N"` struct tags).
- `@trendvidia/protowire/pxf` — PXF (Proto eXpressive Format) text codec. Schema-bound encoder/decoder over `protobuf-es` descriptors.
- `@trendvidia/protowire/sbe` — SBE (Simple Binary Encoding) codec, driven by `sbe.*` annotations on proto schemas.

See the [spec repo](https://github.com/trendvidia/protowire) for the format reference.

## Command-line tool

The `protowire` CLI is shared across every port and lives in the spec repo at [github.com/trendvidia/protowire/cmd/protowire](https://github.com/trendvidia/protowire/tree/main/cmd/protowire). Install:

```sh
go install github.com/trendvidia/protowire/cmd/protowire@latest
```

TypeScript users use this library for in-process encode/decode and the shared CLI for command-line operations. There is no separate TypeScript CLI binary.

## Development

```bash
npm install
npm test
npm run typecheck
npm run build
```

## Limitations & open gaps

Built on `@bufbuild/protobuf` (protobuf-es) — pure TypeScript, no WASM, no `protobufjs`. A few items fall out of that choice or are deferred:

- **`BigInt` is the user-visible type for `int64` / `uint64`.** Numbers above `Number.MAX_SAFE_INTEGER` round in JS, so the bench/tests use BigInt throughout. Down-conversion to `number` is the caller's call.
- **Sub-second `Duration` granularity** is approximated. JavaScript timer resolution is millisecond-bound; the codec preserves the proto-level nanos field for round-trip but you can't author a sub-millisecond duration directly from a JS `Date` / `Duration` ergonomically.
- **`protobuf-es` doesn't surface custom extension fields as known fields on `FieldOptions`.** The PXF annotation reader hand-decodes the unknown bytes — this works but ties the implementation to protobuf-es internals; a runtime API change there will require an update.
- **No standalone TS CLI.** The shared CLI lives in [trendvidia/protowire/cmd/protowire](https://github.com/trendvidia/protowire/tree/main/cmd/protowire). Bun / Deno-native flavors aren't covered today.
- **Browser-friendliness of the SBE codec is unverified.** Most consumers run on Node; the SBE binary path uses `Buffer` in places where it could be `Uint8List`. PRs welcome from anyone who wants to use SBE in the browser.

## Contributing & governance

This repository is part of the `protowire-*` family and is governed by [**Steward**](https://github.com/trendvidia/steward) — the meritocratic, AI-driven governance engine that runs all of the ports. Voting weight is per-directory expertise, the constitution is public in [`governance.pxf`](https://github.com/trendvidia/steward/blob/main/governance.pxf), and Steward routes draft / first-time PRs through a [private mentorship pipeline](https://github.com/trendvidia/steward#-private-mentorship-mode) so initial contributions get private feedback rather than public-review friction.

If any of the items above sound interesting, pull requests are welcome. New contributors start at zero trust and accumulate influence by shipping merged PRs in the directories they actually work on — the [escrow pipeline](https://github.com/trendvidia/steward#%EF%B8%8F-the-escrow-pipeline-zero-trust-onboarding) auto-routes large first-time PRs through 2–3 sandbox issues before unlocking them for community review.

See the [Steward README](https://github.com/trendvidia/steward) for a longer walkthrough of vector reputation, escrow, and the immune system.
