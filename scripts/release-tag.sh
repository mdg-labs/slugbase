#!/usr/bin/env bash
# Creates the git tag of a release on the pushed commit (doc 08 section 6.2).
# GitHub creates the tag of a draft release only when the draft is published, so
# the release workflow makes the tag itself, through the API, after the image is
# pushed and before it opens the draft release from that existing tag. The tag
# is a lightweight tag: a ref `refs/tags/<tag>` that points at the commit.
#
#   POST /repos/{owner}/{repo}/git/refs   ref=refs/tags/<tag> sha=<commit>
#
# Environment:
#   GH_TOKEN           the workflow token (github.token), with contents: write.
#                      It reaches only the `gh` calls below and is never printed.
#   GITHUB_REPOSITORY  owner/name of the repository this run belongs to.
#   GIT_TAG            the tag to create, v<semver>, as scripts/release-plan.sh plans it.
#   SHA                the commit of this run, 40 hexadecimal characters.
#
# A tag that does not exist is created. A tag that exists on the same commit
# (a lightweight tag, or an annotated one that peels to it) lets the step go on,
# so a re-run of the step is harmless. A tag on another commit fails the step with
# a message naming the tag and both commits, and nothing creates the draft release
# after it. Any other answer of the API, on the lookup or on the creation, fails
# the step too.
set -euo pipefail

die() {
  printf 'release-tag: failed. %s\n' "$1" >&2
  exit 1
}

repository="${GITHUB_REPOSITORY:-}"
git_tag="${GIT_TAG:-}"
sha="${SHA:-}"

repository_pattern='^[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9._-]{1,100}$'
tag_pattern='^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$'
sha_pattern='^[0-9a-f]{40}$'
[[ "$repository" =~ $repository_pattern ]] || die "GITHUB_REPOSITORY is not of the form owner/name."
[[ "$git_tag" =~ $tag_pattern ]] || die "GIT_TAG is not v<semver>."
[[ "$sha" =~ $sha_pattern ]] || die "SHA is not a 40-character commit."

# Prints the commit the tag points at, or nothing when the tag does not exist.
# Only the API's own 404 means the tag is free; any other failure stops the step.
lookup() {
  local ref_json errors err_file object_type object_sha
  err_file="$(mktemp)"
  if ! ref_json="$(gh api "repos/${repository}/git/ref/tags/${git_tag}" 2> "$err_file")"; then
    errors="$(cat "$err_file")"
    rm -f "$err_file"
    if grep -q 'HTTP 404' <<<"$errors"; then
      return 0
    fi
    die "The lookup of ${git_tag} did not complete: ${errors}"
  fi
  rm -f "$err_file"
  object_type="$(jq -r '.object.type // empty' <<<"$ref_json")" || die "The lookup of ${git_tag} returned no readable answer."
  object_sha="$(jq -r '.object.sha // empty' <<<"$ref_json")" || die "The lookup of ${git_tag} returned no readable answer."
  # An annotated tag is an object of its own; the commit is what it points at.
  if [[ "$object_type" == "tag" ]]; then
    object_sha="$(gh api "repos/${repository}/git/tags/${object_sha}" --jq '.object.sha // empty')" \
      || die "The annotated tag ${git_tag} could not be read."
  elif [[ "$object_type" != "commit" ]]; then
    die "The tag ${git_tag} points at a ${object_type:-unknown} object, not a commit."
  fi
  [[ "$object_sha" =~ $sha_pattern ]] || die "The commit of ${git_tag} could not be read."
  printf '%s' "$object_sha"
}

# Compares a tag that exists with the commit of this run.
check_existing() {
  local existing="$1"
  if [[ "$existing" == "$sha" ]]; then
    printf 'release-tag: %s already points at %s; going on.\n' "$git_tag" "$sha"
    return 0
  fi
  die "The tag ${git_tag} already points at ${existing}, not at ${sha}, the commit of this run. The draft release is not created."
}

existing="$(lookup)"
if [[ -n "$existing" ]]; then
  check_existing "$existing"
  exit 0
fi

create_errors=""
if ! create_errors="$(gh api --method POST "repos/${repository}/git/refs" \
  -f "ref=refs/tags/${git_tag}" -f "sha=${sha}" 2>&1 > /dev/null)"; then
  # Another run may have created the tag between the lookup and the creation.
  existing="$(lookup)"
  if [[ -n "$existing" ]]; then
    check_existing "$existing"
    exit 0
  fi
  die "The tag ${git_tag} could not be created: ${create_errors}"
fi

printf 'release-tag: created %s at %s.\n' "$git_tag" "$sha"
