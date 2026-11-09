#!/usr/bin/env bash
# Starts the Community Edition image against an empty PostgreSQL and checks what a
# self-hoster relies on (doc 12 section 1, Phase 1 definition of done; doc 08
# section 6.2): the image migrates, reports ready, serves the probes, the API
# config and the web app, runs unprivileged on a read-only root filesystem,
# returns to ready after a restart without applying migrations again, holds no npm,
# npx or corepack, and refuses to start in production with a weak or missing session
# secret, a missing or short encryption key, an http origin, and a database role that
# is a superuser (Q56), unless the operator allows that role, which logs a warning.
#
#   bash scripts/smoke-image.sh
#
# Environment:
#   SLUGBASE_IMAGE      An image that is already present locally. Unset, the script
#                       builds apps/slugbase/Dockerfile from this checkout as
#                       slugbase:smoke-<run id> and removes that tag when it ends.
#   BUILD_COMMIT        The commit the image was built from. Given, /version must
#                       report exactly it (and a build by this script is made with it).
#   SMOKE_READY_SECONDS How long to wait for /ready (default 120).
#   SMOKE_APP_ORIGIN    The https origin the stack is configured with as APP_ORIGIN
#                       (default https://smoke.example.test). e2e/with-stack.sh sets
#                       it to the origin its TLS proxy serves, which a browser needs
#                       to sign in: the session cookie is Secure and a mutation must
#                       come from exactly this origin.
#   SMOKE_AVOID_PORT    A port the free port picked for the server must not be.
#   SMOKE_POSTGRES_MAJOR The PostgreSQL major the database runs: 18 (the default,
#                       compose.yml as it is) or 17 (compose.pg17.yml merged over
#                       it, doc 08 section 6.2). The script reads the version the
#                       running database reports and fails when it is another major.
#
# Everything is per run: the compose project name (slugbase-smoke-<run id>), a free
# host port on 127.0.0.1, and every secret, which is generated into a file in a
# temporary directory that only this user can read. The stack runs through
# compose.yml with that file as its only source of values, so the script reaches
# neither the development database of compose.dev.yml nor a .env file. No secret
# is printed: nothing here traces commands, a failure prints the log of the
# containers with every generated value replaced, and a message names keys, not
# values. The project, its volume, the temporary directory and a built image are
# removed on every way out, and a cleanup that fails does not change the exit
# status. Needs docker with the compose plugin, curl and jq.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# The weak value of the refusal check. It is not a secret and is 21 characters
# long, below the 32 production requires; it is distinctive so that a message
# containing it is found.
WEAK_SESSION_SECRET="smoke-weak-0123456789"

# jq filters of the bodies of /version and /ready.
VERSION_FILTER='(keys | sort) == ["builtAt", "commit", "name", "version"] and all(.[]; type == "string" and length > 0)'
READY_FILTER='.database == "ok" and (.migrations.expected | type == "number" and . > 0) and .migrations.applied == .migrations.expected'

# A /bin/sh script that prints each part of the bundled package managers (npm and
# npx, which share a package, and corepack) the image still holds: the binaries
# (also a link left dangling), their library directories, and any of the three
# names that resolves on PATH. ROOT is empty in the image; the test points it at a
# directory. Single quotes keep the variables for the shell of the image.
# shellcheck disable=SC2016
NPM_PROBE='for p in /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack; do
  if [ -e "${ROOT-}$p" ] || [ -L "${ROOT-}$p" ]; then echo "$p"; fi
done
for c in npm npx corepack; do
  if command -v "$c" >/dev/null 2>&1; then echo "$c on PATH"; fi
done'

# The message of the owner-role refusal and the warning that SLUGBASE_ALLOW_OWNER_CONNECTION
# turns it into (packages/server/src/migrate/role-guard.ts).
OWNER_ROLE_REFUSAL="row-level security does not hold it"
OWNER_ROLE_WARNING="SLUGBASE_ALLOW_OWNER_CONNECTION is set"

