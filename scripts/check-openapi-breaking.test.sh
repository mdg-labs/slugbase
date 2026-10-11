#!/usr/bin/env bash
# Tests scripts/check-openapi-breaking.sh in throwaway git repositories under the
# OS temp dir. The cases that compare documents run the real oasdiff, so the
# binary must be installed (the CI contracts job installs a pinned release) or
# named by OASDIFF; this test fails when it cannot be found instead of skipping.
set -euo pipefail

unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
# A repository of its own, whatever the developer's or runner's git config says.
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.invalid
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.invalid
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
export GIT_CEILING_DIRECTORIES="$tmp"
failures=0
out=""
code=0
spec="packages/contracts/generated/openapi.json"

if ! command -v "${OASDIFF:-oasdiff}" > /dev/null; then
  printf 'check-openapi-breaking.test: %s not found; install oasdiff or set OASDIFF\n' "${OASDIFF:-oasdiff}" >&2
  exit 1
fi
real_oasdiff="$(command -v "${OASDIFF:-oasdiff}")"
export OASDIFF="$real_oasdiff"

# A minimal document: a versioned collection and an unversioned config path.
# $1 are the properties of the /api/v1/things response, $2 those of /api/config,
# $3 an optional extra path item (with its leading comma).
write_spec() {
  local file="$1" things="$2" config="$3" extra="${4:-}"
  mkdir -p "$(dirname "$file")"
  cat > "$file" << JSON
{
  "openapi": "3.1.0",
  "info": { "title": "fixture", "version": "1" },
  "paths": {
    "/api/config": { "get": { "operationId": "getConfig", "responses": { "200": { "description": "ok",
      "content": { "application/json": { "schema": { "type": "object", "properties": { $config }, "required": ["mode"] } } } } } } },
    "/api/v1/things": { "get": { "operationId": "listThings", "responses": { "200": { "description": "ok",
      "content": { "application/json": { "schema": { "type": "object", "properties": { $things }, "required": ["id"] } } } } } } }
    $extra
  }
}
JSON
}

base_things='"id": {"type": "string"}, "name": {"type": "string"}'
base_config='"mode": {"type": "string"}, "theme": {"type": "string"}'
# make_extra PROPS: /api/v1/widgets with a request body of the given properties.
make_extra() {
  printf ', "/api/v1/widgets": { "post": { "operationId": "createWidget", "requestBody": { "content": { "application/json": { "schema": { "type": "object", "properties": { %s } } } } }, "responses": { "200": { "description": "ok" } } } }' "$1"
}
# make_gadgets REQUEST_KIND RESPONSE_CODE: /api/v1/gadgets whose request body has
# a string property "kind" and whose response has a string property "code", each
# given as the extra schema keywords (an enum, with or without the marker).
make_gadgets() {
  printf ', "/api/v1/gadgets": { "post": { "operationId": "createGadget", "requestBody": { "content": { "application/json": { "schema": { "type": "object", "properties": { "kind": { "type": "string", %s } } } } } }, "responses": { "200": { "description": "ok", "content": { "application/json": { "schema": { "type": "object", "properties": { "code": { "type": "string", %s } } } } } } } } }' "$1" "$2"
}
base_widget='"a": {"type": "string"}, "b": {"type": "string"}'
extra_path="$(make_extra "$base_widget")"

git_in() {
  local dir="$1"
  shift
  git -C "$dir" -c commit.gpgsign=false -c tag.gpgsign=false "$@"
}

# new_repo NAME [EXTRA]: a repository on main with the script and a committed
# base document (plus the optional extra path item); no tag yet.
new_repo() {
  local dir="$tmp/$1"
  mkdir -p "$dir/scripts"
  git init -q -b main "$dir"
  cp "$here/check-openapi-breaking.sh" "$dir/scripts/"
  write_spec "$dir/$spec" "$base_things" "$base_config" "$extra_path${2-}"
  git_in "$dir" add scripts "$spec"
  git_in "$dir" commit -q -m base
  printf '%s' "$dir"
}

# edit REPO THINGS CONFIG [EXTRA]: rewrites the document in the working tree.
edit() {
  write_spec "$1/$spec" "$2" "$3" "${4-$extra_path}"
}

commit_all() {
  git_in "$1" add "$spec"
  git_in "$1" commit -q -m "$2"
}

