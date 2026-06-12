#!/usr/bin/env bash
# Inject ReportPortal env vars from Infisical for local test runs.
# Skips when CI=true or when all three keys are already set.
#
# Usage:
#   bash scripts/with-ci-env.sh bash scripts/with-reportportal-env.sh pnpm test:integration

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=ci-env.sh
source "${SCRIPT_DIR}/ci-env.sh"

REPORTPORTAL_KEYS=(REPORTPORTAL_URL REPORTPORTAL_API_KEY REPORTPORTAL_PROJECT)

all_reportportal_keys_set() {
  local key
  for key in "${REPORTPORTAL_KEYS[@]}"; do
    if [[ -z "${!key:-}" ]]; then
      return 1
    fi
  done
  return 0
}

if [[ $# -lt 1 ]]; then
  printf 'usage: %s <command> [args...]\n' "$(basename "$0")" >&2
  exit 1
fi

if [[ "${CI:-}" == "true" ]] || all_reportportal_keys_set; then
  exec "$@"
fi

if ! command -v infisical >/dev/null 2>&1; then
  printf 'with-reportportal-env: infisical not found — running without ReportPortal vars\n' >&2
  exec "$@"
fi

INFISICAL_ENV="${INFISICAL_ENV:-dev}"
PROJECT_ID="$(
  node -e "
    const fs = require('fs');
    const config = JSON.parse(fs.readFileSync('${REPO_ROOT}/.infisical.json', 'utf8'));
    process.stdout.write(config.workspaceId);
  "
)"

fetch_secret() {
  local key="$1"
  infisical secrets get "${key}" \
    --env="${INFISICAL_ENV}" \
    --projectId="${PROJECT_ID}" \
    --plain
}

export REPORTPORTAL_URL="$(fetch_secret REPORTPORTAL_URL)"
export REPORTPORTAL_API_KEY="$(fetch_secret REPORTPORTAL_API_KEY)"
export REPORTPORTAL_PROJECT="$(fetch_secret REPORTPORTAL_PROJECT)"

exec "$@"
