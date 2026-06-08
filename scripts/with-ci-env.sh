#!/usr/bin/env bash
# Run any command with SlugBase Node/pnpm/Infisical PATH setup.
# Usage: bash scripts/with-ci-env.sh pnpm typecheck

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=ci-env.sh
source "${SCRIPT_DIR}/ci-env.sh"

if [[ $# -lt 1 ]]; then
  printf 'usage: %s <command> [args...]\n' "$(basename "$0")" >&2
  exit 1
fi

exec "$@"
