#!/usr/bin/env bash
# Writes the body of the draft GitHub Release (doc 08 section 6.2, doc 09 section
# 3.5). Usage:
#
#   scripts/release-notes.sh <output-file>
#
# The body is the release notes of the version, when docs/releases/<version>.md
# exists in the checkout, followed by the lines that name the image. Without a
# notes file the body is the image lines alone. The frontmatter of the docs
# contract is the page's metadata and is not part of the body. The image lines
# are what scripts/release-publish.sh reads: the single line
# "Image: <image>@sha256:<64 hex>" names the digest it retags to. A notes file
# is therefore refused when any of its lines starts with "Image:", so that the
# notes can never add a second digest line or stand in for the real one. A
# notes file that cannot be read, has no frontmatter or an unclosed one, or has
# no body is refused too: a draft is never made with a silently missing page.
# The output file is written only when every check has passed.
#
# Environment (all required):
#   VERSION  the semver of the release, as scripts/release-plan.sh planned it.
#   IMAGE    the image name without a tag.
#   DIGEST   the digest of the pushed image, sha256:<64 hex>.
#   TAGS     the tags that were pushed, comma separated.
#   SHA      the commit the image was built from.
set -euo pipefail

die() {
  printf 'release-notes: refused. %s\n' "$1" >&2
  exit 1
}

(($# == 1)) || die "usage: release-notes.sh <output-file>"
output="$1"

for name in VERSION IMAGE DIGEST TAGS SHA; do
  [[ -n "${!name:-}" ]] || die "$name is not set."
done

number='(0|[1-9][0-9]*)'
identifier='(0|[1-9][0-9]*|[0-9]*[a-zA-Z-][0-9a-zA-Z-]*)'
semver_pattern="^${number}\\.${number}\\.${number}(-${identifier}(\\.${identifier})*)?\$"
[[ "$VERSION" =~ $semver_pattern ]] || die "VERSION is not semver."
[[ "$DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]] || die "DIGEST is not sha256:<64 hex>."

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
notes_file="$root/docs/releases/$VERSION.md"
work="$(mktemp)"
trap 'rm -f "$work"' EXIT

# The page without its frontmatter and the blank lines after it.
page_body() {
  local line first=true in_frontmatter=false closed=false body="" text
  text="$(<"$1")" || return 1
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    if [[ "$first" == true ]]; then
      first=false
      line="${line#$'\xEF\xBB\xBF'}"
      [[ "$line" == "---" ]] || { printf 'the notes file has no frontmatter.\n' >&2; return 1; }
      in_frontmatter=true
      continue
    fi
    if [[ "$in_frontmatter" == true ]]; then
      if [[ "$line" == "---" ]]; then
        in_frontmatter=false
        closed=true
      fi
      continue
    fi
    [[ -n "$body" || -n "${line//[[:space:]]/}" ]] || continue
    body+="$line"$'\n'
  done <<<"$text"
  [[ "$closed" == true ]] || { printf 'the frontmatter of the notes file is not closed.\n' >&2; return 1; }
  printf '%s' "$body"
}

{
  if [[ -e "$notes_file" ]]; then
    [[ -f "$notes_file" && -r "$notes_file" ]] || die "$notes_file cannot be read."
    body="$(page_body "$notes_file")" || die "$notes_file cannot be used."
    [[ -n "${body//[[:space:]]/}" ]] || die "$notes_file has no body."
    if grep -qE '^Image:' <<<"$body"; then
      die "$notes_file has a line that starts with \"Image:\", which is how the digest is named."
    fi
    printf '%s\n\n---\n\n' "${body%$'\n'}"
  fi
  echo "Image: $IMAGE@$DIGEST"
  echo
  echo "Tags: ${TAGS//,/, }"
  echo
  echo "Publishing this release points the tags latest and <major>.<minor> at this image after the signature is verified again. A pre-release moves neither."
  echo
  echo "Built from $SHA with an SPDX SBOM and provenance attestations. The image and both attestations are signed with cosign, keyless, by the release workflow of this repository on main."
  echo
  echo "Verify the image before you run it, with scripts/verify-image.sh from this release: bash scripts/verify-image.sh $IMAGE@$DIGEST"
} > "$work"

cp "$work" "$output"