check() {
  code=0
  out="$(cd "$1" && bash scripts/check-openapi-breaking.sh 2>&1)" || code=$?
}

fail() {
  printf 'FAIL: %s\n%s\n' "$1" "$out" >&2
  failures=$((failures + 1))
}

pass() {
  printf 'ok: %s\n' "$1"
}

expect_pass() {
  if ((code == 0)); then pass "$1"; else fail "$1 (exit $code, expected 0)"; fi
}

expect_fail() {
  if ((code != 0)); then pass "$1"; else fail "$1 (exit 0, expected non-zero)"; fi
}

expect_out() {
  if grep -q -F -- "$2" <<< "$out"; then pass "$1"; else fail "$1 (output lacks: $2)"; fi
}

# No tag: nothing to compare against, and a change the check would flag is not
# looked at.
repo="$(new_repo no-tag)"
edit "$repo" '"id": {"type": "string"}' "$base_config"
check "$repo"
expect_pass "no tag exits 0"
expect_out "no tag says there is nothing to compare against" "nothing to compare against"

# Tagged, unchanged.
repo="$(new_repo unchanged)"
git_in "$repo" tag v1.0.0
check "$repo"
expect_pass "an unchanged document passes"

# Adding an optional response field is additive.
repo="$(new_repo add-optional)"
git_in "$repo" tag v1.0.0
edit "$repo" "$base_things, \"extra\": {\"type\": \"string\"}" "$base_config"
check "$repo"
expect_pass "adding an optional response field exits 0"

# Removing a response field is breaking, whether the field is optional...
repo="$(new_repo remove-optional)"
git_in "$repo" tag v1.0.0
edit "$repo" '"id": {"type": "string"}' "$base_config"
check "$repo"
expect_fail "removing an optional response field exits non-zero"
expect_out "the removed field is named" "name"

# ...or required.
repo="$(new_repo remove-required)"
git_in "$repo" tag v1.0.0
edit "$repo" '"name": {"type": "string"}' "$base_config"
check "$repo"
expect_fail "removing a required response field exits non-zero"

# Removing a whole operation is breaking.
repo="$(new_repo remove-operation)"
git_in "$repo" tag v1.0.0
edit "$repo" "$base_things" "$base_config" ""
check "$repo"
expect_fail "removing a /api/v1 operation exits non-zero"
expect_out "the removed operation is named" "widgets"

# Unversioned paths are not compared (--match-path).
repo="$(new_repo unversioned)"
git_in "$repo" tag v1.0.0
edit "$repo" "$base_things" '"mode": {"type": "string"}'
check "$repo"
expect_pass "removing a field under an unversioned path exits 0"

# oasdiff rates a removed request property a warning; the check fails on warnings.
repo="$(new_repo remove-request-property)"
git_in "$repo" tag v1.0.0
edit "$repo" "$base_things" "$base_config" "$(make_extra '"a": {"type": "string"}')"
check "$repo"
expect_fail "removing a request property (an oasdiff warning) exits non-zero"

# A value added to a response enum marked x-extensible-enum is additive
# (doc 04 §2.2); the same addition to an unmarked enum is breaking.
ext='"enum": ["a", "b"], "x-extensible-enum": true'
ext_more='"enum": ["a", "b", "c"], "x-extensible-enum": true'
plain='"enum": ["a", "b"]'
plain_more='"enum": ["a", "b", "c"]'

repo="$(new_repo extensible-response-added "$(make_gadgets "$ext" "$ext")")"
git_in "$repo" tag v1.0.0
edit "$repo" "$base_things" "$base_config" "$extra_path$(make_gadgets "$ext" "$ext_more")"
check "$repo"
expect_pass "adding a value to a response enum marked x-extensible-enum exits 0"

repo="$(new_repo plain-response-added "$(make_gadgets "$plain" "$plain")")"
git_in "$repo" tag v1.0.0
edit "$repo" "$base_things" "$base_config" "$extra_path$(make_gadgets "$plain" "$plain_more")"
check "$repo"
expect_fail "adding a value to an unmarked response enum exits non-zero"
expect_out "the unmarked enum change is reported as breaking" "breaking change"

# The marker does not excuse narrowing what a request accepts.
repo="$(new_repo extensible-request-removed "$(make_gadgets "$ext" "$ext")")"
git_in "$repo" tag v1.0.0
edit "$repo" "$base_things" "$base_config" "$extra_path$(make_gadgets '"enum": ["a"], "x-extensible-enum": true' "$ext")"
check "$repo"
expect_fail "removing a value from a request enum marked x-extensible-enum exits non-zero"
expect_out "the removed request enum value is named" "x-extensible-enum value"

