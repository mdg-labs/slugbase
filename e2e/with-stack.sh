#!/usr/bin/env bash
# Starts the Community Edition stack of compose.yml from an image, runs a command
# against it, and tears the stack down on every way out (doc 08 section 5.1, 6.2):
#
#   bash e2e/with-stack.sh pnpm test:e2e
#   bash e2e/with-stack.sh pnpm test:e2e -- --grep "home"
#
# The stack is the one scripts/smoke-image.sh starts, through its start_stack
# function: a compose project of its own, a free port on 127.0.0.1, secrets that
# are generated into a private temporary directory and never printed, and the same
# cleanup, which removes the project, its volume and a built image. The command
# runs with E2E_BASE_URL set to the address of the server, from the repository
# root, and its exit status is the exit status of this script.
#
# Environment (read by smoke-image.sh):
#   SLUGBASE_IMAGE  An image that is already present locally. Unset, the image is
#                   built from this checkout.
#   BUILD_COMMIT    The commit the image was built from.
#
# Without this script, start a stack yourself and set E2E_BASE_URL to its address.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/smoke-image.sh
source "$here/../scripts/smoke-image.sh"

main_e2e() {
  local code=0
  (($# > 0)) || fail "usage: with-stack.sh <command> [argument...]"
  start_stack
  E2E_BASE_URL="http://127.0.0.1:${port}" "$@" || code=$?
  # The cleanup trap tears the stack down and keeps this status.
  exit "$code"
}

main_e2e "$@"
