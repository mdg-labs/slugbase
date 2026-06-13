#!/usr/bin/env bash
# Run Playwright e2e in CI with a tee'd log and a reliable non-zero exit on failures.
#
# GHA uses `pnpm … | tee log` for ReportPortal log capture. In practice Playwright
# can print "N failed" in the list summary while the piped pipeline still exits 0
# (see run 27464021161). Process substitution avoids the pipe; we also parse the
# final Playwright summary line as a backstop.
set -euo pipefail

project="${1:?usage: e2e-ci-playwright.sh <hosted|self-hosted> <log-file>}"
log_file="${2:?usage: e2e-ci-playwright.sh <hosted|self-hosted> <log-file>}"

pnpm e2e:direct --project="$project" > >(tee "$log_file") 2>&1
exit_code=$?

summary_failed="$(
  grep -E '^[[:space:]]+[0-9]+ failed$' "$log_file" | tail -1 | grep -Eo '[0-9]+' | head -1 || true
)"

if [ "$exit_code" -ne 0 ]; then
  exit "$exit_code"
fi

if [ -n "$summary_failed" ] && [ "$summary_failed" -gt 0 ]; then
  echo "Playwright list summary reports ${summary_failed} failed test(s)" >&2
  exit 1
fi

exit 0
