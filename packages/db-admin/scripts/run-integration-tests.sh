#!/usr/bin/env bash
# Run db-admin integration tests against ephemeral Postgres (local dev),
# or pass through when DATABASE_URL is already set (CI / explicit override).

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
COMPOSE_FILE="${ROOT_DIR}/test.docker-compose.yml"
PACKAGE_DIR="${ROOT_DIR}/packages/db-admin"
PRUNE_SCRIPT="${ROOT_DIR}/scripts/prune-stale-test-docker.sh"

COMPOSE_PROJECT=""
TEST_PG_VOLUME_NAME=""
cleanup_done=0

run_vitest() {
  cd "${PACKAGE_DIR}"
  pnpm exec vitest run --config vitest.integration.config.ts --maxWorkers=1
}

cleanup() {
  if [[ "${cleanup_done}" -eq 1 ]]; then
    return 0
  fi
  cleanup_done=1

  if [[ -n "${COMPOSE_PROJECT}" ]]; then
    docker compose \
      -f "${COMPOSE_FILE}" \
      -p "${COMPOSE_PROJECT}" \
      down -v --remove-orphans --timeout 10 \
      >/dev/null 2>&1 || true
  fi

  if [[ -n "${TEST_PG_VOLUME_NAME}" ]]; then
    docker volume rm "${TEST_PG_VOLUME_NAME}" >/dev/null 2>&1 || true
  fi
}

trap 'cleanup' EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM
trap 'cleanup; exit 129' HUP

if [[ -n "${DATABASE_URL:-}" && "${SLUGBASE_INTEGRATION_NO_DOCKER:-}" == "1" ]]; then
  echo "DATABASE_URL is set and SLUGBASE_INTEGRATION_NO_DOCKER=1 — skipping ephemeral Docker Postgres (CI mode)."
  run_vitest
  exit 0
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "error: docker is required for local integration tests when DATABASE_URL is unset." >&2
  exit 1
fi

bash "${PRUNE_SCRIPT}"

RUN_ID="$(openssl rand -hex 8)"
COMPOSE_PROJECT="slugbase-db-admin-test-${RUN_ID}"
TEST_PG_VOLUME_NAME="slugbase-db-admin-test-pg-${RUN_ID}"

TEST_PG_HOST_PORT="$(
  node -e "
    const net = require('net');
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      console.log(port);
      server.close();
    });
  "
)"

export TEST_PG_HOST_PORT TEST_PG_VOLUME_NAME

echo "Starting ephemeral Postgres (project=${COMPOSE_PROJECT}, port=${TEST_PG_HOST_PORT})…"

docker compose \
  -f "${COMPOSE_FILE}" \
  -p "${COMPOSE_PROJECT}" \
  up -d --wait

export DATABASE_URL="postgresql://slugbase:slugbase@127.0.0.1:${TEST_PG_HOST_PORT}/slugbase_test"

echo "DATABASE_URL=${DATABASE_URL}"
run_vitest
