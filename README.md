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
