#!/usr/bin/env bash
# Build and push Cloud container images to the private registry (Coolify deploy).
set -euo pipefail

TARGET=""
IMAGE=""
TAG=""
PUSH_DEV=false
PUSH_LATEST=false
EDITION="cloud"

usage() {
  cat <<'EOF' >&2
Usage: build-push-registry.sh --target api|web|marketing|admin <registry-image> <tag> [--dev] [--latest | --no-latest]

Cloud registry images use scripts/ci/cloud-registry-image.sh (e.g. berth.mdg-labs.dev/slugbase-cloud/api).
EOF
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target)
      TARGET="${2:-}"
      shift 2
      ;;
    --edition)
      EDITION="${2:-}"
      shift 2
      ;;
    --dev)
      PUSH_DEV=true
      shift
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

if [[ "$EDITION" != "cloud" ]]; then
  echo "build-push-registry: only cloud edition is supported (got ${EDITION})" >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

case "$TARGET" in
  api)
    DOCKERFILE="Dockerfile.api"
    BUILD_ARGS=(--build-arg "SLUGBASE_EDITION=${EDITION}")
    ;;
  web)
    DOCKERFILE="Dockerfile.web"
    # shellcheck source=scripts/cloud-vite-build-args.sh
    source "${REPO_ROOT}/scripts/cloud-vite-build-args.sh"
    BUILD_ARGS=("${CLOUD_VITE_BUILD_ARGS[@]}")
    ;;
  marketing)
    DOCKERFILE="Dockerfile.marketing"
    BUILD_ARGS=()
    if [[ -n "${PUBLIC_API_BASE_URL:-}" ]]; then
      BUILD_ARGS+=(--build-arg "PUBLIC_API_BASE_URL=${PUBLIC_API_BASE_URL}")
    fi
    if [[ -n "${PUBLIC_FRONTEND_ORIGIN:-}" ]]; then
      BUILD_ARGS+=(--build-arg "PUBLIC_FRONTEND_ORIGIN=${PUBLIC_FRONTEND_ORIGIN}")
    fi
    if [[ -n "${PUBLIC_MARKETING_ORIGIN:-}" ]]; then
      BUILD_ARGS+=(--build-arg "PUBLIC_MARKETING_ORIGIN=${PUBLIC_MARKETING_ORIGIN}")
    fi
    if [[ -n "${MARKETING_ORIGIN:-}" ]]; then
      BUILD_ARGS+=(--build-arg "MARKETING_ORIGIN=${MARKETING_ORIGIN}")
    fi
    ;;
  admin)
    DOCKERFILE="packages/admin/Dockerfile"
    BUILD_ARGS=()
    ;;
  *)
    echo "Unknown --target: ${TARGET} (expected api, web, marketing, or admin)" >&2
    exit 1
    ;;
esac

tags=(-t "${IMAGE}:${TAG}")
if [[ "${PUSH_DEV}" == "true" ]]; then
  tags+=(-t "${IMAGE}:dev")
fi
if [[ "${PUSH_LATEST}" == "true" ]]; then
  tags+=(-t "${IMAGE}:latest")
fi

echo "Building ${IMAGE}:${TAG} (target=${TARGET}; push_dev=${PUSH_DEV}; push_latest=${PUSH_LATEST})"
docker build \
  --provenance=false \
  "${BUILD_ARGS[@]}" \
  "${tags[@]}" \
  -f "${DOCKERFILE}" \
  .

docker push "${IMAGE}:${TAG}"
if [[ "${PUSH_DEV}" == "true" ]]; then
  docker push "${IMAGE}:dev"
fi
if [[ "${PUSH_LATEST}" == "true" ]]; then
  docker push "${IMAGE}:latest"
fi

echo "Pushed ${IMAGE}:${TAG}$([[ "${PUSH_DEV}" == "true" ]] && printf ' and %s:dev' "${IMAGE}")$([[ "${PUSH_LATEST}" == "true" ]] && printf ' and %s:latest' "${IMAGE}")"