# The latest tag is the baseline: v2 already dropped the field.
repo="$(new_repo latest-tag)"
git_in "$repo" tag v1.0.0
edit "$repo" '"id": {"type": "string"}' "$base_config"
commit_all "$repo" "drop name"
git_in "$repo" tag v1.1.0
check "$repo"
expect_pass "the nearest tag is the baseline, not an older one"

# A tag that never reached main is not a baseline.
repo="$(new_repo side-tag)"
git_in "$repo" checkout -q -b side
edit "$repo" "$base_things, \"extra\": {\"type\": \"string\"}" "$base_config"
commit_all "$repo" "side"
git_in "$repo" tag v9.0.0
git_in "$repo" checkout -q main
edit "$repo" '"id": {"type": "string"}' "$base_config"
check "$repo"
expect_pass "a tag outside main is ignored"
expect_out "a tag outside main leaves nothing to compare" "nothing to compare against"

# Only origin/main visible, as on a CI checkout of a feature branch.
repo="$(new_repo origin-main)"
git_in "$repo" tag v1.0.0
git clone -q "$repo" "$tmp/origin-main-clone"
clone="$tmp/origin-main-clone"
git_in "$clone" checkout -q -b feature
git_in "$clone" branch -q -D main
edit "$clone" '"id": {"type": "string"}' "$base_config"
check "$clone"
expect_fail "origin/main is the baseline when there is no local main"
expect_out "origin/main is reported as a breaking change" "breaking change"

# Failure paths: none may read as a pass.
repo="$(new_repo no-main)"
git_in "$repo" tag v1.0.0
git_in "$repo" branch -q -m main trunk
check "$repo"
expect_fail "a repository without main fails"
expect_out "a missing main is named" "cannot see main"

repo="$(new_repo shallow)"
git_in "$repo" tag v1.0.0
git clone -q --depth 1 "file://$repo" "$tmp/shallow-clone"
check "$tmp/shallow-clone"
expect_fail "a shallow clone fails"
expect_out "a shallow clone is named" "shallow clone"

repo="$(new_repo tag-without-spec)"
git_in "$repo" rm -q --cached "$spec"
git_in "$repo" commit -q -m "no document"
git_in "$repo" tag v1.0.0
write_spec "$repo/$spec" "$base_things" "$base_config" "$extra_path"
check "$repo"
expect_fail "a tag whose tree has no document fails"
expect_out "the missing document at the tag is named" "does not exist at tag v1.0.0"

repo="$(new_repo tree-without-spec)"
git_in "$repo" tag v1.0.0
rm "$repo/$spec"
check "$repo"
expect_fail "a working tree without the document fails"

repo="$(new_repo no-oasdiff)"
git_in "$repo" tag v1.0.0
code=0
out="$(cd "$repo" && OASDIFF="$tmp/missing-oasdiff" bash scripts/check-openapi-breaking.sh 2>&1)" || code=$?
expect_fail "a missing oasdiff fails"
repo="$(new_repo no-oasdiff-no-tag)"
code=0
out="$(cd "$repo" && OASDIFF="$tmp/missing-oasdiff" bash scripts/check-openapi-breaking.sh 2>&1)" || code=$?
expect_fail "a missing oasdiff fails even with no tag"

repo="$(new_repo oasdiff-crash)"
git_in "$repo" tag v1.0.0
printf '#!/usr/bin/env bash\nexit 2\n' > "$tmp/crashing-oasdiff"
chmod +x "$tmp/crashing-oasdiff"
code=0
out="$(cd "$repo" && OASDIFF="$tmp/crashing-oasdiff" bash scripts/check-openapi-breaking.sh 2>&1)" || code=$?
expect_fail "a crashing oasdiff fails"
expect_out "a crashing oasdiff is reported as a failure" "oasdiff failed"

repo="$(new_repo invalid-document)"
git_in "$repo" tag v1.0.0
printf '{\n' > "$repo/$spec"
check "$repo"
expect_fail "an unparseable document fails"
expect_out "an unparseable document is reported" "cannot normalise"

if ((failures > 0)); then
  printf '%d check(s) failed\n' "$failures" >&2
  exit 1
fi
