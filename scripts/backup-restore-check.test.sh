#!/usr/bin/env bash
# Tests the helpers of scripts/backup-restore-check.sh, which the script runs against a real stack: that it reads
# the commands it runs from the guide and refuses a guide that no longer holds them, that the cookie jar, the API call
# and the comparison of the row counts do what the script relies on and fail when they should, that the authenticator
# app gives the code of RFC 6238, and that the rules of db:check the script names still exist. The script is sourced,
# so none of its checks run and no Docker is needed.
# The guide's fences and inline code are written in single quotes on purpose.
# shellcheck disable=SC2016
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/backup-restore-check.sh
source "$here/backup-restore-check.sh"

tmp="$(mktemp -d)"
cleanup_tests() {
  rm -rf "$tmp"
}
trap cleanup_tests EXIT
failures=0
out=""
code=0

# Runs the command in a subshell, since a failed check exits.
run() {
  code=0
  out="$("$@" 2>&1)" || code=$?
}

pass() {
  printf 'ok: %s\n' "$1"
}

fail_test() {
  printf 'FAIL: %s\n%s\n' "$1" "$out" >&2
  failures=$((failures + 1))
}

expect_ok() {
  if ((code == 0)); then pass "$1"; else fail_test "$1 (exit $code, expected 0)"; fi
}

expect_failed() {
  if ((code != 0)); then pass "$1"; else fail_test "$1 (exit 0, expected non-zero)"; fi
}

expect_output() {
  if [[ "$out" == *"$2"* ]]; then pass "$1"; else fail_test "$1 (the output lacks '$2')"; fi
}

expect_quiet_about() {
  if [[ "$out" != *"$2"* ]]; then pass "$1"; else fail_test "$1 (the output holds the value)"; fi
}

# ---------------------------------------------------------------------------------------------------------------------
# The guide
# ---------------------------------------------------------------------------------------------------------------------

run require_guide_commands "$GUIDE"
expect_ok "the guide holds every command the script runs"
run guide_wait_script "$GUIDE"
expect_ok "the guide's wait for the database is read"
expect_output "the wait is the guide's own pg_isready over TCP" "pg_isready -h 127.0.0.1 -U slugbase -d slugbase"
if [[ "$out" == until*"done" ]]; then pass "the wait is the script of the loop"; else fail_test "the wait is not the loop of the guide (got '$out')"; fi

# A copy of the guide with the lines that hold a pattern replaced by another text.
mutated_guide() {
  local pattern="$1" replacement="$2" name="$3"
  awk -v pattern="$pattern" -v replacement="$replacement" 'index($0, pattern) > 0 { if (replacement != "") print replacement; next } { print }' "$GUIDE" >"$tmp/$name"
  printf '%s' "$tmp/$name"
}

run require_guide_commands "$(mutated_guide "pg_dump -U slugbase" "" no-dump.md)"
expect_failed "a guide without the dump is refused"
expect_output "the refusal names the dump" "pg_dump"
run require_guide_commands "$(mutated_guide "pg_restore -U slugbase -d slugbase --exit-on-error --single-transaction" "   docker compose exec -T postgres pg_restore -U slugbase -d slugbase --no-owner" weak-restore.md)"
expect_failed "a guide whose restore changed is refused"
run require_guide_commands "$(mutated_guide "docker compose up -d postgres" "" no-start.md)"
expect_failed "a guide without the start of the database service is refused"
run require_guide_commands "$(mutated_guide "does not exist" "" no-error.md)"
expect_failed "a guide that no longer documents the error of a restore without the roles is refused"
run require_guide_commands "$tmp/missing.md"
expect_failed "a missing guide is refused"

