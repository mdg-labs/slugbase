#!/usr/bin/env bash
# Fails when the committed OpenAPI document breaks /api/v1 compared with the
# document at the latest release tag reachable from main (doc 04 §1.1, §2.2):
# a breaking change goes to /api/v2, never into v1. Only paths under /api/v1 are
# compared; unversioned paths such as /api/config are outside the promise.
#
# Nothing to compare against (no tag on main yet) is a pass. Everything else that
# stops the comparison from running (oasdiff missing or crashing, main not
# visible, a shallow clone, a tag whose tree has no document, a git failure)
# fails, so a broken check can never read as "no breaking change".
#
# A schema marked `x-extensible-enum: true` next to its `enum` (how the contracts
# package declares an enum clients must tolerate growing, doc 04 §2.2) is
# rewritten before the comparison to `x-extensible-enum: [values]` with no
# `enum`, the only form oasdiff treats as extensible: a value added to it in a
# response is additive, while a value removed from it in a request still fails.
# Unmarked enums are compared as they are.
#
# Environment: OASDIFF names the oasdiff binary (default: oasdiff on PATH).
set -euo pipefail

spec="packages/contracts/generated/openapi.json"
oasdiff="${OASDIFF:-oasdiff}"

die() {
  printf 'openapi-breaking: %s\n' "$1" >&2
  exit 1
}

root="$(git rev-parse --show-toplevel)"
cd "$root"

# Checked before the tag lookup so a runner without the tool fails even while
# there is nothing to compare yet.
command -v "$oasdiff" > /dev/null || die "$oasdiff not found (CI installs a pinned release; set OASDIFF to a binary)"
command -v node > /dev/null || die "node not found (it normalises x-extensible-enum before the comparison)"

if [[ "$(git rev-parse --is-shallow-repository)" == "true" ]]; then
  die "shallow clone: fetch full history and tags (actions/checkout fetch-depth: 0)"
fi

# CI checks out a pull request or feature branch without a local main.
if git rev-parse --verify --quiet "refs/heads/main^{commit}" > /dev/null; then
  main_ref="refs/heads/main"
elif git rev-parse --verify --quiet "refs/remotes/origin/main^{commit}" > /dev/null; then
  main_ref="refs/remotes/origin/main"
else
  die "cannot see main (neither refs/heads/main nor refs/remotes/origin/main); fetch it"
fi

merged_tags="$(git tag --merged "$main_ref")"
if [[ -z "$merged_tags" ]]; then
  printf 'openapi-breaking: no release tag is reachable from main yet; nothing to compare against\n'
  exit 0
fi
# The nearest tag by history, so a tag on a branch that never reached main does
# not count.
tag="$(git describe --tags --abbrev=0 "$main_ref")"

[[ -f "$spec" ]] || die "$spec not found in the working tree"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

git cat-file -e "refs/tags/$tag:$spec" 2> /dev/null || die "$spec does not exist at tag $tag"
git show "refs/tags/$tag:$spec" > "$tmp/tag.json"

# normalise IN OUT: rewrites every `x-extensible-enum: true` schema that has an
# `enum` to `x-extensible-enum: [values]` without it. A document that does not
# parse, or cannot be written, fails here rather than being compared as it is.
normalise() {
  node -e '
    const fs = require("node:fs");
    const walk = (node) => {
      if (Array.isArray(node)) {
        node.forEach(walk);
      } else if (node !== null && typeof node === "object") {
        if (node["x-extensible-enum"] === true && Array.isArray(node.enum)) {
          node["x-extensible-enum"] = node.enum;
          delete node.enum;
        }
        Object.values(node).forEach(walk);
      }
    };
    const doc = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    walk(doc);
    fs.writeFileSync(process.argv[2], JSON.stringify(doc));
  ' "$1" "$2" || die "cannot normalise x-extensible-enum in $1"
}
normalise "$tmp/tag.json" "$tmp/openapi@$tag.json"
normalise "$spec" "$tmp/openapi.json"

# oasdiff rates the removal of an optional response field as info; doc 04 §2.2
# calls any removed field breaking, so it is raised to an error here. Combined
# with --fail-on WARN, every warning and error fails the check.
printf 'response-optional-property-removed err\n' > "$tmp/severity-levels.txt"

printf 'openapi-breaking: comparing /api/v1 in %s with tag %s\n' "$spec" "$tag"
rc=0
"$oasdiff" breaking "$tmp/openapi@$tag.json" "$tmp/openapi.json" \
  --match-path '^/api/v1(/|$)' \
  --severity-levels "$tmp/severity-levels.txt" \
  --fail-on WARN || rc=$?

case "$rc" in
  0) printf 'openapi-breaking: no breaking change in /api/v1 since %s\n' "$tag" ;;
  1) die "breaking change in /api/v1 since $tag; ship it under /api/v2 instead (doc 04 §2.2)" ;;
  *) die "oasdiff failed (exit $rc)" ;;
esac
