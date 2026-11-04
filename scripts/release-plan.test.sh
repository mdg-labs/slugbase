#!/usr/bin/env bash
# Tests scripts/release-plan.sh against throwaway git repositories and a stub for
# docker, so nothing leaves this machine. The stub records every call and answers
# the registry existence check as the test asks. It also checks the shape of
# .github/workflows/release.yml that doc 10 T16 depends on.
# Fixtures hold shell syntax that must stay literal.
# shellcheck disable=SC2016
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
failures=0
out=""
code=0

mkdir -p "$tmp/bin"
cat > "$tmp/bin/docker" <<'STUB'
#!/usr/bin/env bash
# A stand-in for `docker`: one line of arguments per call; `login` also records
# what it read from standard input. `buildx imagetools inspect` answers as
# STUB_INSPECT_EXIT and STUB_INSPECT_OUT say; the default is "not found".
printf '%s\n' "$*" >> "$STUB_DIR/calls"
if [[ "${1:-}" == "login" ]]; then
  cat > "$STUB_DIR/login-stdin"
  exit "${STUB_LOGIN_EXIT:-0}"
fi
if [[ "${1:-}" == "buildx" && "${2:-}" == "imagetools" && "${3:-}" == "inspect" ]]; then
  printf '%s\n' "${STUB_INSPECT_OUT-ERROR: ghcr.io/mdg-labs/slugbase: not found}"
  exit "${STUB_INSPECT_EXIT:-1}"
fi
exit 99
STUB
chmod +x "$tmp/bin/docker"

image="ghcr.io/mdg-labs/slugbase"
zero="0000000000000000000000000000000000000000"

g() {
  git -C "$repo" -c user.name=test -c user.email=test@example.invalid -c commit.gpgsign=false -c tag.gpgsign=false "$@"
}

# A repository with two commits whose apps/slugbase/package.json carry the two
# versions; an empty old version means the file is absent at the first commit.
# Sets repo, before and after.
n=0
make_repo() {
  n=$((n + 1))
  repo="$tmp/repo-$n"
  mkdir -p "$repo/apps/slugbase"
  git init --quiet "$repo"
  if [[ -n "$1" ]]; then
    printf '{\n  "name": "slugbase",\n  "version": "%s"\n}\n' "$1" > "$repo/apps/slugbase/package.json"
  else
    printf 'x\n' > "$repo/README"
  fi
  g add -A
  g commit --quiet -m first
  before="$(g rev-parse HEAD)"
  printf '{\n  "name": "slugbase",\n  "version": "%s"\n}\n' "$2" > "$repo/apps/slugbase/package.json"
  g add -A
  g commit --quiet --allow-empty -m second
  after="$(g rev-parse HEAD)"
}

# Runs the script in $repo with a clean environment and the stub on PATH. The
# arguments are the script's, after VAR=value pairs given through `extra`.
extra=()
run_plan() {
  STUB_DIR="$tmp/stub-$n-$RANDOM"
  mkdir -p "$STUB_DIR"
  : > "$STUB_DIR/calls"
  : > "$STUB_DIR/github-output"
  code=0
  out="$(cd "$repo" && env -i PATH="$tmp/bin:$PATH" HOME="$tmp" STUB_DIR="$STUB_DIR" GITHUB_OUTPUT="$STUB_DIR/github-output" \
    "${extra[@]}" bash "$here/release-plan.sh" "$@" 2>&1)" || code=$?
}

pass() {
  printf 'ok: %s\n' "$1"
}

fail() {
  printf 'FAIL: %s\n%s\n' "$1" "$out" >&2
  failures=$((failures + 1))
}

docker_calls() {
  wc -l < "$STUB_DIR/calls" | tr -d ' '
}

# The planned outputs, as seen on standard output and in the step output file.
output() {
  grep -c -- "^$1\$" <<<"$out" || true
}

expect_plan() {
  local name="$1" prerelease="$2" tags="$3" version="$4"
  if ((code == 0)) \
    && [[ "$(output release=true)" == 1 ]] \
    && [[ "$(output "version=$version")" == 1 ]] \
    && [[ "$(output "prerelease=$prerelease")" == 1 ]] \
    && [[ "$(output "git_tag=v$version")" == 1 ]] \
    && [[ "$(output "tags=$tags")" == 1 ]] \
    && [[ "$(grep -c '^tags=' <<<"$out")" == 1 ]] \
    && [[ "$(cat "$STUB_DIR/github-output")" == "$(grep -E '^(release|version|prerelease|git_tag|tags)=' <<<"$out")" ]] \
    && grep -q -- "buildx imagetools inspect ${image}:${version}\$" "$STUB_DIR/calls" \
    && ! grep -q -- 'latest' <<<"$out"; then
    pass "$name"
  else
    fail "$name (exit $code, docker calls: $(tr '\n' ';' < "$STUB_DIR/calls"))"
  fi
}

