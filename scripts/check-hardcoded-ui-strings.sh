#!/usr/bin/env bash
# Rule 10-i18n / P6-07.2: fail CI when user-visible English is hard-coded in UI sources.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

resolve_rg() {
  if command -v rg >/dev/null 2>&1; then
    command -v rg
    return
  fi

  local bundled_rg="${repo_root}/node_modules/@vscode/ripgrep/bin/rg"
  if [[ -x "${bundled_rg}" ]]; then
    echo "${bundled_rg}"
    return
  fi

  echo "check-hardcoded-ui-strings: ripgrep (rg) is required — run pnpm install or install rg system-wide" >&2
  exit 1
}

RG="$(resolve_rg)"

scan_paths=(
  packages/web/app
  packages/marketing/src
  packages/ui/src/components
)

glob_flags=(
  -g '*.tsx'
  -g '*.astro'
  -g '!*.spec.*'
  -g '!messages.ts'
  -g '!message-keys.generated.ts'
  -g '!**/i18n/locales/**'
)

# rg exit 0 = matches found, 1 = no matches, 2+ = error. `if rg` treats 127 (missing) as false — never use bare `if rg`.
run_rg_check() {
  local label=$1
  shift

  set +e
  local output
  output="$("${RG}" -n --pcre2 "$@" 2>&1)"
  local status=$?
  set -e

  case "${status}" in
    0)
      echo "${output}"
      echo "check-hardcoded-ui-strings: ${label}" >&2
      exit 1
      ;;
    1)
      ;;
    *)
      echo "${output}" >&2
      echo "check-hardcoded-ui-strings: rg failed with exit ${status}" >&2
      exit "${status}"
      ;;
  esac
}

# Same heuristics as packages/web/app/i18n/hardcoded-strings.spec.ts
run_rg_check "hard-coded user-visible strings found (use Tolgee catalog keys)" \
  '(?:>|(?:placeholder|aria-label|title|alt)=)["\x27]([A-Z][^"\x27{]{1,})["\x27]' \
  "${scan_paths[@]}" \
  "${glob_flags[@]}"

run_rg_check "hard-coded element text found in marketing Astro (use Tolgee catalog keys)" \
  '\>\s*\n\s*([A-Z][^\n<{]{2,})' \
  packages/marketing/src \
  -g '*.astro' \
  -g '!*.spec.*' \
  -g '!messages.ts'

echo "check-hardcoded-ui-strings: OK"
