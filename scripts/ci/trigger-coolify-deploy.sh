#!/usr/bin/env bash
# Trigger a Coolify deploy via webhook + Bearer token (deploy API).
set -euo pipefail

WEBHOOK_URL="${1:-}"
TOKEN="${2:-}"

if [[ -z "$WEBHOOK_URL" || -z "$TOKEN" ]]; then
  echo "Usage: trigger-coolify-deploy.sh <webhook-url> <bearer-token>" >&2
  exit 1
fi

echo "Triggering Coolify deploy: ${WEBHOOK_URL%%\?*}"

http_status="$(
  curl -fsS -o /tmp/slugbase-coolify-deploy-response.json -w '%{http_code}' \
    -X POST "$WEBHOOK_URL" \
    -H "Authorization: Bearer ${TOKEN}" \
    -H "Content-Type: application/json"
)"

if [[ "$http_status" -lt 200 || "$http_status" -ge 300 ]]; then
  echo "Coolify deploy webhook failed with HTTP ${http_status}" >&2
  cat /tmp/slugbase-coolify-deploy-response.json >&2 || true
  exit 1
fi

cat /tmp/slugbase-coolify-deploy-response.json
echo ""
echo "Coolify deploy triggered (HTTP ${http_status})"
