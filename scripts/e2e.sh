#!/usr/bin/env bash
# CE Playwright e2e lifecycle (spec §22.4 — slugbase Community Edition).
#
# Spins up ephemeral Postgres, builds CE api + web Docker images, runs Playwright,
# and tears everything down — including volumes, containers, and builder cache.
#
# Usage:
#   bash scripts/e2e.sh                    # ce (default)
#   bash scripts/e2e.sh --project=ce       # ce only
#   bash scripts/e2e.sh specs/bookmarks/   # single spec dir
#   bash scripts/e2e.sh --list             # list tests (no infrastructure)
#
# Prerequisites (one-time):
#   npx playwright install --with-deps chromium
#
# shellcheck disable=SC2317,SC2312
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE_FILE="$REPO_ROOT/docker-compose.e2e.yml"

# Parse --project argument (ce-only; flag kept for parity with cloud repo wrapper)
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

case "$MODE" in
  ce|"") ;;
  *) echo "Unknown project: $MODE (slugbase CE e2e supports: ce)" >&2; exit 1 ;;
esac

# Fast path: list/help without Postgres or service startup
for arg in "$@"; do
  case "$arg" in
    --list|--help|-h)
      exec bash scripts/with-ci-env.sh npx playwright test \
        --config e2e/playwright.config.ts \
        --project=ce \
        "$@"
      ;;
  esac
done

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

CE_E2E_OPERATOR_ENV=(
  SMTP_HOST=localhost
  SMTP_PORT=1025
  SMTP_SECURE=false
  SMTP_FROM=e2e@slugbase.test
  OPENAI_API_KEY=sk-e2e-test-openai-key
  OPENAI_MODEL=gpt-4o-mini
  OIDC_e2e_CLIENT_ID=e2e-oidc-client-id
  OIDC_e2e_CLIENT_SECRET=e2e-oidc-client-secret
  OIDC_e2e_ISSUER_URL=https://idp.slugbase.test
  OIDC_e2e_NAME="E2E IdP"
)

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
            if port not in ports:
                ports.append(port)
                break
    else:
        print('find_free_ports: failed after 100 attempts', file=sys.stderr)
        sys.exit(1)
print(' '.join(str(p) for p in ports))
"
}

header "Starting ephemeral Postgres"
docker compose -f "$COMPOSE_FILE" up -d --wait --force-recreate 2>&1 | sed 's/^/  /'

PGPORT="$(docker compose -f "$COMPOSE_FILE" port postgres 5432 | cut -d: -f2)"
export DATABASE_URL="postgresql://slugbase:slugbase@localhost:$PGPORT/slugbase_e2e"
export SLUGBASE_E2E_MODE=true
ok "Postgres ready — port $PGPORT"

info "Running DB migrations …"
DATABASE_URL="$DATABASE_URL" \
  pnpm --filter @slugbase/backend db:migrate 2>&1 | sed 's/^/  /'
ok "Migrations applied"

