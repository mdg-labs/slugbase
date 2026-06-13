#!/usr/bin/env bash
# Fail CI when browser code reads VITE_API_URL for cross-origin fetch (regression guard).
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

resolve_rg() {
  if command -v rg >/dev/null 2>&1; then
    command -v rg
    return
  fi

  local bundled_rg=""
  if bundled_rg="$(
    node --input-type=module -e "import { rgPath } from '@vscode/ripgrep'; console.log(rgPath)" 2>/dev/null
  )" && [[ -n "${bundled_rg}" && -x "${bundled_rg}" ]]; then
    echo "${bundled_rg}"
    return
  fi

  echo "check-client-api-origin: ripgrep (rg) is required — run pnpm install or install rg system-wide" >&2
  exit 1
}

RG="$(resolve_rg)"

matches="$("$RG" -n \
  'import\.meta\.env\.VITE_API_URL|import\.meta as \{ env: \{ VITE_API_URL' \
  packages/web/app \
  -g '!**/*.spec.*' \
  -g '!**/server-api-base-url.ts' \
  -g '!**/vite-env.d.ts' \
  -g '!**/env.d.ts' \
  2>/dev/null || true)"

if [[ -n "${matches}" ]]; then
  echo "check-client-api-origin: VITE_API_URL must not be read in browser code." >&2
  echo "Use client-api-path / client-api-fetch for browser fetch; getServerApiBaseUrl for SSR." >&2
  echo "${matches}" >&2
  exit 1
fi

echo "check-client-api-origin: OK"
