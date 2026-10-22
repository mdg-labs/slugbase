#!/usr/bin/env bash
# Runs a command in the Playwright image of e2e/Dockerfile (doc 08 section 6.1, 6.2),
# from e2e/, with the repository mounted at its own path so that the symlinks of
# node_modules resolve and what Playwright writes under e2e/ (test-results/,
# playwright-report/) lands on the host, owned by the caller:
#
#   bash e2e/with-stack.sh bash e2e/in-image.sh node run-tests.ts
#   bash e2e/in-image.sh --pull
#
# The container shares the network of the host, so the stack that with-stack.sh
# published on 127.0.0.1 is reachable there and the TLS proxy of the global setup is
# reachable from the host. The E2E_* variables and CI are handed on by name, so a
# value (the setup token) is never on a command line. The directories of the files
# named by E2E_TLS_KEY_FILE and E2E_TLS_CERT_FILE are mounted read-only at their own
# paths. Needs docker; the command and node_modules come from the checkout, only the
# browsers and their libraries from the image.
#
# --pull only pulls the image, so that a workflow shows the time of the pull apart
# from the time of the journeys.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"

fail() {
  printf 'in-image.sh: %s\n' "$*" >&2
  exit 1
}

# The image reference is the only FROM line of e2e/Dockerfile.
image_reference() {
  local line
  mapfile -t line < <(sed -n 's/^FROM[[:space:]][[:space:]]*//p' "$here/Dockerfile")
  if ((${#line[@]} != 1)) || [[ -z "${line[0]}" ]]; then
    fail "e2e/Dockerfile must have exactly one FROM line"
  fi
  printf '%s\n' "${line[0]}"
}

main() {
  local image name dir
  local -a args=() mounts=()
  command -v docker >/dev/null 2>&1 || fail "docker is required and was not found on PATH"
  image="$(image_reference)"

  if [[ "${1:-}" == "--pull" ]]; then
    (($# == 1)) || fail "usage: in-image.sh --pull | in-image.sh <command> [argument...]"
    exec docker pull "$image"
  fi
  (($# > 0)) || fail "usage: in-image.sh --pull | in-image.sh <command> [argument...]"

  args=(run --rm --init --network host --ipc=host --user "$(id -u):$(id -g)"
    --env HOME=/tmp --env CI --volume "$root:$root" --workdir "$root/e2e")
  for name in $(compgen -e | grep '^E2E_' || true); do
    args+=(--env "$name")
  done
  for name in E2E_TLS_KEY_FILE E2E_TLS_CERT_FILE; do
    if [[ -n "${!name:-}" ]]; then
      dir="$(dirname "${!name}")"
      [[ " ${mounts[*]-} " == *" $dir "* ]] || mounts+=("$dir")
    fi
  done
  for dir in ${mounts[@]+"${mounts[@]}"}; do
    args+=(--volume "$dir:$dir:ro")
  done
  exec docker "${args[@]}" "$image" "$@"
}

main "$@"
