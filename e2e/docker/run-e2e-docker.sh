#!/usr/bin/env bash
# Build the production Docker image, run it with a fresh anonymous SQLite volume and random
# host port, seed the E2E user inside the app (SLUGBASE_E2E_SEED), run Playwright on the host,
# then remove container, volume, and the per-run image tag. Cleanup runs on EXIT/INT/TERM/HUP.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

if ! command -v docker >/dev/null 2>&1; then
  echo "e2e:docker requires Docker" >&2
  exit 1
fi

RUN_ID="$(openssl rand -hex 4)"
VOL_NAME="slugbase-e2e-db-${RUN_ID}"
CTR_NAME="slugbase-e2e-app-${RUN_ID}"
IMAGE_TAG="slugbase:e2e-${RUN_ID}"

pick_port() {
  if command -v python3 >/dev/null 2>&1; then
    python3 -c "import socket; s=socket.socket(); s.bind(('127.0.0.1',0)); print(s.getsockname()[1]); s.close()"
  else
    node -e "const n=require('net');const s=n.createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close();});"
  fi
}

HOST_PORT="${E2E_HOST_PORT:-$(pick_port)}"
BASE_URL="${PLAYWRIGHT_BASE_URL:-http://127.0.0.1:${HOST_PORT}}"

JWT_SECRET="${JWT_SECRET:-e2e-jwt-secret-at-least-32-characters-long}"
ENCRYPTION_KEY="${ENCRYPTION_KEY:-e2e-encryption-key-at-least-32-chars}"
SESSION_SECRET="${SESSION_SECRET:-e2e-session-secret-at-least-32-characters}"

cleanup() {
  set +e
  docker rm -f "$CTR_NAME" >/dev/null 2>&1
  docker volume rm "$VOL_NAME" >/dev/null 2>&1
  docker rmi "$IMAGE_TAG" >/dev/null 2>&1
  set -e
}

trap cleanup EXIT INT TERM HUP

echo "E2E Docker: run=${RUN_ID} container=${CTR_NAME} volume=${VOL_NAME} image=${IMAGE_TAG}"
echo "E2E Docker: host URL ${BASE_URL}"

docker build -t "$IMAGE_TAG" -f Dockerfile .

docker volume create "$VOL_NAME" >/dev/null

# Override image USER (nodejs): fresh volumes are root-owned; run as root for this disposable e2e container only.
docker run -d --name "$CTR_NAME" \
  --label "slugbase.e2e.run=${RUN_ID}" \
  --user root \
  -p "127.0.0.1:${HOST_PORT}:5000" \
  -v "${VOL_NAME}:/app/data" \
  -e NODE_ENV=production \
  -e PORT=5000 \
  -e DB_PATH=/app/data/slugbase.db \
  -e JWT_SECRET="$JWT_SECRET" \
  -e ENCRYPTION_KEY="$ENCRYPTION_KEY" \
  -e SESSION_SECRET="$SESSION_SECRET" \
  -e SLUGBASE_E2E_SEED=1 \
  -e FRONTEND_URL="$BASE_URL" \
  -e BASE_URL="$BASE_URL" \
  "$IMAGE_TAG"

for i in $(seq 1 90); do
  if curl -sf "${BASE_URL}/api/health" >/dev/null; then
    break
  fi
  if [ "$i" -eq 90 ]; then
    echo "Health check failed: ${BASE_URL}/api/health" >&2
    docker logs "$CTR_NAME" >&2 || true
    exit 1
  fi
  sleep 1
done

export PLAYWRIGHT_BASE_URL="$BASE_URL"
# Seeding happens in the container at startup; host Playwright has no DB file to seed.
unset E2E_DB_PATH

PLAYWRIGHT_CLI="${ROOT}/node_modules/.bin/playwright"
if [[ ! -x "$PLAYWRIGHT_CLI" ]]; then
  echo "e2e:docker: ${PLAYWRIGHT_CLI} missing (run npm ci)" >&2
  exit 1
fi

# Preserve Playwright exit code so CI fails correctly; EXIT trap still runs cleanup.
PW_EXIT=0
"$PLAYWRIGHT_CLI" test --config=e2e/playwright.config.ts "$@" || PW_EXIT=$?
exit "$PW_EXIT"