expect_refused() {
  local name="$1" words="$2"
  if ((code != 0)) && [[ "$(output release=true)" == 0 ]] && [[ ! -s "$STUB_DIR/github-output" ]] \
    && grep -q -- "release-plan: refused" <<<"$out" && grep -q -- "$words" <<<"$out"; then
    pass "$name"
  else
    fail "$name (exit $code)"
  fi
}

expect_nothing() {
  local name="$1"
  if ((code == 0)) && [[ "$(output release=false)" == 1 ]] && [[ "$(output release=true)" == 0 ]] \
    && [[ "$(docker_calls)" == 0 ]] && [[ "$(cat "$STUB_DIR/github-output")" == "release=false" ]]; then
    pass "$name"
  else
    fail "$name (exit $code, docker calls $(docker_calls))"
  fi
}

make_repo 0.0.0 1.0.0-rc.1
run_plan "$before" "$after"
expect_plan "0.0.0 to 1.0.0-rc.1 plans :1.0.0-rc.1 alone, as a pre-release" true "${image}:1.0.0-rc.1" 1.0.0-rc.1

make_repo 1.0.0-rc.1 1.0.0
run_plan "$before" "$after"
expect_plan "1.0.0-rc.1 to 1.0.0 plans :1.0.0 and :1.0, not a pre-release" false "${image}:1.0.0,${image}:1.0" 1.0.0

make_repo 1.4.2 2.10.0-beta.3
run_plan "$before" "$after"
expect_plan "a major bump with a suffix plans only its version" true "${image}:2.10.0-beta.3" 2.10.0-beta.3

make_repo 1.0.0 1.0.1
run_plan "$before" "$after"
expect_plan "a patch release plans :1.0.1 and :1.0" false "${image}:1.0.1,${image}:1.0" 1.0.1

make_repo 1.0.0-rc.1 1.0.0-rc.1
run_plan "$before" "$after"
expect_nothing "an unchanged version plans no release and asks no registry"

make_repo 1.0.0-rc.1 1.0.0-rc.1
printf '{"name":"slugbase","version":"1.0.0-rc.1","description":"changed"}\n' > "$repo/apps/slugbase/package.json"
g add -A
g commit --quiet -m third
run_plan "$before" "$(g rev-parse HEAD)"
expect_nothing "a manifest change that leaves the version alone plans no release"

make_repo "not-semver" "also not semver"
run_plan "$before" "$after"
expect_refused "an invalid new version is refused even where the old one is invalid too" "not valid semver"

for bad in "" "1" "1.0" "v1.0.0" "1.0.0.0" "01.0.0" "1.00.0" "1.0.0-" "1.0.0-01" "1.0.0-rc..1" "1.0.0-rc_1" "1.0.0+build.5" "1.0.0-rc.1+build" "latest" "1.0.0 " " 1.0.0" "1.0.0-rc.1/../x" "1.0.0-$(printf 'a%.0s' {1..130})"; do
  make_repo 0.0.0 "$bad"
  run_plan "$before" "$after"
  expect_refused "the version '${bad:0:40}' is refused before the registry is asked" "not valid semver"
  if [[ "$(docker_calls)" != 0 ]]; then fail "the version '${bad:0:40}' reached docker"; fi
done

make_repo 0.0.0 1.0.0-rc.1
extra=(STUB_INSPECT_EXIT=0 STUB_INSPECT_OUT="Name: ${image}:1.0.0-rc.1")
run_plan "$before" "$after"
expect_refused "an image tag that already exists is refused" "already exists in the registry"

for answer in "ERROR: unauthorized: authentication required" "ERROR: dial tcp: lookup ghcr.io: no such host" "denied" ""; do
  extra=(STUB_INSPECT_EXIT=1 STUB_INSPECT_OUT="$answer")
  run_plan "$before" "$after"
  expect_refused "an existence check answered '${answer:-nothing}' is not read as a free tag" "could not tell"
done

# A docker that cannot run says "not found" about itself, not about the tag.
for case in "127|bash: line 1: docker: command not found" "126|bash: line 1: docker: Permission denied" "1|ERROR: exec: \"docker-buildx\": executable file not found in \$PATH"; do
  extra=(STUB_INSPECT_EXIT="${case%%|*}" STUB_INSPECT_OUT="${case#*|}")
  run_plan "$before" "$after"
  expect_refused "an existence check that could not run ('${case#*|}') is not read as a free tag" "could not tell"
done

for answer in "ERROR: ghcr.io/mdg-labs/slugbase:1.0.0-rc.1: not found" "manifest unknown" "NAME_UNKNOWN: name unknown"; do
  extra=(STUB_INSPECT_EXIT=1 STUB_INSPECT_OUT="$answer")
  run_plan "$before" "$after"
  expect_plan "a registry answer '${answer}' means the tag is free" true "${image}:1.0.0-rc.1" 1.0.0-rc.1
done
extra=()

make_repo 0.0.0 1.0.0-rc.1
g tag v1.0.0-rc.1
run_plan "$before" "$after"
expect_refused "a version whose git tag exists is refused" "git tag v1.0.0-rc.1 already exists"

