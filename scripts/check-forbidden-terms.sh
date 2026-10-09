#!/usr/bin/env bash
# Fails when a tracked file contains a pattern from scripts/forbidden-terms.txt
# (doc 09 §4). Prints file:line for every hit.
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
cd "$root"
list="scripts/forbidden-terms.txt"
# Vendored from mdg-labs/skills and hash-locked in .claude/mdg-workflow.lock.json;
# its runs-on example names a runner label. Fix it upstream, not here.
vendored=".claude/workflow.schema.json"
status=0

while IFS= read -r pattern; do
  [[ -z "$pattern" || "$pattern" == \#* ]] && continue
  flags=(-n -I -E -i)
  if [[ "$pattern" == "(?c)"* ]]; then
    pattern="${pattern#"(?c)"}"
    flags=(-n -I -E)
  fi
  if hits="$(git grep "${flags[@]}" -e "$pattern" -- . ":(exclude)$list" ":(exclude)$vendored")"; then
    printf 'forbidden term /%s/:\n%s\n' "$pattern" "$hits"
    status=1
  fi
done < "$list"

exit "$status"
