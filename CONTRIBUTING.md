# Contributing to protowire-typescript

Welcome — this is the TypeScript port of [protowire](https://protowire.org),
a language-neutral wire-format toolkit. It tracks the canonical
specification in
[`trendvidia/protowire`](https://github.com/trendvidia/protowire) and is
one of nine sibling ports (Go, C++, Rust, Java, TypeScript, Python, C#,
Swift, Dart).

> **Steward integration is rolling out.** The governance described in
> [GOVERNANCE.md](GOVERNANCE.md) is the steady-state model. While Steward
> is being finalised, pull requests are reviewed by human maintainers in
> the conventional way — open a PR, expect review, iterate.

## Where bugs go

| Symptom | File against |
|---|---|
| TypeScript-only crash, wrong API ergonomics, performance regression in this port only | `trendvidia/protowire-typescript` |
| The same input produces different output here vs another port | upstream [`trendvidia/protowire`](https://github.com/trendvidia/protowire) (cross-port wire-equivalence regression) |
| Spec / grammar / proto annotation question | upstream [`trendvidia/protowire`](https://github.com/trendvidia/protowire) |
| Decoder crash / hang / OOM on adversarial input | **email security@trendvidia.com**, do not file public issue (see [SECURITY.md](SECURITY.md)) |

## Local development

Node.js 20+ is required (declared via `engines.node` in `package.json`).

```sh
npm install                # install deps
npm run build              # compile to dist/ (ESM + CJS + .d.ts via tsup)
npm test                   # run vitest
npm run test:watch         # vitest in watch mode
npm run typecheck          # tsc --noEmit (strict type-check; doesn't emit)
npm run buf:lint           # lint vendored .proto files via buf
```

The build emits **both ESM and CJS** so the package works under modern
bundlers (Vite, esbuild, webpack 5+, rollup) and legacy Node CommonJS
consumers alike.

## Sending changes

1. Open a draft PR early — design feedback before you finish saves
   churn for both sides.
2. **For changes that touch the parser/encoder behaviour**: after the
   draft is up, please post a comment listing which fixtures from
   [`src/pxf/testdata/`](src/pxf/testdata/) and
   [`src/sbe/testdata/`](src/sbe/testdata/) you exercised. The cross-port
   wire-equivalence promise means a wrong move here can break eight
   other ports' contracts.
3. **For changes that touch the wire format itself** — annotation field
   numbers in `proto/`, the PXF grammar, the SBE schema-id semantics —
   open the upstream PR in
   [`trendvidia/protowire`](https://github.com/trendvidia/protowire)
   first. This port shouldn't lead spec changes; it implements them.

## Code style

- TypeScript strict mode is on (and won't be relaxed): `strict`,
  `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `verbatimModuleSyntax`. The build flags violations.
- Prefer named exports. The package's public API is everything reachable
  from `src/index.ts` and the per-module `src/{pxf,pb,sbe,envelope}/index.ts`.
- ESM-first internally — relative imports use the `.js` suffix even
  though we author `.ts` (this is what `verbatimModuleSyntax` requires).
- No new top-level dependencies without a one-line justification in the
  PR description. The `:pxf` and `:pb` modules' parsers are pure ECMAScript
  with zero external runtime deps; that's a load-bearing property the
  protowire VS Code extension relies on (it bundles this package's
  parser via tree-shaking).

## What we don't accept

- Changes that break wire-equivalence with another sibling port.
- Changes that ship `protoc` plugins of their own (codegen lives in the
  spec repo, not here).
- Switching the package away from ESM — both formats stay published.

## Releases

This port releases in lockstep with the rest of the `protowire-*` stack.
The version line is `0.70.x` for the first coordinated public release;
ports that share a `0.70.x` minor implement the same wire contract.

A maintainer cuts releases by:
1. Bumping `version` in `package.json` (also updates `package-lock.json`).
2. Adding a `## [X.Y.Z]` section to `CHANGELOG.md`.
3. Tagging `vX.Y.Z` on `main`.
4. The `.github/workflows/publish.yml` workflow promotes to npm under
   the `@trendvidia/protowire` package, with [npm
   provenance](https://docs.npmjs.com/generating-provenance-statements)
   so consumers can verify the package was built from this exact commit.
