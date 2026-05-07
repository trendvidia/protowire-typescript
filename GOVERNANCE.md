# Governance

`protowire-typescript` is governed under the same constitution as the
rest of the `protowire-*` stack. The machine-readable source of truth
lives in the upstream spec repo at
[`governance.pxf`](https://github.com/trendvidia/protowire/blob/main/governance.pxf);
the human-readable preamble is at
[`GOVERNANCE.md`](https://github.com/trendvidia/protowire/blob/main/GOVERNANCE.md).

This file is a short pointer-doc. If anything below disagrees with the
upstream constitution, the upstream wins.

## Domain ownership

This repo's only domain vector is
[`protowire-typescript`](https://github.com/trendvidia/protowire/blob/main/governance.pxf)
under the upstream `port-libraries` umbrella. Approval requirements:

| Path | Reviewer authority |
|---|---|
| `src/pb/`, `src/pxf/`, `src/sbe/`, `src/envelope/` | port maintainers (`@trendvidia/maintainers`) |
| `proto/` | upstream spec maintainers — these are vendored copies of `trendvidia/protowire/proto/{pxf,sbe}/annotations.proto` and may not diverge |
| `scripts/bench-*.ts`, `scripts/dump-*.ts` | port maintainers; these feed the cross-port harness in `trendvidia/protowire/scripts/cross_*.sh` and must keep their JSON output schema stable |
| `.github/`, `package.json`, `tsconfig*.json`, `tsup.config.ts`, `buf.yaml` | port maintainers |

## What's enforced today vs (roadmap)

The Steward agent that enforces the constitution programmatically is
**rolling out**. Until it is live:

- Pull requests are reviewed by human maintainers.
- The `0.70.x` release line implements the wire contract documented in
  [`docs/grammar.ebnf`](https://github.com/trendvidia/protowire/blob/main/docs/grammar.ebnf)
  + [`docs/HARDENING.md`](https://github.com/trendvidia/protowire/blob/main/docs/HARDENING.md);
  cross-port wire-equivalence is verified locally via the upstream
  `scripts/cross_*.sh` harnesses, not yet by CI here.
- Reputation-weighted voting, automatic escrow for risky changes, and
  the `manifesto.blocked_module_globs` restriction are all `(roadmap)`
  per the upstream `governance.pxf`.

## Stable surfaces

Everything reachable from these public entry points is part of this
port's SemVer contract:

- `@trendvidia/protowire` — top-level
- `@trendvidia/protowire/pxf`
- `@trendvidia/protowire/pb`
- `@trendvidia/protowire/sbe`
- `@trendvidia/protowire/envelope`

Anything in an `_internal*` subpath, or marked `@internal` in a doc
comment, is not stable.

The wire contract — what bytes a given proto message produces — is
governed by the **upstream** spec, not this port. Bumping the wire
contract requires a coordinated PR landing in every sibling port; see
[`STABILITY.md`](https://github.com/trendvidia/protowire/blob/main/STABILITY.md)
upstream.