# State shared with the cleanup; set by main.
run_id=""
project=""
work=""
env_file=""
image=""
built_image=""
port=""
postgres_major=""
compose_files=()
secrets=()
docker_env=()
# Files of KEY=value lines that compose() reads after the stack's own, for a caller that must keep a value off every
# command line: the arguments of a process are readable by every user of the host, a file of mode 600 is not.
run_env_files=()
# When set, the number of seconds compose() may run before timeout ends it.
compose_limit=""
# The generated values the checks look for in a message.
smoke_session_secret=""
smoke_encryption_key=""
smoke_superuser_password=""
# Containers a check started by name, removed on every way out.
named_containers=()
refusal_count=0

log() {
  printf 'smoke: %s\n' "$*"
}

fail() {
  printf 'smoke: FAIL: %s\n' "$*" >&2
  exit 1
}

# Replaces every generated secret in the text on stdin.
redact() {
  local text value
  text="$(cat)"
  for value in "${secrets[@]}"; do
    [[ -n "$value" ]] && text="${text//"$value"/[redacted]}"
  done
  printf '%s\n' "$text"
}

random_hex() {
  od -An -vN"$1" -tx1 /dev/urandom | tr -d ' \n'
}

random_base64() {
  head -c "$1" /dev/urandom | base64 | tr -d '\n'
}

port_in_use() {
  (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null
}

# A free port in 20000-32767 on 127.0.0.1, away from the development database (54329).
# The range ends below 32768, where Linux's ephemeral range starts (32768-60999, the
# kernel default that the CE image's container also has). The server connects to
# PostgreSQL before it calls listen, and a port inside the ephemeral range can be handed
# to one of those outbound sockets as its local port, so listen fails with EADDRINUSE
# inside the container, where the check below on the runner's 127.0.0.1 cannot see it.
pick_port() {
  local candidate
  for _ in $(seq 1 50); do
    candidate=$((20000 + (RANDOM * 32768 + RANDOM) % 12768))
    if [[ "$candidate" != "${SMOKE_AVOID_PORT:-}" ]] && ! port_in_use "$candidate"; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  return 1
}

# docker compose with this run's project and only this run's values: the shell's own
# variables (a PORT or a SESSION_SECRET set there) would otherwise win over the file.
compose() {
  local -a bound=()
  if [[ -n "$compose_limit" ]]; then
    bound=(timeout "$compose_limit")
  fi
  local -a extra=()
  local file
  for file in "${run_env_files[@]+"${run_env_files[@]}"}"; do
    extra+=(--env-file "$file")
  done
  "${bound[@]+"${bound[@]}"}" env -i PATH="$PATH" HOME="${HOME:-/}" "${docker_env[@]}" \
    docker compose --ansi never --project-name "$project" --env-file "$env_file" "${extra[@]+"${extra[@]}"}" "${compose_files[@]}" "$@"
}

# Sets postgres_major and compose_files from SMOKE_POSTGRES_MAJOR: compose.yml alone
# runs PostgreSQL 18, and compose.pg17.yml is merged over it for 17. The files of
# SMOKE_EXTRA_COMPOSE_FILES come last.
select_postgres() {
  postgres_major="${SMOKE_POSTGRES_MAJOR:-18}"
  compose_files=(-f "$root/compose.yml")
  case "$postgres_major" in
    18) ;;
    17) compose_files+=(-f "$root/compose.pg17.yml") ;;
    *) fail "SMOKE_POSTGRES_MAJOR is '$postgres_major', expected 17 or 18" ;;
  esac
  local extra
  # Word splitting is the point: the paths are separated by spaces.
  # shellcheck disable=SC2086
  for extra in ${SMOKE_EXTRA_COMPOSE_FILES:-}; do
    [[ -f "$extra" ]] || fail "SMOKE_EXTRA_COMPOSE_FILES names '$extra', which is not a file"
    compose_files+=(-f "$extra")
  done
}

# HTTP: sets status, and leaves the headers and the body of the answer in $work.
request() {
  local path="$1"
  shift
  status="$(curl --silent --show-error --max-time 10 --dump-header "$work/headers" --output "$work/body" \
    --write-out '%{http_code}' "$@" "http://127.0.0.1:${port}${path}")" || return 1
}

# The value of a response header of the last request, empty when it is absent.
header_value() {
  local name="$1" line
  line="$(grep -i -m1 "^${name}:" "$work/headers" || true)"
  line="${line#*:}"
  line="${line%$'\r'}"
  printf '%s' "${line# }"
}

