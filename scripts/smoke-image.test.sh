#!/usr/bin/env bash
# Tests the assertion and helper functions of scripts/smoke-image.sh, which the
# script runs against a real stack: that each assertion fails when its
# expectation is false, that a failure names no value it was told to keep out,
# and that redact removes every secret. The script is sourced, so none of its
# checks run and no Docker is needed.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/smoke-image.sh
source "$here/smoke-image.sh"

tmp="$(mktemp -d)"
listener=""
cleanup_tests() {
  if [[ -n "$listener" ]]; then
    kill "$listener" 2>/dev/null || true
  fi
  rm -rf "$tmp"
}
trap cleanup_tests EXIT
failures=0
out=""
code=0

# Runs the command in a subshell, since a failed assertion exits.
run() {
  code=0
  out="$("$@" 2>&1)" || code=$?
}

pass() {
  printf 'ok: %s\n' "$1"
}

fail_test() {
  printf 'FAIL: %s\n%s\n' "$1" "$out" >&2
  failures=$((failures + 1))
}

expect_ok() {
  if ((code == 0)); then pass "$1"; else fail_test "$1 (exit $code, expected 0)"; fi
}

expect_failed() {
  if ((code != 0)); then pass "$1"; else fail_test "$1 (exit 0, expected non-zero)"; fi
}

expect_quiet_about() {
  if [[ "$out" != *"$2"* ]]; then pass "$1"; else fail_test "$1 (the output holds the value)"; fi
}

work="$tmp"

run expect_equal "a value" "a" "a"
expect_ok "expect_equal accepts equal values"
run expect_equal "a value" "a" "b"
expect_failed "expect_equal fails on different values"

run expect_contains "a text" "one two" "two"
expect_ok "expect_contains accepts a present needle"
run expect_contains "a text" "one two" "three"
expect_failed "expect_contains fails on an absent needle"

run expect_lacks "a text" "one two" "three"
expect_ok "expect_lacks accepts an absent needle"
run expect_lacks "a text" "one top-secret-value two" "top-secret-value"
expect_failed "expect_lacks fails on a present needle"
expect_quiet_about "expect_lacks does not print the value it found" "top-secret-value"

printf '{"database":"ok","migrations":{"expected":3,"applied":3}}' >"$work/body"
filter="$READY_FILTER"
run expect_json "ready" "$filter"
expect_ok "expect_json accepts a body that satisfies the filter"
printf '{"database":"ok","migrations":{"expected":3,"applied":2}}' >"$work/body"
run expect_json "ready" "$filter"
expect_failed "expect_json fails on fewer applied than expected migrations"
printf '{"database":"ok","migrations":{"expected":0,"applied":0}}' >"$work/body"
run expect_json "ready" "$filter"
expect_failed "expect_json fails on a database with no migrations expected"
printf 'not json' >"$work/body"
run expect_json "ready" "$filter"
expect_failed "expect_json fails on a body that is not JSON"

version_filter="$VERSION_FILTER"
printf '{"name":"SlugBase","version":"1.0.0","commit":"abc","builtAt":"2026-01-01T00:00:00Z"}' >"$work/body"
run expect_json "version" "$version_filter"
expect_ok "the /version filter accepts exactly the four members"
printf '{"name":"SlugBase","version":"1.0.0","commit":"abc","builtAt":"2026-01-01T00:00:00Z","extra":"x"}' >"$work/body"
run expect_json "version" "$version_filter"
expect_failed "the /version filter fails on a fifth member"
printf '{"name":"SlugBase","version":"1.0.0","commit":"","builtAt":"2026-01-01T00:00:00Z"}' >"$work/body"
run expect_json "version" "$version_filter"
expect_failed "the /version filter fails on an empty member"

printf 'HTTP/1.1 200 OK\r\nCache-Control: public, max-age=60\r\nContent-Type: text/html\r\n\r\n' >"$work/headers"
if [[ "$(header_value cache-control)" == "public, max-age=60" ]]; then pass "header_value reads a header without case or the line ending"; else fail_test "header_value (got '$(header_value cache-control)')"; fi
if [[ -z "$(header_value content-security-policy)" ]]; then pass "header_value is empty for an absent header"; else fail_test "header_value for an absent header"; fi

secrets=("first-generated-value" "second/generated+value=")
redacted="$(printf 'url=postgres://u:first-generated-value@h key=second/generated+value= tail' | redact)"
if [[ "$redacted" == "url=postgres://u:[redacted]@h key=[redacted] tail" ]]; then pass "redact replaces every generated value"; else fail_test "redact (got '$redacted')"; fi

picked="$(pick_port)"
if [[ "$picked" =~ ^[0-9]+$ ]] && ((picked >= 20000 && picked < 40000)); then pass "pick_port returns a port in 20000-39999"; else fail_test "pick_port (got '$picked')"; fi

node -e 'const s = require("node:net").createServer().listen(0, "127.0.0.1", () => { console.log(s.address().port); }); setTimeout(() => process.exit(0), 20000);' >"$tmp/port" &
listener=$!
for _ in $(seq 1 50); do
  [[ -s "$tmp/port" ]] && break
  sleep 0.1
done
if port_in_use "$(cat "$tmp/port")"; then pass "port_in_use sees a listening port"; else fail_test "port_in_use missed a listening port"; fi
kill "$listener" 2>/dev/null || true
wait "$listener" 2>/dev/null || true
listener=""
if ! port_in_use "$picked"; then pass "port_in_use is false for a port nobody listens on"; else fail_test "port_in_use for a free port"; fi

if ((failures > 0)); then
  printf '%d test(s) failed\n' "$failures" >&2
  exit 1
fi
