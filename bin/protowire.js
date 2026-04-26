#!/usr/bin/env node
// Thin CLI wrapper. The real logic lives in src/cli/main.ts (compiled to
// dist/cli/main.js); this file only handles process I/O.

import { readFile } from "node:fs/promises";

import { run } from "../dist/cli/main.js";

const result = await run(process.argv.slice(2), readFile);
if (result.stdout.length > 0) process.stdout.write(result.stdout);
if (result.stderr.length > 0) process.stderr.write(result.stderr);
process.exit(result.exit);
