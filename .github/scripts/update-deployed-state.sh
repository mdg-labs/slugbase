#!/usr/bin/env bash
# Merge successful deploy surfaces into DEPLOYED_STATE_<environment> (granular-deployment WP-2).
#
# Required env:
#   ENVIRONMENT          staging | production
#   GIT_SHA              deployed commit SHA
#   DEPLOY_API_FLAG      true | false (detect output)
#   DEPLOY_WEB_FLAG
#   DEPLOY_MARKETING_FLAG
#   DEPLOY_ADMIN_FLAG
#   DEPLOY_API_RESULT    success | skipped | failure | …
#   DEPLOY_WEB_RESULT
#   DEPLOY_MARKETING_RESULT
#   DEPLOY_ADMIN_RESULT
#
# Optional:
#   DEPLOYED_STATE_JSON  current repo variable value (workflow passes vars.*)
#   GH_TOKEN             for gh variable set (CI)
#   DRY_RUN              true — print merged JSON only

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

ENVIRONMENT="${ENVIRONMENT:-}"
GIT_SHA="${GIT_SHA:-}"

usage() {
  echo "Usage: ENVIRONMENT=staging|production GIT_SHA=<sha> DEPLOY_*_FLAG/RESULT=... $0" >&2
}

if [[ -z "$ENVIRONMENT" || -z "$GIT_SHA" ]]; then
  usage
  exit 1
fi

if [[ "$ENVIRONMENT" != "staging" && "$ENVIRONMENT" != "production" ]]; then
  echo "update-deployed-state: ENVIRONMENT must be staging or production, got: ${ENVIRONMENT}" >&2
  exit 1
fi

export UPDATE_ENVIRONMENT="$ENVIRONMENT"
export UPDATE_GIT_SHA="$GIT_SHA"
export UPDATE_DEPLOYED_STATE_JSON="${DEPLOYED_STATE_JSON:-}"
export UPDATE_DEPLOY_API_FLAG="${DEPLOY_API_FLAG:-false}"
export UPDATE_DEPLOY_WEB_FLAG="${DEPLOY_WEB_FLAG:-false}"
export UPDATE_DEPLOY_MARKETING_FLAG="${DEPLOY_MARKETING_FLAG:-false}"
export UPDATE_DEPLOY_ADMIN_FLAG="${DEPLOY_ADMIN_FLAG:-false}"
export UPDATE_DEPLOY_API_RESULT="${DEPLOY_API_RESULT:-skipped}"
export UPDATE_DEPLOY_WEB_RESULT="${DEPLOY_WEB_RESULT:-skipped}"
export UPDATE_DEPLOY_MARKETING_RESULT="${DEPLOY_MARKETING_RESULT:-skipped}"
export UPDATE_DEPLOY_ADMIN_RESULT="${DEPLOY_ADMIN_RESULT:-skipped}"

MERGED_JSON="$(
  node <<'NODE'
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  buildSurfaceUpdates,
  deployedStateVariableName,
  mergeDeployedState,
  surfacesToUpdate,
} from "./scripts/update-deployed-state.mjs";

const environment = process.env.UPDATE_ENVIRONMENT;
const sha = process.env.UPDATE_GIT_SHA;
const currentJson = process.env.UPDATE_DEPLOYED_STATE_JSON ?? "";

/** @type {Record<string, string>} */
const deployFlags = {
  api: process.env.UPDATE_DEPLOY_API_FLAG ?? "false",
  web: process.env.UPDATE_DEPLOY_WEB_FLAG ?? "false",
  marketing: process.env.UPDATE_DEPLOY_MARKETING_FLAG ?? "false",
  admin: process.env.UPDATE_DEPLOY_ADMIN_FLAG ?? "false",
};

/** @type {Record<string, string>} */
const deployResults = {
  api: process.env.UPDATE_DEPLOY_API_RESULT ?? "skipped",
  web: process.env.UPDATE_DEPLOY_WEB_RESULT ?? "skipped",
  marketing: process.env.UPDATE_DEPLOY_MARKETING_RESULT ?? "skipped",
  admin: process.env.UPDATE_DEPLOY_ADMIN_RESULT ?? "skipped",
};

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

const surfaces = surfacesToUpdate({ deployFlags, deployResults });
if (surfaces.length === 0) {
  process.stderr.write("update-deployed-state: no successful surfaces to record\n");
  process.exit(0);
}

const updates = buildSurfaceUpdates({
  sha,
  surfaces,
  packageVersions: readPackageVersions(),
});

const merged = mergeDeployedState(currentJson, updates);
const variableName = deployedStateVariableName(environment);

process.stdout.write(
  JSON.stringify({
    variableName,
    merged,
    surfaces,
  }),
);
NODE
)"

if [[ -z "$MERGED_JSON" ]]; then
  exit 0
fi

VARIABLE_NAME="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).variableName)' "$MERGED_JSON")"
BODY="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).merged)' "$MERGED_JSON")"
SURFACES="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).surfaces.join(", "))' "$MERGED_JSON")"

echo "update-deployed-state: recording surfaces: ${SURFACES}"

if [[ "$(echo "${DRY_RUN:-false}" | tr '[:upper:]' '[:lower:]')" == "true" ]]; then
  echo "$BODY"
  exit 0
fi

if [[ -z "${GH_TOKEN:-}" ]]; then
  echo "update-deployed-state: GH_TOKEN is required to write ${VARIABLE_NAME}" >&2
  exit 1
fi

# gh reads value from stdin when --body is omitted (no --body-file flag in gh CLI)
printf '%s' "$BODY" | gh variable set "$VARIABLE_NAME"