expect_equal() {
  local what="$1" actual="$2" expected="$3"
  [[ "$actual" == "$expected" ]] || fail "$what is '$actual', expected '$expected'"
  log "ok: $what is '$expected'"
}

expect_status() {
  local path="$1" expected="$2"
  shift 2
  request "$path" "$@" || fail "GET $path did not answer"
  [[ "$status" == "$expected" ]] || fail "GET $path answered $status, expected $expected"
  log "ok: GET $path answered $expected"
}

# jq -e on the body of the last request.
expect_json() {
  local what="$1" filter="$2"
  jq -e "$filter" "$work/body" >/dev/null 2>&1 || fail "$what: the body does not satisfy $filter"
  log "ok: $what"
}

expect_contains() {
  local what="$1" haystack="$2" needle="$3"
  [[ "$haystack" == *"$needle"* ]] || fail "$what does not contain '$needle'"
  log "ok: $what contains '$needle'"
}

expect_lacks() {
  local what="$1" haystack="$2" needle="$3"
  [[ "$haystack" != *"$needle"* ]] || fail "$what contains a value that must not appear in it"
  log "ok: $what does not contain that value"
}

# Waits for /ready to answer 200, failing early when the server container has stopped.
wait_ready() {
  local limit="${SMOKE_READY_SECONDS:-120}" deadline container state
  deadline=$((SECONDS + limit))
  while ((SECONDS < deadline)); do
    if request /ready 2>/dev/null && [[ "$status" == "200" ]]; then
      log "ok: /ready answered 200"
      return 0
    fi
    container="$(compose ps --all -q slugbase 2>/dev/null || true)"
    if [[ -n "$container" ]]; then
      state="$(docker inspect --format '{{.State.Status}}' "$container" 2>/dev/null || true)"
      case "$state" in
        exited | dead) fail "the server container is $state before /ready answered 200" ;;
      esac
    fi
    sleep 2
  done
  fail "/ready did not answer 200 within ${limit} seconds"
}

