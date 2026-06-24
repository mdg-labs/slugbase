#!/usr/bin/env bash
# Compare release tag package versions + SHA against DEPLOYED_STATE_production (WP-8, spec §22.7).
#
# Inputs (env):
#   RELEASE_TAG            git ref for the published release (required)
#   DEPLOYED_STATE_JSON    current DEPLOYED_STATE_production value (optional)
#
# Outputs (GITHUB_OUTPUT when set):
#   should_deploy, deploy_api_needed, deploy_web_needed,
#   deploy_marketing_needed, deploy_admin_needed, skip_reasons

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

RELEASE_TAG="${RELEASE_TAG:-}"
DEPLOYED_STATE_JSON="${DEPLOYED_STATE_JSON:-}"

usage() {
  echo "Usage: RELEASE_TAG=<tag> [DEPLOYED_STATE_JSON=<json>] $0" >&2
}

if [[ -z "$RELEASE_TAG" ]]; then
  usage
  exit 1
fi

export CHECK_RELEASE_TAG="$RELEASE_TAG"
export CHECK_DEPLOYED_STATE_JSON="$DEPLOYED_STATE_JSON"

RESULT_JSON="$(
  node <<'NODE'
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  checkProductionDeployNeeded,
  formatProductionDeployOutputs,
} from "./scripts/check-production-deploy-needed.mjs";

const releaseTag = process.env.CHECK_RELEASE_TAG;
const deployedStateJson = process.env.CHECK_DEPLOYED_STATE_JSON ?? "";

function readPackageVersions() {
  const packagesDir = join(process.cwd(), "packages");
  /** @type {Record<string, string>} */
  const versions = {};
  for (const entry of readdirSync(packagesDir)) {
    const pkgDir = join(packagesDir, entry);
    const manifestPath = join(pkgDir, "package.json");
    try {
      if (!statSync(pkgDir).isDirectory()) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (manifest.name && manifest.version) {
        versions[manifest.name] = manifest.version;
      }
    } catch {
      // skip non-packages
    }
  }
  return versions;
}

const releaseSha = execFileSync("git", ["rev-parse", releaseTag], {
  encoding: "utf8",
}).trim();

const result = checkProductionDeployNeeded({
  releaseSha,
  deployedStateJson,
  packageVersions: readPackageVersions(),
});

process.stdout.write(
  JSON.stringify({
    outputs: formatProductionDeployOutputs(result.surfaces),
    skipReasons: result.skipReasons,
    log: result.log,
  }),
);
NODE
)"

emit_outputs() {
  local key="$1"
  local value="$2"
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    {
      echo "${key}=${value}"
    } >>"$GITHUB_OUTPUT"
  fi
  echo "check-production-deploy-needed: ${key}=${value}"
}

while IFS= read -r line; do
  key="${line%%=*}"
  value="${line#*=}"
  emit_outputs "$key" "$value"
done < <(
  node -e '
const payload = JSON.parse(process.argv[1]);
for (const [key, value] of Object.entries(payload.outputs)) {
  process.stdout.write(`${key}=${value}\n`);
}
for (const reason of payload.skipReasons) {
  process.stderr.write(`check-production-deploy-needed: ${reason}\n`);
}
for (const entry of payload.log) {
  process.stderr.write(`check-production-deploy-needed: ${entry}\n`);
}
' "$RESULT_JSON"
)

SKIP_REASONS="$(
  node -e '
const payload = JSON.parse(process.argv[1]);
process.stdout.write(payload.skipReasons.join("\n"));
' "$RESULT_JSON"
)"

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  {
    echo "skip_reasons<<EOF"
    printf '%s\n' "${SKIP_REASONS}"
    echo "EOF"
  } >>"$GITHUB_OUTPUT"
fi
