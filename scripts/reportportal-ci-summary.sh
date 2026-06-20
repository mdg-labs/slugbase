#!/usr/bin/env bash
# ReportPortal CI helpers — parse launch UUIDs, write job summary, upsert PR comments.
#
# State file (JSONL): {"layer":"<label>","uuid":"<uuid>"}
# Launch URL: ${REPORTPORTAL_SUMMARY_URL}/ui/#${REPORTPORTAL_SUMMARY_PROJECT}/launches/all/{uuid}
#
# Job summary and PR links MUST run in a job without REPORTPORTAL_API_KEY in env.
# GitHub masks secret substrings everywhere in that job's output (including GITHUB_STEP_SUMMARY),
# which corrupts launch UUIDs and breaks markdown hrefs.
set -euo pipefail

STATE_FILE="${RP_LAUNCHES_FILE:-reportportal-launches.jsonl}"
MARKER_CI='<!-- reportportal-ci -->'
MARKER_E2E='<!-- reportportal-e2e -->'
REPORTPORTAL_UI_BASE_DEFAULT="https://reportportal.mdg-labs.dev"
REPORTPORTAL_PROJECT_DEFAULT="slugbase"

reportportal_summary_base_url() {
  printf '%s' "${REPORTPORTAL_SUMMARY_URL:-$REPORTPORTAL_UI_BASE_DEFAULT}"
}

reportportal_summary_project() {
  printf '%s' "${REPORTPORTAL_SUMMARY_PROJECT:-$REPORTPORTAL_PROJECT_DEFAULT}"
}

reportportal_launch_url() {
  local uuid="$1"
  local base_url
  local project
  base_url="$(reportportal_summary_base_url)"
  project="$(reportportal_summary_project)"
  # HTML / autolink href — literal # is correct inside href; do not use markdown [text](url).
  printf '%s/ui/#%s/launches/all/%s' "${base_url%/}" "$project" "$uuid"
}

# Extract unique launch UUIDs from a log file or stdin.
# client-javascript prints "Report Portal Launch UUID:" (with a space).
RP_LAUNCH_UUID_PATTERN='Report[[:space:]]*Portal Launch UUID: [0-9a-fA-F-]{36}'
RP_LAUNCH_UUID_SED='s/Report[[:space:]]*Portal Launch UUID: //'

reportportal_parse_uuids() {
  local input="${1:--}"
  if [ "$input" = "-" ]; then
    grep -oE "$RP_LAUNCH_UUID_PATTERN" 2>/dev/null \
      | sed -E "$RP_LAUNCH_UUID_SED" \
      | sort -u \
      || true
  else
    grep -oE "$RP_LAUNCH_UUID_PATTERN" "$input" 2>/dev/null \
      | sed -E "$RP_LAUNCH_UUID_SED" \
      | sort -u \
      || true
  fi
}

reportportal_record_log() {
  local layer="$1"
  local logfile="$2"

  if [ ! -f "$logfile" ]; then
    return 0
  fi

  local uuid
  while IFS= read -r uuid; do
    [ -n "$uuid" ] || continue
    echo "{\"layer\":\"${layer}\",\"uuid\":\"${uuid}\"}" >>"$STATE_FILE"
  done < <(reportportal_parse_uuids "$logfile")
}

reportportal_record_env() {
  local layer="$1"
  if [ -n "${RP_LAUNCH_UUID:-}" ]; then
    echo "{\"layer\":\"${layer}\",\"uuid\":\"${RP_LAUNCH_UUID}\"}" >>"$STATE_FILE"
  fi
}

reportportal_has_launches() {
  [ -f "$STATE_FILE" ] && [ -s "$STATE_FILE" ]
}

# Build HTML bullet list for job summary and PR comments (avoids markdown # fragment bugs).
reportportal_build_launch_html() {
  local title="$1"
  if ! reportportal_has_launches; then
    return 0
  fi

  echo "<h3>${title}</h3>"
  echo "<ul>"

  local layer uuid url
  while IFS= read -r line; do
    layer=$(echo "$line" | jq -r '.layer')
    uuid=$(echo "$line" | jq -r '.uuid')
    url=$(reportportal_launch_url "$uuid")
    echo "<li><strong>${layer}</strong>: <a href=\"${url}\">View launch</a> <code>${uuid}</code></li>"
  done < <(sort -u "$STATE_FILE")

  echo "</ul>"
}