# The end of each container's log, for the run that failed.
dump_logs() {
  local service
  for service in slugbase slugbase-worker postgres; do
    printf -- '--- %s (last 60 lines) ---\n' "$service" >&2
    compose logs --no-color --no-log-prefix --tail 60 "$service" 2>&1 | sed 's/\x1b\[[0-9;]*[A-Za-z]//g' | redact >&2 || true
  done
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM HUP
  set +e
  if [[ -n "$project" && -f "$env_file" ]]; then
    if ((status != 0)); then
      dump_logs
    fi
    compose down --volumes --remove-orphans >/dev/null 2>&1 ||
      printf 'smoke: warning: docker compose down failed for project %s\n' "$project" >&2
  fi
  if ((${#named_containers[@]} > 0)); then
    docker rm --force "${named_containers[@]}" >/dev/null 2>&1 ||
      printf 'smoke: warning: could not remove the containers of the refusal checks\n' >&2
  fi
  if [[ -n "$built_image" ]]; then
    docker rmi "$image" >/dev/null 2>&1 ||
      printf 'smoke: warning: could not remove the image %s\n' "$image" >&2
  fi
  if [[ -n "$work" ]]; then
    rm -rf "$work" ||
      printf 'smoke: warning: could not remove %s\n' "$work" >&2
  fi
  exit "$status"
}

preflight() {
  local tool
  for tool in docker curl jq od base64 timeout; do
    command -v "$tool" >/dev/null 2>&1 || fail "$tool is required and was not found on PATH"
  done
  docker compose version >/dev/null 2>&1 || fail "the docker compose plugin is required"
  docker info >/dev/null 2>&1 || fail "the docker daemon is not reachable"
}

prepare_image() {
  if [[ -n "${SLUGBASE_IMAGE:-}" ]]; then
    image="$SLUGBASE_IMAGE"
    docker image inspect "$image" >/dev/null 2>&1 || fail "the image named by SLUGBASE_IMAGE is not present locally"
    log "using the image named by SLUGBASE_IMAGE"
    return 0
  fi
  image="slugbase:smoke-${run_id}"
  log "building $image (this takes a few minutes without a layer cache)"
  # Tagged before it exists so that a build that dies half way is still removed.
  built_image=1
  timeout 900 docker build --file "$root/apps/slugbase/Dockerfile" \
    --build-arg "BUILD_COMMIT=${BUILD_COMMIT:-unknown}" --tag "$image" "$root" >"$work/build.log" 2>&1 ||
    {
      tail -n 40 "$work/build.log" >&2
      fail "docker build failed"
    }
}

write_env_file() {
  local app_password migrator_password
  smoke_session_secret="$(random_hex 32)"
  smoke_encryption_key="$(random_base64 32)"
  smoke_superuser_password="$(random_hex 24)"
  app_password="$(random_hex 24)"
  migrator_password="$(random_hex 24)"
  secrets=("$smoke_session_secret" "$smoke_encryption_key" "$smoke_superuser_password" "$app_password" "$migrator_password")
  # The passwords sit in database URLs, hence hex; APP_ORIGIN is https because
  # production requires it (curl reaches the published port over http).
  {
    printf 'APP_ORIGIN=%s\n' "${SMOKE_APP_ORIGIN:-https://smoke.example.test}"
    printf 'SESSION_SECRET=%s\n' "$smoke_session_secret"
    printf 'ENCRYPTION_KEY=%s\n' "$smoke_encryption_key"
    printf 'ENCRYPTION_KEY_ID=%s\n' "smoke-1"
    printf 'POSTGRES_PASSWORD=%s\n' "$smoke_superuser_password"
    printf 'APP_DB_PASSWORD=%s\n' "$app_password"
    printf 'MIGRATOR_DB_PASSWORD=%s\n' "$migrator_password"
    printf 'SLUGBASE_IMAGE=%s\n' "$image"
    printf 'SLUGBASE_BIND=%s\n' "127.0.0.1"
    printf 'PORT=%s\n' "$port"
  } >"$env_file"
}

check_probes_and_pages() {
  expect_status /health 200
  expect_json "/health reports ok" '.status == "ok"'

  expect_status /version 200
  expect_json "/version has exactly name, version, commit and builtAt, all non-empty strings" "$VERSION_FILTER"
  if [[ -n "${BUILD_COMMIT:-}" ]]; then
    expect_equal "the commit of /version" "$(jq -r .commit "$work/body")" "$BUILD_COMMIT"
  fi

  expect_status /api/config 200
  expect_equal "Cache-Control of /api/config" "$(header_value cache-control)" "public, max-age=60"

  expect_status / 200 --header 'Accept: text/html'
  expect_contains "the content type of /" "$(header_value content-type)" "text/html"
  expect_contains "the content-security-policy of /" "$(header_value content-security-policy)" "default-src 'self'"
  expect_contains "the content-security-policy of /" "$(header_value content-security-policy)" "script-src 'self'"
  expect_contains "the body of /" "$(cat "$work/body")" 'id="root"'
  expect_contains "the body of /" "$(cat "$work/body")" '<script type="module"'

  expect_status /ready 200
  expect_json "/ready reports a reachable database and as many applied as expected migrations, at least one" "$READY_FILTER"
}

check_container_hardening() {
  local container uid output
  container="$(compose ps -q slugbase)"
  [[ -n "$container" ]] || fail "the server container was not found"
  expect_equal "ReadonlyRootfs of the server container" \
    "$(docker inspect --format '{{.HostConfig.ReadonlyRootfs}}' "$container")" "true"
  # PID 1 is the node process the entrypoint exec'd into; the loop runs in the container, so $ is not expanded here.
  # shellcheck disable=SC2016
  uid="$(compose exec -T slugbase sh -c 'while read -r key real rest; do if [ "$key" = "Uid:" ]; then echo "$real"; fi; done < /proc/1/status' | tr -d '\r')"
  [[ "$uid" =~ ^[0-9]+$ ]] || fail "the user of the server process could not be read"
  [[ "$uid" != "0" ]] || fail "the server process runs as root"
  log "ok: the server process runs as user $uid, not root"
  if compose exec -T slugbase sh -c 'touch /app/smoke-probe' >/dev/null 2>&1; then
    fail "the server container can write to its root filesystem"
  fi
  log "ok: the root filesystem of the server container is read-only"
  output="$(compose exec -T slugbase sh -c 'touch /tmp/smoke-probe && echo writable' 2>&1 | tr -d '\r' || true)"
  expect_equal "the tmpfs /tmp of the server container" "$output" "writable"
}

# The runtime stage removes the npm, npx and corepack of the base image: the
# entrypoint only starts node, and the advisories in that bundled npm would
# otherwise ship (doc 01 section 1). The probe runs in the image itself, with no
# network and the root filesystem read-only.
check_no_npm() {
  local found
  found="$(timeout 120 docker run --rm --network none --read-only --entrypoint sh "$image" -c "$NPM_PROBE")" ||
    fail "the probe for npm could not run in the image"
  [[ -z "$found" ]] || fail "the image still holds the bundled package manager: ${found//$'\n'/, }"
  log "ok: the image holds no npm, npx or corepack"
}

# A restart runs the entrypoint again, which runs migrate again; with nothing to
# apply, migrate says so and the server is ready as before.
check_restart() {
  local before after
  before="$(compose logs --no-color --no-log-prefix slugbase 2>&1 | wc -l)"
  expect_contains "the log of the first start" "$(compose logs --no-color --no-log-prefix slugbase 2>&1)" "The database is migrated"
  compose restart slugbase >/dev/null 2>&1 || fail "docker compose restart failed"
  wait_ready
  after="$(compose logs --no-color --no-log-prefix slugbase 2>&1 | tail -n +"$((before + 1))")"
  expect_contains "the log of the restart" "$after" "The database is up to date"
  expect_lacks "the log of the restart" "$after" "The database is migrated"
  expect_status /ready 200
  expect_json "/ready after the restart reports as many applied as expected migrations" \
    '.migrations.applied == .migrations.expected'
}

# The environment file of a server in production whose configuration is valid and that has no
# database to reach (MIGRATE_ON_START is false and the URL points nowhere), with this run's secrets.
# Each override follows: KEY=value replaces or adds a key, and -KEY leaves it out.
write_production_env() {
  local file="$1" line key override skip
  shift
  local -a base=(
    "NODE_ENV=production"
    "APP_ORIGIN=https://smoke.example.test"
    "DATABASE_URL=postgres://slugbase_app:unused@127.0.0.1:5432/slugbase"
    "SESSION_SECRET=${smoke_session_secret}"
    "ENCRYPTION_KEY=${smoke_encryption_key}"
    "ENCRYPTION_KEY_ID=smoke-1"
    "MIGRATE_ON_START=false"
  )
  : >"$file"
  for line in "${base[@]}"; do
    key="${line%%=*}"
    skip=""
    for override in "$@"; do
      if [[ "$override" == "-$key" || "$override" == "$key="* ]]; then
        skip=1
      fi
    done
    if [[ -z "$skip" ]]; then
      printf '%s\n' "$line" >>"$file"
    fi
  done
  for override in "$@"; do
    if [[ "$override" != -* ]]; then
      printf '%s\n' "$override" >>"$file"
    fi
  done
}

# Runs the image's server once with the environment file, on no network and a read-only root
# filesystem, within two minutes. Sets refusal_code and refusal_output. The container has a name,
# and is removed by it, because timeout ends the client of a run and not always the container.
run_refusal() {
  local env_path="$1" name
  name="slugbase-smoke-${run_id}-refusal-${refusal_count}"
  refusal_count=$((refusal_count + 1))
  named_containers+=("$name")
  refusal_code=0
  refusal_output="$(timeout 120 docker run --rm --name "$name" --network none --read-only --tmpfs /tmp \
    --env-file "$env_path" "$image" server 2>&1)" || refusal_code=$?
  docker rm --force "$name" >/dev/null 2>&1 || true
}

# Judges a run that had to be refused: it ended with a status of the server's own (not 0, not the
# 124 of timeout, not the 125 to 127 of a container that did not run), and its message names the
# needle and holds none of the values that must not appear in it. A value to look for that is empty
# fails, since every message holds it.
expect_refused() {
  local what="$1" code="$2" output="$3" needle="$4" forbidden
  shift 4
  case "$code" in
    0) fail "the image started with $what in production" ;;
    124) fail "the image did not refuse $what within the time allowed" ;;
    125 | 126 | 127) fail "the container for $what could not be run (status $code)" ;;
  esac
  log "ok: the image exited with status $code on $what"
  expect_contains "the message on $what" "$output" "$needle"
  for forbidden in "$@"; do
    [[ -n "$forbidden" ]] || fail "the check of the message on $what was given an empty value to look for"
    expect_lacks "the message on $what" "$output" "$forbidden"
  done
}

