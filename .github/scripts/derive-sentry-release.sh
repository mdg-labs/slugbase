#!/usr/bin/env bash
# Derive a Sentry release identifier from package version (and optional release tag).

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

if [[ -n "${RELEASE_VERSION:-}" ]]; then
  VERSION="${RELEASE_VERSION#v}"
else
  VERSION="$(node -p "require('./package.json').version")"
fi

RELEASE="slugbase@${VERSION}"

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  echo "release=${RELEASE}" >> "$GITHUB_OUTPUT"
fi

echo "derive-sentry-release: ${RELEASE}"
