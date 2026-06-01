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

glob_flags=(
  -g '*.tsx'
  -g '*.astro'
  -g '!*.spec.*'
  -g '!messages.ts'
  -g '!message-keys.generated.ts'
  -g '!**/i18n/locales/**'
)

# Same heuristics as packages/web/app/i18n/hardcoded-strings.spec.ts
if rg -n --pcre2 \
  '(?:>|(?:placeholder|aria-label|title|alt)=)["\x27]([A-Z][^"\x27{]{1,})["\x27]' \
  "${scan_paths[@]}" \
  "${glob_flags[@]}"; then
  echo "check-hardcoded-ui-strings: hard-coded user-visible strings found (use Tolgee catalog keys)" >&2
  exit 1
fi

if rg -n --pcre2 \
  '\>\s*\n\s*([A-Z][^\n<{]{2,})' \
  packages/marketing/src \
  -g '*.astro' \
  -g '!*.spec.*' \
  -g '!messages.ts'; then
  echo "check-hardcoded-ui-strings: hard-coded element text found in marketing Astro (use Tolgee catalog keys)" >&2
  exit 1
fi

echo "check-hardcoded-ui-strings: OK"
