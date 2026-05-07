# protowire-typescript

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/@trendvidia/protowire?color=cb3837&logo=npm&label=npm)](https://www.npmjs.com/package/@trendvidia/protowire)
[![CI](https://github.com/trendvidia/protowire-typescript/actions/workflows/ci.yml/badge.svg)](https://github.com/trendvidia/protowire-typescript/actions/workflows/ci.yml)

TypeScript port of [protowire](https://protowire.org) — a wire-format
toolkit. Pure TypeScript on top of
[`@bufbuild/protobuf`](https://github.com/bufbuild/protobuf-es), **no WASM**.
Verified for byte-equivalence with the canonical Go reference and seven
other sibling ports.

Ships **dual ESM + CJS** so the package works under modern bundlers
(Vite, esbuild, webpack 5+, rollup) and legacy CommonJS Node.js
consumers alike. Releases are signed via
[npm provenance](https://docs.npmjs.com/generating-provenance-statements);
verify with `npm audit signatures`.

## Install

```bash
npm install @trendvidia/protowire
```

```ts
import { parse } from "@trendvidia/protowire/pxf";   // ESM
// or:
const { parse } = require("@trendvidia/protowire/pxf");  // CJS
```

All published artifacts share the `0.70.x` line; ports at the same
minor implement the same wire contract.

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
