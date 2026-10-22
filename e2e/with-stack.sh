#!/usr/bin/env bash
# Starts the Community Edition stack of compose.yml from an image, runs a command
# against it, and tears the stack down on every way out (doc 08 section 5.1, 6.2):
#
#   bash e2e/with-stack.sh pnpm test:e2e
#   bash e2e/with-stack.sh pnpm test:e2e -- --grep "home"
#   bash e2e/with-stack.sh bash e2e/in-image.sh node run-tests.ts
#
# The first two run the journeys on the host with the browsers installed there; the
# last runs them in the pinned Playwright image of e2e/Dockerfile on the host's
# network (e2e/in-image.sh), which is what CI does and needs no browser on the host.
#
# The stack is the one scripts/smoke-image.sh starts, through its start_stack
# function: a compose project of its own, a free port on 127.0.0.1, secrets that
# are generated into a private temporary directory and never printed, and the same
# cleanup, which removes the project, its volume and a built image. The command
# runs with E2E_BASE_URL set to the address of the server, from the repository
# root, and its exit status is the exit status of this script.
#
# The stack also has a Mailpit (compose.e2e.yml, merged over compose.yml), which the
# server and the worker send their mail through; the command gets the address of its
# HTTP API as E2E_MAILPIT_URL, to read the mail a journey caused.
#
# A browser can sign in only at the origin the server is configured with: the
# session cookie is Secure and a mutation must come from APP_ORIGIN, which production
# requires to be https. The stack is therefore configured with an https origin on a
# port of its own, 127.0.0.1:<tls port>, and the command is given what its global
# setup (e2e/global-setup.ts) needs to serve that origin from a TLS proxy in front of
# the server: E2E_APP_ORIGIN, and the key and the self-signed certificate of the
# proxy, which are generated into the private temporary directory. The first account
# is claimed the way an operator does it: the one-time setup token that the server
# prints to its log at start is read from there and handed over as E2E_SETUP_TOKEN,
# and it is added to the values every failure dump redacts. Nothing here prints it.
#
# Environment (read by smoke-image.sh):
#   SLUGBASE_IMAGE        An image that is already present locally. Unset, the image
#                         is built from this checkout.
#   BUILD_COMMIT          The commit the image was built from.
#   SMOKE_POSTGRES_MAJOR  17 or 18 (the default): the PostgreSQL major of the
#                         stack's database; 17 merges compose.pg17.yml over
#                         compose.yml.
#
# Without this script, start a stack yourself and set E2E_BASE_URL to its address.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/smoke-image.sh
source "$here/../scripts/smoke-image.sh"

# The setup token from the log of the server, which prints it once the migrations are
# applied, a moment after /ready can answer. The latest line wins: each start replaces
# the token. Sets setup_token; the value is never printed.
read_setup_token() {
  local deadline=$((SECONDS + 30))
  while ((SECONDS < deadline)); do
    # The token is base64url, so the pattern holds all of it; compose adds terminal control sequences to a line.
    setup_token="$(compose logs --no-color --no-log-prefix slugbase 2>/dev/null |
      sed -n 's/.*"setupToken":"\([A-Za-z0-9_-]*\)".*/\1/p' | tail -n 1 || true)"
    if [[ -n "$setup_token" ]]; then
      secrets+=("$setup_token")
      return 0
    fi
    sleep 1
  done
  fail "the server did not log a setup token within 30 seconds"
}

# The address of the HTTP API of Mailpit, which Docker published on a port of its own on
# the loopback address. Sets mailpit_url.
read_mailpit_url() {
  local address
  address="$(compose port mailpit 8025 2>/dev/null | tail -n 1 || true)"
  [[ "$address" =~ ^127\.0\.0\.1:[0-9]+$ ]] || fail "the address of Mailpit could not be read from docker compose"
  mailpit_url="http://${address}"
}

main_e2e() {
  local code=0 tls_port setup_token="" mailpit_url=""
  (($# > 0)) || fail "usage: with-stack.sh <command> [argument...]"
  command -v openssl >/dev/null 2>&1 || fail "openssl is required and was not found on PATH"
  tls_port="$(pick_port)" || fail "no free port found on 127.0.0.1"
  export SMOKE_APP_ORIGIN="https://127.0.0.1:${tls_port}" SMOKE_AVOID_PORT="$tls_port"
  export SMOKE_EXTRA_COMPOSE_FILES="$root/compose.e2e.yml"
  start_stack
  read_setup_token
  read_mailpit_url
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 1 -subj "/CN=127.0.0.1" \
    -addext "subjectAltName=IP:127.0.0.1" -keyout "$work/tls.key" -out "$work/tls.crt" >/dev/null 2>&1 ||
    fail "openssl could not generate the certificate of the TLS proxy"
  E2E_BASE_URL="http://127.0.0.1:${port}" E2E_APP_ORIGIN="$SMOKE_APP_ORIGIN" \
    E2E_TLS_KEY_FILE="$work/tls.key" E2E_TLS_CERT_FILE="$work/tls.crt" E2E_SETUP_TOKEN="$setup_token" \
    E2E_MAILPIT_URL="$mailpit_url" "$@" || code=$?
  # The cleanup trap tears the stack down and keeps this status.
  exit "$code"
}

main_e2e "$@"