# Production refuses a weak or missing session secret, a missing or short encryption key and an
# http origin, before it connects to anything, and each message names the key, not the value.
# The short key decodes to 31 bytes, one below the 32 the cipher needs.
check_startup_refusals() {
  local env_path="$work/refusal.env" short_key
  short_key="$(random_base64 31)"
  secrets+=("$short_key")

  write_production_env "$env_path" "SESSION_SECRET=$WEAK_SESSION_SECRET"
  run_refusal "$env_path"
  expect_refused "a weak SESSION_SECRET" "$refusal_code" "$refusal_output" "SESSION_SECRET" \
    "$WEAK_SESSION_SECRET" "$smoke_encryption_key"

  write_production_env "$env_path" "-SESSION_SECRET"
  run_refusal "$env_path"
  expect_refused "a missing SESSION_SECRET" "$refusal_code" "$refusal_output" "SESSION_SECRET" \
    "$smoke_session_secret" "$smoke_encryption_key"

  write_production_env "$env_path" "-ENCRYPTION_KEY"
  run_refusal "$env_path"
  expect_refused "a missing ENCRYPTION_KEY" "$refusal_code" "$refusal_output" "ENCRYPTION_KEY" \
    "$smoke_session_secret" "$smoke_encryption_key"

  write_production_env "$env_path" "ENCRYPTION_KEY=$short_key"
  run_refusal "$env_path"
  expect_refused "an ENCRYPTION_KEY of 31 bytes" "$refusal_code" "$refusal_output" "ENCRYPTION_KEY" \
    "$short_key" "$smoke_session_secret" "$smoke_encryption_key"

  write_production_env "$env_path" "APP_ORIGIN=http://smoke.example.test"
  run_refusal "$env_path"
  expect_refused "an http APP_ORIGIN" "$refusal_code" "$refusal_output" "APP_ORIGIN" \
    "$smoke_session_secret" "$smoke_encryption_key"
}

