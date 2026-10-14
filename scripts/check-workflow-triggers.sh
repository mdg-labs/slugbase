#!/usr/bin/env bash
# Fails when a workflow under .github/workflows/ uses the pull_request_target
# event outside the exception doc 10 records (section 2.11, T16). Such a run holds
# the base repository's write token for a pull request from a fork, so:
#   - only the workflows listed in `allowed` below may use it;
#   - a workflow that does must not check out code (no actions/checkout), must
#     have no `run:` step, must pin every `uses:` to a full commit SHA, and must
#     read no secret other than the workflow token.
# Full-line comments are skipped; any other mention of the event name, a trailing
# comment included, counts as a use. Any error inside the check (a missing
# folder, a grep failure) fails it as well.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

allowed=(.github/workflows/cla.yml)

dir=.github/workflows
if [[ ! -d "$dir" ]]; then
  printf 'workflow-triggers: %s/ not found under %s\n' "$dir" "$root" >&2
  exit 1
fi

shopt -s nullglob
files=("$dir"/*.yml "$dir"/*.yaml)
if ((${#files[@]} == 0)); then
  printf 'workflow-triggers: no workflow found in %s/\n' "$dir" >&2
  exit 1
fi

status=0

problem() {
  printf 'workflow-triggers: %s: %s\n' "$1" "$2" >&2
  status=1
}

# Prints the lines of a file that are not full-line comments. grep exits 1 when
# none remain, which is not an error here; any other failure is.
code_lines() {
  local rc=0
  grep -vE '^[[:space:]]*#' "$1" || rc=$?
  ((rc <= 1))
}

is_allowed() {
  local entry
  for entry in "${allowed[@]}"; do
    [[ "$entry" == "$1" ]] && return 0
  done
  return 1
}

# True when the text on stdin has a line matching the extended regex; a grep
# failure other than "no match" ends the script.
has_line() {
  local rc=0
  grep -qE "$1" || rc=$?
  case "$rc" in
    0) return 0 ;;
    1) return 1 ;;
    *) printf 'workflow-triggers: grep failed (exit %s)\n' "$rc" >&2; exit 2 ;;
  esac
}

for file in "${files[@]}"; do
  body="$(code_lines "$file")"

  if ! has_line '(^|[^[:alnum:]_])pull_request_target($|[^[:alnum:]_])' <<<"$body"; then
    continue
  fi

  if ! is_allowed "$file"; then
    problem "$file" "uses pull_request_target, which only the workflows allow-listed in scripts/check-workflow-triggers.sh may use (doc 10 section 2.11, T16)"
    continue
  fi

  if has_line '(^|[^[:alnum:]_-])actions/checkout' <<<"$body"; then
    problem "$file" "uses pull_request_target and checks out code (actions/checkout); a pull_request_target workflow checks out nothing (doc 10 T16)"
  fi
  if has_line '^[[:space:]]*(-[[:space:]]+)?run[[:space:]]*:' <<<"$body"; then
    problem "$file" "uses pull_request_target and has a run: step, which could fetch or execute pull request code (doc 10 T16)"
  fi
  while IFS= read -r line; do
    if ! has_line '@[0-9a-f]{40}([[:space:]]|["'\'']|$)' <<<"$line"; then
      problem "$file" "uses pull_request_target and its action is not pinned to a full commit SHA: ${line}"
    fi
  done < <(grep -E '^[[:space:]]*(-[[:space:]]+)?uses[[:space:]]*:' <<<"$body" || [[ $? -eq 1 ]])
  if has_line "secrets[[:space:]]*:[[:space:]]*inherit" <<<"$body"; then
    problem "$file" "uses pull_request_target and passes every secret on (secrets: inherit)"
  fi
  while IFS= read -r secret; do
    [[ -z "$secret" || "$secret" == "secrets.GITHUB_TOKEN" ]] && continue
    problem "$file" "uses pull_request_target and reads a secret other than the workflow token: $secret"
  done < <(grep -oE "secrets(\\.[A-Za-z0-9_-]+|\\[[^]]*\\])" <<<"$body" || [[ $? -eq 1 ]])
done

exit "$status"
