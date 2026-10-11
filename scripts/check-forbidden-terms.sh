#!/usr/bin/env bash
# Fails when a tracked file contains a pattern from scripts/forbidden-terms.txt
# (doc 09 §4). Prints file:line for every hit. Any error inside the check
# (missing or empty list, git failure, invalid pattern) fails it as well.
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
cd "$root"
list="scripts/forbidden-terms.txt"
# Vendored from mdg-labs/skills and hash-locked in .claude/mdg-workflow.lock.json;
# its runs-on example names a runner label. Fix it upstream, not here.
vendored=".claude/workflow.schema.json"
status=0
count=0

if [[ ! -f "$list" ]]; then
  printf 'forbidden-terms: %s not found\n' "$list" >&2
  exit 1
fi

# `|| [[ -n ... ]]` keeps a last line that has no trailing newline.
while IFS= read -r pattern || [[ -n "$pattern" ]]; do
  [[ -z "$pattern" || "$pattern" == \#* ]] && continue
  count=$((count + 1))
  flags=(-n -I -E -i)
  if [[ "$pattern" == "(?c)"* ]]; then
    pattern="${pattern#"(?c)"}"
    flags=(-n -I -E)
  fi
  rc=0
  hits="$(git grep "${flags[@]}" -e "$pattern" -- . ":(exclude)$list" ":(exclude)$vendored")" || rc=$?
  case "$rc" in
    0)
      printf 'forbidden term /%s/:\n%s\n' "$pattern" "$hits"
      status=1
      ;;
    1) ;;
    *)
      printf 'forbidden-terms: git grep failed (exit %s) for /%s/\n' "$rc" "$pattern" >&2
      status=1
      ;;
  esac
done < "$list"

if ((count == 0)); then
  printf 'forbidden-terms: %s holds no patterns\n' "$list" >&2
  exit 1
fi

exit "$status"
