#!/usr/bin/env bash
# Install flyctl on GitHub-hosted runners when missing (spec §22.5).
set -euo pipefail

if command -v flyctl >/dev/null 2>&1; then
  flyctl version
  exit 0
fi

curl -fsSL https://fly.io/install.sh | sh
echo "${HOME}/.fly/bin" >> "${GITHUB_PATH}"
