# protowire4ts

TypeScript port of [protowire](https://github.com/trendvidia/protowire). Pure TypeScript on top of [`@bufbuild/protobuf`](https://github.com/bufbuild/protobuf-es) — no WASM.

## Modules

- `@trendvidia/protowire/envelope` — API response envelope (`OK`, `Err`, `TransportErr`, `AppError`, `FieldError`).
- `@trendvidia/protowire/pb` — schema-free protobuf binary marshaling driven by a TypeScript field-tag schema (mirrors the Go `encoding/pb` package's `protowire:"N"` struct tags).
- `@trendvidia/protowire/pxf` — PXF (Proto eXpressive Format) text codec. Schema-bound encoder/decoder over `protobuf-es` descriptors.
- `@trendvidia/protowire/sbe` — SBE (Simple Binary Encoding) codec, driven by `sbe.*` annotations on proto schemas.

See the [Go README](../protowire/README.md) for format reference.

## Status

In progress. See `MEMORY.md` for the roadmap and porting notes.

## Development

```bash
npm install
npm test
npm run typecheck
npm run build
```
