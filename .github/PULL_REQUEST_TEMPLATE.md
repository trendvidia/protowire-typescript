<!--
For changes that touch wire-format behaviour: please open the upstream
PR in trendvidia/protowire FIRST. This port implements the spec; it
shouldn't lead spec changes. See CONTRIBUTING.md.
-->

## Summary

What this PR changes, in 1–3 sentences.

## Why

Link to the issue or upstream spec change that motivated this.

## Scope

- [ ] Wire-impacting code (`src/pxf/`, `src/sbe/`, `src/pb/`, `src/envelope/`, `proto/`)
- [ ] Test fixtures / benches (`src/*/testdata/`, `scripts/bench-*.ts`)
- [ ] Build / CI / repo plumbing
- [ ] Documentation only

## Test plan

- [ ] `npm test` passes (vitest, all 14 suites)
- [ ] `npm run typecheck` passes (strict tsc, no emit)
- [ ] `npm run build` produces both ESM (`dist/**/*.js`) and CJS (`dist/**/*.cjs`)
- [ ] If wire-impacting: cross-port harness re-run locally via
      [`scripts/cross_*.sh`](https://github.com/trendvidia/protowire/tree/main/scripts) in the spec repo
- [ ] If protocol-touching: matching upstream spec PR linked above
