#!/usr/bin/env bash
# Maps GHA storage keys to Fly/Worker runtime keys before deploy sync (spec §22.9).

map_sentry_storage_to_runtime() {
  local service="$1"

  case "$service" in
    api)
      if [[ -n "${SENTRY_DSN_API-}" ]]; then
        export SENTRY_DSN="${SENTRY_DSN_API}"
      fi
      ;;
    admin)
      if [[ -n "${SENTRY_DSN_ADMIN-}" ]]; then
        export SENTRY_DSN="${SENTRY_DSN_ADMIN}"
      fi
      ;;
    *)
      echo "map_sentry_storage_to_runtime: unknown service: ${service}" >&2
      return 1
      ;;
  esac
}
