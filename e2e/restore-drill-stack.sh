#!/usr/bin/env bash
# Starts a Community Edition stack for the backup and restore drill (doc 08 section 5.1, 6.2;
# e2e/restore-drill.spec.ts) and holds it until the drill says it is finished:
#
#   bash e2e/restore-drill-stack.sh
#
# The drill destroys and restores the database of its stack, so it never uses the stack the
# other journeys run against: this one is a compose project of its own, started the way
# scripts/smoke-image.sh starts one (compose.yml alone, as an operator runs it, with the
# PostgreSQL major of SMOKE_POSTGRES_MAJOR, free port on 127.0.0.1, generated secrets in a
# private temporary directory, and the same teardown on every way out). The image is
# SLUGBASE_IMAGE, or E2E_IMAGE, which e2e/with-stack.sh sets to the image of its own stack;
# with neither, it is built from this checkout.
#
# Once the stack is ready this script prints `ready <file>` as a line of its own. The file
# (readable by this user only) is JSON: the compose project, the arguments that select its
# compose files, the env file that holds its secrets, the address of the server, the origin it is
# configured with and the one-time setup token. The drill then drives the stack through docker
# compose and the HTTP API. The script reads one line from its standard input: `done` ends it with
# status 0, and anything else, an end of input or no line within 30 minutes ends it with status 1,
# printing the end of every container's log with the secrets replaced. Either way it removes the
# project, its volume, the temporary directory and a built image.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=e2e/with-stack.sh
source "$here/with-stack.sh"

VERDICT_SECONDS=1800

main_drill() {
  local setup_token="" handle verdict=""
  (($# == 0)) || fail "usage: restore-drill-stack.sh"
  export SLUGBASE_IMAGE="${SLUGBASE_IMAGE:-${E2E_IMAGE:-}}"
  [[ -n "$SLUGBASE_IMAGE" ]] || unset SLUGBASE_IMAGE
  start_stack
  read_setup_token
  handle="$work/handle.json"
  (
    umask 077
    jq -n --arg project "$project" --arg envFile "$env_file" --arg baseUrl "http://127.0.0.1:${port}" \
      --arg appOrigin "${SMOKE_APP_ORIGIN:-https://smoke.example.test}" --arg setupToken "$setup_token" \
      --arg workDir "$work" --argjson postgresMajor "$postgres_major" \
      --argjson composeArgs "$(printf '%s\n' "${compose_files[@]}" | jq -R . | jq -s .)" \
      '{project: $project, envFile: $envFile, composeArgs: $composeArgs, baseUrl: $baseUrl, appOrigin: $appOrigin,
        setupToken: $setupToken, workDir: $workDir, postgresMajor: $postgresMajor}' >"$handle"
  ) || fail "the handle of the stack could not be written"
  printf 'ready %s\n' "$handle"
  IFS= read -r -t "$VERDICT_SECONDS" verdict || fail "the drill gave no verdict within ${VERDICT_SECONDS} seconds"
  [[ "$verdict" == "done" ]] || fail "the drill ended with '${verdict}'"
  log "the drill is done"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main_drill "$@"
fi
