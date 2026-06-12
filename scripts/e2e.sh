#!/usr/bin/env bash
# Full lifecycle for local Playwright e2e tests (spec §22.4).
#
# Spins up ephemeral Postgres on a random port, runs Playwright for one or
# both deployment modes, and tears everything down — including volumes,
# containers, and builder cache. Leaves zero artifacts behind.
#
# Usage:
#   bash scripts/e2e.sh                              # hosted + self-hosted (default)
#   bash scripts/e2e.sh --project=hosted              # hosted only
#   bash scripts/e2e.sh --project=self-hosted         # self-hosted only
#   bash scripts/e2e.sh specs/bookmarks/              # hosted + self-hosted, single spec dir
#   bash scripts/e2e.sh --debug                       # hosted + self-hosted, debug mode
#
# Prerequisites (one-time):
#   npx playwright install --with-deps chromium
#
# shellcheck disable=SC2317,SC2312
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE_FILE="$REPO_ROOT/docker-compose.e2e.yml"

# Parse --project argument to determine mode
MODE=""
REMAINING_ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --project=*)
      MODE="${1#*=}"
      shift
      ;;
    --project)
      MODE="$2"
      shift 2
      ;;
    *)
      REMAINING_ARGS+=("$1")
      shift
      ;;
  esac
done
set -- "${REMAINING_ARGS[@]}"

# Determine which modes to run
RUN_HOSTED=false
RUN_SELF_HOSTED=false
case "$MODE" in
  hosted)       RUN_HOSTED=true ;;
  self-hosted)  RUN_SELF_HOSTED=true ;;
  "")           RUN_HOSTED=true; RUN_SELF_HOSTED=true ;;
  *)            echo "Unknown project: $MODE (expected: hosted, self-hosted)" >&2; exit 1 ;;
esac

# Colours
GREEN='\033[0;32m'; CYAN='\033[0;36m'; YELLOW='\033[0;33m'; RED='\033[0;31m'; NC='\033[0m'
ok()    { echo -e "${GREEN}✓${NC} $1"; }
info()  { echo -e "${CYAN}→${NC} $1"; }
warn()  { echo -e "${YELLOW}⚠${NC} $1"; }
fail()  { echo -e "${RED}✗${NC} $1"; }
header(){ echo -e "\n${CYAN}═══════════════════════════════════════════${NC}"; echo -e "${CYAN}  $1${NC}"; echo -e "${CYAN}═══════════════════════════════════════════${NC}"; }

# Track all e2e process PIDs for reliable cleanup.
E2E_PIDS=()
kill_e2e_pids() {
  for pid in "${E2E_PIDS[@]}"; do
    # Kill process tree (parent + children)
    if kill -0 "$pid" 2>/dev/null; then
      # pkill -P finds children of pid; kill the tree bottom-up then the root
      pkill -P "$pid" 2>/dev/null || true
      kill -9 "$pid" 2>/dev/null || true
    fi
  done
  E2E_PIDS=()
}

# ---------------------------------------------------------------------------
# Find N unique free TCP ports on localhost.
# Calls python3 once to reserve+release a batch of distinct ports.
# ---------------------------------------------------------------------------
find_free_ports() {
  local count="${1:-1}"
  python3 -c "
import socket, sys
count = $count
ports = []
for _ in range(count):
    for attempt in range(100):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            s.bind(('', 0))
            port = s.getsockname()[1]
            # Check this port isn't already in our list
            if port not in ports:
                ports.append(port)
                break
    else:
        print('find_free_ports: failed after 100 attempts', file=sys.stderr)
        sys.exit(1)
print(' '.join(str(p) for p in ports))
"
}

# ---------------------------------------------------------------------------
# 1. Start ephemeral Postgres (random host port via docker-compose)
# ---------------------------------------------------------------------------
header "Starting ephemeral Postgres"
docker compose -f "$COMPOSE_FILE" up -d --wait --force-recreate 2>&1 | sed 's/^/  /'

PGPORT="$(docker compose -f "$COMPOSE_FILE" port postgres 5432 | cut -d: -f2)"
export DATABASE_URL="postgresql://slugbase:slugbase@localhost:$PGPORT/slugbase_e2e"
export SLUGBASE_E2E_MODE=true
ok "Postgres ready — port $PGPORT"

