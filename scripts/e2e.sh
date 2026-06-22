#!/usr/bin/env bash
# Full lifecycle for local Playwright e2e tests (spec §22.4).
#
# Spins up ephemeral Postgres on a random port, runs Playwright for one or
# both deployment editions, and tears everything down — including volumes,
# containers, and builder cache. Leaves zero artifacts behind.
#
# Usage:
#   bash scripts/e2e.sh                              # cloud + ce (default)
#   bash scripts/e2e.sh --project=cloud              # cloud only
#   bash scripts/e2e.sh --project=ce               # ce only
#   bash scripts/e2e.sh specs/bookmarks/           # cloud + ce, single spec dir
#   bash scripts/e2e.sh --debug                    # cloud + ce, debug mode
#
# Build paths (spec §15 — edition presets set VITE_* at build time; one bundle per edition):
#   Cloud:  SLUGBASE_EDITION=cloud before pnpm build
#   CE:     SLUGBASE_EDITION=ce via Docker build-arg (scripts/self-host-vite-build-args.sh)
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

# Determine which editions to run
RUN_CLOUD=false
RUN_CE=false
case "$MODE" in
  cloud) RUN_CLOUD=true ;;
  ce)    RUN_CE=true ;;
  "")    RUN_CLOUD=true; RUN_CE=true ;;
  *)     echo "Unknown project: $MODE (expected: cloud, ce)" >&2; exit 1 ;;
esac

# Colours
GREEN='\033[0;32m'; CYAN='\033[0;36m'; YELLOW='\033[0;33m'; RED='\033[0;31m'; NC='\033[0m'
ok()    { echo -e "${GREEN}✓${NC} $1"; }
info()  { echo -e "${CYAN}→${NC} $1"; }
warn()  { echo -e "${YELLOW}⚠${NC} $1"; }
fail()  { echo -e "${RED}✗${NC} $1"; }
header(){ echo -e "\n${CYAN}═══════════════════════════════════════════${NC}"; echo -e "${CYAN}  $1${NC}"; echo -e "${CYAN}═══════════════════════════════════════════${NC}"; }

# CE Docker image build args (spec §15 — docs/internal/environment-variables.md)
# shellcheck source=scripts/self-host-vite-build-args.sh
source "${REPO_ROOT}/scripts/self-host-vite-build-args.sh"
CE_DOCKER_BUILD_ARGS=("${SELF_HOST_VITE_BUILD_ARGS[@]}")

# Cloud web bundle: cloud edition presets (billing on, admin UI panels off).
# Args: marketing origin for VITE_MARKETING_ORIGIN; API base for marketing PUBLIC_API_BASE_URL.
build_cloud_packages() {
  local marketing_origin="${1:-}"
  local api_base_url="${2:-}"
  header "Building cloud packages"
  cd "$REPO_ROOT"
  info "SLUGBASE_EDITION=cloud"
  local -a build_env=(SLUGBASE_EDITION=cloud)
  if [ -n "$marketing_origin" ]; then
    info "VITE_MARKETING_ORIGIN=$marketing_origin"
    build_env+=(VITE_MARKETING_ORIGIN="$marketing_origin")
  fi
  if [ -n "$api_base_url" ]; then
    info "PUBLIC_API_BASE_URL=$api_base_url"
    build_env+=(PUBLIC_API_BASE_URL="$api_base_url")
  fi
  "${build_env[@]}" bash scripts/with-ci-env.sh pnpm build 2>&1 | sed 's/^/  /'
  ok "Cloud build complete"
}

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
  docker stop slugbase-e2e-ce 2>/dev/null || true
  docker rm slugbase-e2e-ce 2>/dev/null || true
  docker compose -f "$COMPOSE_FILE" down --volumes --remove-orphans 2>/dev/null || true
  # Only prune the Docker build cache when the CE image was actually built in
  # this run. Pruning unconditionally adds 60-120s of wall time on cloud-only
  # runs (no Docker build) because the stale cache from previous runs can be
  # 1 GB+, causing the script to appear to hang after test completion.
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

