#!/usr/bin/env bash
# Fails when a workflow under .github/workflows/ uses a base-context event
# (pull_request_target, workflow_run, issue_comment) outside the exception doc 10
# records (section 2.11, T16). Such a run holds the base repository's write token
# or secrets while the event can be started by a pull request from a fork, so:
#   - only the workflows listed in `allowed` below may use one;
#   - a workflow that does must not check out code (no actions/checkout), must
#     have no `run:` step, must use only the repositories in `allowed_actions`,
#     each pinned to a full commit SHA, and must read no secret other than the
#     workflow token (the secrets context in any other form, whole or by name,
#     counts as a read).
# Full-line comments are skipped; any other mention of an event name, a trailing
# comment included, counts as a use. YAML escapes (\xNN, \uNNNN, \UNNNNNNNN and a
# backslash at the end of a line) are resolved before matching, so an escaped
# spelling of an event name, key or context is read as written out. A `run` or
# `uses` key counts in block and flow form, quoted or not, and each `uses` value
# is checked on its own, so one pinned action cannot vouch for another on the
# same line. Any error inside the check (a missing folder, a grep failure) fails
# it as well.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

allowed=(.github/workflows/cla.yml)
allowed_actions=(contributor-assistant/github-action)
events=(pull_request_target workflow_run issue_comment)

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

# A key at the start of a line, after a list dash, or inside a flow mapping
# (`- { uses: ... }`), optionally quoted.
key_start='(^|[[:space:]{,])["'\'']?'
key_end='["'\'']?[[:space:]]*:'

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

# Prints the text on stdin with the YAML escapes that could spell a name written
# out: a backslash at the end of a line joins the next line (its indent dropped),
# and \xNN, \uNNNN and \UNNNNNNNN become their character (a code point above
# 127 becomes "?", which no name here uses).
resolve_escapes() {
  perl -0pe '
    s/\\\n[ \t]*//g;
    s/\\(?:x([0-9a-fA-F]{2})|u([0-9a-fA-F]{4})|U([0-9a-fA-F]{8}))/my $c = hex($1 \/\/ $2 \/\/ $3); $c < 128 ? chr($c) : "?"/ge;
  '
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
  body="$(code_lines "$file" | resolve_escapes)"

  used=()
  for event in "${events[@]}"; do
    if has_line "(^|[^[:alnum:]_])${event}(\$|[^[:alnum:]_])" <<<"$body"; then
      used+=("$event")
    fi
  done
  if ((${#used[@]} == 0)); then
    continue
  fi
  names="${used[*]}"
  names="${names// /, }"

  if ! is_allowed "$file"; then
    problem "$file" "uses ${names}, which only the workflows allow-listed in scripts/check-workflow-triggers.sh may use (doc 10 section 2.11, T16)"
    continue
  fi

  if has_line '(^|[^[:alnum:]_-])actions/checkout' <<<"$body"; then
    problem "$file" "uses ${names} and checks out code (actions/checkout); such a workflow checks out nothing (doc 10 T16)"
  fi
  if has_line "${key_start}run${key_end}" <<<"$body"; then
    problem "$file" "uses ${names} and has a run: step, which could fetch or execute pull request code (doc 10 T16)"
  fi
  # Each `uses` value up to a space, comma, brace or quote; a value on the next
  # line, a block scalar or an alias reads as empty or unpinned and fails.
  action_pattern="^($(IFS='|'; printf '%s' "${allowed_actions[*]}"))@[0-9a-f]{40}\$"
  while IFS= read -r ref; do
    ref="$(sed -E "s/^.*uses${key_end}[[:space:]]*[\"']?//" <<<"$ref")"
    if [[ ! "$ref" =~ $action_pattern ]]; then
      problem "$file" "uses ${names} and its action is not an allow-listed repository pinned to a full commit SHA: uses: ${ref}"
    fi
  done < <(grep -oE "${key_start}uses${key_end}[[:space:]]*[\"']?[^[:space:],}\"']*" <<<"$body" || [[ $? -eq 1 ]])
  if has_line "secrets[[:space:]]*:[[:space:]]*inherit" <<<"$body"; then
    problem "$file" "uses ${names} and passes every secret on (secrets: inherit)"
  fi
  # The context name is case-insensitive. What is left after removing the
  # workflow token is any other use of it: a named secret, the whole context
  # (toJSON(secrets), a bare secrets) or a spelling this check cannot read.
  rest="$(perl -pe 's/secrets\.GITHUB_TOKEN(?![A-Za-z0-9_-])//gi' <<<"$body")"
  if has_line '(^|[^[:alnum:]_-])[Ss][Ee][Cc][Rr][Ee][Tt][Ss]($|[^[:alnum:]_-])' <<<"$rest"; then
    problem "$file" "uses ${names} and reads the secrets context other than as the workflow token (secrets.GITHUB_TOKEN)"
  fi
done

exit "$status"
