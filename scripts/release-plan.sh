#!/usr/bin/env bash
# Decides whether a push to main publishes a release image, and which tags it
# carries (doc 08 section 6.2, Q92). Usage:
#
#   scripts/release-plan.sh <previous-commit> <commit>
#
# It compares the `version` of apps/slugbase/package.json at the two commits of
# the working directory's repository. The previous commit is the push's
# `before`. Output is `key=value` lines on standard output and, when
# GITHUB_OUTPUT is set, appended to that file:
#
#   release=false                      the version did not change; nothing is built or pushed
#   release=true                       and, after it:
#   version=<semver>
#   prerelease=true|false              true when the version has a pre-release suffix
#   git_tag=v<semver>
#   tags=<image>:<version>
#
# The build pushes `:<version>` only, for a pre-release and for any other version.
# `:<major>.<minor>` and `:latest` are floating tags: they are never planned or pushed
# by a build, because a build is a draft release candidate. Both move to the signed
# digest when a release without a suffix is published (scripts/release-publish.sh,
# Q92). The git tag `git_tag` is not created here: the build job creates
# it (scripts/release-tag.sh) on the pushed commit after the image is pushed and
# before it opens the draft release from that tag, because GitHub creates the tag of
# a draft only when the draft is published. The script refuses, with a non-zero
# exit and no `release=true`, when it cannot read either version, when the new
# version is not valid semver (build metadata is not allowed: it is not a valid
# image tag), when a git tag `v<version>` or an image `:<version>` already exists,
# or when the registry answers anything other than "not found" to the existence
# check.
#
# Environment:
#   RELEASE_IMAGE    image name without a tag; default ghcr.io/mdg-labs/slugbase.
#   REGISTRY_USER    with REGISTRY_TOKEN, logs in to the image's registry before the
#   REGISTRY_TOKEN   existence check. The token reaches only `docker login`, on its
#                    standard input, and is never printed.
#   GITHUB_OUTPUT    optional; the step output file.
set -euo pipefail

image="${RELEASE_IMAGE:-ghcr.io/mdg-labs/slugbase}"
manifest="apps/slugbase/package.json"

die() {
  printf 'release-plan: refused. %s\n' "$1" >&2
  exit 1
}

emit() {
  printf '%s=%s\n' "$1" "$2"
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    printf '%s=%s\n' "$1" "$2" >> "$GITHUB_OUTPUT"
  fi
}

(($# == 2)) || die "usage: release-plan.sh <previous-commit> <commit>"
before="$1"
sha="$2"

sha_pattern='^[0-9a-f]{40}$'
[[ "$sha" =~ $sha_pattern ]] || die "the commit is not 40 lowercase hexadecimal characters."
[[ "$before" =~ $sha_pattern ]] || die "the previous commit is not 40 lowercase hexadecimal characters."
[[ "$before" != "0000000000000000000000000000000000000000" ]] || die "the push has no previous commit to compare the version with."

version_at() {
  local content
  content="$(git show "$1:$manifest")" || return 1
  printf '%s' "$content" | node -e '
    let text = "";
    process.stdin.on("data", (chunk) => { text += chunk; });
    process.stdin.on("end", () => {
      const version = JSON.parse(text).version;
      if (typeof version !== "string") process.exit(1);
      process.stdout.write(version);
    });
  '
}

old_version="$(version_at "$before")" || die "cannot read the version in $manifest at ${before}."
new_version="$(version_at "$sha")" || die "cannot read the version in $manifest at ${sha}."

if [[ "$old_version" == "$new_version" ]]; then
  emit release false
  exit 0
fi

# semver.org 2.0.0 without build metadata, and short enough for an image tag.
number='(0|[1-9][0-9]*)'
identifier='(0|[1-9][0-9]*|[0-9]*[a-zA-Z-][0-9a-zA-Z-]*)'
semver_pattern="^${number}\\.${number}\\.${number}(-${identifier}(\\.${identifier})*)?\$"
if ((${#new_version} > 128)) || [[ ! "$new_version" =~ $semver_pattern ]]; then
  die "the version in $manifest is not valid semver without build metadata."
fi

# The tag is made after the image push, so a tag that exists before then belongs
# to an earlier run or to someone else, and the version is refused.
git_tag="v${new_version}"
if git rev-parse --quiet --verify "refs/tags/${git_tag}" > /dev/null; then
  die "the git tag ${git_tag} already exists."
fi

if [[ -n "${REGISTRY_TOKEN:-}" ]]; then
  [[ -n "${REGISTRY_USER:-}" ]] || die "REGISTRY_TOKEN is set without REGISTRY_USER."
  printf '%s' "$REGISTRY_TOKEN" | docker login "${image%%/*}" --username "$REGISTRY_USER" --password-stdin > /dev/null \
    || die "the registry login failed."
fi

# Only the registry's own "not found" means the version is free. Any other answer
# (an error, a refusal, a network failure, a docker that could not run and says
# "command not found" about itself) is not known to be free.
inspect_exit=0
answer="$(docker buildx imagetools inspect "${image}:${new_version}" 2>&1)" || inspect_exit=$?
if ((inspect_exit == 0)); then
  die "${image}:${new_version} already exists in the registry."
fi
if ((inspect_exit == 126 || inspect_exit == 127)) || ! grep -qiE ': not found$|manifest unknown|name unknown' <<<"$answer"; then
  die "could not tell whether ${image}:${new_version} exists in the registry."
fi

tags="${image}:${new_version}"
prerelease=true
if [[ "$new_version" != *-* ]]; then
  prerelease=false
fi

emit release true
emit version "$new_version"
emit prerelease "$prerelease"
emit git_tag "$git_tag"
emit tags "$tags"
