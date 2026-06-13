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

build_args=()
while IFS='=' read -r key value; do
  [[ "${key}" == VITE_* ]] || continue
  build_args+=(--build-arg "${key}=${value}")
done < <(env | grep '^VITE_' | sort)

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
