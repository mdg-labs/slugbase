#!/usr/bin/env bash
# Follows the procedure of docs/self-hosting/backup-restore.md on a seeded instance and proves that the restored
# database serves the same data with tenant isolation intact (doc 02 section 13.4, doc 08 section 3.4 and 5.1, Q56,
# doc 10 T1):
#
#   bash scripts/backup-restore-check.sh
#
# It starts the Community Edition stack of compose.yml the way scripts/smoke-image.sh does (a compose project of its own,
# a free port on 127.0.0.1, secrets generated into a private temporary directory, one teardown on every way out),
# seeds an instance through the product's HTTP API (the owner of a workspace, a member with an authenticator app, two
# folders, three tags, eight bookmarks with four slugs, and a share) and takes the guide's dump. Then it checks:
#
#   1. a restore into a PostgreSQL server without the roles fails with the error the guide documents, leaves the
#      database empty, and does not run as the owner instead;
#   2. a restore into a new server with the roles, as the guide's first case does it (an empty volume, the guide's wait
#      for the database, the guide's pg_restore), and the image started against it: /ready reports every migration
#      applied, the rows of accounts, workspaces, bookmarks, folders, tags and shares equal the source's, the owner signs
#      in and a /go slug forwards, the member signs in with a code of the authenticator app, and the RLS and ownership
#      rules of `pnpm db:check` (packages/db/src/check) hold on the restored database;
#   3. the same restore under another ENCRYPTION_KEY: the data is back and the member cannot complete the second step
#      of the sign-in, which the script reports as the guide's warning, and putting the key back repairs it.
#
# The script reads the guide and refuses to run unless these hold, and checks nothing else of its text:
#   - in the guide's code (between fences, or indented four spaces or more outside them) every line that names pg_dump or
#     pg_restore, after backslash continuations are joined, is exactly the documented dump, restore, scheduled dump or
#     listing of a dump, so the tool inside a sh -c, a here-document, docker-compose or a pipe fails; guide_tool_lines in
#     this file lists the forms. What may differ in them is the file the dump is renamed to or the restore reads (one
#     word, or a quoted text whose only substitution is $(date +%F); no /dev/ or /proc/), and, in the crontab line, the
#     schedule, the directory of `cd` (one word) and the number of days of the `find ... -mtime +<days> -delete`
#     clean-up. A tool whose name is not written out in the code is not found, and prose, tables and headings are not
#     read;
#   - the guide has that dump and that restore, and `docker compose up -d postgres` and `docker compose up -d` as lines
#     of their own;
#   - the wait for the database is the guide's own single pg_isready line, which the script runs;
#   - the guide still documents the error of a restore without the roles and names the script that provisions them.
# The other commands of the guide are not read and not run by this script: stopping the application, the recreation of
# a database on the same server (`DROP DATABASE`), the volume snapshot and the `curl` of /ready. The script runs its own
# commands for the removal of the old stack and for the checks.
#
# The instance is seeded through the API and not with `pnpm db:seed`, which refuses every database but the development
# database of compose.dev.yml (packages/testing/src/seed/target.ts); the image migrates the stack's own database.
#
# Environment (read by scripts/smoke-image.sh, which this script sources through e2e/with-stack.sh):
#   SLUGBASE_IMAGE        An image that is already present locally. Unset, the image is built from this checkout.
#   BUILD_COMMIT          The commit the image was built from.
#   SMOKE_POSTGRES_MAJOR  17 or 18 (the default): the PostgreSQL major of the stack's database.
#
# Needs docker with the compose plugin, curl, jq, openssl, node 24 and the installed workspace (the rules of db:check and
# the authenticator app of the journeys are imported from it). Every command that can wait is bounded. Nothing prints a
# generated value: a failure prints the log of the containers with every secret replaced, and the project, its volume,
# the containers the script named and the temporary directory are removed on every way out.
set -euo pipefail

backup_restore_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=e2e/with-stack.sh
source "$backup_restore_dir/../e2e/with-stack.sh"

GUIDE="$root/docs/self-hosting/backup-restore.md"
JOURNAL="$root/packages/db/migrations/meta/_journal.json"

# The commands of the guide that this script runs, as the guide writes them after `docker compose `. The script
# refuses to run when the guide does not hold each of them.
GUIDE_DUMP="exec -T postgres pg_dump -U slugbase -d slugbase --format=custom"
GUIDE_RESTORE="exec -T postgres pg_restore -U slugbase -d slugbase --exit-on-error --single-transaction"
GUIDE_START="up -d postgres"
GUIDE_APP_START="up -d"
# The file a dump is written to, and renamed to its dated name only when pg_dump succeeded, so a failed run keeps the
# dump of the same day that is already there. The clean-up below does not match it.
GUIDE_PARTIAL_NAME="slugbase.partial"
GUIDE_PARTIAL="backups/${GUIDE_PARTIAL_NAME}"
# The clean-up of the scheduled dump in the guide, up to the number of days.
GUIDE_FIND=" && find backups -name 'slugbase-*.dump' -mtime +"
GUIDE_WAIT_PREFIX="exec -T postgres timeout 120 sh -c '"
# The error the guide documents for a restore without the roles, and what makes it the error of the first statement
# that names the owner.
DOCUMENTED_ERROR='role "slugbase_owner" does not exist'