# ---------------------------------------------------------------------------
# 3. Run cloud tests (if selected)
#    Playwright webServer starts API, web, marketing on random ports
# ---------------------------------------------------------------------------
if [ "$RUN_CLOUD" = true ]; then
  header "Running cloud tests"

  IFS=' ' read -r PORT_API PORT_WEB PORT_MKTG <<< "$(find_free_ports 3)"

  build_cloud_packages "http://localhost:$PORT_MKTG" "http://localhost:$PORT_API"

  export E2E_BASE_URL_API="http://localhost:$PORT_API"
  export E2E_BASE_URL_WEB="http://localhost:$PORT_WEB"
  export E2E_BASE_URL_MARKETING="http://localhost:$PORT_MKTG"
  export E2E_PORT_API="$PORT_API"
  export E2E_PORT_WEB="$PORT_WEB"
  export E2E_PORT_MKTG="$PORT_MKTG"
  export E2E_JSON_REPORT_PATH="$REPO_ROOT/e2e/test-results/report-cloud.json"

  info "Ports — API:$PORT_API  Web:$PORT_WEB  Marketing:$PORT_MKTG"

  mkdir -p "$REPO_ROOT/e2e/test-results"

  # Service logs — background processes must NOT inherit the script's stdout.
  # If stdout is piped (e.g. `pnpm test:e2e | tail`), inherited fds keep the
  # pipe open after Playwright exits and the shell appears to hang forever.
  LOGFILE_CLOUD_API="$REPO_ROOT/e2e/test-results/cloud-services-api.log"
  LOGFILE_CLOUD_WEB="$REPO_ROOT/e2e/test-results/cloud-services-web.log"
  LOGFILE_CLOUD_MKTG="$REPO_ROOT/e2e/test-results/cloud-services-marketing.log"
  : >"$LOGFILE_CLOUD_API"
  : >"$LOGFILE_CLOUD_WEB"
  : >"$LOGFILE_CLOUD_MKTG"

  # Start API
  # Cloud edition preset sets EMAIL_VERIFICATION_REQUIRED=true; e2e global-setup
  # registers users without verification — override after SLUGBASE_EDITION=cloud.
  info "Starting API on port $PORT_API …"
  PORT="$PORT_API" \
    SLUGBASE_E2E_MODE=true \
    SLUGBASE_EDITION=cloud \
    PUBLIC_REGISTRATION=true \
    EMAIL_VERIFICATION_REQUIRED=false \
    SESSION_SECRET='e2e-test-session-secret-at-least-32-chars!!' \
    ENCRYPTION_KEY='e2e-test-encryption-key-at-least-32-chars!!' \
    APP_BASE_URL="http://localhost:$PORT_API" \
    FRONTEND_ORIGIN="http://localhost:$PORT_WEB" \
    MARKETING_ORIGIN="http://localhost:$PORT_MKTG" \
    node packages/backend/dist/main.js >>"$LOGFILE_CLOUD_API" 2>&1 &
  API_PID=$!
  E2E_PIDS+=("$API_PID")

  # Start Web (react-router-serve)
  # API_BASE_URL must point at the backend so server-side loaders/actions can
  # reach it (login, session checks, workspace fetch, etc.).
  info "Starting Web on port $PORT_WEB …"
  (cd packages/web && PORT="$PORT_WEB" API_BASE_URL="http://localhost:$PORT_API" npx react-router-serve build/server/index.js) >>"$LOGFILE_CLOUD_WEB" 2>&1 &
  WEB_PID=$!
  E2E_PIDS+=("$WEB_PID")

  # Start Marketing (static serve)
  info "Starting Marketing on port $PORT_MKTG …"
  npx serve packages/marketing/dist -l "$PORT_MKTG" >>"$LOGFILE_CLOUD_MKTG" 2>&1 &
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

  LOGFILE_CLOUD="$REPO_ROOT/e2e/test-results/cloud-output.log"

  # shellcheck disable=SC2068
  bash scripts/with-ci-env.sh npx playwright test \
    --config e2e/playwright.config.ts \
    --project=cloud \
    "$@" 2>&1 | tee "$LOGFILE_CLOUD" | sed 's/^/  /' || {
    fail "Cloud tests failed (exit code $?) — full log: $LOGFILE_CLOUD"
    EXIT_CODE=1
  }

  # Kill services — use process tree kill to clean up child processes too.
  # Subshells ( ) & and npx wrappers spawn child nodes that survive a plain kill.
  kill_e2e_pids

  # Unset cloud env vars so CE phase doesn't inherit them
  unset E2E_BASE_URL_API E2E_BASE_URL_WEB E2E_BASE_URL_MARKETING \
        E2E_PORT_API E2E_PORT_WEB E2E_PORT_MKTG
