#!/bin/sh
# The command of the one image (doc 01 sections 2.1 and 3): server, worker or migrate.
#
#   migrate  passes through with the environment as it is.
#   worker   starts without DATABASE_MIGRATE_URL.
#   server   with MIGRATE_ON_START true (the default) runs `migrate` first, as the
#            migrator role; a failure exits here, before anything serves. The server
#            then starts without DATABASE_MIGRATE_URL and with its own in-process
#            migration off, so a compromised server process holds no credentials
#            that can change the schema (D25, doc 05 section 5.3).
#
# Every start `exec`s node, so the signals of the container runtime reach node.
set -eu

main="$(cd "$(dirname "$0")" && pwd)/dist/main.js"

die() {
  status="$1"
  shift
  printf '{"level":"error","msg":"%s"}\n' "$*" >&2
  exit "$status"
}

if [ "$#" -ne 1 ]; then
  die 2 "Expected exactly one command; use one of server, worker, migrate"
fi

case "$1" in
  migrate)
    exec node "$main" migrate
    ;;
  worker)
    unset DATABASE_MIGRATE_URL
    exec node "$main" worker
    ;;
  server) ;;
  *)
    die 2 "Unknown command; use one of server, worker, migrate"
    ;;
esac

case "${MIGRATE_ON_START-true}" in
  true | 1)
    if [ -z "${DATABASE_MIGRATE_URL:-}" ]; then
      die 1 "DATABASE_MIGRATE_URL is required while MIGRATE_ON_START is true; set it or set MIGRATE_ON_START=false"
    fi
    # A failing migrate ends the script (set -e) with its status; the server is never reached.
    node "$main" migrate
    ;;
  false | 0) ;;
  *)
    die 1 'MIGRATE_ON_START must be one of "true", "false", "1" or "0"'
    ;;
esac

unset DATABASE_MIGRATE_URL
MIGRATE_ON_START=false
export MIGRATE_ON_START
exec node "$main" server
