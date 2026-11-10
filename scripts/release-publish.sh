#!/usr/bin/env bash
# Moves the floating image tags when a GitHub Release is published (doc 08
# section 6.2, Q92, doc 10 T16). The build job of .github/workflows/release.yml
# pushes `:<version>` only, signs it and opens a draft release; the tags that
# move are not touched until a maintainer publishes that release. This script is
# run by the `publish` job of the same workflow, on the `release` event.
#
#   scripts/release-publish.sh [--dry-run]
#
# Every run reconciles the two floating tags, whichever release it was started
# for. `:latest` is to point at the highest published stable release (a release that
# is not a draft and not flagged as a pre-release) and `:<major>.<minor>`, of the
# release this run is for, at the highest published release of that line, compared
# as numbers (1.10.0 is above 1.9.0). The digest of each is the one in its own
# notes ("Image: <image>@sha256:<64 hex>", exactly one). A tag that already
# points at that digest is left alone; any other is moved there, after
# `scripts/verify-image.sh --digest <that digest> <image>:<version>` passes for the
# release it is moved to: the version tag has to resolve to the digest the build
# recorded, and that digest has to be signed, with its attestations, by the identity
# of this workflow on main. So a publish run that was dropped (GitHub replaces a
# waiting job of a concurrency group with a newer one) or that failed is repaired
# only as far as the next run reconciles: `:latest` and that run's own line's
# `:<major>.<minor>`. The tag of another line waits for that line's next publish or
# for a re-run of the cancelled run. A release below the highest published one
# never leaves a tag on a lower version. When both tags are already right the run
# ends green and moves nothing.
#
# A pre-release (a version with a suffix such as 1.0.0-rc.1, or a release GitHub
# flags as a pre-release) moves nothing and the script exits 0: that is the
# decision, not a failure. Everything else that stops the move fails the script
# (exit 1) before anything is retagged:
#   - the release is not found, is still a draft, or its tag is not the one asked for;
#   - the published releases cannot be read, or the list does not hold this release
#     (an empty list moves nothing);
#   - the notes of a release a tag is to move to do not name exactly one image digest;
#   - the verification above fails for a release a tag is to move to;
#   - the retagging itself fails.
# The list of published releases is read from the API at run time, and the release
# itself too (not the event payload), so a release changed after the event is judged
# as it now is. After the move every tag moved is verified again by digest and the
# list is read again: a release above the one a tag was moved to, published while
# this ran, fails the job, so that a retagging that was overtaken is never taken for
# done. The publish job has a concurrency group of its own that never cancels a
# running job; a job waiting behind it can still be replaced by a newer one, which
# is why every run reconciles. Nothing is pushed in --dry-run: every check runs,
# then the script prints the tags it would move.
#
# Environment:
#   RELEASE_TAG        the tag of the published release, v<semver> (github.event.release.tag_name).
#   GITHUB_REPOSITORY  owner/name of the repository this run belongs to.
#   GH_TOKEN           the workflow token, with contents: read (the release is read with `gh`).
#   RELEASE_IMAGE      image name without a tag; default ghcr.io/mdg-labs/slugbase.
#   The registry login is the one the job already holds (packages: write); no
#   token is read or printed here.
#
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
image="${RELEASE_IMAGE:-ghcr.io/mdg-labs/slugbase}"

die() {
  printf 'release-publish: refused. %s\n' "$1" >&2
  exit 1
}

dry_run=false
case "${1:-}" in
  "") ;;
  --dry-run) dry_run=true ;;
  *) die "usage: release-publish.sh [--dry-run]" ;;
