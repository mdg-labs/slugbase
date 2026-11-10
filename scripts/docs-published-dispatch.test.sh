#!/usr/bin/env bash
# Tests scripts/docs-published-dispatch.sh with a stub for the GitHub CLI: the
# stub records its arguments, its standard input and the token it was given, and
# exits with the status the test asks for, so no request leaves this machine.
# Fixtures hold shell syntax that must stay literal.
# shellcheck disable=SC2016
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
failures=0
out=""
code=0

mkdir -p "$tmp/bin"
cat > "$tmp/bin/gh" <<'STUB'
#!/usr/bin/env bash
# A stand-in for `gh`: one line of arguments per call, the body, and the token.
printf '%s\n' "$*" >> "$STUB_DIR/args"
cat > "$STUB_DIR/body"
printf '%s' "${GH_TOKEN:-}" > "$STUB_DIR/token"
if [[ "${STUB_GH_EXIT:-0}" != 0 ]]; then
  # Like the real CLI, a refusal names the request URL, which holds the repository.
  printf 'gh: Not Found (HTTP 404) https://api.github.com/repos/%s\n' "${4:-}" >&2
fi
exit "${STUB_GH_EXIT:-0}"
STUB
chmod +x "$tmp/bin/gh"

sha="0123456789abcdef0123456789abcdef01234567"
token="stub-token-value"
repository="example-org/site-repo"

# Runs the script with a clean environment: only the variables named in the
# call and the stub's directory on PATH. A new stub directory per case.
n=0
run_case() {
  n=$((n + 1))
  STUB_DIR="$tmp/case-$n"
  mkdir -p "$STUB_DIR"
  : > "$STUB_DIR/summary"
  code=0
  out="$(env -i PATH="$tmp/bin:$PATH" STUB_DIR="$STUB_DIR" GITHUB_STEP_SUMMARY="$STUB_DIR/summary" "$@" \
    bash "$here/docs-published-dispatch.sh" 2>&1)" || code=$?
}

pass() {
  printf 'ok: %s\n' "$1"
}

fail() {
  printf 'FAIL: %s\n%s\n' "$1" "$out" >&2
  failures=$((failures + 1))
}

calls() {
  if [[ -f "$STUB_DIR/args" ]]; then wc -l < "$STUB_DIR/args" | tr -d ' '; else printf '0'; fi
}

expect_no_call_and_ok() {
  local name="$1" words="$2"
  if ((code == 0)) && [[ "$(calls)" == 0 ]] && grep -q -- "nothing sent" "$STUB_DIR/summary" && grep -q -- "$words" "$STUB_DIR/summary"; then
    pass "$name"
  else
    fail "$name (exit $code, calls $(calls), summary: $(cat "$STUB_DIR/summary"))"
  fi
}

# The site repository's name stays out of the output and the job summary.
expect_quiet_about_repository() {
  if [[ "$out" != *"$repository"* ]] && ! grep -q -- "$repository" "$STUB_DIR/summary"; then
    pass "$1"
  else
    fail "$1 (the repository name is in the output or the summary)"
  fi
}

expect_no_call_and_failed() {
  local name="$1"
  if ((code != 0)) && [[ "$(calls)" == 0 ]] && grep -q -- "failed" "$STUB_DIR/summary"; then
    pass "$name"
  else
    fail "$name (exit $code, calls $(calls), summary: $(cat "$STUB_DIR/summary"))"
  fi
}

expect_quiet_about_token() {
  if [[ "$out" != *"$token"* ]] && ! grep -q -- "$token" "$STUB_DIR/summary" && { [[ ! -f "$STUB_DIR/args" ]] || ! grep -q -- "$token" "$STUB_DIR/args"; }; then
    pass "$1"
  else
    fail "$1 (the token is in the output, the summary or the command line)"
  fi
}

good=(
  GITHUB_REPOSITORY=mdg-labs/slugbase
  GITHUB_SHA="$sha"
  DOCS_SITE_REPOSITORY="$repository"
  DOCS_SITE_WORKFLOW=deploy.yml
  DOCS_SITE_DISPATCH_TOKEN="$token"
)

# Every `good` entry except the one named by its variable.
without() {
  local entry
  for entry in "${good[@]}"; do
    [[ "${entry%%=*}" == "$1" ]] || printf '%s\n' "$entry"
  done
}

# A `good` environment with one entry replaced.
with() {
  local entry
  for entry in "${good[@]}"; do
    [[ "${entry%%=*}" == "$1" ]] || printf '%s\n' "$entry"
  done
  printf '%s=%s\n' "$1" "$2"
}

run_with() {
  local -a vars
  mapfile -t vars
  run_case "${vars[@]}"
}

run_case "${good[@]}"
if ((code == 0)) && [[ "$(calls)" == 1 ]] \
  && [[ "$(cat "$STUB_DIR/args")" == "api --method POST repos/example-org/site-repo/actions/workflows/deploy.yml/dispatches --input -" ]] \
  && [[ "$(cat "$STUB_DIR/body")" == "{\"ref\":\"main\",\"inputs\":{\"docs_sha\":\"$sha\"}}" ]] \
  && [[ "$(cat "$STUB_DIR/token")" == "$token" ]]; then
  pass "a complete configuration sends one dispatch with ref main and the commit as the only input"
