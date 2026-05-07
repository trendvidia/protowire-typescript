// SPDX-License-Identifier: MIT
// Copyright (c) 2026 TrendVidia, LLC.

import { defineConfig } from "tsup";

/**
 * Dual ESM + CJS build for `@trendvidia/protowire`.
 *
 * Each public entry produces three files:
 *   dist/<path>/index.js   — ESM
 *   dist/<path>/index.cjs  — CJS
 *   dist/<path>/index.d.ts — types (one set, dual-consumed)
 *
 * The protowire VS Code extension (in trendvidia/protowire) bundles the
 * `:pxf` parser via tree-shaking; keeping the parser deps zero (pure
 * ECMAScript) is a load-bearing property — don't reach for runtime
 * polyfills here without first checking the bundle-size impact.
 */
export default defineConfig({
  entry: [
    "src/index.ts",
    "src/pxf/index.ts",
    "src/pb/index.ts",
    "src/sbe/index.ts",
    "src/envelope/index.ts",
  ],
  format: ["esm", "cjs"],
  outExtension({ format }) {
    return { js: format === "cjs" ? ".cjs" : ".js" };
  },
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,    // keep one file per entry; predictable for consumers
  treeshake: true,
  target: "node20",
  // The package is ESM-first internally (NodeNext); leave runtime-only
  // platform set to node so tsup doesn't try to polyfill node: imports.
  platform: "neutral",
  // Don't bundle peer/runtime deps — leave them as imports so consumers
  // dedupe on their side.
  external: ["@bufbuild/protobuf"],
});