# Runs the command (a compose call) with DATABASE_URL set to the superuser the stack provisions, for the server of the stack's
# compose file against the stack's PostgreSQL. The URL is written to a file of mode 600 in the work directory and compose reads it
# as a second --env-file, so that `-e DATABASE_URL` hands it to the container by name: the password is on the arguments of no
# process (timeout, env, docker), and the file is removed when the command ends.
owner_role_run() {
  local owner_env="$work/owner-role.env" code=0
  (
    umask 077
    printf 'DATABASE_URL=postgres://slugbase:%s@postgres:5432/slugbase\n' "$smoke_superuser_password" >"$owner_env"
  )
  run_env_files=("$owner_env")
  compose_limit=120
  "$@" || code=$?
  run_env_files=()
  compose_limit=""
  rm -f "$owner_env"
  return "$code"
}

# Against the stack's PostgreSQL, a server whose DATABASE_URL is the superuser exits before it
# serves, with the owner-role message of role-guard.ts, and the password is not in the output.
check_owner_role_refused() {
  local name output code=0
  name="slugbase-smoke-${run_id}-owner-refused"
  named_containers+=("$name")
  output="$(owner_role_run compose run --rm --no-deps --name "$name" \
    -e DATABASE_URL -e MIGRATE_ON_START=false slugbase server 2>&1)" || code=$?
  docker rm --force "$name" >/dev/null 2>&1 || true
  expect_refused "a DATABASE_URL that connects as the superuser" "$code" "$output" "$OWNER_ROLE_REFUSAL" \
    "$smoke_superuser_password"
}

# What a server on the owner role must have done once SLUGBASE_ALLOW_OWNER_CONNECTION allows it:
# be running, and have logged the warning, without the password.
expect_owner_allowed() {
  local state="$1" logs="$2"
  [[ "$state" == "running" ]] || fail "the server on the owner role is $state, expected running"
  log "ok: the server on the owner role is running"
  expect_contains "the log of the server on the owner role" "$logs" "$OWNER_ROLE_WARNING"
  expect_lacks "the log of the server on the owner role" "$logs" "$smoke_superuser_password"
}

