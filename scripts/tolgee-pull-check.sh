#!/usr/bin/env bash
# Wrapper for spec §22.6 `tolgee pull --check` (implemented in tolgee-pull-check.mjs).
set -euo pipefail
exec node "$(dirname "$0")/tolgee-pull-check.mjs" "$@"