# ---------------------------------------------------------------------------
# 1.1. Run DB migrations against ephemeral Postgres
# ---------------------------------------------------------------------------
info "Running DB migrations …"
DATABASE_URL="$DATABASE_URL" \
  pnpm --filter @slugbase/backend db:migrate 2>&1 | sed 's/^/  /'
ok "Migrations applied"

# ---------------------------------------------------------------------------
# Cleanup trap — guaranteed run on exit, INT, or TERM
# ---------------------------------------------------------------------------
EXIT_CODE=0
cleanup() {
  local last_exit=$?
  # If we got here via EXIT after explicit exit, use EXIT_CODE. Otherwise use last_exit.
  [ "$last_exit" -ne 0 ] && [ "$EXIT_CODE" -eq 0 ] && EXIT_CODE=$last_exit
  echo ""
  header "Tearing down"
  kill_e2e_pids
  docker stop slugbase-e2e-self 2>/dev/null || true
  docker rm slugbase-e2e-self 2>/dev/null || true
  docker compose -f "$COMPOSE_FILE" down --volumes --remove-orphans 2>/dev/null || true
  # Only prune the Docker build cache when the self-hosted image was actually
  # built in this run. Pruning unconditionally adds 60-120s of wall time on
  # hosted-only runs (no Docker build) because the stale cache from previous
  # runs can be 1 GB+, causing the script to appear to hang after test
  # completion. Skipping prune on hosted-only runs is safe — the cache is
  # from a prior self-hosted build and will be pruned on the next full run.
  if [ "${DOCKER_BUILD_RAN:-false}" = true ]; then
    docker builder prune --force 2>/dev/null || true
  fi
  if [ "$EXIT_CODE" -eq 0 ]; then
    ok "All clean — no containers, volumes, or build cache left"
  else
    fail "Cleanup finished (some tests failed — see above)"
  fi
  exit "$EXIT_CODE"
}
trap cleanup EXIT INT TERM

# ---------------------------------------------------------------------------
# 1.5. Ensure Playwright browsers are installed (idempotent — skips if present)
# ---------------------------------------------------------------------------
info "Ensuring Playwright browsers …"
npx playwright install chromium 2>&1 | sed 's/^/  /'
ok "Playwright browsers ready"
header "Building packages"
cd "$REPO_ROOT"
bash scripts/with-ci-env.sh pnpm build 2>&1 | sed 's/^/  /'
ok "Build complete"

