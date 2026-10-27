#!/usr/bin/env bash
set -euo pipefail

# Builds the sidecar the way the Dockerfile sidecar stage does:
# `npm ci` from the committed lockfile, `tsc` into dist/, then prune the dev
# tree so only the runtime dependency set remains. `--check` runs the same
# recipe but stops before the prune, leaving the dev tree usable for lint,
# typecheck, and tests, and additionally asserts dist exists and every pin
# recorded in package.json is the version actually installed.

cd "$(dirname "$0")"

if [[ ! -f package-lock.json ]]; then
  echo "sidecar/package-lock.json is missing, cannot pin the install" >&2
  exit 1
fi

echo "### npm ci (sidecar)"
npm ci

echo "### npm run build (sidecar)"
npm run build

if [[ "${1:-}" != "--check" ]]; then
  echo "### npm prune --omit=dev (sidecar)"
  npm prune --omit=dev
  exit 0
fi

if [[ ! -f dist/index.js ]]; then
  echo "sidecar/dist/index.js is missing after the build" >&2
  exit 1
fi

node --input-type=module -e '
import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

const manifest = JSON.parse(readFileSync("package.json", "utf8"));
const pins = { ...manifest.dependencies, ...manifest.overrides };
const failures = [];

function installedVersion(name) {
  for (let dir = process.cwd(); dir !== "/"; dir = dirname(dir)) {
    const entry = `${dir}/node_modules/${name}/package.json`;
    if (existsSync(entry)) {
      return String(JSON.parse(readFileSync(entry, "utf8")).version);
    }
  }
  return null;
}

for (const [name, pin] of Object.entries(pins)) {
  const installed = installedVersion(name);
  if (installed === null) {
    failures.push(`${name}: pinned ${pin}, not installed`);
  } else if (installed !== pin) {
    failures.push(`${name}: pinned ${pin}, installed ${installed}`);
  }
}

if (failures.length > 0) {
  console.error(`sidecar pin check failed:\n${failures.join("\n")}`);
  process.exit(1);
}

console.log(`sidecar pin check passed: ${Object.keys(pins).length} packages exact, dist/index.js present`);
'

exit 0