fi

# ---------------------------------------------------------------------------
# 4. Run CE tests (if selected)
#    Build combined Docker image, run container, test against it on random port
# ---------------------------------------------------------------------------
if [ "$RUN_CE" = true ]; then
  header "Running CE tests"

  read -r PORT_CE <<< "$(find_free_ports 1)"
  export E2E_JSON_REPORT_PATH="$REPO_ROOT/e2e/test-results/report-ce.json"

  info "Building combined Docker image (SLUGBASE_EDITION=ce) …"
  DOCKER_BUILD_RAN=true
  docker build -t slugbase-e2e:ce \
    "${CE_DOCKER_BUILD_ARGS[@]}" \
    . 2>&1 | sed 's/^/  /'
  ok "Docker image built"

  info "Starting combined container on port $PORT_CE …"
  # CE prod default is PUBLIC_REGISTRATION=false (invite-only). E2e overrides
  # to true so global-setup can register per-worker accounts via /auth/register —
  # no invite flow in this harness (see e2e/global-setup.ts).
  docker run -d \
    --name slugbase-e2e-ce \
    --network host \
    -e DATABASE_URL="$DATABASE_URL" \
    -e SLUGBASE_E2E_MODE=true \
    -e SLUGBASE_EDITION=ce \
    -e PORT="$PORT_CE" \
    -e SESSION_SECRET='ce-e2e-session-secret-at-least-32-chars-long!!' \
    -e ENCRYPTION_KEY='ce-e2e-encryption-key-at-least-32-chars-long!!' \
    -e APP_BASE_URL="http://localhost:$PORT_CE" \
    -e FRONTEND_ORIGIN="http://localhost:$PORT_CE" \
    -e API_BASE_URL="http://localhost:$PORT_CE" \
    -e PUBLIC_REGISTRATION=true \
    slugbase-e2e:ce 2>&1 | sed 's/^/  /'
  ok "Container started"

  info "Waiting for health endpoint …"
  for i in $(seq 1 30); do
    curl -sf "http://localhost:$PORT_CE/health" >/dev/null 2>&1 && break
    sleep 2
  done
  curl -sf "http://localhost:$PORT_CE/health" >/dev/null 2>&1 || {
    fail "Container did not become healthy within 60s"
    EXIT_CODE=1
    # Mark that container is not healthy so we skip the test run
    HEALTHY=false
  }

  if [ "${HEALTHY:-true}" = true ]; then
    export E2E_BASE_URL_CE="http://localhost:$PORT_CE"

    LOGFILE_CE="$REPO_ROOT/e2e/test-results/ce-output.log"

    # shellcheck disable=SC2068
    bash scripts/with-ci-env.sh npx playwright test \
      --config e2e/playwright.config.ts \
      --project=ce \
      "$@" 2>&1 | tee "$LOGFILE_CE" | sed 's/^/  /' || {
      fail "CE tests failed (exit code $?) — full log: $LOGFILE_CE"
      EXIT_CODE=1
    }
  else
    fail "Skipping CE tests — container not healthy"
  fi
fi

# ---------------------------------------------------------------------------
# 5. Print test summary (parse JSON reports from both editions)
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
printf "  %-14s │ %5s │ %5s │ %5s │ %7s │ %s\n" "Edition" "Total" "Passed" "Failed" "Skipped" "Duration"
printf "  %s\n" "──────────────────────────────────────────────────────────────"
if [ "$RUN_CLOUD" = true ]; then
  print_summary "Cloud" "$REPO_ROOT/e2e/test-results/report-cloud.json"
fi
if [ "$RUN_CE" = true ]; then
  print_summary "CE" "$REPO_ROOT/e2e/test-results/report-ce.json"
fi

# All editions that were selected ran
if [ "$EXIT_CODE" -eq 0 ]; then
  ok "All tests passed"
else
  fail "Some tests failed — see above"
fi
exit "$EXIT_CODE"