# The rules of `pnpm db:check` that hold the isolation of tenants, by id (packages/db/src/check/rls.ts, ownership.ts).
DB_CHECK_RULES="rls-forced app-owns-nothing"

# Run in packages/db against the restored database, with the connection in DB_CHECK_URL and the ids in DB_CHECK_RULES.
# It runs the rules of `pnpm db:check` themselves, not a copy of their queries, and it fails when a rule is missing or
# when the database has no tenant table at all, since a check that looked at nothing is not a pass.
# shellcheck disable=SC2016
DB_CHECK_PROGRAM='
import postgres from "postgres";
import { checkRules } from "./src/check/index.ts";
import { formatReport, runChecks } from "./src/check/run.ts";

const wanted = (process.env.DB_CHECK_RULES ?? "").split(" ").filter((id) => id !== "");
const rules = checkRules.filter((rule) => wanted.includes(rule.id));
const sql = postgres(process.env.DB_CHECK_URL ?? "", { max: 1, onnotice: () => {} });
try {
  if (rules.length !== wanted.length) {
    throw new Error(`a rule of ${wanted.join(", ")} is no longer one of the rules of db:check`);
  }
  const [{ tenant }] = await sql`
    SELECT count(*)::int AS tenant FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN (${"r"}, ${"p"}) AND n.nspname = ${"public"}
      AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = ${"workspace_id"} AND a.attnum > 0 AND NOT a.attisdropped)`;
  if (tenant === 0) {
    throw new Error("the restored database has no table with a workspace_id column");
  }
  const { passed, lines } = formatReport(await runChecks(rules, { packageDir: process.cwd(), sql, hashSqlFiles: () => "" }));
  process.stdout.write(`${lines.join("\n")}\ndb:check: ${String(tenant)} tenant tables were checked\n`);
  process.exitCode = passed ? 0 : 1;
} catch (error) {
  process.stderr.write(`db:check: ${error instanceof Error ? error.message : "failed"}\n`);
  process.exitCode = 1;
} finally {
  await sql.end();
}
'

# State of the instance the script seeds.
app_origin=""
owner_email=""
owner_password=""
member_email=""
member_password=""
member_id=""
member_key=""
member_last_step=-1
shared_slugs=()
shared_urls=()
setup_token=""
dump=""
pg_port=""
wait_script=""

log() {
  printf 'backup-restore: %s\n' "$*"
}

fail() {
  printf 'backup-restore: FAIL: %s\n' "$*" >&2
  exit 1
}

# ---------------------------------------------------------------------------------------------------------------------
# The guide
# ---------------------------------------------------------------------------------------------------------------------

# guide_has <guide> <command>: succeeds when the guide has a line that is `docker compose <command>` and nothing else,
# apart from the indent. The script runs its own copy of the command, so a guide whose line adds a flag must not pass.
guide_has() {
  awk -v command="docker compose $2" '
    { line = $0; sub(/^[ \t]+/, "", line); sub(/[ \t]+$/, "", line) }
    line == command { found = 1 }
    END { exit !found }' "$1"
}

