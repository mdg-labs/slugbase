# Shared self-host Docker build-args (spec §14.2, §15).
# Edition presets derive VITE_* flags at web build time (#481).
# Sourced by CI GHCR publish (.github/scripts/build-push-ghcr.sh) and e2e self-host
# image builds. Values are not secrets — pass explicit --build-arg values only.
SELF_HOST_VITE_BUILD_ARGS=(
  --build-arg SLUGBASE_EDITION=ce
)
