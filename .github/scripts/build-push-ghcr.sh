#!/usr/bin/env bash
# Build and push the combined self-host image to GHCR (spec §22.8).
set -euo pipefail

IMAGE="${1:?Usage: build-push-ghcr.sh <ghcr.io/owner/repo> <tag> [--no-latest]}"
TAG="${2:?Usage: build-push-ghcr.sh <ghcr.io/owner/repo> <tag> [--no-latest]}"
shift 2

PUSH_LATEST=true
while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-latest)
      PUSH_LATEST=false
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
  shift
done

# Self-host image: only pass VITE_* keys safe to bake into the combined bundle (spec §14.2).
# Never pass VITE_SENTRY_* — CI Infisical env includes hosted telemetry for Worker builds.
SELF_HOST_VITE_BUILD_ARGS=(
  VITE_BILLING_ENABLED
  VITE_PLAN_PRICE_PERSONAL_MONTHLY
  VITE_PLAN_PRICE_PERSONAL_YEARLY
  VITE_PLAN_PRICE_TEAM_SEAT
  VITE_PLAN_PRICE_SUPPORTER
  VITE_SUPPORTER_PROMOTION_END
  VITE_TEAM_BASE_SEATS
  VITE_FREE_BOOKMARK_CAP
  VITE_MAIL_ADMIN_UI
  VITE_OIDC_ADMIN_UI
  VITE_AI_BYO_CREDENTIAL
  VITE_APP_BASE_URL
  VITE_UMAMI_HOST
  VITE_UMAMI_WEBSITE_ID
)

build_args=()
for key in "${SELF_HOST_VITE_BUILD_ARGS[@]}"; do
  if [[ -n "${!key-}" ]]; then
    build_args+=(--build-arg "${key}=${!key}")
  fi
done

tags=(-t "${IMAGE}:${TAG}")
if [[ "${PUSH_LATEST}" == "true" ]]; then
  tags+=(-t "${IMAGE}:latest")
fi

echo "Building ${IMAGE}:${TAG} (combined self-host image; push_latest=${PUSH_LATEST})"
docker build \
  --provenance=false \
  "${build_args[@]}" \
  "${tags[@]}" \
  -f Dockerfile \
  .

docker push "${IMAGE}:${TAG}"
if [[ "${PUSH_LATEST}" == "true" ]]; then
  docker push "${IMAGE}:latest"
  echo "Pushed ${IMAGE}:${TAG} and ${IMAGE}:latest"
else
  echo "Pushed ${IMAGE}:${TAG}"
fi
