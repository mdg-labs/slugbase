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

# The probe that the runtime image holds no npm, npx or corepack, run here against a
# directory standing in for the root of the image and with no command on PATH.
probe_root="$tmp/image-root"
mkdir -p "$probe_root/usr/local/bin" "$probe_root/usr/local/lib/node_modules"
run_probe() {
  env ROOT="$probe_root" PATH=/nonexistent /bin/sh -c "$NPM_PROBE"
}
run run_probe
if ((code == 0)) && [[ -z "$out" ]]; then pass "the npm probe is silent on a root without npm"; else fail_test "the npm probe on a clean root (exit $code)"; fi
ln -s ../lib/node_modules/npm/bin/npm-cli.js "$probe_root/usr/local/bin/npm"
run run_probe
if [[ "$out" == "/usr/local/bin/npm" ]]; then pass "the npm probe finds a dangling npm link"; else fail_test "the npm probe on a dangling link"; fi
rm "$probe_root/usr/local/bin/npm"
for leftover in usr/local/bin/npx usr/local/bin/corepack usr/local/lib/node_modules/npm usr/local/lib/node_modules/corepack; do
  if [[ "$leftover" == */node_modules/* ]]; then mkdir -p "$probe_root/$leftover"; else : >"$probe_root/$leftover"; fi
  run run_probe
  if [[ "$out" == "/$leftover" ]]; then pass "the npm probe finds /$leftover"; else fail_test "the npm probe on /$leftover"; fi
  rm -rf "${probe_root:?}/$leftover"
done
mkdir -p "$tmp/path-bin"
printf '#!/bin/sh\n' >"$tmp/path-bin/npx"
chmod +x "$tmp/path-bin/npx"
run env ROOT="$probe_root" PATH="$tmp/path-bin" /bin/sh -c "$NPM_PROBE"
if [[ "$out" == "npx on PATH" ]]; then pass "the npm probe finds a command on PATH"; else fail_test "the npm probe on a PATH command"; fi

# check_no_npm judges what the probe printed inside the image.
image="slugbase:test"
fake_probe_output=""
# The check starts docker through timeout, an external command that cannot see a function.
# shellcheck disable=SC2317
timeout() { shift; "$@"; }
# shellcheck disable=SC2317
docker() { printf '%s' "$fake_probe_output"; }
run check_no_npm
expect_ok "check_no_npm accepts an image whose probe prints nothing"
fake_probe_output="/usr/local/bin/npm"
run check_no_npm
expect_failed "check_no_npm fails on an image that holds npm"
unset -f docker timeout

# The environment file of a production server whose configuration is valid, with a key changed, added or left out.
smoke_session_secret="session-secret-generated-for-this-run-0123456789"
smoke_encryption_key="encryption-key-generated-for-this-run"
smoke_superuser_password="superuser-password-generated-for-this-run"
env_path="$tmp/production.env"
write_production_env "$env_path"
if grep -qx 'NODE_ENV=production' "$env_path" && grep -qx "SESSION_SECRET=$smoke_session_secret" "$env_path" &&
  grep -qx "ENCRYPTION_KEY=$smoke_encryption_key" "$env_path" && grep -qx 'APP_ORIGIN=https://smoke.example.test' "$env_path"; then
  pass "write_production_env writes a production configuration with this run's secrets"
else
  out="$(cat "$env_path")"
  fail_test "write_production_env (the file is above)"
fi
write_production_env "$env_path" "SESSION_SECRET=short" "-ENCRYPTION_KEY" "EXTRA_KEY=1"
if grep -qx 'SESSION_SECRET=short' "$env_path" && ! grep -q '^ENCRYPTION_KEY=' "$env_path" && grep -qx 'EXTRA_KEY=1' "$env_path" &&
  [[ "$(grep -c '^SESSION_SECRET=' "$env_path")" == "1" ]] && grep -qx 'ENCRYPTION_KEY_ID=smoke-1' "$env_path"; then
  pass "write_production_env replaces, removes and adds a key, and keeps a key that merely starts with a removed one"
else
  out="$(cat "$env_path")"
  fail_test "write_production_env with overrides (the file is above)"
fi

# A run of the image that must have been refused: the exit status, the message and what the message must name and must not hold.
run expect_refused "a weak SESSION_SECRET" 1 "SESSION_SECRET must be at least 32 characters" "SESSION_SECRET" "weak-value"
expect_ok "expect_refused accepts a non-zero status and a message that names the key and holds no value"
run expect_refused "a weak SESSION_SECRET" 0 "SESSION_SECRET must be at least 32 characters" "SESSION_SECRET" "weak-value"
expect_failed "expect_refused fails when the container exits 0 (the refusal is bypassed)"
run expect_refused "a weak SESSION_SECRET" 124 "SESSION_SECRET must be at least 32 characters" "SESSION_SECRET" "weak-value"
expect_failed "expect_refused fails when the run timed out"
for unrun in 125 126 127; do
  run expect_refused "a weak SESSION_SECRET" "$unrun" "SESSION_SECRET must be at least 32 characters" "SESSION_SECRET" "weak-value"
  expect_failed "expect_refused fails on status $unrun, which is the container not running"
done
run expect_refused "a weak SESSION_SECRET" 1 "something else went wrong" "SESSION_SECRET" "weak-value"
expect_failed "expect_refused fails when the message does not name the key"
run expect_refused "a weak SESSION_SECRET" 1 "SESSION_SECRET weak-value" "SESSION_SECRET" "weak-value"
expect_failed "expect_refused fails when the message holds the value"
expect_quiet_about "expect_refused does not print the value it found" "weak-value"
run expect_refused "a weak SESSION_SECRET" 1 "SESSION_SECRET is short" "SESSION_SECRET" "first-value" "second-value"
expect_ok "expect_refused accepts a message that holds none of several values"
run expect_refused "a weak SESSION_SECRET" 1 "SESSION_SECRET second-value" "SESSION_SECRET" "first-value" "second-value"
expect_failed "expect_refused fails when the message holds any one of several values"
run expect_refused "a weak SESSION_SECRET" 1 "SESSION_SECRET is short" "SESSION_SECRET" ""
expect_failed "expect_refused fails on an empty value to look for, which every message would hold"

# check_startup_refusals runs the image once for each configuration production refuses; docker is a stand-in that refuses as told.
image="slugbase:test"
run_id="test"
work="$tmp"
secrets=("$smoke_session_secret" "$smoke_encryption_key" "$smoke_superuser_password")
fake_code=1
fake_output="SESSION_SECRET ENCRYPTION_KEY APP_ORIGIN are invalid"
docker_calls="$tmp/docker-calls"
: >"$docker_calls"
# The check starts docker through timeout, an external command that cannot see a function.
# shellcheck disable=SC2317
timeout() { shift; "$@"; }
# shellcheck disable=SC2317
docker() {
  printf '%s\n' "$1" >>"$docker_calls"
  if [[ "$1" == "run" ]]; then
    printf '%s' "$fake_output"
    return "$fake_code"
  fi
}
run check_startup_refusals
expect_ok "check_startup_refusals accepts an image that refuses every configuration"
removed="$(grep -cx rm "$docker_calls" || true)"
ran="$(grep -cx run "$docker_calls" || true)"
if ((ran == 5 && removed >= 5)); then pass "check_startup_refusals runs five configurations and removes each container"; else fail_test "check_startup_refusals ran $ran containers and removed $removed"; fi
fake_code=0
run check_startup_refusals
expect_failed "check_startup_refusals fails when the image starts with a configuration production refuses"
fake_code=124
run check_startup_refusals
expect_failed "check_startup_refusals fails when the image does not refuse within the time allowed"
fake_code=1
fake_output="SESSION_SECRET ENCRYPTION_KEY APP_ORIGIN were $smoke_encryption_key"
run check_startup_refusals
expect_failed "check_startup_refusals fails when a message holds the encryption key of the run"
expect_quiet_about "check_startup_refusals does not print the key it found" "$smoke_encryption_key"
fake_output="SESSION_SECRET ENCRYPTION_KEY were wrong"
run check_startup_refusals
expect_failed "check_startup_refusals fails when the message of the origin does not name APP_ORIGIN"
unset -f docker timeout

# The owner-role check hands the superuser URL to compose without putting it on the arguments of any process. This runs the real
# compose() through stand-ins for timeout, env and docker that record their own arguments (what `ps` shows) and, for each
# --env-file they are given, its mode and its contents at that moment; timeout and env then run what they were given.
stub_bin="$tmp/stub-bin"
argv_log="$tmp/argv.log"
envfile_log="$tmp/envfile-contents.log"
envfile_modes="$tmp/envfile-modes.log"
real_env="$(command -v env)"
mkdir -p "$stub_bin"
cat >"$stub_bin/timeout" <<STUB
#!$BASH
printf 'timeout %s\n' "\$*" >>"$argv_log"
shift
exec "\$@"
STUB
cat >"$stub_bin/env" <<STUB
#!$BASH
printf 'env %s\n' "\$*" >>"$argv_log"
exec "$real_env" "\$@"
STUB
cat >"$stub_bin/docker" <<STUB
#!$BASH
printf 'docker %s\n' "\$*" >>"$argv_log"
previous=""
for argument in "\$@"; do
  if [[ "\$previous" == "--env-file" && -f "\$argument" ]]; then
    stat -c '%a' "\$argument" >>"$envfile_modes"
    cat "\$argument" >>"$envfile_log"
  fi
  previous="\$argument"
done
if [[ "\$1" == "compose" ]]; then
  printf '%s' "DATABASE_URL connects as the role slugbase, which is a superuser, so row-level security does not hold it."
  exit 1
fi
STUB
chmod +x "$stub_bin/timeout" "$stub_bin/env" "$stub_bin/docker"
: >"$argv_log"
: >"$envfile_log"
: >"$envfile_modes"
project="slugbase-smoke-test"
env_file="$tmp/stack.env"
: >"$env_file"
compose_files=(-f "$root/compose.yml")
docker_env=()
run_id="test"
work="$tmp"
with_stubs() {
  PATH="$stub_bin:$PATH"
  "$@"
}
run with_stubs check_owner_role_refused
expect_ok "check_owner_role_refused runs through the real compose() and accepts the refusal"
if [[ -s "$argv_log" ]] && grep -q '^timeout 120 env -i ' "$argv_log" && grep -q '^docker compose .* run ' "$argv_log"; then
  pass "the owner-role run goes through timeout, env and docker compose"
else
  out="$(cat "$argv_log")"
  fail_test "the arguments of the owner-role run were not recorded as expected"
fi
if ! grep -q "$smoke_superuser_password" "$argv_log"; then
  pass "the superuser password is on the arguments of no process (timeout, env, docker)"
else
  out="the recorded arguments hold the password"
  fail_test "the superuser password is on a command line"
fi
if grep -q "$smoke_superuser_password" "$envfile_log"; then
  pass "the superuser URL reaches compose in an --env-file"
else
  out="$(cat "$envfile_log")"
  fail_test "the --env-file handed to compose holds no password, so the check proves nothing"
fi
if grep -qx 600 "$envfile_modes"; then pass "the file that holds the URL is readable by this user alone"; else out="$(cat "$envfile_modes")"; fail_test "the mode of the --env-file that holds the URL"; fi
if grep -qE -- '-e DATABASE_URL( |$)' "$argv_log" && ! grep -q 'DATABASE_URL=' "$argv_log"; then
  pass "DATABASE_URL is handed to the container by name, without a value"
else
  out="$(cat "$argv_log")"
  fail_test "DATABASE_URL on the command line"
fi
if ! grep -rq "$smoke_superuser_password" "$work" --include='*.env' 2>/dev/null; then
  pass "the file that held the URL is gone once the check ends"
else
  fail_test "a file in the work directory still holds the password"
fi

# The owner-role checks run the server through compose against the database of the stack; compose is a stand-in.
compose_calls="$tmp/compose-calls"
: >"$compose_calls"
# shellcheck disable=SC2317
compose() {
  printf '%s\n' "$*" >>"$compose_calls"
  printf '%s' "$fake_output"
  return "$fake_code"
}
# shellcheck disable=SC2317
docker() { :; }
fake_code=1
fake_output="DATABASE_URL connects as the role slugbase, which is a superuser, so row-level security does not hold it."
run check_owner_role_refused
expect_ok "check_owner_role_refused accepts a server that refuses the superuser role"
fake_code=0
run check_owner_role_refused
expect_failed "check_owner_role_refused fails when the server starts as the superuser (the refusal is bypassed)"
fake_code=124
run check_owner_role_refused
expect_failed "check_owner_role_refused fails on a server that does not answer within the time allowed"
fake_code=1
fake_output="DATABASE_URL=postgres://slugbase:$smoke_superuser_password@postgres/slugbase is a superuser, so row-level security does not hold it."
run check_owner_role_refused
expect_failed "check_owner_role_refused fails when the message holds the password"
expect_quiet_about "check_owner_role_refused does not print the password it found" "$smoke_superuser_password"
fake_output="something else went wrong"
run check_owner_role_refused
expect_failed "check_owner_role_refused fails on a refusal that is not the owner-role message"
unset -f compose docker

# What a server run as the owner, with the override, must have done: be running and have logged the warning, without the password.
owner_warning="SLUGBASE_ALLOW_OWNER_CONNECTION is set: the application role is not held by row-level security"
run expect_owner_allowed running "$owner_warning"
expect_ok "expect_owner_allowed accepts a running server that logged the warning"
run expect_owner_allowed exited "$owner_warning"
expect_failed "expect_owner_allowed fails on a server that has stopped"
run expect_owner_allowed running "the server is listening"
expect_failed "expect_owner_allowed fails when the warning was not logged"
run expect_owner_allowed running "$owner_warning $smoke_superuser_password"
expect_failed "expect_owner_allowed fails when the log holds the password"
expect_quiet_about "expect_owner_allowed does not print the password it found" "$smoke_superuser_password"

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
