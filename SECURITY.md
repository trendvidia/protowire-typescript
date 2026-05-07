# Security Policy

## Reporting a vulnerability

Email **security@trendvidia.com** with a description, reproduction steps,
and the affected version(s) or commit(s). PGP key on request.

Please do **not** file public GitHub issues for vulnerabilities, and do
**not** post details in pull request comments.

You can expect:

- An acknowledgement within **3 business days**.
- A triage decision (accepted / not-a-vulnerability / needs-more-info)
  within **10 business days**.
- A coordinated fix on the timeline below.

## Scope

This policy covers `@trendvidia/protowire` — the TypeScript port of the
`protowire` stack. Cross-port issues (the same input affecting multiple
language ports) are also accepted here and routed to the upstream
project; you can equivalently file at
[`trendvidia/protowire`](https://github.com/trendvidia/protowire) per
its [`SECURITY.md`](https://github.com/trendvidia/protowire/blob/main/SECURITY.md).

In scope:

- Decoder crashes, hangs, infinite loops, unbounded memory, or OOMs
  triggered by adversarial PXF / PB / SBE / envelope input.
- Wire-format divergences from other ports for the same input that
  could be exploited (e.g. authorization bypass via parser disagreement).
- Schema-validation bypasses that let invalid messages reach
  application code.
- Prototype-pollution or supply-chain risks in the `:pxf` parser
  reaching consumers via `JSON.parse`-style coercion or unsafe object
  creation. Please report even theoretical paths.

Out of scope:

- Denial-of-service via legitimately large inputs that respect the
  limits in the upstream
  [`docs/HARDENING.md`](https://github.com/trendvidia/protowire/blob/main/docs/HARDENING.md).
- Issues in `@bufbuild/protobuf` itself — file those upstream at
  [`bufbuild/protobuf-es`](https://github.com/bufbuild/protobuf-es)
  and CC us.

## Supply-chain assurances

Releases of `@trendvidia/protowire` published from `0.70.0` onward are
signed via [npm provenance](https://docs.npmjs.com/generating-provenance-statements):
the published tarball cryptographically attests it was built by the
[`publish.yml`](.github/workflows/publish.yml) workflow on a specific
commit, runner, and tag. Consumers can verify with:

```sh
npm audit signatures
```

## Coordinated disclosure

For vulnerabilities affecting **more than one port**, a **30-day
embargo** applies from the date we acknowledge your report (per the
upstream project's policy), extendable by mutual agreement when a fix
needs more time. During the embargo we coordinate fixes across all
affected ports so they ship simultaneously.

Single-port issues follow this port's own disclosure timeline,
typically 7–14 days, but always at least long enough for a fix to be
released to npm.

## Hall of fame

Reporters who follow coordinated disclosure are credited in
`SECURITY-ADVISORY-*.md` advisories on the upstream repo and (with
permission) in the release notes. We do not currently run a paid
bug-bounty program.
