#!/usr/bin/env bash
# Restore web + marketing Worker deploy artifacts (spec §22.5).
set -euo pipefail

ARCHIVE="${1:?Usage: unpack-staging-worker-artifacts.sh <archive.tar.gz>}"

tar -xzf "${ARCHIVE}"
