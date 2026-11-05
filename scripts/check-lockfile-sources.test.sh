#!/usr/bin/env bash
# Tests scripts/check-lockfile-sources.sh against fixture lockfiles in throwaway
# directories under the OS temp dir, and against the repository's own pnpm-lock.yaml.
# The fixture lines hold braces and quotes that must stay literal.
# shellcheck disable=SC2016
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
failures=0
out=""
code=0

integrity='sha512-4sPLzdBl4UFI0lLV1b9yDyHv6v0A2CtdcQSzrFZ+XJsVYXQmJHg3qvs+6qnZAA7GzLwZWY5fnr3GDnYdI04AuQ=='

# A lockfile of `lines`, in a tree holding a copy of the script, checked from there.
lockfile_of() {
  local dir="$tmp/$1"
  shift
  mkdir -p "$dir/scripts"
  cp "$here/check-lockfile-sources.sh" "$dir/scripts/"
  printf '%s\n' "$@" > "$dir/pnpm-lock.yaml"
  printf '%s' "$dir"
}

check() {
  code=0
  out="$(cd "$1" && bash scripts/check-lockfile-sources.sh 2>&1)" || code=$?
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
  local name="$1" text="$2"
  if ((code != 0)) && grep -qF -- "$text" <<<"$out"; then
    pass "$name"
  else
    fail "$name (exit $code, expected non-zero naming $text)"
  fi
}

expect_error() {
  if ((code != 0)); then pass "$1"; else fail "$1 (exit 0, expected non-zero)"; fi
}

head_lines=("lockfileVersion: '9.0'" '' 'packages:' '' "  left-pad@1.3.0:" "    resolution: {integrity: $integrity}")

tree="$(lockfile_of clean "${head_lines[@]}" '' "  '@scope/pkg@2.0.0':" "    resolution: {integrity: $integrity}" "    engines: {node: '>=18'}")"
check "$tree"
expect_pass "integrity-only registry resolutions pass"

tree="$(lockfile_of workspace-link "${head_lines[@]}" '' 'importers:' '  apps/a:' '    dependencies:' "      '@slugbase/core':" '        specifier: workspace:*' '        version: link:../../packages/core')"
check "$tree"
expect_pass "a workspace link in the importers passes"

tree="$(lockfile_of tarball "${head_lines[@]}" '' "  evil@1.0.0:" "    resolution: {tarball: https://example.test/evil-1.0.0.tgz, integrity: $integrity}")"
check "$tree"
expect_hit "a resolution with a tarball URL fails" "https://example.test/evil-1.0.0.tgz"

tree="$(lockfile_of tarball-last "${head_lines[@]}" '' "  evil@1.0.0:" "    resolution: {integrity: $integrity, tarball: https://example.test/evil-1.0.0.tgz}")"
check "$tree"
expect_hit "a tarball URL after the integrity fails" "line 9"

tree="$(lockfile_of tarball-only "${head_lines[@]}" '' "  evil@https://example.test/evil.tgz:" "    resolution: {tarball: https://example.test/evil.tgz}")"
check "$tree"
expect_hit "a tarball resolution with no integrity fails" "evil.tgz"

tree="$(lockfile_of git "${head_lines[@]}" '' "  evil@github.com/x/evil:" "    resolution: {type: git, repo: https://github.com/x/evil.git, commit: ca4a40a7d1004f18d9960b404b97e5f30a505a08}")"
check "$tree"
expect_hit "a git resolution fails" "type: git"

tree="$(lockfile_of directory "${head_lines[@]}" '' "  local@file:../local:" "    resolution: {directory: ../local, type: directory}")"
check "$tree"
expect_hit "a directory resolution fails" "directory: ../local"

tree="$(lockfile_of block-form "${head_lines[@]}" '' "  evil@1.0.0:" '    resolution:' '      tarball: https://example.test/evil-1.0.0.tgz' "      integrity: $integrity")"
check "$tree"
expect_hit "a resolution written as a block mapping fails" "line 9"

tree="$(lockfile_of quoted-key "${head_lines[@]}" '' "  evil@1.0.0:" "    \"resolution\": {integrity: $integrity, tarball: https://example.test/evil.tgz}")"
check "$tree"
expect_hit "a quoted resolution key with a tarball fails" "line 9"

tree="$(lockfile_of escaped-key "${head_lines[@]}" '' "  evil@1.0.0:" "    \"resolut\\x69on\": {tarball: https://example.test/evil.tgz, integrity: $integrity}")"
check "$tree"
expect_hit "a resolution key spelled with an escape fails" "line 9"

tree="$(lockfile_of explicit-key "${head_lines[@]}" '' "  evil@1.0.0:" '    ? resolution' "    : {tarball: https://example.test/evil.tgz, integrity: $integrity}")"
check "$tree"
expect_hit "a resolution key written as a YAML explicit key fails" "line 9"

tree="$(lockfile_of alias-key "${head_lines[@]}" 'names: &k resolution' '' "  evil@1.0.0:" "    *k : {tarball: https://example.test/evil.tgz, integrity: $integrity}")"
check "$tree"
expect_hit "a resolution key named through an alias fails" "line 7"

tree="$(lockfile_of flow-entry "${head_lines[@]}" '' "  evil@1.0.0: {resolution: {integrity: $integrity, tarball: https://example.test/evil.tgz}}")"
check "$tree"
expect_hit "a resolution inside a flow mapping fails" "line 8"

tree="$(lockfile_of trailing-key "${head_lines[@]}" '' "  evil@1.0.0:" "    resolution: {integrity: $integrity}, tarball: https://example.test/evil.tgz")"
check "$tree"
expect_hit "a value that continues past the closing brace fails" "line 9"

tree="$(lockfile_of bad-integrity "${head_lines[@]}" '' "  evil@1.0.0:" '    resolution: {integrity: not-a-hash}')"
check "$tree"
expect_hit "an integrity that is not a hash fails" "line 9"

tree="$(lockfile_of no-resolution 'lockfileVersion: '"'9.0'" '' 'packages: {}')"
check "$tree"
expect_error "a lockfile with no resolution fails"

tree="$(lockfile_of missing "${head_lines[@]}")"
rm "$tree/pnpm-lock.yaml"
check "$tree"
expect_error "a missing lockfile fails"

# The repository's own lockfile, through the same script.
code=0
out="$(bash "$here/check-lockfile-sources.sh" 2>&1)" || code=$?
expect_pass "the repository's pnpm-lock.yaml passes"

if ((failures > 0)); then
  printf '%d check(s) failed\n' "$failures" >&2
  exit 1
fi
