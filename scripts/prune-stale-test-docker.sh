#!/usr/bin/env bash
# Remove orphaned SlugBase ephemeral test Postgres containers/volumes/networks.
# Safe to run before each integration test run (e.g. after kill -9 aborted a prior run).

set -euo pipefail

if ! command -v docker >/dev/null 2>&1; then
  exit 0
fi

# Containers from prior ephemeral test runs
if ids="$(docker ps -aq --filter "label=slugbase.test.ephemeral=integration" 2>/dev/null)"; then
  if [[ -n "${ids}" ]]; then
    # shellcheck disable=SC2086
    docker rm -f ${ids} >/dev/null 2>&1 || true
  fi
fi

# Named volumes created by the test runner (slugbase-test-pg-<hex>)
while IFS= read -r vol; do
  [[ -z "${vol}" ]] && continue
  docker volume rm "${vol}" >/dev/null 2>&1 || true
done < <(docker volume ls -q --filter "name=slugbase-test-pg-" 2>/dev/null || true)

# Compose projects left behind (slugbase-test-<hex>)
if command -v docker >/dev/null 2>&1 && docker compose ls --format json >/dev/null 2>&1; then
  while IFS= read -r project; do
    [[ -z "${project}" ]] && continue
    docker compose -p "${project}" down -v --remove-orphans --timeout 5 >/dev/null 2>&1 || true
  done < <(
    docker compose ls --format '{{.Name}}' 2>/dev/null \
      | grep -E '^slugbase-test-[0-9a-f]+$' \
      || true
  )
fi