# A copy of the guide in which the first command line of the tool (not a crontab line, not a listing) has `from` replaced by
# `to`. The copy must differ from the guide, so a test of a mutation that did not apply cannot pass.
mutated_command() {
  local name="$1" tool="$2" from="$3" to="$4"
  awk -v tool="docker compose $tool" -v from="$from" -v to="$to" '
    {
      text = $0
      sub(/^[ \t]+/, "", text)
      sub(/^\(umask 077; /, "", text)
      at = index($0, from)
      if (!done && index(text, tool) == 1 && index(text, tool " --list") != 1 && at > 0) {
        $0 = substr($0, 1, at - 1) to substr($0, at + length(from))
        done = 1
      }
      print
    }' "$GUIDE" >"$tmp/$name"
  if cmp -s "$GUIDE" "$tmp/$name"; then
    printf 'the mutation %s changed nothing\n' "$name" >&2
    return 1
  fi
  printf '%s' "$tmp/$name"
}

DUMP_TOOL="exec -T postgres pg_dump"
RESTORE_TOOL="exec -T postgres pg_restore -U"
run require_guide_commands "$(mutated_command dump-flag.md "$DUMP_TOOL" "--format=custom" "--format=custom --schema-only")"
expect_failed "a dump line with a flag added is refused"
expect_output "the refusal names the dump" "pg_dump"
run require_guide_commands "$(mutated_command restore-no-owner.md "$RESTORE_TOOL" "--single-transaction" "--single-transaction --no-owner --role=slugbase")"
expect_failed "a restore line with --no-owner --role added is refused"
expect_output "the refusal names the restore" "pg_restore"
run require_guide_commands "$(mutated_command restore-clean.md "$RESTORE_TOOL" "--single-transaction" "--single-transaction --clean --if-exists")"
expect_failed "a restore line with --clean --if-exists added is refused"
run require_guide_commands "$(mutated_command dump-prepended.md "$DUMP_TOOL" "docker compose" "echo skipped; docker compose")"
expect_failed "a dump line with a command put before it is refused"
run require_guide_commands "$(mutated_command restore-prepended.md "$RESTORE_TOOL" "docker compose" "true && docker compose")"
expect_failed "a restore line with a command put before it is refused"
run require_guide_commands "$(mutated_command restore-appended.md "$RESTORE_TOOL" "2026-11-04.dump" "2026-11-04.dump | tee restore.log")"
expect_failed "a restore line with a command put after its redirection is refused"
run require_guide_commands "$(mutated_command dump-appended.md "$DUMP_TOOL" "%F).dump\")" "%F).dump\") && echo done")"
expect_failed "a dump line with a command put after it is refused"
run require_guide_commands "$(mutated_command restore-other-file.md "$RESTORE_TOOL" "backups/slugbase-2026-11-04.dump" "/srv/backups/other.dump")"
expect_ok "a restore line that reads another file is the same command"
{
  cat "$GUIDE"
  printf '\n```sh\ndocker compose exec -T postgres pg_restore -U slugbase -d slugbase --clean --exit-on-error --single-transaction < other.dump\n```\n'
} >"$tmp/extra-restore.md"
run require_guide_commands "$tmp/extra-restore.md"
expect_failed "a second restore line that is not the command is refused although the command is there"
{
  cat "$GUIDE"
  printf '\n```sh\n(umask 077; docker compose exec -T postgres pg_dump -U slugbase -d slugbase --schema-only > other.dump)\n```\n'
} >"$tmp/extra-dump.md"
run require_guide_commands "$tmp/extra-dump.md"
expect_failed "a second dump line that is not the command is refused although the command is there"

# A copy of the guide in which `from` is replaced by `to` on the first line that matches the extended regular expression.
mutated_matching() {
  local name="$1" pattern="$2" from="$3" to="$4"
  awk -v pattern="$pattern" -v from="$from" -v to="$to" '
    {
      at = index($0, from)
      if (!done && $0 ~ pattern && at > 0) {
        $0 = substr($0, 1, at - 1) to substr($0, at + length(from))
        done = 1
      }
      print
    }' "$GUIDE" >"$tmp/$name"
  if cmp -s "$GUIDE" "$tmp/$name"; then
    printf 'the mutation %s changed nothing\n' "$name" >&2
    return 1
  fi
  printf '%s' "$tmp/$name"
}

