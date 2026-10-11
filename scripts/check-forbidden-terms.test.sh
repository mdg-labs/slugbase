#!/usr/bin/env bash
# Tests scripts/check-forbidden-terms.sh in throwaway git repositories under the
# OS temp dir. Every forbidden term is assembled at run time, so this file never
# contains one and the repository still passes its own check.
set -euo pipefail

unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
failures=0
out=""
code=0

new_repo() {
  local dir="$tmp/$1"
  mkdir -p "$dir/scripts"
  git -C "$dir" init -q
  cp "$here/check-forbidden-terms.sh" "$dir/scripts/"
  cp "$here/forbidden-terms.txt" "$dir/scripts/"
  printf '%s' "$dir"
}

seed() {
  local dir="$1" file="$2"
  shift 2
  printf '%s\n' "$@" > "$dir/$file"
  git -C "$dir" add "$file"
}

check() {
  code=0
  out="$(cd "$1" && GIT_CEILING_DIRECTORIES="$tmp" bash scripts/check-forbidden-terms.sh 2>&1)" || code=$?
}

fail() {
  printf 'FAIL: %s\n%s\n' "$1" "$out" >&2
  failures=$((failures + 1))
}

pass() {
  printf 'ok: %s\n' "$1"
}

expect_pass() {
  if ((code == 0)) && [[ -z "$out" ]]; then pass "$1"; else fail "$1 (exit $code, expected 0 and no output)"; fi
}

expect_hit() {
  local name="$1" location="$2"
  if ((code != 0)) && grep -q -- "^$location:" <<<"$out"; then
    pass "$name"
  else
    fail "$name (exit $code, expected non-zero with a $location: line)"
  fi
}

expect_error() {
  if ((code != 0)); then pass "$1"; else fail "$1 (exit 0, expected non-zero)"; fi
}

term="cool""ify"

repo="$(new_repo clean)"
seed "$repo" notes.md "nothing to see" "plain text"
check "$repo"
expect_pass "a clean repository passes"

repo="$(new_repo hit)"
seed "$repo" notes.md "first line" "uses $term here" "last line"
check "$repo"
expect_hit "a hit fails and prints file:line" "notes.md:2"

repo="$(new_repo missing-list)"
rm "$repo/scripts/forbidden-terms.txt"
seed "$repo" notes.md "uses $term here"
check "$repo"
expect_error "a missing list fails"

repo="$(new_repo empty-list)"
printf '# only a comment\n\n' > "$repo/scripts/forbidden-terms.txt"
seed "$repo" notes.md "nothing to see"
check "$repo"
expect_error "a list without patterns fails"

repo="$(new_repo bad-pattern)"
printf '(unclosed\n' > "$repo/scripts/forbidden-terms.txt"
seed "$repo" notes.md "nothing to see"
check "$repo"
expect_error "a pattern git cannot compile fails"

repo="$(new_repo no-trailing-newline)"
printf 'harmless-first\nzz-last-pattern' > "$repo/scripts/forbidden-terms.txt"
seed "$repo" notes.md "nothing to see" "zz-last-pattern is here"
check "$repo"
expect_hit "a last pattern without a trailing newline is enforced" "notes.md:2"

mkdir -p "$tmp/no-git/scripts"
cp "$here/check-forbidden-terms.sh" "$here/forbidden-terms.txt" "$tmp/no-git/scripts/"
check "$tmp/no-git"
expect_error "a directory outside a git repository fails"

if ((failures > 0)); then
  printf '%d check(s) failed\n' "$failures" >&2
  exit 1
fi
