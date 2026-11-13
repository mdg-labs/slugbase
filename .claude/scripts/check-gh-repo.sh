#!/usr/bin/env bash
# Fails on a `gh` call that does not name its repository, anywhere under
# .claude/ or scripts/: a repository-scoped subcommand (`gh issue …`,
# `gh pr …`, `gh run …`, …) without `-R`/`--repo`, a `gh search` without
# `--repo`/`--owner` or a `repo:` qualifier, and a `gh api` call whose path
# uses gh's `{owner}`/`{repo}` placeholders. Each of those takes the
# repository from the working directory, which in orchestrate's scratch
# clones is a local path: wrong or missing.
#
# A script line, or a line in a Markdown code block, is checked whole; a `gh`
# command continued over several lines with a trailing `\` counts as one
# line. In Markdown prose only inline code spans are checked, one at a time,
# and a span that only names a command (`gh issue edit`, no arguments) is
# prose, not a call. A call whose repository is in a URL argument
# (https://github.com/<owner>/<repo>/…) passes too.
#
# Vendored to .claude/scripts/; the repo root is two levels up. Run it from
# the repo's lint target and CI.
set -euo pipefail

HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
root=$(cd -- "$HERE/../.." && pwd)
# Two allowlists in the same format: the one vendored with these scripts,
# covering the vendored skills and agents, and the repo's own, for its own
# files. Either may be absent.
allowlists=("$HERE/gh-repo-allowlist.txt" "$root/.claude/gh-repo-allowlist.local.txt")

# gh's repository-scoped command groups: each infers the repository unless
# told one.
scoped='(issue|pr|run|workflow|release|label|cache|secret|variable|ruleset|attestation) +[a-z]|repo +(view|edit|delete|archive|unarchive|rename|sync|deploy-key|autolink)\>'
re_scoped="(^|[^[:alnum:]_./-])gh +($scoped)"
# -R/--repo, a github.com URL, or `gh repo <cmd> <owner/repo | "$VAR" | <repo>>`.
re_repo_flag='(^|[[:space:]])(-R|--repo)([[:space:]=]|$)|https://github\.com/|gh +repo +[a-z-]+ +("?\$|<|[[:alnum:]_.-]+/)'
re_search='(^|[^[:alnum:]_./-])gh +search +[a-z]'
re_search_scoped='(^|[[:space:]])(--repo|-R|--owner)([[:space:]=]|$)|repo:|org:|user:'
re_api='(^|[^[:alnum:]_./-])gh +api\>'
re_placeholder='\{(owner|repo|branch)\}'

# Allowlist lines are "<repo-relative file>::<substring>": a flagged line in
# that file (the whole line, also for a code span in it) that also contains
# that exact substring is prose naming a command
# (to explain or forbid it), not a live call. Deliberately narrow: the same
# call anywhere else in that file still fails.
declare -a allow_file=() allow_substr=()
for allowlist in "${allowlists[@]}"; do
  [[ -f $allowlist ]] || continue
  while IFS= read -r entry; do
    [[ -z $entry || $entry == \#* ]] && continue
    [[ $entry == *"::"* ]] || continue
    allow_file+=("${entry%%::*}")
    allow_substr+=("${entry#*::}")
  done <"$allowlist"
done

is_allowed() {
  local file=$1 line=$2 i
  for i in "${!allow_file[@]}"; do
    if [[ $file == "${allow_file[$i]}" && $line == *"${allow_substr[$i]}"* ]]; then
      return 0
    fi
  done
  return 1
}

# Prints why $1 (one logical line) is a call without its repository, or
# nothing.
violation() {
  local line=$1 cmd
  # A permission rule such as `Bash(gh run view *)` names a command; it is
  # not a call.
  while [[ $line =~ Bash\([^\)]*\) ]]; do
    line=${line/"${BASH_REMATCH[0]}"/}
  done
  # BASH_REMATCH is read before the second match replaces it.
  if [[ $line =~ $re_scoped ]]; then
    cmd=${BASH_REMATCH[0]#"${BASH_REMATCH[1]}"}
    if [[ ! $line =~ $re_repo_flag ]]; then
      printf '%s… without -R/--repo' "$cmd"
      return
    fi
  fi
  if [[ $line =~ $re_search && ! $line =~ $re_search_scoped ]]; then
    printf 'gh search without --repo, --owner or a repo: qualifier'
  elif [[ $line =~ $re_api && $line =~ $re_placeholder ]]; then
    printf 'gh api with the %s placeholder' "${BASH_REMATCH[0]}"
  fi
}

# shellcheck disable=SC2016 # literal backticks: a Markdown code span
re_span='`([^`]+)`'
re_name_only='^gh +[a-z-]+( +[a-z-]+)?$'

# Checks one piece of text from line $3 of $2, whose whole text is $4 (what
# the allowlist matches); sets fail on a violation.
check() {
  local text=$1 rel=$2 at=$3 whole=$4 why
  why=$(violation "$text")
  if [[ -n $why ]] && ! is_allowed "$rel" "$whole"; then
    printf 'check-gh-repo: %s:%d: %s: %s\n' "$rel" "$at" "$why" "$text" >&2
    fail=1
  fi
}

fail=0
while IFS= read -r -d '' file; do
  rel=${file#"$root"/}
  md=0 fence=0
  [[ $file == *.md ]] && md=1
  line_no=0 start=0 logical=""
  while IFS= read -r line || [[ -n $line ]]; do
    line_no=$((line_no + 1))
    if (( md )) && [[ $line =~ ^[[:space:]]*(\`\`\`|~~~) ]]; then
      fence=$(( ! fence ))
      continue
    fi
    if (( md && ! fence )); then
      rest=$line
      while [[ $rest =~ $re_span ]]; do
        span=${BASH_REMATCH[1]}
        rest=${rest#*"${BASH_REMATCH[0]}"}
        [[ $span =~ $re_name_only ]] || check "$span" "$rel" "$line_no" "$line"
      done
      continue
    fi
    (( start )) || start=$line_no
    if [[ $line == *\\ ]]; then
      logical+="${line%\\} "
      continue
    fi
    logical+=$line
    check "$logical" "$rel" "$start" "$logical"
    logical="" start=0
  done <"$file"
done < <(
  dirs=()
  for d in "$root/.claude" "$root/scripts"; do [[ -d $d ]] && dirs+=("$d"); done
  ((${#dirs[@]})) || exit 0
  find "${dirs[@]}" -type f \
    \( -name '*.md' -o -name '*.sh' -o -name '*.yml' -o -name '*.yaml' \) \
    -not -path '*/testdata/*' \
    -not -name 'check-gh-repo.sh' \
    -not -name 'test-check-gh-repo.sh' \
    -print0
)

exit "$fail"