# ---------------------------------------------------------------------------
# 3. Run hosted tests (if selected)
#    Playwright webServer starts API, web, marketing on random ports
# ---------------------------------------------------------------------------
if [ "$RUN_HOSTED" = true ]; then
  header "Running hosted tests"

  IFS=' ' read -r PORT_API PORT_WEB PORT_MKTG <<< "$(find_free_ports 3)"

  export E2E_BASE_URL_API="http://localhost:$PORT_API"
  export E2E_BASE_URL_WEB="http://localhost:$PORT_WEB"
  export E2E_BASE_URL_MARKETING="http://localhost:$PORT_MKTG"
  export E2E_PORT_API="$PORT_API"
  export E2E_PORT_WEB="$PORT_WEB"
  export E2E_PORT_MKTG="$PORT_MKTG"
  export E2E_JSON_REPORT_PATH="$REPO_ROOT/e2e/test-results/report-hosted.json"

  info "Ports — API:$PORT_API  Web:$PORT_WEB  Marketing:$PORT_MKTG"

  mkdir -p "$REPO_ROOT/e2e/test-results"

  # Service logs — background processes must NOT inherit the script's stdout.
  # If stdout is piped (e.g. `pnpm test:e2e | tail`), inherited fds keep the
  # pipe open after Playwright exits and the shell appears to hang forever.
  LOGFILE_HOSTED_API="$REPO_ROOT/e2e/test-results/hosted-services-api.log"
  LOGFILE_HOSTED_WEB="$REPO_ROOT/e2e/test-results/hosted-services-web.log"
  LOGFILE_HOSTED_MKTG="$REPO_ROOT/e2e/test-results/hosted-services-marketing.log"
  : >"$LOGFILE_HOSTED_API"
  : >"$LOGFILE_HOSTED_WEB"
  : >"$LOGFILE_HOSTED_MKTG"

  # Start API
  info "Starting API on port $PORT_API …"
  PORT="$PORT_API" \
    SLUGBASE_E2E_MODE=true \
    PUBLIC_REGISTRATION=true \
    SESSION_SECRET='e2e-test-session-secret-at-least-32-chars!!' \
    ENCRYPTION_KEY='e2e-test-encryption-key-at-least-32-chars!!' \
    APP_BASE_URL="http://localhost:$PORT_API" \
    FRONTEND_ORIGIN="http://localhost:$PORT_WEB" \
    node packages/backend/dist/main.js >>"$LOGFILE_HOSTED_API" 2>&1 &
  API_PID=$!
  E2E_PIDS+=("$API_PID")

  # Start Web (react-router-serve)
  # API_BASE_URL must point at the backend so server-side loaders/actions can
  # reach it (login, session checks, workspace fetch, etc.).
  info "Starting Web on port $PORT_WEB …"
  (cd packages/web && PORT="$PORT_WEB" API_BASE_URL="http://localhost:$PORT_API" npx react-router-serve build/server/index.js) >>"$LOGFILE_HOSTED_WEB" 2>&1 &
  WEB_PID=$!
  E2E_PIDS+=("$WEB_PID")

  # Start Marketing (static serve)
  info "Starting Marketing on port $PORT_MKTG …"
  npx serve packages/marketing/dist -l "$PORT_MKTG" >>"$LOGFILE_HOSTED_MKTG" 2>&1 &
  MKTG_PID=$!
  E2E_PIDS+=("$MKTG_PID")

  # Wait for all three to be healthy
  info "Waiting for services …"
  for i in $(seq 1 30); do
    curl -sf "http://localhost:$PORT_API/health" >/dev/null 2>&1 && break
    sleep 2
  done
  for i in $(seq 1 30); do
    curl -sf "http://localhost:$PORT_WEB/health" >/dev/null 2>&1 && break
    sleep 2
  done
  for i in $(seq 1 15); do
    curl -sf "http://localhost:$PORT_MKTG/" >/dev/null 2>&1 && break
    sleep 2
  done

  ok "Services ready — API:$PORT_API Web:$PORT_WEB Marketing:$PORT_MKTG"

  # NOTE: Worker-scoped users are now registered by e2e/global-setup.ts
  # (via Playwright's globalSetup hook). No manual seed needed here.

  LOGFILE_HOSTED="$REPO_ROOT/e2e/test-results/hosted-output.log"

  # shellcheck disable=SC2068
  bash scripts/with-ci-env.sh npx playwright test \
    --config e2e/playwright.config.ts \
    --project=hosted \
    "$@" 2>&1 | tee "$LOGFILE_HOSTED" | sed 's/^/  /' || {
    fail "Hosted tests failed (exit code $?) — full log: $LOGFILE_HOSTED"
    EXIT_CODE=1
  }

  # Kill services — use process tree kill to clean up child processes too.
  # Subshells ( ) & and npx wrappers spawn child nodes that survive a plain kill.
  kill_e2e_pids

  # Unset hosted env vars so self-hosted phase doesn't inherit them
  unset E2E_BASE_URL_API E2E_BASE_URL_WEB E2E_BASE_URL_MARKETING \
        E2E_PORT_API E2E_PORT_WEB E2E_PORT_MKTG
fi

