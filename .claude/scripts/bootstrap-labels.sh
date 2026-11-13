#!/usr/bin/env bash
# Create or update the issue label set on the GitHub repo.
#
# Two parts. The base set below is what triage, orchestrate and
# issue-status.sh assume exists in every repository — the type labels, the
# status:* family (read from status-labels.txt, its single source), epic and
# security. The repo's own labels come from .claude/workflow.json: its area:* labels, its risk label (e.g.
# safety-critical, data-loss-risk), its maintainer-only label (e.g.
# needs-sudo) and any extras.
#
# Idempotent: `--force` on label creation updates colour and description on an
# existing label instead of failing, so re-running after editing the config is
# the way to change a label. Labels that exist on the repo but are in neither
# set are left alone. `--dry-run` prints the names without calling gh.
set -euo pipefail

HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=workflow-config.sh
source "$HERE/workflow-config.sh"

die() { printf '%s\n' "$*" >&2; exit 1; }

DRY_RUN=0
for arg in "$@"; do
  case $arg in
    --dry-run) DRY_RUN=1 ;;
    *) die "usage: $0 [--dry-run]" ;;
  esac
done

REPO=$(wf_repo)

base_labels=(
  # name|colour|description
  "feat|0e8a16|New capability"
  "bug|d73a4a|Something isn't working"
  "chore|fef2c0|Maintenance, tooling, CI"
  "docs|0075ca|Documentation only"
  "spike|c2e0c6|Time-boxed investigation; deliverable is recorded findings"

  "epic|3e4b9e|Parent issue with sub-issues"
  "security|e11d21|A public issue for a security defect or hardening"
  "regression|b60205|A defect that came back after its fix shipped"
  "dependencies|0366d6|A dependency bump or vulnerable-dependency fix"
)

# The status:* family, from the one file that defines it.
status_labels=()
while IFS= read -r line; do
  [[ -z $line || $line == \#* ]] || status_labels+=("$line")
done <"$HERE/status-labels.txt"

# The repo's own labels, as the same name|colour|description lines. Each is
# optional in the config; a missing colour falls back to a neutral grey.
repo_labels_raw=$(wf_get_json '
  [ (.labels.areas // [])[],
    (.labels.risk // empty),
    (.labels.maintainerOnly // empty),
    (.labels.extra // [])[] ]
  | map("\(.name)|\(.color // "ededed")|\(.description // "")")' '[]' | jq -r '.[]') \
  || die "could not read labels from $WF_CONFIG"

repo_labels=()
if [[ -n $repo_labels_raw ]]; then mapfile -t repo_labels <<<"$repo_labels_raw"; fi

for entry in "${base_labels[@]}" "${status_labels[@]}" ${repo_labels[@]+"${repo_labels[@]}"}; do
  IFS='|' read -r name colour description <<<"$entry"
  [[ -n $name ]] || continue
  if ((DRY_RUN)); then
    printf '%s\n' "$name"
    continue
  fi
  gh label create "$name" --repo "$REPO" --color "$colour" --description "$description" --force >/dev/null
  printf '%s\n' "$name"
done
