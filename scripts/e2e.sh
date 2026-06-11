#!/usr/bin/env bash
# Full lifecycle for local Playwright e2e tests (spec §22.4).
#
# Spins up ephemeral Postgres on a random port, builds packages, runs
# Playwright, and tears everything down — including volumes and builder
# cache. Leaves zero containers, images, or volumes behind.
#
# Usage:
#   bash scripts/e2e.sh                          # hosted (default project)
#   bash scripts/e2e.sh --project=self-hosted      # self-hosted project
#   bash scripts/e2e.sh --debug                    # debug mode
#   bash scripts/e2e.sh specs/bookmarks/           # single spec dir
#   CI=1 bash scripts/e2e.sh                       # CI mode (2 retries, neeto reporter)
#
# Prerequisites (one-time):
#   npx playwright install --with-deps chromium
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE_FILE="$REPO_ROOT/docker-compose.e2e.yml"

# Colours for output readability
GREEN='\033[0;32m'
CYAN='\033[0;36m'
RED='\033[0;31m'
NC='\033[0m' # No Colour

ok()   { echo -e "${GREEN}✓${NC} $1"; }
info() { echo -e "${CYAN}→${NC} $1"; }
fail() { echo -e "${RED}✗${NC} $1"; }

# ---------------------------------------------------------------------------
# 1. Start ephemeral Postgres (random host port)
# ---------------------------------------------------------------------------
info "Starting ephemeral Postgres …"
docker compose -f "$COMPOSE_FILE" up -d --wait 2>&1 | sed 's/^/  /'

# Discover the random host port that Docker mapped to container 5432
PGPORT="$(docker compose -f "$COMPOSE_FILE" port postgres 5432 | cut -d: -f2)"
export DATABASE_URL="postgresql://slugbase:slugbase@localhost:$PGPORT/slugbase_e2e"
export SLUGBASE_E2E_MODE=true
ok "Postgres ready — $DATABASE_URL"

# ---------------------------------------------------------------------------
# Cleanup trap — guaranteed run on exit, INT, or TERM
# ---------------------------------------------------------------------------
cleanup() {
  local exit_code=$?
  echo ""
  info "Tearing down …"
  # Remove the compose stack (volumes + orphans)
  docker compose -f "$COMPOSE_FILE" down --volumes --remove-orphans 2>/dev/null || true
  # Prune builder cache (CI-style cleanup)
  docker builder prune --force 2>/dev/null || true
  if [ "$exit_code" -eq 0 ]; then
    ok "All clean — no containers, volumes, or build cache left"
  else
    fail "Cleanup finished (previous step had exit code $exit_code)"
  fi
  exit "$exit_code"
}
trap cleanup EXIT INT TERM

# ---------------------------------------------------------------------------
# 2. Build packages
# ---------------------------------------------------------------------------
info "Building packages …"
cd "$REPO_ROOT"
bash scripts/with-ci-env.sh pnpm build 2>&1 | sed 's/^/  /'
ok "Build complete"

# ---------------------------------------------------------------------------
# 3. Run Playwright
#    DATABASE_URL is inherited by webServer subprocesses automatically.
# ---------------------------------------------------------------------------
info "Running Playwright …"
cd "$REPO_ROOT"
# shellcheck disable=SC2068
bash scripts/with-ci-env.sh npx playwright test --config e2e/playwright.config.ts "$@"
ok "All tests passed"