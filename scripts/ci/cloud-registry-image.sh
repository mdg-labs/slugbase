#!/usr/bin/env bash
# Private registry image path for Cloud deploy surfaces.
# Example: REGISTRY=berth.mdg-labs.dev → berth.mdg-labs.dev/slugbase-cloud/api
set -euo pipefail

SERVICE="${1:?service required (api|web|marketing|admin)}"

case "$SERVICE" in
  api | web | marketing | admin) ;;
  *)
    echo "cloud-registry-image: invalid service '${SERVICE}'" >&2
    exit 1
    ;;
esac

: "${REGISTRY:?REGISTRY is required}"

printf '%s/slugbase-cloud/%s' "${REGISTRY%/}" "$SERVICE"