# ---------------------------------------------------------------------------
# 4. Run self-hosted tests (if selected)
#    Build combined Docker image, run container, test against it on random port
# ---------------------------------------------------------------------------
if [ "$RUN_SELF_HOSTED" = true ]; then
  header "Running self-hosted tests"

  read -r PORT_SELF <<< "$(find_free_ports 1)"
  export E2E_JSON_REPORT_PATH="$REPO_ROOT/e2e/test-results/report-self-hosted.json"

  info "Building combined Docker image …"
  DOCKER_BUILD_RAN=true
  docker build -t slugbase-e2e:self-hosted . 2>&1 | sed 's/^/  /'
  ok "Docker image built"

  info "Starting combined container on port $PORT_SELF …"
  docker run -d \
    --name slugbase-e2e-self \
    --network host \
    -e DATABASE_URL="$DATABASE_URL" \
    -e SLUGBASE_E2E_MODE=true \
    -e PORT="$PORT_SELF" \
    -e SESSION_SECRET='selfhosted-e2e-session-secret-at-least-32!!' \
    -e ENCRYPTION_KEY='selfhosted-e2e-encryption-key-at-least-32!!' \
    -e APP_BASE_URL="http://localhost:$PORT_SELF" \
    -e FRONTEND_ORIGIN="http://localhost:$PORT_SELF" \
    -e API_BASE_URL="http://localhost:$PORT_SELF" \
    -e PUBLIC_REGISTRATION=true \
    slugbase-e2e:self-hosted 2>&1 | sed 's/^/  /'
  ok "Container started"

  info "Waiting for health endpoint …"
  for i in $(seq 1 30); do
    curl -sf "http://localhost:$PORT_SELF/health" >/dev/null 2>&1 && break
    sleep 2
  done
  curl -sf "http://localhost:$PORT_SELF/health" >/dev/null 2>&1 || {
    fail "Container did not become healthy within 60s"
    EXIT_CODE=1
    # Mark that container is not healthy so we skip the test run
    HEALTHY=false
  }

  if [ "${HEALTHY:-true}" = true ]; then
    export E2E_BASE_URL_SELF_HOSTED="http://localhost:$PORT_SELF"

    LOGFILE_SELF="$REPO_ROOT/e2e/test-results/self-hosted-output.log"

    # shellcheck disable=SC2068
    bash scripts/with-ci-env.sh npx playwright test \
      --config e2e/playwright.config.ts \
      --project=self-hosted \
      "$@" 2>&1 | tee "$LOGFILE_SELF" | sed 's/^/  /' || {
      fail "Self-hosted tests failed (exit code $?) — full log: $LOGFILE_SELF"
      EXIT_CODE=1
    }
  else
    fail "Skipping self-hosted tests — container not healthy"
  fi
fi

# ---------------------------------------------------------------------------
# 5. Print test summary (parse JSON reports from both modes)
# ---------------------------------------------------------------------------
print_summary() {
  local mode="$1" file="$2"
  if [ ! -f "$file" ]; then
    echo "  $mode: no report (skipped or errored before tests ran)"
    return
  fi

  local total passed failed skipped
  total=$(python3 -c "import json; r=json.load(open('$file')); print(r['stats']['expected']+r['stats']['unexpected']+r['stats']['skipped'])" 2>/dev/null || echo "?")
  passed=$(python3 -c "import json; r=json.load(open('$file')); print(r['stats']['expected'])" 2>/dev/null || echo "?")
  failed=$(python3 -c "import json; r=json.load(open('$file')); print(r['stats']['unexpected'])" 2>/dev/null || echo "?")
  skipped=$(python3 -c "import json; r=json.load(open('$file')); print(r['stats']['skipped'])" 2>/dev/null || echo "?")

  # Format duration using Python (bash can't handle float arithmetic)
  local duration_str=""
  duration_str=$(python3 -c "
import json
r = json.load(open('$file'))
ms = r['stats']['duration']
s = int(ms / 1000)
m = s // 60
s = s % 60
print(f'{m}m{s}s')
" 2>/dev/null || echo "?")

  printf "  %-14s │ %5s │ %5s │ %5s │ %7s │ %s\n" "$mode" "$total" "$passed" "$failed" "$skipped" "$duration_str"
}

header "Test summary"
printf "  %-14s │ %5s │ %5s │ %5s │ %7s │ %s\n" "Mode" "Total" "Passed" "Failed" "Skipped" "Duration"
printf "  %s\n" "──────────────────────────────────────────────────────────────"
if [ "$RUN_HOSTED" = true ]; then
  print_summary "Hosted" "$REPO_ROOT/e2e/test-results/report-hosted.json"
fi
if [ "$RUN_SELF_HOSTED" = true ]; then
  print_summary "Self-hosted" "$REPO_ROOT/e2e/test-results/report-self-hosted.json"
fi

# All modes that were selected ran
if [ "$EXIT_CODE" -eq 0 ]; then
  ok "All tests passed"
else
  fail "Some tests failed — see above"
fi
exit "$EXIT_CODE"