else
  fail "a complete configuration sends one dispatch (exit $code, calls $(calls), args: $(cat "$STUB_DIR/args" 2>/dev/null), body: $(cat "$STUB_DIR/body" 2>/dev/null))"
fi
expect_quiet_about_token "the token is not printed and not on the command line"
expect_quiet_about_repository "a successful dispatch does not print the repository name"

run_with < <(without DOCS_SITE_REPOSITORY)
expect_no_call_and_ok "an unset repository secret sends nothing" "secret DOCS_SITE_REPOSITORY is not set"

run_with < <(with DOCS_SITE_REPOSITORY "")
expect_no_call_and_ok "an empty repository secret sends nothing" "secret DOCS_SITE_REPOSITORY is not set"

run_with < <(without DOCS_SITE_WORKFLOW)
expect_no_call_and_ok "an unset workflow variable sends nothing" "variable DOCS_SITE_WORKFLOW is not set"

run_with < <(without DOCS_SITE_DISPATCH_TOKEN)
expect_no_call_and_ok "an unset secret sends nothing" "DOCS_SITE_DISPATCH_TOKEN is not set"

run_with < <(with DOCS_SITE_DISPATCH_TOKEN "")
expect_no_call_and_ok "an empty secret sends nothing" "DOCS_SITE_DISPATCH_TOKEN is not set"

run_with < <(with GITHUB_REPOSITORY someone/slugbase)
expect_no_call_and_ok "a fork sends nothing" "not the upstream"

run_with < <(with GITHUB_REPOSITORY mdg-labs/slugbase-fork)
expect_no_call_and_ok "a repository that only starts with the upstream name sends nothing" "not the upstream"

run_with < <(without GITHUB_REPOSITORY)
expect_no_call_and_ok "a run with no repository sends nothing" "not the upstream"

for bad in "no-slash" "a/b/c" "owner/" "/name" "owner/na me" 'owner/name;rm' '-owner/name' 'owner/na$(id)me' '../name' 'owner/..%2f'; do
  run_with < <(with DOCS_SITE_REPOSITORY "$bad")
  expect_no_call_and_failed "a malformed repository secret (${bad}) fails"
done

for bad in "deploy" "deploy.txt" "dir/deploy.yml" "../deploy.yml" ".hidden.yml" "deploy.yml?x=1" "de ploy.yml" 'a$(id).yml'; do
  run_with < <(with DOCS_SITE_WORKFLOW "$bad")
  expect_no_call_and_failed "a malformed workflow variable (${bad}) fails"
done

run_with < <(with DOCS_SITE_WORKFLOW build-and-deploy.yaml)
if ((code == 0)) && grep -q -- "workflows/build-and-deploy.yaml/dispatches" "$STUB_DIR/args"; then
  pass "a .yaml workflow file name is accepted"
else
  fail "a .yaml workflow file name is accepted (exit $code)"
fi

for bad in "" "abc" "0123456789ABCDEF0123456789ABCDEF01234567" "${sha}0" "${sha:0:39}"; do
  run_with < <(with GITHUB_SHA "$bad")
  expect_no_call_and_failed "a commit that is not 40 lowercase hexadecimal characters (${bad:-empty}) fails"
done

n=$((n + 1))
STUB_DIR="$tmp/case-$n"
mkdir -p "$STUB_DIR"
: > "$STUB_DIR/summary"
code=0
out="$(env -i PATH="$tmp/bin:$PATH" STUB_DIR="$STUB_DIR" GITHUB_STEP_SUMMARY="$STUB_DIR/summary" STUB_GH_EXIT=1 "${good[@]}" \
  bash "$here/docs-published-dispatch.sh" 2>&1)" || code=$?
if ((code != 0)) && [[ "$(calls)" == 1 ]] && grep -q -- "failed" "$STUB_DIR/summary" && ! grep -q -- "asked " "$STUB_DIR/summary"; then
  pass "a failing API call fails the run and reports no success"
else
  fail "a failing API call fails the run (exit $code, calls $(calls), summary: $(cat "$STUB_DIR/summary"))"
fi
expect_quiet_about_token "a failing call does not print the token"
expect_quiet_about_repository "a failing call does not print the repository name, even when gh's error does"
if grep -q -- "HTTP 404" "$STUB_DIR/summary"; then
  pass "a failing call reports its HTTP status"
else
  fail "a failing call reports its HTTP status (summary: $(cat "$STUB_DIR/summary"))"
fi

# Nothing sent, with the repository set but the token unset: still no name.
run_with < <(without DOCS_SITE_DISPATCH_TOKEN)
expect_quiet_about_repository "a skipped run does not print the repository name"

# A malformed value is the one case that is not a name: it must not be echoed either.
run_with < <(with DOCS_SITE_REPOSITORY "no-slash-secret-value")
if [[ "$out" != *"no-slash-secret-value"* ]] && ! grep -q -- "no-slash-secret-value" "$STUB_DIR/summary"; then
  pass "a malformed repository secret is not echoed"
else
  fail "a malformed repository secret is not echoed"
fi

if ((failures > 0)); then
  printf '%s test(s) failed\n' "$failures" >&2
  exit 1
fi
