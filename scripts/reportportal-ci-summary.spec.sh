#!/usr/bin/env bash
# Unit tests for reportportal-ci-summary.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/reportportal-ci-summary.sh
source "${SCRIPT_DIR}/reportportal-ci-summary.sh"

TMPDIR="${TMPDIR:-/tmp}"
STATE_FILE="${TMPDIR}/rp-launches-test-$$.jsonl"
export RP_LAUNCHES_FILE="$STATE_FILE"
export REPORTPORTAL_URL="https://reportportal.example.com"
export REPORTPORTAL_PROJECT="slugbase"

cleanup() {
  rm -f "$STATE_FILE"
}
trap cleanup EXIT

assert_eq() {
  local expected="$1"
  local actual="$2"
  local label="${3:-}"
  if [ "$expected" != "$actual" ]; then
    echo "FAIL ${label}: expected '${expected}', got '${actual}'" >&2
    exit 1
  fi
}

LOG_FILE="${TMPDIR}/rp-log-test-$$.txt"
cat >"$LOG_FILE" <<'EOF'
some test output
Report Portal Launch UUID: 61ce1c26-842a-4bde-9abe-a4696e31d626
more output
Report Portal Launch UUID: 61ce1c26-842a-4bde-9abe-a4696e31d626
Report Portal Launch UUID: aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee
EOF

# launch-url
assert_eq \
  "https://reportportal.example.com/ui/#slugbase/launches/all/61ce1c26-842a-4bde-9abe-a4696e31d626" \
  "$(reportportal_launch_url "61ce1c26-842a-4bde-9abe-a4696e31d626")" \
  "launch-url"

# parse-uuids (dedupe)
mapfile -t PARSED_UUIDS < <(reportportal_parse_uuids "$LOG_FILE")
assert_eq "2" "${#PARSED_UUIDS[@]}" "parse-uuids count"
assert_eq "61ce1c26-842a-4bde-9abe-a4696e31d626" "${PARSED_UUIDS[0]}" "parse-uuids first"
assert_eq "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" "${PARSED_UUIDS[1]}" "parse-uuids second"

# legacy client string without space between Report and Portal
LEGACY_LOG="${TMPDIR}/rp-log-legacy-$$.txt"
printf '%s\n' 'ReportPortal Launch UUID: bbbbbbbb-cccc-dddd-eeee-ffffffffffff' >"$LEGACY_LOG"
mapfile -t LEGACY_UUIDS < <(reportportal_parse_uuids "$LEGACY_LOG")
assert_eq "1" "${#LEGACY_UUIDS[@]}" "legacy parse-uuids count"
assert_eq "bbbbbbbb-cccc-dddd-eeee-ffffffffffff" "${LEGACY_UUIDS[0]}" "legacy parse-uuids"

# record-log + markdown
reportportal_record_log "unit" "$LOG_FILE"
assert_eq "2" "$(wc -l <"$STATE_FILE" | tr -d ' ')" "record-log count"

MD=$(reportportal_build_launch_markdown "ReportPortal · CI")
echo "$MD" | grep -q "61ce1c26-842a-4bde-9abe-a4696e31d626"
echo "$MD" | grep -q "reportportal.example.com/ui/#slugbase/launches/all/"

# record-env
export RP_LAUNCH_UUID="ffffffff-1111-2222-3333-444444444444"
reportportal_record_env "integration"
grep -q "ffffffff-1111-2222-3333-444444444444" "$STATE_FILE"

echo "All reportportal-ci-summary tests passed"
