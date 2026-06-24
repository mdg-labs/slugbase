#!/usr/bin/env bash
# Derive a per-package Sentry release identifier (granular-deployment WP-9).

set -euo pipefail

PACKAGE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --package)
      PACKAGE="${2:?derive-sentry-release: --package requires a value}"
      shift 2
      ;;
    -h | --help)
      echo "usage: derive-sentry-release.sh --package <api|web>" >&2
      exit 0
      ;;
    *)
      echo "derive-sentry-release: unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

if [[ -z "$PACKAGE" ]]; then
  echo "derive-sentry-release: --package is required (api|web)" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

case "$PACKAGE" in
  api)
    PKG_DIR="packages/backend"
  ;;
  web)
    PKG_DIR="packages/web"
  ;;
  *)
    echo "derive-sentry-release: unsupported package: ${PACKAGE} (expected api|web)" >&2
    exit 1
    ;;
esac

if [[ ! -f "${PKG_DIR}/package.json" ]]; then
  echo "derive-sentry-release: missing ${PKG_DIR}/package.json" >&2
  exit 1
fi

VERSION="$(node -p "require('./${PKG_DIR}/package.json').version")"
GIT_SHA="${GIT_SHA:-$(git rev-parse HEAD)}"

RELEASE="$(node --input-type=module -e "
import { deriveSentryRelease } from './scripts/derive-sentry-release.mjs';
console.log(deriveSentryRelease({
  packageName: '${PACKAGE}',
  packageVersion: '${VERSION}',
  gitSha: '${GIT_SHA}',
}));
")"

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  echo "release=${RELEASE}" >> "$GITHUB_OUTPUT"
fi

echo "derive-sentry-release: ${RELEASE}"
