#!/usr/bin/env bash
# Back-compat wrapper — prefer deploy-fly.sh with FLY_APP set (spec §22.5).
set -euo pipefail

app="${1:?Usage: fly-deploy.sh <fly-app-name>}"
export FLY_APP="${app}"
exec bash "$(cd "$(dirname "$0")" && pwd)/deploy-fly.sh" api