# Deprecated markdown builder — kept for tests / local debugging only.
reportportal_build_launch_markdown() {
  local title="$1"
  if ! reportportal_has_launches; then
    return 0
  fi

  echo "### ${title}"
  echo ""

  local layer uuid url
  while IFS= read -r line; do
    layer=$(echo "$line" | jq -r '.layer')
    uuid=$(echo "$line" | jq -r '.uuid')
    url=$(reportportal_launch_url "$uuid")
    echo "- **${layer}**: <${url}>"
  done < <(sort -u "$STATE_FILE")

  echo ""
}

reportportal_write_summary() {
  local workflow="${1:-ci}"
  if ! reportportal_has_launches; then
    echo "No ReportPortal launches recorded for ${workflow}" >&2
    return 0
  fi

  if [ -z "${GITHUB_STEP_SUMMARY:-}" ]; then
    reportportal_build_launch_html "ReportPortal · ${workflow}"
    return 0
  fi

  {
    echo ""
    reportportal_build_launch_html "ReportPortal · ${workflow}"
  } >>"$GITHUB_STEP_SUMMARY"
}

reportportal_marker_for_workflow() {
  case "${1:-ci}" in
    e2e) echo "$MARKER_E2E" ;;
    *) echo "$MARKER_CI" ;;
  esac
}

reportportal_build_pr_body() {
  local workflow="$1"
  local marker
  marker=$(reportportal_marker_for_workflow "$workflow")

  local title
  case "$workflow" in
    e2e) title="ReportPortal · E2E" ;;
    *) title="ReportPortal · CI" ;;
  esac

  {
    echo "$marker"
    reportportal_build_launch_html "$title"
    echo "<p><em>Workflow run: <a href=\"${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-}/actions/runs/${GITHUB_RUN_ID:-}\">${GITHUB_RUN_ID:-local}</a></em></p>"
  }
}

reportportal_update_pr_comment() {
  local workflow="${1:-ci}"

  if [ "${GITHUB_EVENT_NAME:-}" != "pull_request" ]; then
    return 0
  fi

  if ! reportportal_has_launches; then
    echo "No ReportPortal launches to post for ${workflow}" >&2
    return 0
  fi

  if ! command -v gh >/dev/null 2>&1; then
    echo "gh CLI required to update PR comment" >&2
    return 1
  fi

  local marker pr_number body existing_id
  marker=$(reportportal_marker_for_workflow "$workflow")
  pr_number="${GITHUB_PR_NUMBER:-${GITHUB_EVENT_PULL_REQUEST_NUMBER:-}}"
  if [ -z "$pr_number" ]; then
    echo "PR number not available; skipping comment" >&2
    return 0
  fi
  body=$(reportportal_build_pr_body "$workflow")

  existing_id=$(
    gh api "repos/${GITHUB_REPOSITORY}/issues/${pr_number}/comments" --paginate \
      --jq ".[] | select(.body | contains(\"${marker}\")) | .id" 2>/dev/null | head -1 || true
  )

  if [ -n "$existing_id" ]; then
    gh api -X PATCH "repos/${GITHUB_REPOSITORY}/issues/comments/${existing_id}" \
      -f body="$body" >/dev/null
    echo "Updated ReportPortal PR comment (${workflow})"
  else
    gh pr comment "$pr_number" --body "$body" >/dev/null
    echo "Created ReportPortal PR comment (${workflow})"
  fi
}

usage() {
  cat <<'EOF'
Usage: reportportal-ci-summary.sh <command> [args]

Commands:
  record-log <layer> <logfile>   Append UUIDs parsed from test log
  record-env <layer>             Append RP_LAUNCH_UUID when set
  write-summary [workflow]       Append launch links to GITHUB_STEP_SUMMARY
  update-pr-comment [workflow]   Create or update PR comment (ci|e2e)
  launch-url <uuid>              Print a single launch URL (for tests)
  parse-uuids <logfile>          Print UUIDs from log (for tests)
EOF
}

main() {
  local cmd="${1:-}"
  shift || true

  case "$cmd" in
    record-log)
      reportportal_record_log "$1" "$2"
      ;;
    record-env)
      reportportal_record_env "$1"
      ;;
    write-summary)
      reportportal_write_summary "${1:-ci}"
      ;;
    update-pr-comment)
      reportportal_update_pr_comment "${1:-ci}"
      ;;
    launch-url)
      reportportal_launch_url "$1"
      ;;
    parse-uuids)
      reportportal_parse_uuids "$1"
      ;;
    "")
      usage >&2
      exit 1
      ;;
    *)
      echo "Unknown command: ${cmd}" >&2
      usage >&2
      exit 1
      ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main "$@"
fi
