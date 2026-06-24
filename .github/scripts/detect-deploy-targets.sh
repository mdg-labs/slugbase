#!/usr/bin/env bash
# Detect which deploy surfaces are affected (granular-deployment WP-1, spec §22.5).
#
# Inputs (env):
#   ENVIRONMENT          staging | production (required)
#   HEAD_REF             git ref for head (default: HEAD)
#   BASE_REF             optional git base for turbo --filter=...[BASE_REF]
#   FORCE_FULL_DEPLOY    true | false (default: false)
#   DEPLOYED_STATE_JSON  optional production idempotency map (WP-8)
#   RELEASE_SHA          optional deployed commit SHA (defaults to HEAD)
#
# Outputs (GITHUB_OUTPUT when set):
#   deploy_api, deploy_web, deploy_marketing, deploy_admin,
#   run_migrate, run_migrate_admin, push_ghcr_api, push_ghcr_web, sync_services

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

ENVIRONMENT="${ENVIRONMENT:-}"
HEAD_REF="${HEAD_REF:-HEAD}"
BASE_REF="${BASE_REF:-}"
FORCE_FULL_DEPLOY="${FORCE_FULL_DEPLOY:-false}"
DEPLOYED_STATE_JSON="${DEPLOYED_STATE_JSON:-}"
RELEASE_SHA="${RELEASE_SHA:-}"

usage() {
  echo "Usage: ENVIRONMENT=staging|production [HEAD_REF=ref] [BASE_REF=ref] [FORCE_FULL_DEPLOY=true|false] $0" >&2
}

if [[ -z "$ENVIRONMENT" ]]; then
  usage
  exit 1
fi

if [[ "$ENVIRONMENT" != "staging" && "$ENVIRONMENT" != "production" ]]; then
  echo "detect-deploy-targets: ENVIRONMENT must be staging or production, got: ${ENVIRONMENT}" >&2
  exit 1
fi

normalize_bool() {
  case "${1,,}" in
    true | 1 | yes) echo "true" ;;
    *) echo "false" ;;
  esac
}

FORCE_FULL_DEPLOY="$(normalize_bool "$FORCE_FULL_DEPLOY")"

export DETECT_ENVIRONMENT="$ENVIRONMENT"
export DETECT_HEAD_REF="$HEAD_REF"
export DETECT_BASE_REF="$BASE_REF"
export DETECT_FORCE_FULL_DEPLOY="$FORCE_FULL_DEPLOY"
export DETECT_DEPLOYED_STATE_JSON="$DEPLOYED_STATE_JSON"
export DETECT_RELEASE_SHA="${RELEASE_SHA:-$(git rev-parse HEAD)}"

RESULT_JSON="$(
  node <<'NODE'
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  detectDeployTargets,
  extractAffectedPackages,
  formatGithubOutputs,
} from "./scripts/detect-deploy-targets.mjs";

const environment = process.env.DETECT_ENVIRONMENT;
const headRef = process.env.DETECT_HEAD_REF || "HEAD";
const baseRef = process.env.DETECT_BASE_REF || "";
const forceFullDeploy = process.env.DETECT_FORCE_FULL_DEPLOY === "true";
const deployedStateJson = process.env.DETECT_DEPLOYED_STATE_JSON ?? "";
const releaseSha = process.env.DETECT_RELEASE_SHA ?? "";

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

function collectChangedPaths() {
  if (!baseRef) {
    return [];
  }
  try {
    const output = execFileSync(
      "git",
      ["diff", "--name-only", baseRef, headRef],
      { encoding: "utf8" },
    );
    return output
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function collectAffectedPackages() {
  const args = ["exec", "turbo", "run", "build", "--dry-run=json"];
  if (baseRef) {
    args.splice(3, 0, `--filter=...[${baseRef}]`);
  }
  try {
    const output = execFileSync("bash", ["scripts/with-ci-env.sh", "pnpm", ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return extractAffectedPackages(JSON.parse(output));
  } catch {
    return [];
  }
}

const result = detectDeployTargets({
  environment,
  affectedPackages: collectAffectedPackages(),
  changedPaths: collectChangedPaths(),
  packageVersions: readPackageVersions(),
  forceFullDeploy,
  deployedStateJson,
  releaseSha,
});

process.stdout.write(
  JSON.stringify({
    outputs: formatGithubOutputs(result.targets),
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
  echo "detect-deploy-targets: ${key}=${value}"
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
  process.stderr.write(`detect-deploy-targets: ${reason}\n`);
}
for (const entry of payload.log) {
  process.stderr.write(`detect-deploy-targets: ${entry}\n`);
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

if [[ -n "${SKIP_REASONS}" ]]; then
  while IFS= read -r reason; do
    [[ -z "${reason}" ]] && continue
    echo "detect-deploy-targets: ${reason}"
  done <<<"${SKIP_REASONS}"
fi
