#!/usr/bin/env bash
# Build and push the combined self-host image to GHCR (spec §22.8).
set -euo pipefail

IMAGE="${1:?Usage: build-push-ghcr.sh <ghcr.io/owner/repo>}"
TAG="${2:?Usage: build-push-ghcr.sh <image> <tag>}"

build_args=()
while IFS='=' read -r key value; do
  [[ "${key}" == VITE_* ]] || continue
  build_args+=(--build-arg "${key}=${value}")
done < <(env | grep '^VITE_' | sort)

echo "Building ${IMAGE}:${TAG} (combined self-host image)"
docker build \
  "${build_args[@]}" \
  -t "${IMAGE}:${TAG}" \
  -t "${IMAGE}:latest" \
  -f Dockerfile \
  .

docker push "${IMAGE}:${TAG}"
docker push "${IMAGE}:latest"

echo "Pushed ${IMAGE}:${TAG} and ${IMAGE}:latest"