EXIT_CODE=0
DOCKER_BUILD_RAN=false
cleanup() {
  local last_exit=$?
  [ "$last_exit" -ne 0 ] && [ "$EXIT_CODE" -eq 0 ] && EXIT_CODE=$last_exit
  echo ""
  header "Tearing down"
  docker stop slugbase-e2e-ce-api slugbase-e2e-ce-web 2>/dev/null || true
  docker rm slugbase-e2e-ce-api slugbase-e2e-ce-web 2>/dev/null || true
  docker compose -f "$COMPOSE_FILE" down --volumes --remove-orphans 2>/dev/null || true
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

info "Ensuring Playwright browsers …"
npx playwright install chromium 2>&1 | sed 's/^/  /'
ok "Playwright browsers ready"

header "Running CE tests"

IFS=' ' read -r PORT_CE_API PORT_CE_WEB <<< "$(find_free_ports 2)"
export E2E_JSON_REPORT_PATH="$REPO_ROOT/e2e/test-results/report-ce.json"

info "Building CE api image (Dockerfile.api, SLUGBASE_EDITION=ce) …"
DOCKER_BUILD_RAN=true
docker build -f Dockerfile.api -t slugbase-e2e:api \
  "${CE_DOCKER_BUILD_ARGS[@]}" \
  . 2>&1 | sed 's/^/  /'
ok "API image built"

info "Building CE web image (Dockerfile.web, SLUGBASE_EDITION=ce) …"
docker build -f Dockerfile.web -t slugbase-e2e:web \
  "${CE_DOCKER_BUILD_ARGS[@]}" \
  . 2>&1 | sed 's/^/  /'
ok "Web image built"

CE_E2E_DOCKER_ENV=()
for kv in "${CE_E2E_OPERATOR_ENV[@]}"; do
  CE_E2E_DOCKER_ENV+=(-e "$kv")
done

info "Starting API container on port $PORT_CE_API …"
docker run -d \
  --name slugbase-e2e-ce-api \
  --network host \
  -e NODE_ENV=development \
  -e DATABASE_URL="$DATABASE_URL" \
  -e SLUGBASE_E2E_MODE=true \
  -e SLUGBASE_EDITION=ce \
  -e SERVE_WEB_CLIENT=false \
  -e PORT="$PORT_CE_API" \
  -e SESSION_SECRET='ce-e2e-session-secret-at-least-32-chars-long!!' \
  -e ENCRYPTION_KEY='ce-e2e-encryption-key-at-least-32-chars-long!!' \
  -e APP_BASE_URL="http://localhost:$PORT_CE_API" \
  -e FRONTEND_ORIGIN="http://localhost:$PORT_CE_WEB" \
  -e PUBLIC_REGISTRATION=true \
  "${CE_E2E_DOCKER_ENV[@]}" \
  slugbase-e2e:api 2>&1 | sed 's/^/  /'
ok "API container started"

info "Starting web container on port $PORT_CE_WEB …"
docker run -d \
  --name slugbase-e2e-ce-web \
  --network host \
  -e NODE_ENV=development \
  -e PORT="$PORT_CE_WEB" \
  -e API_BASE_URL="http://localhost:$PORT_CE_API" \
  slugbase-e2e:web 2>&1 | sed 's/^/  /'
ok "Web container started"

info "Ports — API:$PORT_CE_API  Web:$PORT_CE_WEB"
info "Waiting for health endpoints …"
HEALTHY=true
for i in $(seq 1 30); do
  curl -sf "http://localhost:$PORT_CE_API/health" >/dev/null 2>&1 && break
  sleep 2
done
curl -sf "http://localhost:$PORT_CE_API/health" >/dev/null 2>&1 || {
  fail "API container did not become healthy within 60s"
  EXIT_CODE=1
  HEALTHY=false
}
if [ "$HEALTHY" = true ]; then
  for i in $(seq 1 30); do
    curl -sf "http://localhost:$PORT_CE_WEB/health" >/dev/null 2>&1 && break
    sleep 2
  done
  curl -sf "http://localhost:$PORT_CE_WEB/health" >/dev/null 2>&1 || {
    fail "Web container did not become healthy within 60s"
    EXIT_CODE=1
    HEALTHY=false
  }
fi

if [ "$HEALTHY" = true ]; then
  export E2E_CE_MODE=true
  export E2E_BASE_URL_API="http://localhost:$PORT_CE_API"
  export E2E_BASE_URL_WEB="http://localhost:$PORT_CE_WEB"

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
  fail "Skipping CE tests — containers not healthy"
fi

header "Test summary"
if [ -f "$REPO_ROOT/e2e/test-results/report-ce.json" ]; then
  python3 -c "
import json
r = json.load(open('$REPO_ROOT/e2e/test-results/report-ce.json'))
s = r['stats']
ms = s['duration']
sec = int(ms / 1000)
print(f\"  CE: {s['expected']+s['unexpected']+s['skipped']} total, {s['expected']} passed, {s['unexpected']} failed, {s['skipped']} skipped ({sec//60}m{sec%60}s)\")
" 2>/dev/null || echo "  CE: report parse failed"
else
  echo "  CE: no report"
fi

if [ "$EXIT_CODE" -eq 0 ]; then
  ok "All tests passed"
else
  fail "Some tests failed — see above"
fi
exit "$EXIT_CODE"
