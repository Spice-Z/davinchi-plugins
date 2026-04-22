#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");
const require = createRequire(join(pkgRoot, "package.json"));
const tsxRoot = dirname(require.resolve("tsx/package.json"));
const tsxCli = join(tsxRoot, "dist", "cli.mjs");
const entry = join(pkgRoot, "src/cli/runXmlSilenceCut.ts");

const result = spawnSync(process.execPath, [tsxCli, entry, ...process.argv.slice(2)], {
  stdio: "inherit",
  cwd: pkgRoot,
  env: process.env,
});

process.exit(result.status === null ? 1 : result.status);
