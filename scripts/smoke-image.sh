#!/usr/bin/env bash
# Starts the Community Edition image against an empty PostgreSQL and checks what a
# self-hoster relies on (doc 12 section 1, Phase 1 definition of done; doc 08
# section 6.2): the image migrates, reports ready, serves the probes, the API
# config and the web app, runs unprivileged on a read-only root filesystem,
# returns to ready after a restart without applying migrations again, and refuses
# to start with a weak session secret.
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

# State shared with the cleanup; set by main.
run_id=""
project=""
work=""
env_file=""
image=""
built_image=""
port=""
secrets=()
docker_env=()

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

# A free port in 20000-39999 on 127.0.0.1, away from the development database (54329).
pick_port() {
  local candidate
  for _ in $(seq 1 50); do
    candidate=$((20000 + (RANDOM * 32768 + RANDOM) % 20000))
    if ! port_in_use "$candidate"; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  return 1
}

# docker compose with this run's project and only this run's values: the shell's own
# variables (a PORT or a SESSION_SECRET set there) would otherwise win over the file.
compose() {
  env -i PATH="$PATH" HOME="${HOME:-/}" "${docker_env[@]}" \
    docker compose --ansi never --project-name "$project" --env-file "$env_file" -f "$root/compose.yml" "$@"
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
  local session_secret encryption_key superuser_password app_password migrator_password
  session_secret="$(random_hex 32)"
  encryption_key="$(random_base64 32)"
  superuser_password="$(random_hex 24)"
  app_password="$(random_hex 24)"
  migrator_password="$(random_hex 24)"
  secrets=("$session_secret" "$encryption_key" "$superuser_password" "$app_password" "$migrator_password")
  # The passwords sit in database URLs, hence hex; APP_ORIGIN is https because
  # production requires it (curl reaches the published port over http).
  {
    printf 'APP_ORIGIN=%s\n' "https://smoke.example.test"
    printf 'SESSION_SECRET=%s\n' "$session_secret"
    printf 'ENCRYPTION_KEY=%s\n' "$encryption_key"
    printf 'ENCRYPTION_KEY_ID=%s\n' "smoke-1"
    printf 'POSTGRES_PASSWORD=%s\n' "$superuser_password"
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

# Production refuses a session secret shorter than 32 characters, before it connects
# to anything, and the message names the key, not the value.
check_weak_secret_refused() {
  local weak_env="$work/weak.env" output code=0
  {
    printf 'NODE_ENV=production\n'
    printf 'APP_ORIGIN=https://smoke.example.test\n'
    printf 'DATABASE_URL=postgres://slugbase_app:%s@127.0.0.1:5432/slugbase\n' "unused"
    printf 'SESSION_SECRET=%s\n' "$WEAK_SESSION_SECRET"
    printf 'ENCRYPTION_KEY=%s\n' "${secrets[1]}"
    printf 'ENCRYPTION_KEY_ID=smoke-1\n'
    printf 'MIGRATE_ON_START=false\n'
  } >"$weak_env"
  output="$(timeout 120 docker run --rm --network none --read-only --tmpfs /tmp --env-file "$weak_env" "$image" server 2>&1)" || code=$?
  ((code != 0)) || fail "the image started with a weak SESSION_SECRET in production"
  log "ok: the image exited with status $code on a weak SESSION_SECRET"
  expect_contains "the message" "$output" "SESSION_SECRET"
  expect_lacks "the message" "$output" "$WEAK_SESSION_SECRET"
}

main() {
  cd "$root"
  preflight

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
  check_probes_and_pages
  check_container_hardening
  check_restart
  check_weak_secret_refused

  log "all checks passed"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