# guide_tool_lines <guide>: succeeds when every place in the guide's code that names pg_dump or pg_restore is one of the
# forms below, and the guide has the dump and the restore of its steps.
#
# Code is what stands between a pair of fences (``` or ~~~, at any indent, closed by the same kind) and any line outside the fences that is
# indented four spaces or more. Prose, tables and headings are not read: a tool named there is not a command. In code,
# the lines that a backslash continues are joined, and every joined line that holds `pg_dump` or `pg_restore` as a word,
# wherever it stands in the line and however the line starts, must be exactly one of these forms. So the tool inside a
# `sh -c` (on one line or several), a here-document, `docker-compose`, a pipe or a changed spelling of `docker compose`
# fails. A tool whose name is not written out in the code (assembled by the shell, say) is not found. The forms
# (GUIDE_DUMP and GUIDE_RESTORE are the commands of the steps):
#   - the dump: `(umask 077; docker compose <GUIDE_DUMP> > <GUIDE_PARTIAL> && mv <GUIDE_PARTIAL> <file>)`;
#   - the scheduled dump: five cron fields, `cd <directory> && `, the dump as above, and ` && find backups -name
#     'slugbase-*.dump' -mtime +<days> -delete` (GUIDE_FIND) as the whole clean-up: the schedule, the directory and the
#     number of days are free;
#   - the restore: `docker compose <GUIDE_RESTORE> < <file>`;
#   - the listing of a dump: `docker compose exec -T postgres pg_restore --list < <file>`, optionally with ` | head`.
# A file is one word, or one double-quoted text whose only substitution is $(date +%F) (or $(date +\%F) in a crontab);
# it has no $ or backtick outside that, and no /dev/ or /proc/ in it. The file the dump is written to is GUIDE_PARTIAL
# itself, in both places. The guide must hold the dump and the restore of its steps. The check is made by the awk named in GUIDE_AWK (awk by default).
# shellcheck disable=SC2016
guide_tool_lines() {
  "${GUIDE_AWK:-awk}" -v dump="docker compose $GUIDE_DUMP" -v restore="docker compose $GUIDE_RESTORE" \
    -v list="docker compose exec -T postgres pg_restore --list" -v find_prefix="$GUIDE_FIND" -v partial="$GUIDE_PARTIAL" '
    function trim(text) {
      sub(/^[ \t]+/, "", text)
      sub(/[ \t]+$/, "", text)
      return text
    }
    # Splits `rest`, which starts with `lead` (" > " or " < "), into the file (`file`) and what follows it (`after`).
    function split_file(rest, lead) {
      if (index(rest, lead) != 1) {
        return 0
      }
      rest = substr(rest, length(lead) + 1)
      if (!match(rest, ("^" target))) {
        return 0
      }
      file = substr(rest, 1, RLENGTH)
      after = substr(rest, RLENGTH + 1)
      return 1
    }
    function file_ok(text,    inner) {
      if (text ~ /\/(dev|proc)\//) {
        return 0
      }
      if (substr(text, 1, 1) == "\042") {
        inner = substr(text, 2, length(text) - 2)
        gsub(/\$\(date \+\\?%F\)/, "", inner)
        return inner !~ /[$`]/
      }
      return text !~ /[$`]/
    }
    # The dump after its command: ` > <partial> && mv <partial> <file>)`, and for the scheduled dump the clean-up after it.
    function dump_rest_ok(rest, scheduled,    lead) {
      lead = " > " partial " && mv " partial
      if (index(rest, lead) != 1 || !split_file(substr(rest, length(lead) + 1), " ") || !file_ok(file) || substr(after, 1, 1) != ")") {
        return 0
      }
      after = substr(after, 2)
      if (after == "") {
        return 1
      }
      if (!scheduled || index(after, find_prefix) != 1) {
        return 0
      }
      return substr(after, length(find_prefix) + 1) ~ /^[0-9]+ -delete$/
    }
    function check(line,    rest, remainder) {
      if (index(line, "(umask 077; " dump) == 1) {
        return dump_rest_ok(substr(line, length("(umask 077; " dump) + 1), 0) ? "dump" : ""
      }
      if (match(line, /^[0-9*\/,-]+ [0-9*\/,-]+ [0-9*\/,-]+ [0-9*\/,-]+ [0-9*\/,-]+ cd [^ ;&|$`\042\047()<>]+ && \(umask 077; /)) {
        remainder = substr(line, RLENGTH + 1)
        if (index(remainder, dump) == 1) {
          return dump_rest_ok(substr(remainder, length(dump) + 1), 1) ? "cron" : ""
        }
        return ""
      }
      if (index(line, restore) == 1) {
        rest = substr(line, length(restore) + 1)
        return (split_file(rest, " < ") && file_ok(file) && after == "") ? "restore" : ""
      }
      if (index(line, list) == 1) {
        rest = substr(line, length(list) + 1)
        return (split_file(rest, " < ") && file_ok(file) && (after == "" || after == " | head")) ? "list" : ""
      }
      return ""
    }
    function judge(line,    kind) {
      line = trim(line)
      if (line !~ /(^|[^A-Za-z0-9_-])pg_(dump|restore)([^A-Za-z0-9_-]|$)/) {
        return
      }
      kind = check(line)
      if (kind == "") {
        bad = 1
      } else if (kind == "dump") {
        dump_found = 1
      } else if (kind == "restore") {
        restore_found = 1
      }
    }
    function flush() {
      if (pending != "") {
        judge(pending)
        pending = ""
      }
    }
    BEGIN { target = "(\042[^\042]+\042|[^ ;|\046<>\042\047()$`]+)" }
    {
      if ($0 ~ /^[ \t]*(```|~~~)/) {
        marker = ($0 ~ /^[ \t]*```/) ? "`" : "~"
        if (!fenced) {
          flush()
          fenced = marker
          next
        }
        if (fenced == marker) {
          flush()
          fenced = ""
          next
        }
      }
      if (!fenced && $0 !~ /^    /) {
        flush()
        next
      }
      text = $0
      if (pending != "") {
        text = pending " " $0
        pending = ""
      }
      if (text ~ /\\[ \t]*$/) {
        sub(/\\[ \t]*$/, "", text)
        pending = text
        next
      }
      judge(text)
    }
    END {
      flush()
      exit !(dump_found && restore_found && !bad)
    }' "$1"
}

# Fails unless the commands the script runs are in the guide, as the guide writes them.
require_guide_commands() {
  local guide="$1"
  [[ -f "$guide" ]] || fail "the guide ${guide} was not found"
  guide_tool_lines "$guide" ||
    fail "the guide has no dump or no restore of its steps as 'docker compose ${GUIDE_DUMP}' and 'docker compose ${GUIDE_RESTORE}', or has a line that runs pg_dump or pg_restore in another form"
  guide_has "$guide" "$GUIDE_START" || fail "the guide no longer holds the command 'docker compose ${GUIDE_START}'"
  guide_has "$guide" "$GUIDE_APP_START" || fail "the guide no longer holds the command 'docker compose ${GUIDE_APP_START}'"
  grep -qF -e "$DOCUMENTED_ERROR" "$guide" || fail "the guide no longer documents the error ${DOCUMENTED_ERROR}"
  grep -qF -e "/docker-entrypoint-initdb.d/10-roles.sql" "$guide" || fail "the guide no longer names the script that provisions the roles"
}

# Prints the script of the guide's wait for the database of a new server: the one command of the guide that runs
# pg_isready, which must be `docker compose exec -T postgres timeout 120 sh -c '<script>'`.
guide_wait_script() {
  local guide="$1" lines count line prefix
  lines="$(grep -E '^[[:space:]]*docker compose .*\bpg_isready\b' "$guide" || true)"
  count="$(printf '%s' "$lines" | grep -c . || true)"
  [[ "$count" == "1" ]] || fail "the guide has ${count} commands that run pg_isready, and this script needs exactly one"
  line="${lines#"${lines%%[![:space:]]*}"}"
  prefix="docker compose ${GUIDE_WAIT_PREFIX}"
  [[ "$line" == "$prefix"*"'" ]] || fail "the guide's wait for the database is not '${prefix}<script>'"
  line="${line#"$prefix"}"
  printf '%s' "${line%\'}"
}

# ---------------------------------------------------------------------------------------------------------------------
# The HTTP API, with a cookie jar of its own for each session
# ---------------------------------------------------------------------------------------------------------------------

# Keeps the cookies of the Set-Cookie headers in $2 in the jar $1, one `name=value` line each: the session cookie is
# Secure and `__Host-` prefixed and the stack answers over http, so curl's own cookie engine is not used. A cookie that
# is empty or has a Max-Age of 0 or less ends it.
jar_update() {
  local jar="$1" headers="$2" line pair name value attributes ends
  touch "$jar"
  while IFS= read -r line; do
    line="${line%$'\r'}"
    [[ "${line,,}" == set-cookie:* ]] || continue
    pair="${line#*:}"
    pair="${pair# }"
    attributes="${pair#*;}"
    [[ "$pair" == *";"* ]] || attributes=""
    pair="${pair%%;*}"
    name="${pair%%=*}"
    value="${pair#*=}"
    [[ -n "$name" && "$pair" == *"="* ]] || continue
    ends=""
    if [[ -z "$value" ]] || [[ "${attributes,,}" =~ (^|[[:space:]]|;)max-age=(0|-[0-9]+)(;|$|[[:space:]]) ]]; then
      ends=1
    fi
    awk -F= -v name="$name" '$1 != name' "$jar" >"$jar.next"
    if [[ -z "$ends" ]]; then
      printf '%s=%s\n' "$name" "$value" >>"$jar.next"
    fi
    mv "$jar.next" "$jar"
  done <"$headers"
}

# api <jar> <method> <path> [request-body-file]: sets `status`, leaves the body of the answer in $work/body and the
# headers in $work/headers, and keeps the cookies of the answer in the jar. A mutation carries the origin the server
# is configured with. The cookie goes in a file and the body is read from a file, so no secret is on a command line.
api() {
  local jar="$1" method="$2" path="$3" body="${4:-}"
  local -a args=(--silent --show-error --max-time 15 --request "$method" --dump-header "$work/headers" --output "$work/body"
    --write-out '%{http_code}' --header "Origin: ${app_origin}" --header "Content-Type: application/json")
  if [[ -s "$jar" ]]; then
    (
      umask 077
      printf 'Cookie: %s\n' "$(paste -sd';' "$jar" | sed 's/;/; /g')" >"$work/cookie-header"
    )
    args+=(--header "@$work/cookie-header")
  fi
  if [[ -n "$body" ]]; then
    args+=(--data-binary "@$body")
  fi
  status="$(curl "${args[@]}" "http://127.0.0.1:${port}${path}")" || fail "${method} ${path} did not answer"
  jar_update "$jar" "$work/headers"
}

# api_expect <jar> <method> <path> <status> [request-body-file]: the answer must have that status. The message names
# the call and the status and nothing of the request or the answer.
api_expect() {
  local expected="$4"
  api "$1" "$2" "$3" "${5:-}"
  [[ "$status" == "$expected" ]] || fail "${2} ${3} answered ${status}, expected ${expected}"
}

# The value of a jq filter over the body of the last answer.
body_value() {
  jq -er "$1" "$work/body" || fail "the answer has no $1"
}

# ---------------------------------------------------------------------------------------------------------------------
# The authenticator app
# ---------------------------------------------------------------------------------------------------------------------

# The code (RFC 6238) of a time step for a setup key, from the authenticator app of the journeys (e2e/support/totp.ts),
# which is written out there and not taken from packages/core so that the server is checked against the standard.
totp_code() {
  local key="$1" step="$2"
  TOTP_KEY="$key" node --input-type=module -e \
    'import { totpCode } from "file://'"$root"'/e2e/support/totp.ts"; process.stdout.write(totpCode(process.env.TOTP_KEY ?? "", Number(process.argv[1])));' "$step"
}

current_step() {
  printf '%s' "$(($(date +%s) / 30))"
}

# Waits for a time step later than the last accepted one (a code is accepted once, and only for a later step), then
# sets `code` and `member_last_step`. At most 31 seconds.
next_code() {
  local key="$1" step
  local deadline=$((SECONDS + 35))
  while (($(current_step) <= member_last_step)); do
    ((SECONDS < deadline)) || fail "no later time step came within 35 seconds"
    sleep 1
  done
  step="$(current_step)"
  code="$(totp_code "$key" "$step")"
  member_last_step="$step"
}

# ---------------------------------------------------------------------------------------------------------------------
# The seed
# ---------------------------------------------------------------------------------------------------------------------

# Seeds the instance through the API: the first-run owner, two folders, eight bookmarks (four with a slug, the first
# one pinned, three tags), a member who accepted an invitation, a share of one bookmark with that member, and an
# authenticator app for the member.
seed_instance() {
  local token owner_jar member_jar index slug folder_a folder_b folder bookmark_ids=() id invitation link invite_token
  token="$(random_hex 4)"
  app_origin="${SMOKE_APP_ORIGIN:-https://smoke.example.test}"
  owner_email="owner-${token}@example.test"
  member_email="member-${token}@example.test"
  owner_password="$(random_hex 24)"
  member_password="$(random_hex 24)"
  secrets+=("$owner_password" "$member_password")
  owner_jar="$work/owner.jar"
  member_jar="$work/member.jar"
  : >"$owner_jar"
  : >"$member_jar"

  OWNER_PASSWORD="$owner_password" SETUP_TOKEN="$setup_token" jq -n --arg email "$owner_email" \
    '{displayName: "Backup Owner", email: $email, password: $ENV.OWNER_PASSWORD, workspaceName: "Backup", setupToken: $ENV.SETUP_TOKEN}' >"$work/request.json"
  api_expect "$owner_jar" POST /api/v1/setup 201 "$work/request.json"

  jq -n '{name: "Reading"}' >"$work/request.json"
  api_expect "$owner_jar" POST /api/v1/folders 201 "$work/request.json"
  folder_a="$(body_value .id)"
  jq -n '{name: "Tools"}' >"$work/request.json"
  api_expect "$owner_jar" POST /api/v1/folders 201 "$work/request.json"
  folder_b="$(body_value .id)"

  for index in 0 1 2 3 4 5 6 7; do
    slug=""
    if ((index < 4)); then
      slug="backup-${token}-${index}"
      shared_slugs+=("$slug")
      shared_urls+=("https://backup.example.test/page/${index}")
    fi
    folder="$folder_a"
    ((index % 2 == 0)) || folder="$folder_b"
    jq -n --arg url "https://backup.example.test/page/${index}" --arg title "Backup page ${index}" \
      --arg description "Page ${index} of the backup check" --arg folder "$folder" --arg slug "$slug" --argjson index "$index" \
      '{url: $url, title: $title, description: $description, pinned: ($index == 0),
        tagNames: (["alpha", "beta", "gamma"] | .[0:(($index % 3) + 1)]), folderIds: [$folder]}
        + (if $slug == "" then {} else {slug: $slug} end)' >"$work/request.json"
    api_expect "$owner_jar" POST /api/v1/bookmarks 201 "$work/request.json"
    id="$(body_value .id)"
    bookmark_ids+=("$id")
  done

  jq -n --arg email "$member_email" '{email: $email, role: "member"}' >"$work/request.json"
  api_expect "$owner_jar" POST /api/v1/invitations 201 "$work/request.json"
  invitation="$(body_value .id)"
  api_expect "$owner_jar" POST "/api/v1/invitations/${invitation}/link" 200
  link="$(body_value .link)"
  invite_token="${link##*/invite/}"
  [[ -n "$invite_token" && "$invite_token" != "$link" ]] || fail "the invitation link has no /invite/<token>"
  secrets+=("$invite_token")
  MEMBER_PASSWORD="$member_password" INVITE_TOKEN="$invite_token" jq -n \
    '{token: $ENV.INVITE_TOKEN, displayName: "Backup Member", password: $ENV.MEMBER_PASSWORD}' >"$work/request.json"
  api_expect "$member_jar" POST /api/v1/invitations/accept 201 "$work/request.json"
  api_expect "$member_jar" GET /api/v1/me 200
  member_id="$(body_value .account.id)"

  jq -n --arg account "$member_id" '{accountId: $account}' >"$work/request.json"
  api_expect "$owner_jar" POST "/api/v1/bookmarks/${bookmark_ids[1]}/shares" 201 "$work/request.json"

  # An authenticator app for the member: the password confirms the account, the enrolment answers with a setup key,
  # and the code of the current step confirms it.
  MEMBER_PASSWORD="$member_password" jq -n '{password: $ENV.MEMBER_PASSWORD}' >"$work/request.json"
  api_expect "$member_jar" POST /api/v1/me/reauth 204 "$work/request.json"
  api_expect "$member_jar" POST /api/v1/me/mfa/enrollment 200
  member_key="$(body_value .secret)"
  secrets+=("$member_key")
  next_code "$member_key"
  jq -n --arg code "$code" '{code: $code}' >"$work/request.json"
  api "$member_jar" POST /api/v1/me/mfa/enrollment/confirm "$work/request.json"
  [[ "$status" == 200 || "$status" == 201 || "$status" == 204 ]] || fail "POST /api/v1/me/mfa/enrollment/confirm answered ${status}"
  log "seeded: an owner, a member with an authenticator app, 2 folders, 8 bookmarks (4 with a slug), 3 tags and a share"
}

# ---------------------------------------------------------------------------------------------------------------------
# The database
# ---------------------------------------------------------------------------------------------------------------------

# psql as the superuser of the stack's database service, as the guide does.
psql_super() {
  compose exec -T postgres psql -U slugbase -d slugbase --no-psqlrc --tuples-only --no-align -v ON_ERROR_STOP=1 "$@"
}

# One line of six numbers, `|` apart: the rows of accounts, workspaces, bookmarks, folders, tags and shares (the shares
# of bookmarks and of folders). A superuser reads every row, row-level security or not.
row_counts() {
  psql_super -c "SELECT (SELECT count(*) FROM accounts), (SELECT count(*) FROM workspaces), (SELECT count(*) FROM bookmarks),
    (SELECT count(*) FROM folders), (SELECT count(*) FROM tags), (SELECT count(*) FROM bookmark_shares) + (SELECT count(*) FROM folder_shares)" |
    tr -d '[:space:]'
}

# The tables of the public schema of the database.
table_count() {
  psql_super -c "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'" | tr -d '[:space:]'
}

# compare_counts <source> <restored>: both are the line of row_counts, and each of the six must be equal and the
# first five positive (a seed that made nothing would equal an empty restore).
compare_counts() {
  local source_counts="$1" restored_counts="$2" names=(accounts workspaces bookmarks folders tags shares) index
  local -a before after
  IFS='|' read -r -a before <<<"$source_counts"
  IFS='|' read -r -a after <<<"$restored_counts"
  ((${#before[@]} == 6 && ${#after[@]} == 6)) || fail "the row counts are not six numbers (source '${source_counts}', restored '${restored_counts}')"
  for index in 0 1 2 3 4 5; do
    [[ "${before[index]}" =~ ^[0-9]+$ && "${after[index]}" =~ ^[0-9]+$ ]] || fail "the count of ${names[index]} is not a number"
    ((before[index] > 0)) || fail "the source has no ${names[index]}: the seed did not make any"
    [[ "${before[index]}" == "${after[index]}" ]] ||
      fail "the restored database has ${after[index]} ${names[index]}, the source had ${before[index]}"
    log "ok: ${names[index]}: ${after[index]} in the source and in the restored database"
  done
}

# The guide's dump into a file only this user can read.
take_dump() {
  dump="$work/backups/slugbase.dump"
  install -d -m 700 "$work/backups"
  (
    umask 077
    # shellcheck disable=SC2086
    compose $GUIDE_DUMP >"$work/$GUIDE_PARTIAL" && mv "$work/$GUIDE_PARTIAL" "$dump"
  ) || fail "the dump of the guide failed"
  [[ -s "$dump" ]] || fail "the dump of the guide is empty"
  # The listing is captured whole and then matched. Piping it into `grep -q` would close the pipe at the first match,
  # pg_restore would get SIGPIPE while it is still writing, and pipefail would fail a listing that holds the line.
  local listing
  listing="$(compose exec -T postgres pg_restore --list <"$dump")" || fail "listing the dump failed"
  [[ "$listing" == *'TABLE DATA public bookmarks'* ]] || fail "the dump does not list the data of the bookmarks"
  log "ok: the guide's dump was made and lists its contents"
}

# The paths the image declares as volumes, one a line. `docker run` makes an anonymous volume for each of them that the
# command does not mount, and a container removed without `--volumes` leaves it behind.
# shellcheck disable=SC2016
image_volumes() {
  timeout 60 docker image inspect --format '{{range $path, $_ := .Config.Volumes}}{{println $path}}{{end}}' "$1"
}

# Sets bare_args to the arguments of `docker run` for the server without roles: detached, named, with no network and
# the superuser password from a file, and with a tmpfs on each path the image declares as a volume, so the data of the
# server is in memory and no anonymous volume is made (bare_server_arguments <name> <env-file> <image> [volume...]).
bare_args=()
bare_server_arguments() {
  local name="$1" env_file_path="$2" server_image="$3" volume
  shift 3
  bare_args=(run --detach --name "$name" --network none --env-file "$env_file_path")
  for volume in "$@"; do
    [[ -n "$volume" ]] || continue
    bare_args+=(--tmpfs "$volume")
  done
  bare_args+=("$server_image")
}

# Removes a container the script named, with the anonymous volumes it made.
remove_container() {
  timeout 60 docker rm --force --volumes "$1" >/dev/null 2>&1
}

# A restore into a server that has no roles must fail with the error the guide documents, leave the database empty, and
# not run as the owner instead. The server is a container of the image of the stack's database service, started with
# no provisioning script and no network.
check_restore_without_roles() {
  local name="slugbase-backup-${run_id}-bare" container database_image tables restore_status=0 volumes=() volume_list
  container="$(compose ps -aq postgres)"
  [[ -n "$container" ]] || fail "the database container of the stack was not found"
  database_image="$(docker inspect --format '{{.Config.Image}}' "$container")"
  (
    umask 077
    printf 'POSTGRES_USER=slugbase\nPOSTGRES_DB=slugbase\nPOSTGRES_PASSWORD=%s\n' "$smoke_superuser_password" >"$work/bare.env"
  )
  named_containers+=("$name")
  volume_list="$(image_volumes "$database_image")" || fail "the volumes of the image ${database_image} could not be read"
  mapfile -t volumes <<<"$volume_list"
  bare_server_arguments "$name" "$work/bare.env" "$database_image" "${volumes[@]+"${volumes[@]}"}"
  timeout 120 docker "${bare_args[@]}" >/dev/null || fail "the server without roles could not be started"
  timeout 150 docker exec "$name" timeout 120 sh -c "$wait_script" >/dev/null 2>&1 || fail "the server without roles did not answer within 120 seconds"
  # shellcheck disable=SC2086
  timeout 120 docker exec -i "$name" ${GUIDE_RESTORE#exec -T postgres} <"$dump" >"$work/bare-restore.out" 2>&1 || restore_status=$?
  ((restore_status != 0)) || fail "the restore into a server without the roles succeeded"
  grep -qF -e "$DOCUMENTED_ERROR" "$work/bare-restore.out" ||
    fail "the restore into a server without the roles failed, but not with the documented error ${DOCUMENTED_ERROR}"
  tables="$(timeout 60 docker exec "$name" psql -U slugbase -d slugbase --no-psqlrc --tuples-only --no-align -c "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'" | tr -d '[:space:]')"
  [[ "$tables" == "0" ]] || fail "the failed restore left ${tables} tables in the database"
  remove_container "$name" || fail "could not remove the container ${name} with its volumes"
  log "ok: a restore without the roles fails with '${DOCUMENTED_ERROR}' and leaves the database empty"
}

# The first case of the guide's step 2: a new server with an empty volume. The old stack is removed with its volume, the
# database service starts (compose.yml provisions the roles on first start), and the guide's wait asks until it answers.
new_server() {
  compose down --volumes --remove-orphans >"$work/down.log" 2>&1 || fail "docker compose down failed"
  # shellcheck disable=SC2086
  compose $GUIDE_START >"$work/up-postgres.log" 2>&1 || fail "the database service did not start"
  compose exec -T postgres timeout 120 sh -c "$wait_script" >"$work/wait.log" 2>&1 ||
    fail "the new database did not answer within 120 seconds"
  [[ "$(table_count)" == "0" ]] || fail "the new database is not empty"
}

# The guide's restore into the empty database of the new server.
restore_dump() {
  # shellcheck disable=SC2086
  compose $GUIDE_RESTORE <"$dump" >"$work/restore.log" 2>&1 ||
    {
      redact <"$work/restore.log" | tail -n 20 >&2
      fail "the restore of the guide failed"
    }
  [[ "$(table_count)" != "0" ]] || fail "the restore made no table"
}

# The guide's step 4: start the application, which migrates before it serves.
start_application() {
  # shellcheck disable=SC2086
  compose $GUIDE_APP_START --no-build >"$work/up.log" 2>&1 ||
    {
      redact <"$work/up.log" | tail -n 20 >&2
      fail "docker compose up failed"
    }
  wait_ready
}

# Publishes the database of the new server on a port of the loopback address, for the rules of db:check, which connect.
publish_database() {
  pg_port="$(SMOKE_AVOID_PORT="$port" pick_port)" || fail "no free port found for the database"
  printf 'services:\n  postgres:\n    ports:\n      - "127.0.0.1:%s:5432"\n' "$pg_port" >"$work/postgres-port.yml"
  compose_files+=(-f "$work/postgres-port.yml")
}

# The rules of db:check on the restored database, as slugbase_app: it must see the tables RLS enabled and forced, and
# own none of them.
check_isolation() {
  local app_password output
  app_password="$(sed -n 's/^APP_DB_PASSWORD=//p' "$env_file")"
  [[ -n "$app_password" ]] || fail "the env file of the stack has no APP_DB_PASSWORD"
  output="$(cd "$root/packages/db" && DB_CHECK_URL="postgres://slugbase_app:${app_password}@127.0.0.1:${pg_port}/slugbase" \
    DB_CHECK_RULES="$DB_CHECK_RULES" timeout 120 node --input-type=module -e "$DB_CHECK_PROGRAM" 2>&1)" ||
    {
      printf '%s\n' "$output" | redact >&2
      fail "the restored database does not hold the rules of db:check"
    }
  printf '%s\n' "$output" | redact | sed 's/^/backup-restore: /'
}

# ---------------------------------------------------------------------------------------------------------------------
# The restored instance
# ---------------------------------------------------------------------------------------------------------------------

# /ready with every migration applied, as many as the checkout ships.
check_ready() {
  local shipped
  shipped="$(jq '.entries | length' "$JOURNAL")"
  [[ "$shipped" =~ ^[0-9]+$ ]] || fail "the migration journal could not be counted"
  ((shipped > 0)) || fail "the migration journal lists no migration"
  expect_status /ready 200
  expect_json "/ready reports a reachable database and every migration applied" "$READY_FILTER"
  expect_equal "the migrations /ready expects" "$(jq -r .migrations.expected "$work/body")" "$shipped"
}

# The owner signs in with the password alone and each slug forwards to its bookmark.
check_owner_and_slugs() {
  local jar="$work/owner-restored.jar" index
  : >"$jar"
  OWNER_PASSWORD="$owner_password" jq -n --arg email "$owner_email" '{email: $email, password: $ENV.OWNER_PASSWORD}' >"$work/request.json"
  api_expect "$jar" POST /api/v1/auth/login 200 "$work/request.json"
  expect_equal "the next step of the owner's sign-in" "$(body_value .next)" "done"
  for index in "${!shared_slugs[@]}"; do
    api "$jar" GET "/go/${shared_slugs[index]}"
    expect_equal "the status of GET /go/<slug ${index}>" "$status" "302"
    expect_equal "where /go/<slug ${index}> forwards" "$(header_value location)" "${shared_urls[index]}"
  done
}

# The member signs in with the password, which asks for the second step, and the code gives the whole session.
check_member_signs_in() {
  local jar="$work/member-restored.jar"
  : >"$jar"
  MEMBER_PASSWORD="$member_password" jq -n --arg email "$member_email" '{email: $email, password: $ENV.MEMBER_PASSWORD}' >"$work/request.json"
  api_expect "$jar" POST /api/v1/auth/login 200 "$work/request.json"
  expect_equal "the next step of the member's sign-in" "$(body_value .next)" "mfa"
  next_code "$member_key"
  jq -n --arg code "$code" '{code: $code}' >"$work/request.json"
  api_expect "$jar" POST /api/v1/auth/mfa/verify 200 "$work/request.json"
  expect_equal "the next step after the member's code" "$(body_value .next)" "done"
  api_expect "$jar" GET /api/v1/me 200
  expect_equal "the account that signed in with a code" "$(body_value .account.id)" "$member_id"
}

# The guide's warning: under another ENCRYPTION_KEY the password is right but the code cannot be checked. The script
# reports it as a finding of the scenario, and fails when the code is accepted.
check_member_cannot_complete_mfa() {
  local jar="$work/member-wrong-key.jar"
  : >"$jar"
  MEMBER_PASSWORD="$member_password" jq -n --arg email "$member_email" '{email: $email, password: $ENV.MEMBER_PASSWORD}' >"$work/request.json"
  api_expect "$jar" POST /api/v1/auth/login 200 "$work/request.json"
  expect_equal "the next step of the member's sign-in under another key" "$(body_value .next)" "mfa"
  next_code "$member_key"
  jq -n --arg code "$code" '{code: $code}' >"$work/request.json"
  api "$jar" POST /api/v1/auth/mfa/verify "$work/request.json"
  ((status >= 400)) || fail "the member's second step was accepted under another ENCRYPTION_KEY (answered ${status})"
  [[ "$status" != "429" ]] || fail "the second step was rate limited, so it proved nothing"
  api "$jar" GET /api/v1/me
  expect_equal "the status of GET /api/v1/me after the refused second step" "$status" "401"
  log "REPORTED: with another ENCRYPTION_KEY the member with an authenticator app cannot complete the sign-in (the second step answered ${status}), as the guide warns: without the key that sealed it, a member who uses two-step verification cannot sign in with their code"
}

# ---------------------------------------------------------------------------------------------------------------------

check_requirements() {
  local tool
  for tool in node install paste awk sed grep; do
    command -v "$tool" >/dev/null 2>&1 || fail "$tool is required and was not found on PATH"
  done
  [[ -d "$root/packages/db/node_modules/postgres" ]] || fail "the workspace is not installed (pnpm install --frozen-lockfile): packages/db has no postgres"
}

main_check() {
  local source_counts restored_counts wrong_key
  (($# == 0)) || fail "usage: backup-restore-check.sh"
  check_requirements
  require_guide_commands "$GUIDE"
  wait_script="$(guide_wait_script "$GUIDE")"
  [[ -n "$wait_script" ]] || fail "the guide's wait for the database is empty"

  start_stack
  compose_limit=300
  read_setup_token
  seed_instance
  source_counts="$(row_counts)"
  log "source rows (accounts|workspaces|bookmarks|folders|tags|shares): ${source_counts}"
  take_dump

  check_restore_without_roles

  log "restoring into a new server with the roles, as the guide's first case does"
  publish_database
  new_server
  restore_dump
  start_application
  check_ready
  restored_counts="$(row_counts)"
  compare_counts "$source_counts" "$restored_counts"
  check_isolation
  check_owner_and_slugs
  check_member_signs_in
  log "ok: the image started against the restored database; /ready, the sign-ins and /go work"

  log "restoring under another ENCRYPTION_KEY, as an operator who lost the key would"
  wrong_key="$(random_base64 32)"
  secrets+=("$wrong_key")
  (
    umask 077
    printf 'ENCRYPTION_KEY=%s\n' "$wrong_key" >"$work/wrong-key.env"
  )
  run_env_files=("$work/wrong-key.env")
  new_server
  restore_dump
  start_application
  compare_counts "$source_counts" "$(row_counts)"
  check_member_cannot_complete_mfa

  log "putting the key back, as the guide's troubleshooting says"
  run_env_files=()
  start_application
  check_member_signs_in
  log "ok: with the key put back the member signs in again"

  log "all checks passed"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main_check "$@"
fi
