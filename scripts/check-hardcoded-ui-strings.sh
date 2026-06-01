#!/usr/bin/env bash
# Rule 10-i18n / P6-07.2: fail CI when user-visible English is hard-coded in UI sources.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

scan_paths=(
  packages/web/app
  packages/marketing/src
  packages/ui/src/components
)

# Same heuristic as packages/web/app/i18n/hardcoded-strings.spec.ts
if rg -n --pcre2 \
  '(?:>|(?:placeholder|aria-label|title|alt)=)["\x27]([A-Z][^"\x27{]{1,})["\x27]' \
  "${scan_paths[@]}" \
  -g '*.tsx' \
  -g '*.astro' \
  -g '!*.spec.*' \
  -g '!messages.ts' \
  -g '!test-utils/**'; then
  echo "check-hardcoded-ui-strings: hard-coded user-visible strings found (use Tolgee catalog keys)" >&2
  exit 1
fi

echo "check-hardcoded-ui-strings: OK"
