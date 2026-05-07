---
name: Bug report
about: Report a defect — wrong output, crash, parse error on valid input, etc.
title: "bug: "
labels: bug
---

<!--
Cross-port issues (the same input behaves differently on multiple ports)
belong upstream at trendvidia/protowire, not here. See CONTRIBUTING.md.

Security issues (decoder crash/hang/OOM on adversarial input) go to
security@trendvidia.com instead. See SECURITY.md.
-->

## What happened

A clear description of the bug.

## How to reproduce

Smallest possible PXF / PB / SBE / envelope input + TypeScript code
that triggers it. Inline if short, or attach as a Gist.

```ts
import { parse } from "@trendvidia/protowire/pxf";

parse(`@type my.Type\nname = "x"\n`);  // throws here?
```

## What you expected

What you thought should happen.

## Versions

- `@trendvidia/protowire` version (`npm ls @trendvidia/protowire`):
- Node.js version (`node --version`):
- Module system (`"type": "module"` or CommonJS):
- TypeScript version (if applicable):
- OS / arch (only if it might matter):
