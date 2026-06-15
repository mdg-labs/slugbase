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

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=scripts/self-host-vite-build-args.sh
source "${REPO_ROOT}/scripts/self-host-vite-build-args.sh"

tags=(-t "${IMAGE}:${TAG}")
if [[ "${PUSH_LATEST}" == "true" ]]; then
  tags+=(-t "${IMAGE}:latest")
fi

echo "Building ${IMAGE}:${TAG} (combined self-host image; push_latest=${PUSH_LATEST})"
docker build \
  --provenance=false \
  "${SELF_HOST_VITE_BUILD_ARGS[@]}" \
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
