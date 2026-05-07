// SPDX-License-Identifier: MIT
// Copyright (c) 2026 TrendVidia, LLC.

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Test fixtures live under src/*/testdata/ and contain valid PXF /
    // SBE binaries that we don't want vitest to try to import.
    exclude: ["**/node_modules/**", "**/dist/**", "**/testdata/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      reportsDirectory: "./coverage",
      include: [
        "src/pxf/**/*.ts",
        "src/pb/**/*.ts",
        "src/sbe/**/*.ts",
        "src/envelope/**/*.ts",
      ],
      exclude: [
        "**/*.test.ts",
        "**/*.bench.ts",
        "**/testdata/**",
        "src/**/index.ts",      // re-export barrel files; nothing to cover
      ],
      thresholds: {
        // Conservative starting bar — bump as coverage gaps close. The
        // PXF parser has dense fixture coverage already; SBE less so.
        lines: 70,
        functions: 70,
        branches: 70,
        statements: 70,
      },
    },
  },
});
