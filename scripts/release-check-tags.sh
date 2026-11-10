#!/usr/bin/env bash
# Refuses to push an image tag that already exists in the registry (doc 08
# section 6.2, Q92: "an image tag that already exists is never pushed again").
# The `build` job of .github/workflows/release.yml runs it immediately before
# the push. `plan` refuses an existing version too, but GitHub's "Re-run failed
# jobs" reuses the outputs of the jobs that succeeded and skips `plan`, so a
# re-run of `build` after a published push would push `:<version>` again with a
# new digest. This check is made in `build` itself, so no re-run path avoids it.
#
#   scripts/release-check-tags.sh
#
# Environment:
#   TAGS   the image references the job is about to push, comma separated, as
#          scripts/release-plan.sh plans them (<image>:<tag>[,<image>:<tag>]).
#
# The registry is read only, with the login the job already holds
# (`docker buildx imagetools inspect <image>:<tag>`); no token is read here.
# Each tag is looked up. A tag that exists fails the script with a message
# naming it and saying the version must be bumped. Only the registry's own
# "not found" means a tag is free; any other answer (an error, a refusal, a
# network failure, a docker that could not run) fails the script, because the
# tag is not known to be free. Nothing is pushed by this script.
set -euo pipefail

die() {
  printf 'release-check-tags: refused. %s\n' "$1" >&2
  exit 1
}

tags="${TAGS:-}"
[[ -n "$tags" ]] || die "TAGS is empty, so there is nothing to check."

# `read` drops a trailing empty entry, so a stray comma is judged on the whole string.
[[ "$tags" != ,* && "$tags" != *, && "$tags" != *,,* ]] || die "TAGS holds an empty or malformed entry."
IFS=',' read -r -a tag_list <<<"$tags"
((${#tag_list[@]} > 0)) || die "TAGS names no tag."

for tag in "${tag_list[@]}"; do
  [[ -n "$tag" && "$tag" != *[[:space:]]* ]] || die "TAGS holds an empty or malformed entry."
  inspect_exit=0
  answer="$(docker buildx imagetools inspect "$tag" 2>&1)" || inspect_exit=$?
  if ((inspect_exit == 0)); then
    die "${tag} already exists in the registry. A published tag is never overwritten: bump the version instead of re-running this release."
  fi
  # 126 and 127 are the shell saying docker could not run ("command not found"),
  # not the registry saying the tag is free.
  if ((inspect_exit == 126 || inspect_exit == 127)) || ! grep -qiE ': not found$|manifest unknown|name unknown' <<<"$answer"; then
    die "could not tell whether ${tag} exists in the registry (exit ${inspect_exit}): ${answer}"
  fi
  printf 'release-check-tags: %s is not in the registry.\n' "$tag"
done
