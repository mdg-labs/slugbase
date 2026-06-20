# Shared self-host VITE_* Docker build-args (spec §14.2, §15).
# Sourced by CI GHCR publish (.github/scripts/build-push-ghcr.sh) and e2e self-host
# image builds. Values are not secrets — pass explicit --build-arg values only.
SELF_HOST_VITE_BUILD_ARGS=(
  --build-arg VITE_BILLING_ENABLED=false
  --build-arg VITE_MAIL_ADMIN_UI=true
  --build-arg VITE_OIDC_ADMIN_UI=true
  --build-arg VITE_AI_BYO_CREDENTIAL=true
)
