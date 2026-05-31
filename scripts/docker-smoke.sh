#!/usr/bin/env bash
# Smoke-test a SlugBase container image: GET /health and /version (P1-10)
set -euo pipefail

IMAGE="${1:?Usage: docker-smoke.sh <image> [extra docker run args...]}"
shift || true

CONTAINER="slugbase-smoke-$$"
VOLUME="slugbase-smoke-data-$$"
SESSION_SECRET="$(openssl rand -hex 32)"
ENCRYPTION_KEY="$(openssl rand -hex 32)"
HOST_PORT="${SMOKE_HOST_PORT:-3000}"

cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  docker volume rm "$VOLUME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker volume create "$VOLUME" >/dev/null

docker run -d --name "$CONTAINER" \
  -e NODE_ENV=production \
  -e SESSION_SECRET="$SESSION_SECRET" \
  -e ENCRYPTION_KEY="$ENCRYPTION_KEY" \
  -e DATABASE_URL=sqlite:///data/slugbase.db \
  -e APP_BASE_URL="http://127.0.0.1:${HOST_PORT}" \
  -e FRONTEND_ORIGIN="http://127.0.0.1:${HOST_PORT}" \
  -e PORT=3000 \
  -v "${VOLUME}:/data" \
  -p "${HOST_PORT}:3000" \
  "$@" \
  "$IMAGE" >/dev/null

echo "Waiting for ${IMAGE} on port ${HOST_PORT}..."
for _ in $(seq 1 60); do
  if curl -sf "http://127.0.0.1:${HOST_PORT}/health" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

health_status="$(curl -s -o /tmp/slugbase-health.json -w '%{http_code}' "http://127.0.0.1:${HOST_PORT}/health")"
version_status="$(curl -s -o /tmp/slugbase-version.json -w '%{http_code}' "http://127.0.0.1:${HOST_PORT}/version")"

echo "GET /health -> HTTP ${health_status}"
cat /tmp/slugbase-health.json
echo ""
echo "GET /version -> HTTP ${version_status}"
cat /tmp/slugbase-version.json
echo ""

if [[ "$health_status" != "200" || "$version_status" != "200" ]]; then
  echo "Smoke failed" >&2
  docker logs "$CONTAINER" >&2 || true
  exit 1
fi

echo "Smoke passed"