CRON_LINE='^[0-9*]+ [0-9*]+ [0-9*]+ [0-9*]+ [0-9*]+ cd '
run require_guide_commands "$(mutated_matching cron-schema-only.md "$CRON_LINE" "--format=custom" "--format=custom --schema-only")"
expect_failed "a crontab dump with --schema-only is refused"
expect_output "the refusal says a line runs pg_dump or pg_restore in another form" "in another form"
run require_guide_commands "$(mutated_matching cron-no-format.md "$CRON_LINE" " --format=custom" "")"
expect_failed "a crontab dump without --format=custom is refused"
run require_guide_commands "$(mutated_matching cron-no-umask.md "$CRON_LINE" "(umask 077; " "(")"
expect_failed "a crontab dump without the umask is refused"
run require_guide_commands "$(mutated_matching cron-null.md "$CRON_LINE" "\"backups/slugbase-\$(date +\\%F).dump\"" "/dev/null")"
expect_failed "a crontab dump to /dev/null is refused"
run require_guide_commands "$(mutated_matching cron-other-schedule.md "$CRON_LINE" "17 3 * * *" "*/5 1 * * 1-5")"
expect_ok "a crontab dump on another schedule is the same dump"
run require_guide_commands "$(mutated_command dump-null.md "$DUMP_TOOL" "\"backups/slugbase-\$(date +%F).dump\"" "/dev/null")"
expect_failed "a dump to /dev/null is refused"
run require_guide_commands "$(mutated_command dump-no-umask.md "$DUMP_TOOL" "(umask 077; " "(")"
expect_failed "a dump without the umask is refused"
run require_guide_commands "$(mutated_command restore-from-null.md "$RESTORE_TOOL" "< backups/slugbase-2026-11-04.dump" "< /dev/null")"
expect_failed "a restore that reads /dev/null is refused"

# Another line that runs the tool, in a spelling the first check would not have read as the command: it is still found by
# the name of the tool, and it is not the command.
add_line() {
  local name="$1" text="$2"
  { cat "$GUIDE"; printf '\n```sh\n%b\n```\n' "$text"; } >"$tmp/$name"
  printf '%s' "$tmp/$name"
}
# The same text added as prose, which is not read, and as an indented code block, which is.
add_prose() {
  local name="$1" text="$2"
  { cat "$GUIDE"; printf '\n%b\n' "$text"; } >"$tmp/$name"
  printf '%s' "$tmp/$name"
}
run require_guide_commands "$(add_line restore-no-T.md '   docker compose exec postgres pg_restore -U slugbase -d slugbase --clean < other.dump')"
expect_failed "a second restore line without -T is refused although the restore is there"
run require_guide_commands "$(add_line restore-double-space.md '   docker compose exec -T  postgres pg_restore -U slugbase -d slugbase --exit-on-error --single-transaction < other.dump')"
expect_failed "a second restore line with two spaces is refused"
run require_guide_commands "$(add_line restore-split.md '   docker compose exec -T postgres \\\n     pg_restore -U slugbase -d slugbase --clean < other.dump')"
expect_failed "a second restore line split with a backslash is refused"
run require_guide_commands "$(add_line restore-split-same.md '   docker compose exec -T postgres pg_restore -U slugbase -d slugbase \\\n     --exit-on-error --single-transaction < other.dump')"
expect_failed "a second restore line split with a backslash is refused, though it says the same"
run require_guide_commands "$(add_line dump-in-sh.md '   docker compose exec -T postgres sh -c "pg_dump -U slugbase -d slugbase --schema-only"')"
expect_failed "a dump run through sh -c is refused"
run require_guide_commands "$(add_line dump-multiline-sh.md "   docker compose exec -T postgres sh -c '\n     pg_dump -U slugbase -d slugbase --schema-only\n   ' > other.dump")"
expect_failed "a dump in a sh -c of several lines is refused"
run require_guide_commands "$(add_line dump-heredoc.md "   docker compose exec -T postgres sh <<'EOF'\npg_dump -U slugbase -d slugbase --schema-only\nEOF")"
expect_failed "a dump in a here-document is refused"
run require_guide_commands "$(add_line hyphen-restore.md '   docker-compose exec -T postgres pg_restore -U slugbase -d slugbase --clean < x.dump')"
expect_failed "a restore through docker-compose is refused"
run require_guide_commands "$(add_line hyphen-dump.md '   docker-compose exec -T postgres pg_dump -U slugbase -d slugbase --format=custom > x.dump')"
expect_failed "a dump through docker-compose is refused"
run require_guide_commands "$(add_line piped-dump.md '   docker compose exec -T postgres pg_dump -U slugbase -d slugbase --format=custom | gzip > x.dump.gz')"
expect_failed "a piped dump is refused"
run require_guide_commands "$(add_prose indented-restore.md '    docker-compose exec -T postgres pg_restore -U slugbase -d slugbase --clean < x.dump')"
expect_failed "a command in an indented code block is read and refused"
run require_guide_commands "$(add_prose prose-mention.md 'A dump with `pg_dump --schema-only` holds no data, and `docker-compose exec pg_restore --clean` would delete it. This is prose, and prose is not read.')"
expect_ok "a tool named in prose is not read"
run require_guide_commands "$(add_prose table-mention.md '| pg_dump | pg_restore | `pg_restore --clean` |')"
expect_ok "a tool named in a table is not read"
run require_guide_commands "$(add_line tilde-in-backticks.md '~~~\ndocker compose exec -T postgres pg_restore -U slugbase --clean < x.dump')"
expect_failed "a tilde fence line inside a backtick fence does not close it: the command after it is refused"
run require_guide_commands "$(add_prose tilde-fence.md '~~~sh\ndocker-compose exec -T postgres pg_restore -U slugbase --clean < x.dump\n~~~')"
expect_failed "a command in a ~~~ fence is read and refused"
run require_guide_commands "$(add_prose after-fence.md '```sh\ntrue\n```\n\nProse again: pg_dump --schema-only is only prose here.')"
expect_ok "prose after a closed fence is not read"
run require_guide_commands "$GUIDE"
expect_ok "the unchanged guide passes"

# The scheduled dump: the clean-up is the guide's own, and a file is not a device.
CRON_FIND='-mtime +14 -delete'
run require_guide_commands "$(mutated_matching cron-mtime-minus.md "$CRON_LINE" "$CRON_FIND" "-mtime -1 -delete")"
expect_failed "a crontab clean-up that deletes the dump just taken is refused"
run require_guide_commands "$(mutated_matching cron-find-root.md "$CRON_LINE" "find backups" "find /")"
expect_failed "a crontab clean-up of another directory is refused"
run require_guide_commands "$(mutated_matching cron-find-extra.md "$CRON_LINE" "$CRON_FIND" "$CRON_FIND && rm -rf backups")"
expect_failed "a crontab with another command after the clean-up is refused"
run require_guide_commands "$(mutated_matching cron-days.md "$CRON_LINE" "$CRON_FIND" "-mtime +30 -delete")"
expect_ok "a crontab clean-up of another number of days is the same clean-up"
run require_guide_commands "$(mutated_matching cron-cd.md "$CRON_LINE" "cd /opt/slugbase" "cd /srv/slug base")"
expect_failed "a crontab directory that is not one word is refused"
run require_guide_commands "$(mutated_matching cron-cd-other.md "$CRON_LINE" "cd /opt/slugbase" "cd /srv/slugbase")"
expect_ok "a crontab in another directory is the same dump"
run require_guide_commands "$(mutated_matching cron-stdout.md "$CRON_LINE" "\"backups/slugbase-\$(date +\\%F).dump\"" "/dev/stdout")"
expect_failed "a crontab dump to /dev/stdout is refused"
run require_guide_commands "$(mutated_command dump-proc.md "$DUMP_TOOL" "\"backups/slugbase-\$(date +%F).dump\"" "/proc/self/fd/1")"
expect_failed "a dump to a file under /proc is refused"
run require_guide_commands "$(mutated_command dump-substitution.md "$DUMP_TOOL" "\$(date +%F)" "\$(rm -rf x)")"
expect_failed "a dump file with another substitution is refused"
run require_guide_commands "$(mutated_command dump-backtick.md "$DUMP_TOOL" "\$(date +%F)" "\`id\`")"
expect_failed "a dump file with a backtick is refused"

# Cron turns every % that is not escaped into a newline, so a crontab line with one would never take a dump: the only
# % of the crontab line is the \% of the date, and the other forms keep the plain $(date +%F).
run require_guide_commands "$(mutated_matching cron-date-unescaped.md "$CRON_LINE" "+\\%F" "+%F")"
expect_failed "a crontab dump whose date is not escaped is refused"
run require_guide_commands "$(mutated_matching cron-date-other.md "$CRON_LINE" "+\\%F" "+\\%Y")"
expect_failed "a crontab dump with another escaped date format is refused"
run require_guide_commands "$(mutated_matching cron-percent-cd.md "$CRON_LINE" "cd /opt/slugbase" "cd /opt/slug%base")"
expect_failed "a crontab directory with a % is refused"
run require_guide_commands "$(mutated_matching cron-percent-cd-escaped.md "$CRON_LINE" "cd /opt/slugbase" "cd /opt/slug\\%base")"
expect_failed "a crontab directory with an escaped % is refused"
run require_guide_commands "$(mutated_matching cron-percent-word.md "$CRON_LINE" "\"backups/slugbase-\$(date +\\%F).dump\"" "backups/slugbase-%F.dump")"
expect_failed "a crontab dump to a one-word file with a % is refused"
run require_guide_commands "$(mutated_matching cron-percent-word-escaped.md "$CRON_LINE" "\"backups/slugbase-\$(date +\\%F).dump\"" "backups/slugbase-\\%F.dump")"
expect_failed "a crontab dump to a one-word file with an escaped % is refused"
run require_guide_commands "$(mutated_matching cron-percent-text.md "$CRON_LINE" ").dump\"" ")-\\%x.dump\"")"
expect_failed "a crontab dump to a quoted text with a second % beside the date is refused"
run require_guide_commands "$(mutated_matching cron-percent-twice.md "$CRON_LINE" ").dump\"" ")\$(date +%F).dump\"")"
expect_failed "a crontab dump with an unescaped date beside the escaped one is refused"
run require_guide_commands "$(mutated_matching cron-escaped-backslash.md "$CRON_LINE" "+\\%F" "+\\\\%F")"
expect_failed "a crontab dump whose date has a doubled backslash is refused"
run require_guide_commands "$(mutated_command dump-date-escaped.md "$DUMP_TOOL" "+%F" "+\\%F")"
expect_failed "a dump outside a crontab whose date is escaped is refused"
run require_guide_commands "$(mutated_command restore-date-escaped.md "$RESTORE_TOOL" "backups/slugbase-2026-11-04.dump" "\"backups/slugbase-\$(date +\\%F).dump\"")"
expect_failed "a restore outside a crontab whose date is escaped is refused"
run require_guide_commands "$(mutated_command restore-date.md "$RESTORE_TOOL" "backups/slugbase-2026-11-04.dump" "\"backups/slugbase-\$(date +%F).dump\"")"
expect_ok "a restore that reads the dump of a date is the same restore"
{
  cat "$GUIDE"
  printf '\n```sh\n%s\n```\n' 'docker compose exec -T postgres pg_restore --list < "backups/slugbase-$(date +\%F).dump"'
} >"$tmp/list-date-escaped.md"
run require_guide_commands "$tmp/list-date-escaped.md"
expect_failed "a listing outside a crontab whose date is escaped is refused"

# The schedule is five valid cron fields.
bad_cron=0
good_cron=0
cron_schedule() {
  local name="$1" schedule="$2"
  mutated_matching "$name" "$CRON_LINE" "17 3 * * *" "$schedule"
}
for schedule in "99 99 99 99 99" "*/0 * * * *" "5-1 * * * *" "60 * * * *" "* 24 * * *" "* * 0 * *" "* * 32 * *" "* * * 0 *" \
  "* * * 13 *" "* * * * 8" "1,,2 * * * *" "1, * * * *" ",1 * * * *" "*/ * * * *" "*/5/2 * * * *" "5/2 * * * *" "1-5/0 * * * *" \
  "1-2-3 * * * *" "-1 * * * *" "1- * * * *" "*-5 * * * *" "7-0 * * * *" "1-60 * * * *" "0-5,*/0 * * * *" "* * * * * *" "* * * *"; do
  bad_cron=$((bad_cron + 1))
  run require_guide_commands "$(cron_schedule "cron-bad-${bad_cron}.md" "$schedule")"
  expect_failed "a crontab schedule of '$schedule' is refused"
  expect_output "the refusal of '$schedule' is the one of a line in another form" "in another form"
done
for schedule in "*/5 1 * * 1-5" "0,30 0-23/2 1-31 1-12 0-7" "1-5/2 * * * *" "59 23 31 12 7" "00 03 01 01 00" "*/1 * * * *" "1,2,3 * * * *"; do
  good_cron=$((good_cron + 1))
  run require_guide_commands "$(cron_schedule "cron-good-${good_cron}.md" "$schedule")"
  expect_ok "a crontab schedule of '$schedule' is valid"
done
run require_guide_commands "$(cron_schedule cron-name.md "17 3 * * mon")"
expect_failed "a crontab schedule with a day name is refused"
run require_guide_commands "$(cron_schedule cron-at.md "@daily")"
expect_failed "a crontab with an @ form instead of five fields is refused"

# The dump is written to a partial file and renamed only when pg_dump succeeded: the old form, which truncates the dated
# file before pg_dump starts, and every variant of the new one are refused.
PARTIAL_REDIRECT="> backups/slugbase.partial && mv backups/slugbase.partial "
run require_guide_commands "$(mutated_command dump-direct.md "$DUMP_TOOL" "$PARTIAL_REDIRECT" "> ")"
expect_failed "a dump that is redirected straight to the dated file is refused"
expect_output "the refusal names the dump" "pg_dump"
run require_guide_commands "$(mutated_matching cron-direct.md "$CRON_LINE" "$PARTIAL_REDIRECT" "> ")"
expect_failed "a crontab dump that is redirected straight to the dated file is refused"
run require_guide_commands "$(mutated_command dump-other-partial.md "$DUMP_TOOL" "> backups/slugbase.partial" "> backups/other.partial")"
expect_failed "a dump written to another file than the partial one is refused"
run require_guide_commands "$(mutated_command dump-mv-other.md "$DUMP_TOOL" "&& mv backups/slugbase.partial" "&& mv backups/other.partial")"
expect_failed "a dump that renames another file than the one it wrote is refused"
run require_guide_commands "$(mutated_command dump-cp.md "$DUMP_TOOL" "&& mv " "&& cp ")"
expect_failed "a dump that copies instead of renaming is refused"
run require_guide_commands "$(mutated_command dump-mv-always.md "$DUMP_TOOL" "&& mv " "; mv ")"
expect_failed "a dump that renames the file even when pg_dump failed is refused"
run require_guide_commands "$(mutated_matching cron-mv-always.md "$CRON_LINE" "&& mv " "; mv ")"
expect_failed "a crontab dump that renames the file even when pg_dump failed is refused"
run require_guide_commands "$(mutated_command dump-mv-extra.md "$DUMP_TOOL" "&& mv " "&& chmod 644 backups/slugbase.partial && mv ")"
expect_failed "a dump with another command between the dump and the rename is refused"
run require_guide_commands "$(mutated_command dump-renamed.md "$DUMP_TOOL" "\"backups/slugbase-\$(date +%F).dump\"" "backups/latest.dump")"
expect_ok "a dump that is renamed to another file is the same dump"

run guide_wait_script "$(mutated_guide "pg_isready" "" no-wait.md)"
expect_failed "a guide without a wait for the database is refused"
expect_output "the refusal counts the commands" "0 commands"
{
  cat "$GUIDE"
  printf '\n    docker compose exec -T postgres pg_isready -h 127.0.0.1\n'
} >"$tmp/two-waits.md"
run guide_wait_script "$tmp/two-waits.md"
expect_failed "a guide with two waits is refused"
run guide_wait_script "$(mutated_guide "pg_isready" "   docker compose exec -T postgres pg_isready -h 127.0.0.1 -U slugbase" other-wait.md)"
expect_failed "a wait that is not a bounded script is refused"

# ---------------------------------------------------------------------------------------------------------------------
# The cookie jar and the API
# ---------------------------------------------------------------------------------------------------------------------

jar="$tmp/jar"
printf 'HTTP/1.1 200 OK\r\nSet-Cookie: __Host-sb=abc.def; Path=/; HttpOnly; Secure; SameSite=Lax\r\nSet-Cookie: other=1; Max-Age=60\r\n\r\n' >"$tmp/headers-set"
jar_update "$jar" "$tmp/headers-set"
if [[ "$(cat "$jar")" == $'__Host-sb=abc.def\nother=1' ]]; then pass "the jar keeps each cookie of the answer"; else fail_test "the jar (got '$(cat "$jar")')"; fi
printf 'HTTP/1.1 200 OK\r\nSet-Cookie: __Host-sb=new; Path=/\r\n\r\n' >"$tmp/headers-replace"
jar_update "$jar" "$tmp/headers-replace"
if [[ "$(cat "$jar")" == $'other=1\n__Host-sb=new' ]]; then pass "a cookie that is set again replaces the old one"; else fail_test "the jar after a replacement (got '$(cat "$jar")')"; fi
printf 'HTTP/1.1 204 No Content\r\nSet-Cookie: other=; Path=/; Max-Age=0\r\n\r\n' >"$tmp/headers-end"
jar_update "$jar" "$tmp/headers-end"
if [[ "$(cat "$jar")" == "__Host-sb=new" ]]; then pass "an empty cookie with a Max-Age of 0 ends it"; else fail_test "the jar after an end (got '$(cat "$jar")')"; fi
printf 'HTTP/1.1 204 No Content\r\nset-cookie: __Host-sb=x; max-age=-1\r\nX-Other: y\r\n\r\n' >"$tmp/headers-negative"
jar_update "$jar" "$tmp/headers-negative"
if [[ ! -s "$jar" ]]; then pass "a negative Max-Age ends a cookie, whatever the case of the header"; else fail_test "the jar after a negative Max-Age (got '$(cat "$jar")')"; fi
printf 'HTTP/1.1 200 OK\r\nSet-Cookie: garbage\r\n\r\n' >"$tmp/headers-garbage"
jar_update "$jar" "$tmp/headers-garbage"
if [[ ! -s "$jar" ]]; then pass "a header that is no cookie is ignored"; else fail_test "the jar after garbage (got '$(cat "$jar")')"; fi

# A stand-in for curl: it records its arguments and the cookie header file, writes the answer the test asks for and
# prints the status.
curl_log="$tmp/curl.log"
curl() {
  local previous="" argument header_file=""
  : >"$curl_log"
  for argument in "$@"; do
    printf '%s\n' "$argument" >>"$curl_log"
    if [[ "$previous" == "--header" && "$argument" == @* ]]; then
      header_file="${argument#@}"
    fi
    previous="$argument"
  done
  if [[ -n "$header_file" ]]; then
    cat "$header_file" >>"$curl_log"
  fi
  printf 'HTTP/1.1 201 Created\r\nSet-Cookie: __Host-sb=issued; Path=/\r\n\r\n' >"$work/headers"
  printf '{"id":"an-id"}' >"$work/body"
  printf '201'
}
work="$tmp"
port=1234
app_origin="https://smoke.example.test"
printf '{"secret":"never-on-a-command-line"}' >"$tmp/request.json"
printf '__Host-sb=held\nother=2\n' >"$tmp/api.jar"
api "$tmp/api.jar" POST /api/v1/things "$tmp/request.json"
if [[ "$status" == "201" ]]; then pass "api sets the status of the answer"; else fail_test "api status (got '$status')"; fi
logged="$(cat "$curl_log")"
for expected in "Origin: https://smoke.example.test" "Content-Type: application/json" "http://127.0.0.1:1234/api/v1/things" "@$tmp/request.json" "Cookie: __Host-sb=held; other=2"; do
  if [[ "$logged" == *"$expected"* ]]; then pass "api sends '$expected'"; else fail_test "api does not send '$expected' (got: $logged)"; fi
done
if [[ "$(cat "$tmp/api.jar")" == $'other=2\n__Host-sb=issued' ]]; then pass "api keeps the cookie of the answer in the jar"; else fail_test "api jar (got '$(cat "$tmp/api.jar")')"; fi
: >"$tmp/empty.jar"
api "$tmp/empty.jar" GET /ready
if [[ "$logged" == *"--data-binary"* && "$(cat "$curl_log")" != *"--data-binary"* && "$(cat "$curl_log")" != *"Cookie:"* ]]; then
  pass "a call without a body or a cookie sends neither"
else
  fail_test "api without a body or a cookie sent one (got: $(cat "$curl_log"))"
fi
run api_expect "$tmp/api.jar" POST /api/v1/things 201 "$tmp/request.json"
expect_ok "api_expect accepts the status it expects"
run api_expect "$tmp/api.jar" POST /api/v1/things 200 "$tmp/request.json"
expect_failed "api_expect fails on another status"
expect_output "the failure names the call and the statuses" "POST /api/v1/things answered 201, expected 200"
expect_quiet_about "the failure names nothing of the request" "never-on-a-command-line"
if [[ "$(body_value .id)" == "an-id" ]]; then pass "body_value reads the body of the last answer"; else fail_test "body_value"; fi
run body_value .missing
expect_failed "body_value fails on a member the answer lacks"
unset -f curl

# ---------------------------------------------------------------------------------------------------------------------
# The authenticator app
# ---------------------------------------------------------------------------------------------------------------------

# The key of RFC 6238's test vectors, "12345678901234567890" in base32, at its time of 59 seconds (step 1).
if [[ "$(totp_code GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ 1)" == "287082" ]]; then pass "totp_code gives the code of RFC 6238"; else fail_test "totp_code (got '$(totp_code GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ 1)')"; fi

# next_code waits for a step later than the last accepted one.
current_step() {
  printf '%s' "$fake_step"
}
member_last_step=9
fake_step=10
next_code GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ
if [[ "$member_last_step" == "10" && "$code" == "$(totp_code GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ 10)" ]]; then pass "next_code gives the code of a later step and remembers it"; else fail_test "next_code (step '$member_last_step', code '$code')"; fi
sleep() {
  fake_step=$((fake_step + 1))
}
member_last_step=10
fake_step=10
next_code GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ
if [[ "$member_last_step" == "11" ]]; then pass "next_code waits while the step is not later than the last accepted one"; else fail_test "next_code waiting (step '$member_last_step')"; fi
unset -f sleep current_step

# ---------------------------------------------------------------------------------------------------------------------
# The row counts
# ---------------------------------------------------------------------------------------------------------------------

run compare_counts "3|1|8|2|3|1" "3|1|8|2|3|1"
expect_ok "equal counts pass"
expect_output "each count is reported" "ok: shares: 1 in the source and in the restored database"
run compare_counts "3|1|8|2|3|1" "3|1|7|2|3|1"
expect_failed "a missing bookmark fails"
expect_output "the failure names what is missing" "restored database has 7 bookmarks, the source had 8"
run compare_counts "3|1|8|2|3|1" "3|1|8|2|3|0"
expect_failed "a missing share fails"
run compare_counts "3|1|8|2|3|0" "3|1|8|2|3|0"
expect_failed "a seed without shares fails, since it would equal an empty restore"
run compare_counts "3|1|8|2|3|1" "3|1|8|2|3"
expect_failed "counts of another shape fail"
run compare_counts "3|1|8|2|3|1" "3|1|8|2|3|x"
expect_failed "a count that is not a number fails"

# ---------------------------------------------------------------------------------------------------------------------
# The rules of db:check
# ---------------------------------------------------------------------------------------------------------------------

# Without a reachable database the program fails when it queries; it must get that far, which means each id it is
# given is a rule of db:check today. A renamed rule stops it before any query.
db_check() {
  (cd "$root/packages/db" && DB_CHECK_URL="postgres://nobody:none@127.0.0.1:1/none" DB_CHECK_RULES="$1" timeout 60 node --input-type=module -e "$DB_CHECK_PROGRAM")
}
run db_check "$DB_CHECK_RULES"
expect_failed "the rules of db:check fail where no database answers"
expect_quiet_about "every rule the script names is a rule of db:check" "no longer one of the rules"
run db_check "rls-forced a-rule-that-was-renamed"
expect_failed "a rule that is not one of db:check's fails before it checks anything"
expect_output "the failure says which rules" "no longer one of the rules"

# ---------------------------------------------------------------------------------------------------------------------
# The cleanup of the server without roles
# ---------------------------------------------------------------------------------------------------------------------

# A stand-in for docker on PATH, which timeout can run: it records its arguments and answers `ps` and `image inspect`.
bin="$tmp/bin"
mkdir -p "$bin"
cat >"$bin/docker" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$FAKE_DOCKER_LOG"
case "$*" in
  "image inspect"*) printf '/var/lib/postgresql\n/var/lib/postgresql/data\n\n' ;;
  "ps --all --quiet --filter name=^slugbase-backup-") printf 'bare1\nbare2\n' ;;
  "ps"*"--format"*) printf 'abc slugbase-smoke-1\ndef other\nghi \n' ;;
esac
STUB
chmod +x "$bin/docker"
export FAKE_DOCKER_LOG="$tmp/docker.log"
: >"$FAKE_DOCKER_LOG"

bare_server_arguments the-name /secrets/bare.env the-image /var/lib/postgresql /var/lib/postgresql/data
expected_args="run --detach --name the-name --network none --env-file /secrets/bare.env --tmpfs /var/lib/postgresql --tmpfs /var/lib/postgresql/data the-image"
if [[ "${bare_args[*]}" == "$expected_args" ]]; then pass "the server without roles gets a tmpfs on each volume the image declares"; else fail_test "bare_server_arguments (got '${bare_args[*]}')"; fi
bare_server_arguments the-name /secrets/bare.env the-image
bare_server_arguments the-name /secrets/bare.env the-image ""
if [[ "${bare_args[*]}" == "run --detach --name the-name --network none --env-file /secrets/bare.env the-image" ]]; then pass "an image that declares no volume, or an empty line of the list, gets no tmpfs"; else fail_test "bare_server_arguments without volumes (got '${bare_args[*]}')"; fi

volumes_read="$(PATH="$bin:$PATH" image_volumes the-image | tr '\n' ' ')"
if [[ "$volumes_read" == "/var/lib/postgresql /var/lib/postgresql/data  " ]]; then pass "the volumes of the image are read from docker image inspect"; else fail_test "image_volumes (got '$volumes_read')"; fi
PATH="$bin:$PATH" remove_container slugbase-backup-x-bare
if grep -qx "rm --force --volumes slugbase-backup-x-bare" "$FAKE_DOCKER_LOG"; then pass "the container is removed with its volumes"; else fail_test "remove_container (log: $(cat "$FAKE_DOCKER_LOG"))"; fi

# The step of nightly.yml that removes what a killed run left behind: the last step of the file, run against the stand-in.
step="$tmp/cleanup-step.sh"
awk '
  /name: Remove any stack left behind/ { found = NR; collecting = 0; script = ""; next }
  found && /^        run: \|$/ { collecting = 1; next }
  collecting && /^          / { line = $0; sub(/^          /, "", line); script = script line "\n"; next }
  collecting { collecting = 0 }
  END { printf "%s", script }' "$root/.github/workflows/nightly.yml" >"$step"
if [[ -s "$step" ]]; then pass "the cleanup step of the job is found in nightly.yml"; else fail_test "the cleanup step of the job was not found"; fi
: >"$FAKE_DOCKER_LOG"
run env PATH="$bin:$PATH" bash "$step"
expect_ok "the cleanup step runs"
if grep -qx "rm --force --volumes abc" "$FAKE_DOCKER_LOG"; then pass "the cleanup step removes the containers of a smoke project with their volumes"; else fail_test "cleanup of smoke projects (log: $(cat "$FAKE_DOCKER_LOG"))"; fi
if grep -qx "rm --force --volumes bare1 bare2" "$FAKE_DOCKER_LOG"; then pass "the cleanup step finds the server without roles by its name and removes it with its volumes"; else fail_test "cleanup of the bare server (log: $(cat "$FAKE_DOCKER_LOG"))"; fi
if ! grep -qE "(def|ghi)" "$FAKE_DOCKER_LOG"; then pass "the cleanup step leaves other containers alone"; else fail_test "cleanup removed another container (log: $(cat "$FAKE_DOCKER_LOG"))"; fi

# ---------------------------------------------------------------------------------------------------------------------
# The dump's listing
# ---------------------------------------------------------------------------------------------------------------------

# take_dump matches the listing of pg_restore for the data of the bookmarks. A consumer that closes the pipe at the first
# match (grep -q) gives the producer SIGPIPE, and pipefail then fails the check although the line was found. The stand-in
# compose makes the dump, then prints the matching line first and keeps writing well past the size of a pipe, so the
# producer is always still writing when the match is found.
# shellcheck disable=SC2317 # called by take_dump
compose() {
  case "$*" in
    "$GUIDE_DUMP") printf 'PGDMP\n' ;;
    "exec -T postgres pg_restore --list")
      printf '1; 0 0 TABLE DATA public bookmarks slugbase\n'
      local i
      for ((i = 0; i < 4096; i++)); do printf '%s; 0 0 TABLE DATA public filler_%s slugbase %0100d\n' "$i" "$i" 0; done
      ;;
    *) return 1 ;;
  esac
}
work="$tmp/listing-work"
mkdir -p "$work"
run take_dump
expect_ok "the dump's listing is matched although the listing is still being written when the match is found"
expect_output "the check reports the dump and its contents" "the guide's dump was made and lists its contents"

# Without the data of the bookmarks the check still fails.
# shellcheck disable=SC2317 # called by take_dump
compose() {
  case "$*" in
    "$GUIDE_DUMP") printf 'PGDMP\n' ;;
    "exec -T postgres pg_restore --list") printf '1; 0 0 TABLE DATA public tags slugbase\n' ;;
    *) return 1 ;;
  esac
}
run take_dump
expect_failed "a listing without the data of the bookmarks fails the check"
expect_output "the failure names the bookmarks" "the dump does not list the data of the bookmarks"

# A listing that fails is a failure of its own, whatever it printed.
# shellcheck disable=SC2317 # called by take_dump
compose() {
  case "$*" in
    "$GUIDE_DUMP") printf 'PGDMP\n' ;;
    "exec -T postgres pg_restore --list") printf '1; 0 0 TABLE DATA public bookmarks slugbase\n'; return 3 ;;
    *) return 1 ;;
  esac
}
run take_dump
expect_failed "a listing that fails fails the check even when it printed the bookmarks"
expect_output "the failure says the listing failed" "listing the dump failed"

# A dump that fails keeps the dump of the same day that is already there, and the dated file is only made by a rename.
# shellcheck disable=SC2317 # called by take_dump
compose() {
  case "$*" in
    "$GUIDE_DUMP") printf 'PGDMP, cut off'; return 3 ;;
    *) return 1 ;;
  esac
}
work="$tmp/failed-dump-work"
mkdir -p "$work/backups"
printf 'dump made earlier' >"$work/backups/slugbase.dump"
run take_dump
expect_failed "a dump that fails fails the check"
expect_output "the failure says the dump failed" "the dump of the guide failed"
if [[ "$(cat "$work/backups/slugbase.dump")" == "dump made earlier" ]]; then pass "a failed dump leaves the dump of the same day as it was"; else fail_test "a failed dump replaced the earlier dump"; fi
if [[ "$(cat "$work/$GUIDE_PARTIAL")" == "PGDMP, cut off" ]]; then pass "a failed dump stays in the partial file"; else fail_test "the partial file after a failed dump"; fi

# shellcheck disable=SC2317 # called by take_dump
compose() {
  case "$*" in
    "$GUIDE_DUMP") printf 'PGDMP\n' ;;
    "exec -T postgres pg_restore --list") printf '1; 0 0 TABLE DATA public bookmarks slugbase\n' ;;
    *) return 1 ;;
  esac
}
run take_dump
expect_ok "a dump that succeeds replaces the earlier dump"
if [[ "$(cat "$work/backups/slugbase.dump")" == "PGDMP" && ! -e "$work/$GUIDE_PARTIAL" ]]; then pass "the dated file holds the new dump and the partial file is gone"; else fail_test "the files after a dump that succeeded"; fi

if ((failures > 0)); then
  printf '%s test(s) failed\n' "$failures" >&2
  exit 1
fi
printf 'all tests passed\n'
