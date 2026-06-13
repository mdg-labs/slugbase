#!/usr/bin/env bash
# Generate an Allure 3 HTML report from CI artifacts and stage a gh-pages payload.
#
# Uses allurerc.mjs (see https://allurereport.org/docs/v3/configure/).
# Discovers every package-level results directory — Allure 3 does not recurse
# into unit/<package>/ subtrees when given only the parent path.
set -euo pipefail

RESULTS_ROOT="${1:-allure-results}"
WORKFLOW="${ALLURE_WORKFLOW:-ci}"
SITE_BASE_URL="${ALLURE_SITE_BASE_URL:-https://mdg-labs.github.io/slugbase}"
REPORTS_SEGMENT="${ALLURE_REPORTS_SEGMENT:-test-reports}"
GH_PAGES_DIR="${GH_PAGES_DIR:-gh-pages-dir}"
OUTPUT_DIR="./allure-report-out"
PAGES_PAYLOAD="pages-payload"
HISTORY_FILE="allure-history-${WORKFLOW}.jsonl"

if ! command -v node >/dev/null 2>&1; then
  echo "node is required" >&2
  exit 1
fi

# Restore trend history from the previous gh-pages publish (per workflow).
if [ -f "${GH_PAGES_DIR}/${REPORTS_SEGMENT}/${HISTORY_FILE}" ]; then
  cp "${GH_PAGES_DIR}/${REPORTS_SEGMENT}/${HISTORY_FILE}" "./${HISTORY_FILE}"
  echo "Restored Allure history from gh-pages (${HISTORY_FILE})"
fi

mapfile -t RESULT_DIRS < <(
  find "$RESULTS_ROOT" -type f -name '*-result.json' -printf '%h\n' 2>/dev/null | sort -u
)

if [ "${#RESULT_DIRS[@]}" -eq 0 ]; then
  echo "No Allure *-result.json files under ${RESULTS_ROOT}" >&2
  exit 1
fi

echo "Found ${#RESULT_DIRS[@]} Allure results directory(ies) under ${RESULTS_ROOT}"

rm -rf "${OUTPUT_DIR}" "${PAGES_PAYLOAD}"
mkdir -p "${OUTPUT_DIR}"

# Config (output, history, plugins) from allurerc.mjs in repo root.
pnpm exec allure generate "${RESULT_DIRS[@]}"

RUN_SUFFIX="${GITHUB_RUN_NUMBER:-local}-${GITHUB_RUN_ATTEMPT:-1}"
REPORT_DEST="${REPORTS_SEGMENT}/${RUN_SUFFIX}"
REPORT_URL="${SITE_BASE_URL}/${REPORT_DEST}/index.html"

mkdir -p "${PAGES_PAYLOAD}/${REPORT_DEST}"
cp -r "${OUTPUT_DIR}/." "${PAGES_PAYLOAD}/${REPORT_DEST}/"
mkdir -p "${PAGES_PAYLOAD}/${REPORTS_SEGMENT}"
if [ -f "./${HISTORY_FILE}" ]; then
  cp "./${HISTORY_FILE}" "${PAGES_PAYLOAD}/${REPORTS_SEGMENT}/${HISTORY_FILE}"
fi

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "report-url=${REPORT_URL}"
    echo "reports-site-path=${REPORT_DEST}"
    echo "pages-payload=${PAGES_PAYLOAD}"
    echo "report-directory=${OUTPUT_DIR}"
  } >>"$GITHUB_OUTPUT"
fi

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo ""
    echo "## Test report"
    echo "[Allure test report](${REPORT_URL})"
    echo ""
  } >>"$GITHUB_STEP_SUMMARY"
fi

echo "Report URL: ${REPORT_URL}"
