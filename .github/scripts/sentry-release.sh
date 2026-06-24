#!/usr/bin/env bash
# Create a Sentry release and upload Node service source maps. No-op when auth is absent.

set -euo pipefail

SERVICE="${1:-}"
SOURCE_DIR="${2:-}"
RELEASE="${3:-}"
ENVIRONMENT="${4:-}"

if [[ -z "$SERVICE" || -z "$SOURCE_DIR" || -z "$RELEASE" ]]; then
  echo "sentry-release: usage: sentry-release.sh <service> <source-dir> <release> [environment]" >&2
  exit 1
fi

if [[ -z "${SENTRY_AUTH_TOKEN:-}" || -z "${SENTRY_ORG:-}" ]]; then
  echo "sentry-release: skipping ${SERVICE} (SENTRY_AUTH_TOKEN or SENTRY_ORG not set)"
  exit 0
fi

PROJECT="slugbase-${SERVICE}"

if [[ ! -d "$SOURCE_DIR" ]]; then
  echo "sentry-release: source dir ${SOURCE_DIR} missing — skipping ${SERVICE}"
  exit 0
fi

MAP_COUNT="$(find "$SOURCE_DIR" -name '*.map' 2>/dev/null | wc -l | tr -d ' ')"
if [[ "$MAP_COUNT" -eq 0 ]]; then
  echo "sentry-release: no source maps in ${SOURCE_DIR} — skipping ${SERVICE}"
  exit 0
fi

npm install -g @sentry/cli@2

echo "sentry-release: uploading ${MAP_COUNT} source maps for ${SERVICE} (${PROJECT}) release ${RELEASE}"

sentry-cli releases new "$RELEASE" --org "$SENTRY_ORG" --project "$PROJECT" 2>/dev/null || true
sentry-cli releases set-commits "$RELEASE" --auto --org "$SENTRY_ORG" --ignore-missing 2>/dev/null || true
sentry-cli sourcemaps upload \
  --org "$SENTRY_ORG" \
  --project "$PROJECT" \
  --release "$RELEASE" \
  "$SOURCE_DIR"

if [[ -n "$ENVIRONMENT" ]]; then
  sentry-cli releases deploys "$RELEASE" new \
    --env "$ENVIRONMENT" \
    --org "$SENTRY_ORG" \
    --project "$PROJECT" 2>/dev/null || true
fi

sentry-cli releases finalize "$RELEASE" --org "$SENTRY_ORG" --project "$PROJECT" 2>/dev/null || true

echo "sentry-release: ${SERVICE} release ${RELEASE} complete"
