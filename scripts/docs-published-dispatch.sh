#!/usr/bin/env bash
# Asks the site repository to rebuild after documentation changed on main (doc 09
# section 3.5, Q111). It calls the dispatch API of one workflow in the repository
# named by configuration:
#
#   POST /repos/{owner}/{repo}/actions/workflows/{workflow}/dispatches
#   {"ref":"main","inputs":{"docs_sha":"<the commit of this run>"}}
#
# Environment:
#   DOCS_SITE_REPOSITORY      owner/name of the site repository (repository variable).
#   DOCS_SITE_WORKFLOW        file name of its workflow, such as deploy.yml (repository variable).
#   DOCS_SITE_DISPATCH_TOKEN  a token with Actions: write on that one repository (secret).
#                             It reaches only the `gh` call below, as GH_TOKEN, and is never printed.
#   GITHUB_REPOSITORY         the repository this run belongs to.
#   GITHUB_SHA                the commit of this run, 40 hexadecimal characters.
#   GITHUB_STEP_SUMMARY       optional; the job summary file.
#
# It does nothing, and says so in the job summary, when the repository it runs in
# is not the upstream Community Edition repository (forks and self-hosters send
# nothing), or when the variables or the secret are unset. A malformed value, or
# an API answer other than success, fails the run.
set -euo pipefail

upstream="mdg-labs/slugbase"

summary_file="${GITHUB_STEP_SUMMARY:-/dev/null}"

note() {
  printf '%s\n' "$1"
  printf '%s\n' "$1" >> "$summary_file"
}

skip() {
  note "docs-published: nothing sent. $1"
  exit 0
}

die() {
  note "docs-published: failed. $1"
  exit 1
}

if [[ "${GITHUB_REPOSITORY:-}" != "$upstream" ]]; then
  skip "This repository is not the upstream Community Edition repository."
fi

site_repository="${DOCS_SITE_REPOSITORY:-}"
site_workflow="${DOCS_SITE_WORKFLOW:-}"

if [[ -z "$site_repository" ]]; then
  skip "The repository variable DOCS_SITE_REPOSITORY is not set."
fi
if [[ -z "$site_workflow" ]]; then
  skip "The repository variable DOCS_SITE_WORKFLOW is not set."
fi
if [[ -z "${DOCS_SITE_DISPATCH_TOKEN:-}" ]]; then
  skip "The secret DOCS_SITE_DISPATCH_TOKEN is not set."
fi

repository_pattern='^[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9._-]{1,100}$'
workflow_pattern='^[A-Za-z0-9][A-Za-z0-9._-]*\.(yml|yaml)$'
sha_pattern='^[0-9a-f]{40}$'

if [[ ! "$site_repository" =~ $repository_pattern ]]; then
  die "The repository variable DOCS_SITE_REPOSITORY is not of the form owner/name."
fi
if [[ ! "$site_workflow" =~ $workflow_pattern ]]; then
  die "The repository variable DOCS_SITE_WORKFLOW is not a workflow file name ending in .yml or .yaml."
fi

sha="${GITHUB_SHA:-}"
if [[ ! "$sha" =~ $sha_pattern ]]; then
  die "GITHUB_SHA is not a 40-character commit."
fi

payload="$(printf '{"ref":"main","inputs":{"docs_sha":"%s"}}' "$sha")"

if ! printf '%s' "$payload" | GH_TOKEN="$DOCS_SITE_DISPATCH_TOKEN" gh api \
  --method POST \
  "repos/${site_repository}/actions/workflows/${site_workflow}/dispatches" \
  --input - > /dev/null; then
  die "The dispatch request to ${site_repository} (${site_workflow}) was refused or did not complete."
fi

note "docs-published: asked ${site_repository} to run ${site_workflow} for ${sha}."