# With SLUGBASE_ALLOW_OWNER_CONNECTION=true the same server starts, answers /ready and logs the warning.
check_owner_role_allowed() {
  local name state="" logs="" deadline limit="${SMOKE_READY_SECONDS:-120}"
  name="slugbase-smoke-${run_id}-owner-allowed"
  named_containers+=("$name")
  owner_role_run compose run --detach --no-deps --name "$name" \
    -e DATABASE_URL -e MIGRATE_ON_START=false -e SLUGBASE_ALLOW_OWNER_CONNECTION=true slugbase server \
    >"$work/owner-allowed.log" 2>&1 ||
    {
      redact <"$work/owner-allowed.log" | tail -n 20 >&2
      fail "the server on the owner role could not be started"
    }
  deadline=$((SECONDS + limit))
  # The probe is the compose healthcheck's: node answers from inside, since no port is published.
  # shellcheck disable=SC2016
  until timeout 20 docker exec "$name" node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/ready').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))" >/dev/null 2>&1; do
    state="$(docker inspect --format '{{.State.Status}}' "$name" 2>/dev/null || true)"
    case "$state" in
      exited | dead)
        docker logs "$name" 2>&1 | redact >&2 || true
        fail "the server on the owner role is $state before /ready answered 200"
        ;;
    esac
    ((SECONDS < deadline)) || fail "the server on the owner role did not answer /ready within ${limit} seconds"
    sleep 2
  done
  state="$(docker inspect --format '{{.State.Status}}' "$name" 2>/dev/null || true)"
  logs="$(docker logs "$name" 2>&1 | sed 's/\x1b\[[0-9;]*[A-Za-z]//g')"
  expect_owner_allowed "$state" "$logs"
  docker rm --force "$name" >/dev/null 2>&1 || true
}

# The database answers with the major that was asked for, so that a selection which
# the compose files ignore cannot pass as a run against that major.
check_postgres_major() {
  local reported
  reported="$(compose exec -T postgres psql --username slugbase --dbname slugbase --no-psqlrc --tuples-only --no-align \
    --command 'SHOW server_version_num' | tr -d '\r' || true)"
  [[ "$reported" =~ ^[0-9]{6}$ ]] || fail "the version of the database could not be read"
  expect_equal "the major of the database" "$((10#$reported / 10000))" "$postgres_major"
}

# Prepares the image, writes this run's secrets and starts the stack, and returns once
# /ready answers 200. Sets the state the cleanup reads and installs the cleanup, so a
# caller that sources this file (e2e/with-stack.sh) gets the same teardown on every
# way out, and reaches the server at http://127.0.0.1:$port.
start_stack() {
  cd "$root"
  preflight
  select_postgres

  run_id="$(random_hex 4)"
  project="slugbase-smoke-${run_id}"
  work="$(mktemp -d "${TMPDIR:-/tmp}/slugbase-smoke.XXXXXX")"
  chmod 700 "$work"
  env_file="$work/stack.env"
  # The variables that tell the docker CLI which daemon to use survive the clean environment of compose().
  local name
  for name in DOCKER_HOST DOCKER_CONFIG DOCKER_CONTEXT DOCKER_TLS_VERIFY DOCKER_CERT_PATH XDG_RUNTIME_DIR; do
    if [[ -n "${!name:-}" ]]; then
      docker_env+=("${name}=${!name}")
    fi
  done
  trap cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  trap 'exit 129' HUP

  prepare_image
  port="$(pick_port)" || fail "no free port found on 127.0.0.1"
  write_env_file
  log "project $project, port $port"

  compose config --quiet || fail "compose.yml does not accept the generated environment"
  compose up --detach --no-build --pull missing >"$work/up.log" 2>&1 ||
    {
      redact <"$work/up.log" | tail -n 20 >&2
      fail "docker compose up failed"
    }

  wait_ready
  check_postgres_major
}

main() {
  start_stack
  check_probes_and_pages
  check_container_hardening
  check_no_npm
  check_restart
  check_startup_refusals
  check_owner_role_refused
  check_owner_role_allowed

  log "all checks passed"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