make_repo 0.0.0 1.0.0-rc.1
g tag v0.1.0
run_plan "$before" "$after"
expect_plan "an unrelated git tag does not stop the release" true "${image}:1.0.0-rc.1" 1.0.0-rc.1

make_repo 0.0.0 1.0.0-rc.1
run_plan "$zero" "$after"
expect_refused "a push with no previous commit is refused" "no previous commit"

run_plan "1111111111111111111111111111111111111111" "$after"
expect_refused "a previous commit the checkout does not hold is refused" "cannot read the version"

run_plan "main" "$after"
expect_refused "a previous commit that is not a full hash is refused" "previous commit"

run_plan "$before"
expect_refused "a missing commit argument is refused" "usage"

make_repo "" 1.0.0-rc.1
run_plan "$before" "$after"
expect_refused "a previous commit without the manifest is refused" "cannot read the version"

make_repo 0.0.0 1.0.0-rc.1
printf '{"name":"slugbase"}\n' > "$repo/apps/slugbase/package.json"
g add -A
g commit --quiet -m noversion
run_plan "$after" "$(g rev-parse HEAD)"
expect_refused "a manifest without a version is refused" "cannot read the version"

make_repo 0.0.0 1.0.0-rc.1
token="stub-token-value"
extra=(RELEASE_IMAGE="${image}" REGISTRY_USER=octocat REGISTRY_TOKEN="$token")
run_plan "$before" "$after"
if ((code == 0)) && head -1 "$STUB_DIR/calls" | grep -qx -- "login ghcr.io --username octocat --password-stdin" \
  && [[ "$(cat "$STUB_DIR/login-stdin")" == "$token" ]] \
  && ! grep -q -- "$token" "$STUB_DIR/calls" && ! grep -q -- "$token" <<<"$out"; then
  pass "the registry login reads the token from standard input, before the check, and never prints it"
else
  fail "the registry login (exit $code, calls: $(tr '\n' ';' < "$STUB_DIR/calls"))"
fi

extra=(REGISTRY_USER=octocat REGISTRY_TOKEN="$token" STUB_LOGIN_EXIT=1)
run_plan "$before" "$after"
expect_refused "a failed registry login is refused, not read as an anonymous check" "login failed"
if [[ "$(grep -c '^buildx' "$STUB_DIR/calls")" != 0 ]] || grep -q -- "$token" <<<"$out"; then fail "a failed login went on to the check or printed the token"; fi

extra=(REGISTRY_TOKEN="$token")
run_plan "$before" "$after"
expect_refused "a token without a user is refused" "REGISTRY_USER"
extra=()

# The workflow: the shape doc 10 T16 depends on.
wf="$root/.github/workflows/release.yml"
code_lines="$(grep -vE '^[[:space:]]*#' "$wf")"
out="$wf"
if [[ -f "$wf" ]]; then
  triggers="$(awk '/^on:/ { inside = 1; next } /^[^[:space:]]/ { inside = 0 } inside' <<<"$code_lines" | sed -E 's/^[[:space:]]+//')"
  if [[ "$triggers" == $'push:\nbranches: [main]' ]]; then
    pass "release.yml runs on a push to main and on nothing else"
  else
    fail "release.yml triggers: $(tr '\n' ';' <<<"$triggers")"
  fi
  secret_refs="$(grep -oE 'secrets\.[A-Za-z0-9_]+|secrets\[[^]]*\]|secrets: *inherit' <<<"$code_lines" | sort -u || true)"
  if [[ -z "$secret_refs" ]]; then
    pass "release.yml reads no secret; the token is github.token"
  else
    fail "release.yml reads: $secret_refs"
  fi
  unpinned="$(grep -E '^[[:space:]-]*uses:' <<<"$code_lines" | grep -vE '@[0-9a-f]{40}( |$)' || true)"
  if [[ -z "$unpinned" ]]; then
    pass "every action in release.yml is pinned to a full commit SHA"
  else
    fail "unpinned action: $unpinned"
  fi
  scopes="$(grep -E '^[[:space:]]+[a-z-]+: (read|write|none)$' <<<"$code_lines" | sed -E 's/^[[:space:]]+//' | sort -u)"
  if ! grep -vxE 'contents: (read|write)|packages: (read|write)' <<<"$scopes" > /dev/null \
    && grep -qx 'contents: write' <<<"$scopes" && grep -qx 'packages: write' <<<"$scopes"; then
    pass "release.yml asks for contents and packages permissions only"
  else
    fail "release.yml permissions: $(tr '\n' ';' <<<"$scopes")"
  fi
  if grep -qE ':latest|tags: *latest|,latest' <<<"$code_lines"; then
    fail "release.yml names :latest"
  else
    pass "release.yml never names :latest"
  fi
  if grep -qE 'cosign|id-token' <<<"$code_lines"; then
    fail "release.yml signs, which is Phase 6"
  else
    pass "release.yml has no signing step and no OIDC token"
  fi
else
  fail "release.yml does not exist"
fi

if ((failures > 0)); then
  printf '%s test(s) failed\n' "$failures" >&2
  exit 1
fi
