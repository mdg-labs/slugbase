# Cloud web Docker build-args (spec §15).
# Edition presets derive VITE_* flags at web build time.
# Sourced by CI private-registry publish (build-push-registry.sh).
CLOUD_VITE_BUILD_ARGS=(
  --build-arg SLUGBASE_EDITION=cloud
)
