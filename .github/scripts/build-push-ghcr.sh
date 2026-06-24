#!/usr/bin/env bash
# Build and push split CE images to GHCR (spec §22.8).
set -euo pipefail

TARGET=""
IMAGE=""
TAG=""
PUSH_LATEST=false

usage() {
  cat <<'EOF' >&2
Usage: build-push-ghcr.sh --target api|web <ghcr-image> <tag> [--latest | --no-latest]
EOF
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target)
      TARGET="${2:-}"
      shift 2
      ;;
    --latest)
      PUSH_LATEST=true
      shift
      ;;
    --no-latest)
      PUSH_LATEST=false
      shift
      ;;
    -h | --help)
      usage
      ;;
    *)
      if [[ -z "$IMAGE" ]]; then
        IMAGE="$1"
      elif [[ -z "$TAG" ]]; then
        TAG="$1"
      else
        echo "Unexpected argument: $1" >&2
        usage
      fi
      shift
      ;;
  esac
done

if [[ -z "$TARGET" || -z "$IMAGE" || -z "$TAG" ]]; then
  usage
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

case "$TARGET" in
  api)
    DOCKERFILE="Dockerfile.api"
    BUILD_ARGS=(--build-arg SLUGBASE_EDITION=ce)
    ;;
  web)
    DOCKERFILE="Dockerfile.web"
    # shellcheck source=scripts/self-host-vite-build-args.sh
    source "${REPO_ROOT}/scripts/self-host-vite-build-args.sh"
    BUILD_ARGS=("${SELF_HOST_VITE_BUILD_ARGS[@]}")
    ;;
  *)
    echo "Unknown --target: ${TARGET} (expected api or web)" >&2
    exit 1
    ;;
esac

tags=(-t "${IMAGE}:${TAG}")
if [[ "${PUSH_LATEST}" == "true" ]]; then
  tags+=(-t "${IMAGE}:latest")
fi

echo "Building ${IMAGE}:${TAG} (target=${TARGET}; push_latest=${PUSH_LATEST})"
docker build \
  --provenance=false \
  "${BUILD_ARGS[@]}" \
  "${tags[@]}" \
  -f "${DOCKERFILE}" \
  .

docker push "${IMAGE}:${TAG}"
if [[ "${PUSH_LATEST}" == "true" ]]; then
  docker push "${IMAGE}:latest"
  echo "Pushed ${IMAGE}:${TAG} and ${IMAGE}:latest"
else
  echo "Pushed ${IMAGE}:${TAG}"
fi
