#!/usr/bin/env bash
# Open a Pangolin machine-client tunnel, wait for Postgres connectivity, then run a command.
#
# Requires: PANGOLIN_MACHINE_ID, PANGOLIN_MACHINE_SECRET, PANGOLIN_ENDPOINT, DATABASE_URL
#
# Self-hosted runner prerequisite (one-time per host):
#   - /usr/local/sbin/pangolin-migrate-ci installed
#   - NOPASSWD sudoers for each runner user on that binary
#
# Pangolin is a host-level singleton (root via sudo). Prior failed/cancelled jobs can leave
# a stale daemon that blocks `up` with "a client is already running" without registering the
# machine client in the Pangolin UI — always `down` before `up`.
#
# Usage: with-pangolin-tunnel.sh <command> [args...]
set -euo pipefail

export TERM="${TERM:-dumb}"

: "${PANGOLIN_MACHINE_ID:?PANGOLIN_MACHINE_ID is required}"
: "${PANGOLIN_MACHINE_SECRET:?PANGOLIN_MACHINE_SECRET is required}"
: "${PANGOLIN_ENDPOINT:?PANGOLIN_ENDPOINT is required}"
: "${DATABASE_URL:?DATABASE_URL is required}"

if [[ $# -lt 1 ]]; then
  echo "with-pangolin-tunnel: command required" >&2
  exit 1
fi

PANGOLIN_BIN="${PANGOLIN_BIN:-/usr/local/sbin/pangolin-migrate-ci}"
PANGOLIN_PUBLIC_IP="${PANGOLIN_PUBLIC_IP:-159.195.45.249}"
PANGOLIN_STARTED_BY_SCRIPT=0

require_runner_setup() {
  if [[ ! -x "$PANGOLIN_BIN" ]]; then
    echo "Pangolin CLI not found at ${PANGOLIN_BIN}." >&2
    echo "Install on each self-hosted runner host, then grant NOPASSWD sudo for this path." >&2
    exit 1
  fi

  if ! sudo -n "$PANGOLIN_BIN" --help >/dev/null 2>&1; then
    echo "Passwordless sudo is not configured for ${PANGOLIN_BIN} (user: $(whoami))." >&2
    echo "Add a sudoers drop-in on the runner host, e.g.:" >&2
    echo "  $(whoami) ALL=(root) NOPASSWD: ${PANGOLIN_BIN}" >&2
    exit 1
  fi
}

pangolin_cmd() {
  sudo -n "$PANGOLIN_BIN" "$@"
}

pangolin_down() {
  if [[ "${PANGOLIN_STARTED_BY_SCRIPT}" -eq 1 ]]; then
    if [[ -n "${PANGOLIN_PID:-}" ]] && kill -0 "$PANGOLIN_PID" 2>/dev/null; then
      kill "$PANGOLIN_PID" 2>/dev/null || true
      wait "$PANGOLIN_PID" 2>/dev/null || true
    fi
    pangolin_cmd down >/dev/null 2>&1 || true
  fi
}

pangolin_site_connected() {
  pangolin_cmd status 2>&1 | awk 'NR > 1 && $3 == "Connected" { found = 1 } END { exit found ? 0 : 1 }'
}

resolve_db_ip() {
  local ip
  ip="$(dig @100.96.128.1 +time=2 +tries=1 "$DB_HOST" +short 2>/dev/null | head -1 || true)"
  if [[ -z "$ip" ]]; then
    ip="$(dig +time=2 +tries=1 "$DB_HOST" +short 2>/dev/null | head -1 || true)"
  fi
  printf '%s' "$ip"
}

start_pangolin_up() {
  local log
  log="$(mktemp)"
  trap 'rm -f "$log"' RETURN

  pangolin_cmd up \
    --attach \
    --id "$PANGOLIN_MACHINE_ID" \
    --secret "$PANGOLIN_MACHINE_SECRET" \
    --endpoint "$PANGOLIN_ENDPOINT" </dev/null >"$log" 2>&1 &
  PANGOLIN_PID=$!

  for _ in $(seq 1 15); do
    if kill -0 "$PANGOLIN_PID" 2>/dev/null; then
      if pangolin_site_connected; then
        PANGOLIN_STARTED_BY_SCRIPT=1
        rm -f "$log"
        trap - RETURN
        return 0
      fi
      sleep 1
      continue
    fi

    cat "$log" >&2
    rm -f "$log"
    trap - RETURN
    return 1
  done

  if kill -0 "$PANGOLIN_PID" 2>/dev/null; then
    echo "Pangolin client is running but site is not Connected yet:" >&2
    pangolin_cmd status >&2 || true
    kill "$PANGOLIN_PID" 2>/dev/null || true
    wait "$PANGOLIN_PID" 2>/dev/null || true
  fi
  rm -f "$log"
  trap - RETURN
  return 1
}

require_runner_setup
trap pangolin_down EXIT

echo "Stopping any stale Pangolin client on this host..."
pangolin_cmd down >/dev/null 2>&1 || true
sleep 2

echo "Starting Pangolin machine client (sudo: ${PANGOLIN_BIN})..."
if ! start_pangolin_up; then
  echo "Pangolin up failed; running down and retrying once..." >&2
  pangolin_cmd down >/dev/null 2>&1 || true
  sleep 2
  if ! start_pangolin_up; then
    echo "Could not start Pangolin machine client:" >&2
    pangolin_cmd status >&2 || true
    exit 1
  fi
fi

echo "Pangolin site connected."
pangolin_cmd status >&2 || true

DB_HOST="$(
  node -e "
    const raw = process.env.DATABASE_URL ?? '';
    const normalized = raw.replace(/^postgresql:/, 'http:');
    process.stdout.write(new URL(normalized).hostname);
  "
)"

echo "Waiting for Postgres connectivity (${DB_HOST}:5432)..."
connected=0
resolved_ip=""
for _ in $(seq 1 45); do
  if [[ "${PANGOLIN_STARTED_BY_SCRIPT}" -eq 1 ]] && ! kill -0 "$PANGOLIN_PID" 2>/dev/null; then
    echo "Pangolin client stopped while waiting for Postgres:" >&2
    pangolin_cmd status >&2 || true
    exit 1
  fi

  resolved_ip="$(resolve_db_ip)"
  if [[ -n "$resolved_ip" && "$resolved_ip" != "$PANGOLIN_PUBLIC_IP" ]]; then
    if nc -z -w 3 "$resolved_ip" 5432 2>/dev/null; then
      connected=1
      break
    fi
  fi
  sleep 2
done

if [[ "$connected" -ne 1 ]]; then
  echo "Could not reach Postgres via Pangolin (host: ${DB_HOST})." >&2
  echo "Last resolved IP: ${resolved_ip:-<none>}" >&2
  pangolin_cmd status >&2 || true
  exit 1
fi

echo "Postgres reachable at ${resolved_ip}:5432"
exec "$@"