esac
(($# <= 1)) || die "usage: release-publish.sh [--dry-run]"

repository="${GITHUB_REPOSITORY:-}"
release_tag="${RELEASE_TAG:-}"

repository_pattern='^[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9._-]{1,100}$'
[[ "$repository" =~ $repository_pattern ]] || die "GITHUB_REPOSITORY is not of the form owner/name."

# semver.org 2.0.0 without build metadata, as scripts/release-plan.sh reads it.
number='(0|[1-9][0-9]*)'
identifier='(0|[1-9][0-9]*|[0-9]*[a-zA-Z-][0-9a-zA-Z-]*)'
tag_pattern="^v(${number}\\.${number}\\.${number}(-${identifier}(\\.${identifier})*)?)\$"
if ((${#release_tag} > 129)) || [[ ! "$release_tag" =~ $tag_pattern ]]; then
  die "RELEASE_TAG is not v<semver> without build metadata."
fi
version="${BASH_REMATCH[1]}"
major="${BASH_REMATCH[2]}"
minor="${BASH_REMATCH[3]}"
patch="${BASH_REMATCH[4]}"

# The tag computation: a version with a suffix moves nothing.
if [[ "$version" == *-* ]]; then
  printf 'release-publish: %s is a pre-release; :latest and :%s.%s are not moved.\n' "$version" "$major" "$minor"
  exit 0
fi

# The numbers of a stable v<semver> tag as "major minor patch", or nothing.
stable_numbers() {
  local re="^v(${number})\\.(${number})\\.(${number})\$"
  if [[ "$1" =~ $re ]]; then
    printf '%s %s %s\n' "${BASH_REMATCH[1]}" "${BASH_REMATCH[3]}" "${BASH_REMATCH[5]}"
  fi
}

# True when version a is above version b, each "major minor patch", compared as
# numbers so that 1.10.0 is above 1.9.0 (10#: never read as octal).
version_above() {
  local -a a b
  read -r -a a <<<"$1"
  read -r -a b <<<"$2"
  local i
  for i in 0 1 2; do
    if ((10#${a[i]} > 10#${b[i]})); then return 0; fi
    if ((10#${a[i]} < 10#${b[i]})); then return 1; fi
  done
  return 1
}

# The highest published stable version of the repository, and of the line
# major.minor of this release, as "major minor patch" (this release included).
# Drafts, pre-releases and tags that are not stable v<semver> do not count. The
# list is kept in $releases for the notes of the releases in it. A list that
# cannot be read stops the script, and so does one in which this release does not
# appear as published: an empty list is not a list that allows a move.
releases=""
highest_all=""
highest_line=""
highest_published() {
  local tag numbers tags own=false
  if ! releases="$(gh api --paginate "repos/${repository}/releases?per_page=100" 2>&1)"; then
    die "the published releases could not be read: ${releases}"
  fi
  tags="$(jq -r '.[] | select(.draft == false and .prerelease == false) | .tag_name' <<<"$releases")" \
    || die "the list of the published releases is not readable."
  highest_all="$major $minor $patch"
  highest_line="$major $minor $patch"
  while IFS= read -r tag; do
    [[ "$tag" == "$release_tag" ]] && own=true
    numbers="$(stable_numbers "$tag")"
    [[ -n "$numbers" ]] || continue
    if version_above "$numbers" "$highest_all"; then highest_all="$numbers"; fi
    if [[ "$numbers" == "$major $minor "* ]] && version_above "$numbers" "$highest_line"; then highest_line="$numbers"; fi
  done <<<"$tags"
  [[ "$own" == true ]] || die "the list of the published releases does not hold ${release_tag}, so no tag is moved on its account."
}

# The single image digest a release's notes name, as the build's draft writes it,
# or nothing. $1 is the notes text.
notes_digest() {
  local line found="" count=0
  while IFS= read -r line; do
    line="${line%$'\r'}"
    if [[ "$line" == "Image: ${image}@sha256:"* ]]; then
      found="${line#"Image: ${image}@"}"
      count=$((count + 1))
    fi
  done <<<"$1"
  if ((count == 1)) && [[ "$found" =~ ^sha256:[0-9a-f]{64}$ ]]; then printf '%s\n' "$found"; fi
}

# The digest a tag of the image resolves to now, or nothing when it has none.
tag_digest() {
  local inspected
  inspected="$(docker buildx imagetools inspect "${image}:$1" 2>/dev/null)" || return 0
  sed -nE 's/^Digest:[[:space:]]+(sha256:[0-9a-f]{64})[[:space:]]*$/\1/p' <<<"$inspected" | head -n 1
}

# The release as it is now. The endpoint does not return a draft, so a draft and
# a missing release both end here.
release_json=""
if ! release_json="$(gh api "repos/${repository}/releases/tags/${release_tag}" 2>&1)"; then
  die "the release ${release_tag} could not be read, or is still a draft: ${release_json}"
fi
fields="$(jq -r '[(.tag_name // ""), (.draft | tostring), (.prerelease | tostring)] | join(" ")' <<<"$release_json")" \
  || die "the answer of the API for ${release_tag} is not readable."
read -r api_tag api_draft api_prerelease <<<"$fields"
[[ "$api_tag" == "$release_tag" ]] || die "the API answered for the tag '${api_tag}', not ${release_tag}."
[[ "$api_draft" == "false" ]] || die "the release ${release_tag} is a draft, not published."
if [[ "$api_prerelease" == "true" ]]; then
  printf 'release-publish: %s is flagged as a pre-release; :latest and :%s.%s are not moved.\n' "$release_tag" "$major" "$minor"
  exit 0
fi
[[ "$api_prerelease" == "false" ]] || die "the release ${release_tag} has no readable pre-release flag."

# The version order. `:latest` follows the highest published stable version and
# `:<major>.<minor>` the highest of this release's line. Every run reconciles both
# tags to those releases, whichever release it was started for: a tag that already
# points at the digest of its release is left alone, any other is moved there after
# that release is verified. So a run that was dropped or failed earlier is repaired
# for `:latest` and for this run's own line by the next one (another line's tag waits
# for that line's next publish or a re-run), and a release below the highest is no
# reason to leave a tag wrong.
highest_published
targets=("latest|${highest_all}" "${major}.${minor}|${highest_line}")
plan=()
verify_versions=()
for target in "${targets[@]}"; do
  tag="${target%%|*}"
  numbers="${target#*|}"
  target_version="${numbers// /.}"
  target_tag="v${target_version}"
  if [[ "$target_tag" == "$release_tag" ]]; then
    target_body="$(jq -r '.body // ""' <<<"$release_json")" || die "the notes of ${release_tag} are not readable."
  else
    target_body="$(jq -r --arg tag "$target_tag" '[.[] | select(.tag_name == $tag and .draft == false and .prerelease == false)][0].body // ""' <<<"$releases")" \
      || die "the notes of ${target_tag} are not readable."
  fi
  target_digest="$(notes_digest "$target_body")"
  [[ -n "$target_digest" ]] || die "the notes of ${target_tag}, which :${tag} follows, do not name exactly one image digest as 'Image: ${image}@sha256:<64 hex>'."
  if [[ "$(tag_digest "$tag")" == "$target_digest" ]]; then
    printf 'release-publish: :%s already points at %s (%s).\n' "$tag" "$target_digest" "$target_tag"
    continue
  fi
  plan+=("${tag}|${target_version}|${target_digest}")
  case " ${verify_versions[*]:-} " in
    *" ${target_version}|${target_digest} "*) ;;
    *) verify_versions+=("${target_version}|${target_digest}") ;;
  esac
done
if ((${#plan[@]} == 0)); then
  printf 'release-publish: %s: :latest and :%s.%s are already on the releases they follow; nothing to move.\n' "$release_tag" "$major" "$minor"
  exit 0
fi

# Each release a tag is to move to has to resolve, by its version tag, to the digest
# its notes name, and that digest has to be signed, with its attestations, by the
# identity of the release workflow on main.
for entry in "${verify_versions[@]}"; do
  target_version="${entry%%|*}"
  target_digest="${entry#*|}"
  printf 'release-publish: verifying %s:%s against %s\n' "$image" "$target_version" "$target_digest"
  bash "$here/verify-image.sh" --digest "$target_digest" "${image}:${target_version}" \
    || die "the image ${image}:${target_version} is not verified as the signed digest ${target_digest}; nothing was moved."
done

for entry in "${plan[@]}"; do
  IFS='|' read -r tag target_version target_digest <<<"$entry"
  if [[ "$target_version" != "${major}.${minor}.${patch}" ]]; then
    printf 'release-publish: :%s follows v%s, which is not %s; it moves to that release.\n' "$tag" "$target_version" "$release_tag"
  fi
done

if [[ "$dry_run" == "true" ]]; then
  for entry in "${plan[@]}"; do
    IFS='|' read -r tag target_version target_digest <<<"$entry"
    printf 'release-publish: dry run. Would point :%s at %s (v%s).\n' "$tag" "$target_digest" "$target_version"
  done
  exit 0
fi

# One retagging per digest; the two tags usually go to the same one.
digests_to_move=()
for entry in "${plan[@]}"; do
  target_digest="${entry##*|}"
  case " ${digests_to_move[*]:-} " in
    *" ${target_digest} "*) ;;
    *) digests_to_move+=("$target_digest") ;;
  esac
done
for target_digest in "${digests_to_move[@]}"; do
  create_args=()
  for entry in "${plan[@]}"; do
    IFS='|' read -r tag target_version entry_digest <<<"$entry"
    if [[ "$entry_digest" == "$target_digest" ]]; then create_args+=(--tag "${image}:${tag}"); fi
  done
  docker buildx imagetools create "${create_args[@]}" "${image}@${target_digest}" || die "retagging ${image}@${target_digest} failed."
done

# What moved has to be what was signed.
moved_list=""
for entry in "${plan[@]}"; do
  IFS='|' read -r tag target_version target_digest <<<"$entry"
  bash "$here/verify-image.sh" --digest "$target_digest" "${image}:${tag}" || die "after the move, ${image}:${tag} is not verified as ${target_digest}."
  moved_list+="${moved_list:+ and }:${tag}"
done
# Overlapping runs: a release published while this ran has a run of its own, which
# may have been replaced while it waited. If the list now holds a release above the
# one a tag was moved to, say so and fail, so that a retagging that was overtaken is
# not taken for done; the next publish run, or a re-run of the one that was
# cancelled, moves the tags to it.
highest_published
for entry in "${plan[@]}"; do
  IFS='|' read -r tag target_version target_digest <<<"$entry"
  followed="$highest_line"
  if [[ "$tag" == latest ]]; then followed="$highest_all"; fi
  if version_above "$followed" "${target_version//./ }"; then
    die "after the move, v${followed// /.} is published and is above v${target_version}, which :${tag} follows; the next publish run has to move the tag to it (re-run the run of that release if it was cancelled)."
  fi
done
printf 'release-publish: moved %s.\n' "$moved_list"
