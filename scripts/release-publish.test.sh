#!/usr/bin/env bash
# Tests scripts/release-publish.sh with stand-ins for gh, docker and cosign, so no
# request leaves this machine and nothing is signed or pushed. The registry stand-in
# keeps state: `buildx imagetools create` points tags at a digest and `inspect`
# reads them back, so a test can see what moved and what did not. The cosign
# stand-in accepts only a digest it was told is signed, under the identity and issuer
# scripts/verify-image.sh requires, and scripts/verify-image.sh itself runs
# unchanged, so the decision tested is the one the publish job makes. It also reads
# the publish job of .github/workflows/release.yml.
# Fixtures hold shell syntax that must stay literal.
# shellcheck disable=SC2016
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
failures=0
out=""
code=0

mkdir -p "$tmp/bin"
cat > "$tmp/bin/gh" <<'STUB'
#!/usr/bin/env bash
# A stand-in for `gh api repos/<repo>/releases/tags/<tag>`: it answers with the
# release in $STUB_DIR/release.json, or with a 404 when the file is absent (the
# real endpoint does not return a draft either). `gh api --paginate
# repos/<repo>/releases?...` answers with the list in $STUB_DIR/releases.json, or
# with the one release of release.json when there is no list, and fails when
# $STUB_LIST_FAIL is set. $STUB_RELEASE_AFTER, when set, is a list that replaces
# the first one from the second reading on (a release published during the run).
# $STUB_NOTICE, when set, is written to stderr by every call, as gh does with a
# notice or its debug output on a call that succeeds.
printf 'gh %s\n' "$*" >> "$STUB_DIR/calls"
if [[ -n "${STUB_NOTICE:-}" ]]; then printf '%s\n' "$STUB_NOTICE" >&2; fi
if [[ "${1:-}" == "api" && "$*" == *"/releases?"* ]]; then
  if [[ -n "${STUB_LIST_FAIL:-}" ]]; then
    echo 'gh: HTTP 502' >&2
    exit 1
  fi
  reads="$(grep -c -- '/releases?' "$STUB_DIR/calls")"
  if ((reads > 1)) && [[ -n "${STUB_RELEASE_AFTER:-}" ]]; then
    printf '%s\n' "$STUB_RELEASE_AFTER"
  elif [[ -f "$STUB_DIR/releases.json" ]]; then
    cat "$STUB_DIR/releases.json"
  else
    jq -c '[.]' "$STUB_DIR/release.json"
  fi
  exit 0
fi
if [[ "${1:-}" == "api" && -f "$STUB_DIR/release.json" ]]; then
  cat "$STUB_DIR/release.json"
  exit 0
fi
echo 'gh: Not Found (HTTP 404)' >&2
exit 1
STUB
cat > "$tmp/bin/docker" <<'STUB'
#!/usr/bin/env bash
# A stand-in for docker with a registry in $STUB_DIR/registry ("ref digest" lines).
printf 'docker %s\n' "$*" >> "$STUB_DIR/calls"
if [[ "${1:-}" == "buildx" && "${2:-}" == "imagetools" && "${3:-}" == "inspect" ]]; then
  ref="$4"
  while read -r name digest; do
    if [[ "$name" == "$ref" ]]; then
      printf 'Name:      %s\nMediaType: application/vnd.oci.image.index.v1+json\nDigest:    %s\n' "$ref" "$digest"
      exit 0
    fi
  done < "$STUB_DIR/registry"
  echo "ERROR: $ref: not found" >&2
  exit 1
fi
if [[ "${1:-}" == "buildx" && "${2:-}" == "imagetools" && "${3:-}" == "create" ]]; then
  if [[ -n "${STUB_CREATE_FAIL:-}" ]]; then
    echo 'ERROR: failed to push' >&2
    exit 1
  fi
  shift 3
  tags=()
  while (($# > 1)); do
    if [[ "$1" == "--tag" ]]; then tags+=("$2"); fi
    shift
  done
  source_ref="$1"
  digest="${source_ref#*@}"
  # STUB_CREATE_WRONG simulates a registry that ends up with another digest.
  digest="${STUB_CREATE_WRONG:-$digest}"
  for tag in "${tags[@]}"; do
    grep -vF "$tag " "$STUB_DIR/registry" > "$STUB_DIR/registry.next" || true
    printf '%s %s\n' "$tag" "$digest" >> "$STUB_DIR/registry.next"
    mv "$STUB_DIR/registry.next" "$STUB_DIR/registry"
  done
  exit 0
fi
exit 99
STUB
cat > "$tmp/bin/cosign" <<'STUB'
#!/usr/bin/env bash
# A stand-in for cosign: verification succeeds for the digests in STUB_SIGNED
# (space separated), under the identity and issuer of the release workflow only,
# and for both attestation types.
if [[ "${1:-}" == version ]]; then
  printf 'GitVersion:    v3.1.4\n'
  exit 0
fi
printf 'cosign %s\n' "$*" >> "$STUB_DIR/calls"
identity=""
issuer=""
for ((i = 1; i < $#; i++)); do
  case "${!i}" in
    --certificate-identity) j=$((i + 1)); identity="${!j}" ;;
    --certificate-oidc-issuer) j=$((i + 1)); issuer="${!j}" ;;
  esac
done
subject="${!#}"
[[ "$identity" == "https://github.com/mdg-labs/slugbase/.github/workflows/release.yml@refs/heads/main" ]] || { echo 'Error: identity does not match' >&2; exit 1; }
[[ "$issuer" == "https://token.actions.githubusercontent.com" ]] || { echo 'Error: issuer does not match' >&2; exit 1; }
for digest in ${STUB_SIGNED:-}; do
  if [[ "$subject" == *"@$digest" ]]; then
    printf '{"payload":"not printed"}\n'
    exit 0
  fi
done
echo 'Error: no signatures found' >&2
exit 1
STUB
chmod +x "$tmp/bin/gh" "$tmp/bin/docker" "$tmp/bin/cosign"

image="ghcr.io/mdg-labs/slugbase"
d1="sha256:$(printf '1%.0s' {1..64})"
d2="sha256:$(printf '2%.0s' {1..64})"
d3="sha256:$(printf '3%.0s' {1..64})"
n=0
releases_list=""
releases_after=""

# A case: the registry, the release as the API returns it, and the run. Arguments:
# <registry lines> <release json or "none"> then the script's environment pairs and
# arguments after `--`.
run_case() {
  local registry="$1" release="$2"
  shift 2
  n=$((n + 1))
  STUB_DIR="$tmp/case-$n"
  mkdir -p "$STUB_DIR"
  : > "$STUB_DIR/calls"
  printf '%s' "$registry" > "$STUB_DIR/registry"
  if [[ "$release" != "none" ]]; then printf '%s\n' "$release" > "$STUB_DIR/release.json"; fi
  if [[ -n "${releases_list:-}" ]]; then printf '%s\n' "$releases_list" > "$STUB_DIR/releases.json"; fi
  local env_pairs=() script_args=()
  while (($# > 0)); do
    if [[ "$1" == "--" ]]; then
      shift
      script_args=("$@")
      break
    fi
    env_pairs+=("$1")
    shift
  done
  code=0
  out="$(env -i PATH="$tmp/bin:$PATH" STUB_DIR="$STUB_DIR" STUB_RELEASE_AFTER="${releases_after:-}" GITHUB_REPOSITORY="mdg-labs/slugbase" "${env_pairs[@]}" \
    bash "$here/release-publish.sh" "${script_args[@]}" 2>&1)" || code=$?
}

release_json() {
  # <tag> <draft> <prerelease> <body>
  jq -cn --arg tag "$1" --argjson draft "$2" --argjson prerelease "$3" --arg body "$4" \
    '{tag_name: $tag, draft: $draft, prerelease: $prerelease, body: $body}'
}

# A list of releases as the API returns it: "<tag>:<state>[:<digest>]" words, where
# the state is published, draft or pre-release (a stable tag with the pre-release
# flag) and the digest, when given, is the one the notes of that release name (the
# notes of the others say nothing).
releases_of() {
  local word tag rest state digest body draft prerelease items=()
  for word in "$@"; do
    tag="${word%%:*}"
    rest="${word#*:}"
    state="${rest%%:*}"
    digest=""
    [[ "$rest" == *:* ]] && digest="${rest#*:}"
    draft=false
    prerelease=false
    [[ "$state" == draft ]] && draft=true
    [[ "$state" == pre-release ]] && prerelease=true
    body="x"
    [[ -n "$digest" ]] && body="$(notes "$digest")"
    items+=("$(release_json "$tag" "$draft" "$prerelease" "$body")")
  done
  printf '%s\n' "${items[@]}" | jq -cs .
}

notes() {
  printf 'Image: %s@%s\n\nTags: x\n' "$image" "$1"
}

registry_digest() {
  awk -v ref="$1" '$1 == ref { print $2 }' "$STUB_DIR/registry"
}

calls_of() {
  grep -c -- "$1" "$STUB_DIR/calls" || true
}

moved() {
  [[ "$(calls_of 'imagetools create')" != 0 ]]
}

pass() {
  printf 'ok: %s\n' "$1"
}

fail() {
  printf 'FAIL: %s\n%s\n' "$1" "$out" >&2
  failures=$((failures + 1))
}

expect_refused() {
  local name="$1" words="$2"
  if ((code != 0)) && ! moved && grep -q -- "release-publish: refused" <<<"$out" && grep -q -- "$words" <<<"$out"; then
    pass "$name"
  else
    fail "$name (exit $code, moved $(moved && echo yes || echo no))"
  fi
}

expect_no_move() {
  local name="$1" words="$2"
  if ((code == 0)) && ! moved && [[ "$(calls_of '^docker')" == 0 && "$(calls_of '^cosign')" == 0 ]] && grep -q -- "$words" <<<"$out"; then
    pass "$name"
  else
    fail "$name (exit $code, calls: $(tr '\n' ';' < "$STUB_DIR/calls"))"
  fi
}

# A run that finds every tag where it is to be: green, nothing retagged, no signature asked for.
expect_unchanged() {
  local name="$1" words="$2"
  if ((code == 0)) && ! moved && [[ "$(calls_of '^cosign')" == 0 ]] && grep -q -- "$words" <<<"$out"; then
    pass "$name"
  else
    fail "$name (exit $code, calls: $(tr '\n' ';' < "$STUB_DIR/calls"))"
  fi
}

signed="STUB_SIGNED=$d1"
stable="$(release_json v1.0.0 false false "$(notes "$d1")")"
registry_one="${image}:1.0.0 $d1
"

# The tag computation, on the three fixtures of the item.
run_case "$registry_one" "$stable" RELEASE_TAG=v1.0.0-rc.1 "$signed" -- --dry-run
expect_no_move "fixture 1.0.0-rc.1: a pre-release moves nothing, and asks neither the API nor the registry" "pre-release"

run_case "$registry_one" "$stable" RELEASE_TAG=v1.0.0 "$signed" -- --dry-run
if ((code == 0)) && ! moved && grep -q -- "dry run. Would point :latest at $d1" <<<"$out" && grep -q -- "dry run. Would point :1.0 at $d1" <<<"$out"; then
  pass "fixture 1.0.0: the set is {:latest, :1.0}, and a dry run moves nothing"
else
  fail "fixture 1.0.0 dry run (exit $code)"
fi

run_case "$registry_one" "$stable" RELEASE_TAG=v1.0.0 "$signed"
if ((code == 0)) && [[ "$(registry_digest "${image}:latest")" == "$d1" && "$(registry_digest "${image}:1.0")" == "$d1" ]] \
  && grep -q -- "docker buildx imagetools create --tag ${image}:latest --tag ${image}:1.0 ${image}@${d1}\$" "$STUB_DIR/calls"; then
  pass "a published 1.0.0 points :latest and :1.0 at the digest of the notes, in one retagging"
else
  fail "published 1.0.0 (exit $code, calls: $(tr '\n' ';' < "$STUB_DIR/calls"))"
fi
# The signature was checked before the move and each tag again after it.
first_create="$(grep -n 'imagetools create' "$STUB_DIR/calls" | head -1 | cut -d: -f1)"
first_verify="$(grep -n '^cosign verify ' "$STUB_DIR/calls" | head -1 | cut -d: -f1)"
last_verify="$(grep -n '^cosign verify ' "$STUB_DIR/calls" | tail -1 | cut -d: -f1)"
if [[ -n "$first_create" && -n "$first_verify" ]] && ((first_verify < first_create && last_verify > first_create)) \
  && [[ "$(calls_of '^cosign verify ')" == 3 ]] && ! grep -q -- "$d2" "$STUB_DIR/calls"; then
  pass "the signature is verified before the move (by the digest) and :latest and :1.0 are verified after it"
else
  fail "verification order (first verify ${first_verify:-none}, create ${first_create:-none}, last verify ${last_verify:-none})"
fi

# A repeated publish of the same release is harmless: the same digest, the same tags.
run_case "${image}:1.0.0 $d1
${image}:latest $d1
${image}:1.0 $d1
" "$stable" RELEASE_TAG=v1.0.0 "$signed"
if ((code == 0)) && [[ "$(registry_digest "${image}:latest")" == "$d1" ]]; then
  pass "publishing the same release again leaves the tags where they are"
else
  fail "repeated publish (exit $code)"
fi

# A patch release moves :1.0 and :latest and leaves every version tag alone.
run_case "${image}:1.0.0 $d1
${image}:1.0.1 $d2
${image}:1.0 $d1
${image}:latest $d1
" "$(release_json v1.0.1 false false "$(notes "$d2")")" RELEASE_TAG=v1.0.1 "STUB_SIGNED=$d1 $d2"
if ((code == 0)) && [[ "$(registry_digest "${image}:latest")" == "$d2" && "$(registry_digest "${image}:1.0")" == "$d2" \
  && "$(registry_digest "${image}:1.0.0")" == "$d1" && "$(registry_digest "${image}:1.0.1")" == "$d2" ]]; then
  pass "a published 1.0.1 moves :latest and :1.0 to its digest and leaves :1.0.0 and :1.0.1"
else
  fail "patch publish (exit $code): $(tr '\n' ';' < "$STUB_DIR/registry")"
fi

# The version order: the floating tags only ever move to a version that is at
# least the highest published one they follow. Each case gives the registry as it
# is, the release being published and the published releases the API lists.
latest_old="${image}:latest $d2
${image}:1.1 $d2
${image}:1.1.0 $d2
"
releases_list="$(releases_of v1.1.0:published:"$d2" v1.0.3:published:"$d3" v1.0.2:published:"$d1")"
run_case "${latest_old}${image}:1.0.2 $d1
${image}:1.0.3 $d3
${image}:1.0 $d3
" "$(release_json v1.0.2 false false "$(notes "$d1")")" RELEASE_TAG=v1.0.2 "STUB_SIGNED=$d1 $d2 $d3"
if ((code == 0)) && ! moved && [[ "$(registry_digest "${image}:latest")" == "$d2" && "$(registry_digest "${image}:1.0")" == "$d3" ]]; then
  pass "an older release of an older line (1.0.2 after 1.0.3 and 1.1.0) moves neither :latest nor :1.0, and publishing it is not an error"
else
  fail "older line publish (exit $code): $(tr '\n' ';' < "$STUB_DIR/registry")"
fi
if ((code == 0)) && grep -q -- "nothing to move" <<<"$out" && grep -q -- ":latest already points at $d2 (v1.1.0)" <<<"$out"; then
  pass "the no-op says why"
else
  fail "skip message (exit $code)"
fi

# The older line still has its own tag: 1.0.2 is the highest of 1.0, so :1.0 moves, :latest does not,
# and the newer line published meanwhile does not fail the run.
releases_list="$(releases_of v1.1.0:published:"$d2" v1.0.2:published:"$d1" v1.0.1:published)"
run_case "${latest_old}${image}:1.0.2 $d1
${image}:1.0 $d3
" "$(release_json v1.0.2 false false "$(notes "$d1")")" RELEASE_TAG=v1.0.2 "STUB_SIGNED=$d1 $d2 $d3"
if ((code == 0)) && [[ "$(registry_digest "${image}:latest")" == "$d2" && "$(registry_digest "${image}:1.0")" == "$d1" ]] \
  && grep -q -- "imagetools create --tag ${image}:1.0 ${image}@${d1}\$" "$STUB_DIR/calls"; then
  pass "the highest of an older line moves its :major.minor and leaves :latest on the newer release"
else
  fail "older line, own tag (exit $code): $(tr '\n' ';' < "$STUB_DIR/registry")"
fi

releases_list="$(releases_of v1.1.1:published:"$d3" v1.1.0:published:"$d2")"
run_case "${image}:1.1.0 $d2
${image}:1.1.1 $d3
${image}:1.1 $d3
${image}:latest $d3
" "$(release_json v1.1.0 false false "$(notes "$d2")")" RELEASE_TAG=v1.1.0 "STUB_SIGNED=$d2 $d3"
expect_unchanged "a lower patch of the same line (1.1.0 after 1.1.1) finds the tags on 1.1.1 and moves nothing" "nothing to move"

# An old draft published after a newer release, and the same release published again after a newer one.
releases_list="$(releases_of v1.1.1:published:"$d3" v1.1.0:published:"$d2")"
run_case "${image}:1.1.0 $d2
${image}:1.1.1 $d3
${image}:1.1 $d3
${image}:latest $d3
" "$(release_json v1.1.0 false false "$(notes "$d2")")" RELEASE_TAG=v1.1.0 "STUB_SIGNED=$d2 $d3"
if ((code == 0)) && ! moved && [[ "$(registry_digest "${image}:latest")" == "$d3" && "$(registry_digest "${image}:1.1")" == "$d3" ]]; then
  pass "publishing the 1.1.0 draft after 1.1.1 leaves :latest and :1.1 on 1.1.1"
else
  fail "old draft published late (exit $code)"
fi

# Pre-releases, drafts and unrelated tags in the list do not hold the tags back.
releases_list="$(releases_of v1.0.1:published:"$d2" v1.2.0:draft:"$d3" v2.0.0:pre-release:"$d3" v3.0.0-rc.1:published:"$d3" nightly:published:"$d3")"
run_case "${image}:1.0.0 $d1
${image}:1.0.1 $d2
${image}:latest $d1
${image}:1.0 $d1
" "$(release_json v1.0.1 false false "$(notes "$d2")")" RELEASE_TAG=v1.0.1 "STUB_SIGNED=$d1 $d2"
if ((code == 0)) && [[ "$(registry_digest "${image}:latest")" == "$d2" && "$(registry_digest "${image}:1.0")" == "$d2" ]]; then
  pass "a draft, a pre-release and a tag that is not v<semver> in the list do not count as newer"
else
  fail "list with drafts and pre-releases (exit $code): $(tr '\n' ';' < "$STUB_DIR/registry")"
fi

# Numbers compare as numbers: 1.10.0 is above 1.9.0 and 1.9.9 is below 1.10.0.
releases_list="$(releases_of v1.10.0:published:"$d3" v1.9.0:published:"$d1")"
run_case "${image}:1.9.0 $d1
${image}:1.10.0 $d3
${image}:latest $d3
${image}:1.10 $d3
${image}:1.9 $d2
" "$(release_json v1.9.0 false false "$(notes "$d1")")" RELEASE_TAG=v1.9.0 "STUB_SIGNED=$d1 $d3"
if ((code == 0)) && [[ "$(registry_digest "${image}:latest")" == "$d3" && "$(registry_digest "${image}:1.9")" == "$d1" ]] \
  && ! grep -q -- "--tag ${image}:latest" "$STUB_DIR/calls"; then
  pass "1.9.0 published after 1.10.0 does not move :latest (multi-digit components) and moves :1.9"
else
  fail "1.9.0 after 1.10.0 (exit $code)"
fi

releases_list="$(releases_of v1.10.0:published:"$d3" v1.9.0:published:"$d1")"
run_case "${image}:1.9.0 $d1
${image}:1.10.0 $d3
${image}:latest $d1
${image}:1.9 $d1
" "$(release_json v1.10.0 false false "$(notes "$d3")")" RELEASE_TAG=v1.10.0 "STUB_SIGNED=$d1 $d3"
if ((code == 0)) && [[ "$(registry_digest "${image}:latest")" == "$d3" && "$(registry_digest "${image}:1.10")" == "$d3" && "$(registry_digest "${image}:1.9")" == "$d1" ]]; then
  pass "1.10.0 published after 1.9.0 moves :latest and :1.10 and leaves :1.9"
else
  fail "1.10.0 after 1.9.0 (exit $code): $(tr '\n' ';' < "$STUB_DIR/registry")"
fi

releases_list="$(releases_of v1.0.9:published:"$d1" v1.0.10:published:"$d2" v2.0.0:published:"$d3")"
run_case "${image}:1.0.9 $d1
${image}:1.0.10 $d2
${image}:2.0.0 $d3
${image}:latest $d3
${image}:1.0 $d2
" "$(release_json v1.0.9 false false "$(notes "$d1")")" RELEASE_TAG=v1.0.9 "STUB_SIGNED=$d1 $d2 $d3"
if ((code == 0)) && ! moved && [[ "$(registry_digest "${image}:1.0")" == "$d2" ]]; then
  pass "1.0.9 published after 1.0.10 does not move :1.0 (multi-digit patch), nor :latest after 2.0.0"
else
  fail "1.0.9 after 1.0.10 (exit $code)"
fi

# Reconcile: a run repairs `:latest` and its own line's tag after a dropped or
# failed run. GitHub replaces a publish job that waits behind a running one with a
# newer one, so 1.2.0's run can be dropped when 1.1.0 is published. 1.1.0's run
# then has to put :latest on 1.2.0, verified, and its own line's tag on 1.1.0.
releases_list="$(releases_of v1.2.0:published:"$d3" v1.1.0:published:"$d2" v1.0.0:published:"$d1")"
dropped="${image}:1.0.0 $d1
${image}:1.1.0 $d2
${image}:1.2.0 $d3
${image}:latest $d1
${image}:1.0 $d1
"
run_case "$dropped" "$(release_json v1.1.0 false false "$(notes "$d2")")" RELEASE_TAG=v1.1.0 "STUB_SIGNED=$d1 $d2 $d3"
if ((code == 0)) && [[ "$(registry_digest "${image}:latest")" == "$d3" && "$(registry_digest "${image}:1.1")" == "$d2" && "$(registry_digest "${image}:1.0")" == "$d1" ]] \
  && grep -q -- "imagetools create --tag ${image}:latest ${image}@${d3}\$" "$STUB_DIR/calls" \
  && grep -q -- "imagetools create --tag ${image}:1.1 ${image}@${d2}\$" "$STUB_DIR/calls" \
  && grep -q -- "^cosign verify .*${image}@${d3}\$" "$STUB_DIR/calls" && grep -q -- "^cosign verify .*${image}@${d2}\$" "$STUB_DIR/calls"; then
  pass "1.1.0's run, with 1.2.0's run dropped, verifies 1.2.0 and moves :latest to its digest and :1.1 to 1.1.0's"
else
  fail "dropped 1.2.0 run (exit $code): $(tr '\n' ';' < "$STUB_DIR/registry")"
fi

# The same, when 1.1.0 is not newer than a tag it leaves alone but the tags are already right.
run_case "${dropped}${image}:1.1 $d2
" "$(release_json v1.1.0 false false "$(notes "$d2")")" RELEASE_TAG=v1.1.0 "STUB_SIGNED=$d1 $d2 $d3"
if ((code == 0)) && [[ "$(registry_digest "${image}:latest")" == "$d3" ]]; then
  pass "a run whose own tag is already right still repairs :latest"
else
  fail "own tag right, :latest wrong (exit $code)"
fi

# Everything already correct: a green no-op that asks for no signature and retags nothing.
run_case "${image}:1.0.0 $d1
${image}:1.1.0 $d2
${image}:1.2.0 $d3
${image}:latest $d3
${image}:1.1 $d2
" "$(release_json v1.1.0 false false "$(notes "$d2")")" RELEASE_TAG=v1.1.0 "STUB_SIGNED=$d1 $d2 $d3"
expect_unchanged "a run that finds :latest and :1.1 on the releases they follow is a green no-op" "nothing to move"

# What gh writes to stderr on a call that succeeds is not read as part of its answer.
run_case "${image}:1.0.0 $d1
${image}:1.1.0 $d2
${image}:1.2.0 $d3
${image}:latest $d3
${image}:1.1 $d2
" "$(release_json v1.1.0 false false "$(notes "$d2")")" RELEASE_TAG=v1.1.0 "STUB_SIGNED=$d1 $d2 $d3" "STUB_NOTICE=gh: a notice on stderr"
if ((code == 0)) && ! moved && grep -q -- "nothing to move" <<<"$out" && [[ "$(grep -c -- "gh: a notice on stderr" <<<"$out")" == "$(calls_of '^gh api')" ]]; then
  pass "a notice gh writes to stderr on a call that succeeds leaves its answer readable, and is passed on"
else
  fail "gh notice on stderr (exit $code)"
fi

# The release the tag is to move to is checked, not the one the run is for.
run_case "$dropped" "$(release_json v1.1.0 false false "$(notes "$d2")")" RELEASE_TAG=v1.1.0 "STUB_SIGNED=$d1 $d2"
if ((code != 0)) && ! moved && grep -q -- "NOT VERIFIED" <<<"$out" && grep -q -- "refused" <<<"$out" \
  && [[ "$(registry_digest "${image}:latest")" == "$d1" && -z "$(registry_digest "${image}:1.1")" ]]; then
  pass "the newest release's digest unsigned: nothing is moved, not even the run's own line"
else
  fail "newest release unsigned (exit $code): $(tr '\n' ';' < "$STUB_DIR/registry")"
fi

run_case "$(printf '%s\n' "${dropped%$'\n'}" | sed "s|^${image}:1.2.0 .*|${image}:1.2.0 $d1|")
" "$(release_json v1.1.0 false false "$(notes "$d2")")" RELEASE_TAG=v1.1.0 "STUB_SIGNED=$d1 $d2 $d3"
expect_refused "the version tag of the newest release no longer points at the digest of its notes: refused" "is ${d1}, not ${d3}"

releases_list="$(releases_of v1.2.0:published v1.1.0:published:"$d2")"
run_case "$dropped" "$(release_json v1.1.0 false false "$(notes "$d2")")" RELEASE_TAG=v1.1.0 "STUB_SIGNED=$d1 $d2 $d3"
expect_refused "notes of the newest release that name no digest: refused" "of v1.2.0, which :latest follows, do not name exactly one image digest"

# A run for a release that no tag follows is not held up by that release's own notes
# or tag: 1.0.0 is below 1.0.1 and 1.2.0, and both tags are already right.
releases_list="$(releases_of v1.2.0:published:"$d3" v1.0.1:published:"$d2" v1.0.0:published)"
run_case "${image}:1.2.0 $d3
${image}:1.0.1 $d2
${image}:latest $d3
${image}:1.0 $d2
" "$(release_json v1.0.0 false false 'No digest, no tag.')" RELEASE_TAG=v1.0.0 "STUB_SIGNED=$d2 $d3"
expect_unchanged "a release no tag follows (1.0.0 after 1.0.1 and 1.2.0) is a green no-op, whatever its own notes say" "nothing to move"

# A list that cannot be read, or is not JSON, moves nothing and fails the job.
releases_list=""
run_case "$registry_one" "$stable" RELEASE_TAG=v1.0.0 "$signed" STUB_LIST_FAIL=1
expect_refused "a list of releases that cannot be read is refused" "could not be read"

releases_list="[]"
run_case "$registry_one" "$stable" RELEASE_TAG=v1.0.0 "$signed"
expect_refused "an empty list of releases does not allow a move" "does not hold v1.0.0"

releases_list="$(releases_of v0.9.0:published:"$d2")"
run_case "$registry_one" "$stable" RELEASE_TAG=v1.0.0 "$signed"
expect_refused "a list in which the release being published does not appear is refused" "does not hold v1.0.0"

releases_list="$(releases_of v1.0.0:draft:"$d1")"
run_case "$registry_one" "$stable" RELEASE_TAG=v1.0.0 "$signed"
expect_refused "a list in which the release is still a draft is refused" "does not hold v1.0.0"

releases_list="not json"
run_case "$registry_one" "$stable" RELEASE_TAG=v1.0.0 "$signed"
expect_refused "a list of releases that is not JSON is refused" "not readable"

# A release published while the run was moving the tags: the run does not pass for done.
releases_list="$(releases_of v1.0.0:published)"
releases_after="$(releases_of v1.0.1:published v1.0.0:published)"
run_case "$registry_one" "$stable" RELEASE_TAG=v1.0.0 "$signed"
if ((code != 0)) && moved && grep -q -- "after the move, v1.0.1 is published and is above v1.0.0, which :latest follows" <<<"$out"; then
  pass "a newer release published during the run fails the job after the move, and names it"
else
  fail "overtaken run (exit $code)"
fi
releases_after=""
releases_list=""

# A pre-release never moves the floating tags, even published, and whatever the API says.
rc_registry="${image}:1.0.0-rc.1 $d3
${image}:latest $d1
${image}:1.0 $d1
"
run_case "$rc_registry" "$(release_json v1.0.0-rc.1 false true "$(notes "$d3")")" RELEASE_TAG=v1.0.0-rc.1 "STUB_SIGNED=$d1 $d3"
if ((code == 0)) && ! moved && [[ "$(registry_digest "${image}:latest")" == "$d1" && "$(registry_digest "${image}:1.0")" == "$d1" ]]; then
  pass "a published pre-release leaves :latest and :1.0 where they were"
else
  fail "pre-release publish (exit $code)"
fi

run_case "$registry_one" "$(release_json v1.0.0 false true "$(notes "$d1")")" RELEASE_TAG=v1.0.0 "$signed"
if ((code == 0)) && ! moved && grep -q -- "flagged as a pre-release" <<<"$out"; then
  pass "a release GitHub flags as a pre-release moves nothing, though its version has no suffix"
else
  fail "flagged pre-release (exit $code)"
fi

# Fail closed: each of these stops before the retagging.
run_case "$registry_one" "$(release_json v1.0.0 true false "$(notes "$d1")")" RELEASE_TAG=v1.0.0 "$signed"
expect_refused "a draft release is refused" "is a draft"

run_case "$registry_one" none RELEASE_TAG=v1.0.0 "$signed"
expect_refused "a release the API cannot find (or a failing API) is refused" "could not be read"

run_case "$registry_one" "$(release_json v1.0.1 false false "$(notes "$d1")")" RELEASE_TAG=v1.0.0 "$signed"
expect_refused "a release answered for another tag is refused" "not v1.0.0"

run_case "$registry_one" "$(printf '{"tag_name":"v1.0.0","body":"x"}')" RELEASE_TAG=v1.0.0 "$signed"
expect_refused "a release without draft and pre-release flags is refused" "not published"

run_case "$registry_one" "$(release_json v1.0.0 false false 'No digest here.')" RELEASE_TAG=v1.0.0 "$signed"
expect_refused "notes that name no digest are refused" "exactly one image digest"

run_case "$registry_one" "$(release_json v1.0.0 false false "$(notes "$d1")"$'\n'"$(notes "$d2")")" RELEASE_TAG=v1.0.0 "STUB_SIGNED=$d1 $d2"
expect_refused "notes that name two digests are refused" "exactly one image digest"

run_case "$registry_one" "$(release_json v1.0.0 false false "Image: ghcr.io/other/image@$d1")" RELEASE_TAG=v1.0.0 "$signed"
expect_refused "notes that name the digest of another image are refused" "exactly one image digest"

run_case "$registry_one" "$(release_json v1.0.0 false false "Image: ${image}@sha256:abc")" RELEASE_TAG=v1.0.0 "$signed"
expect_refused "notes that name a malformed digest are refused" "exactly one image digest"

run_case "${image}:1.0.0 $d2
" "$stable" RELEASE_TAG=v1.0.0 "STUB_SIGNED=$d1 $d2"
expect_refused "a version tag that no longer points at the digest of the notes is refused" "is ${d2}, not ${d1}"

run_case "$registry_one" "$stable" RELEASE_TAG=v1.0.0 STUB_SIGNED=
expect_refused "a digest with no signature is refused" "NOT VERIFIED"

run_case "$registry_one" "$stable" RELEASE_TAG=v1.0.0 "STUB_SIGNED=$d2"
expect_refused "a signature on another digest does not vouch for this one" "NOT VERIFIED"

run_case "" "$stable" RELEASE_TAG=v1.0.0 "$signed"
expect_refused "a version tag the registry does not have is refused" "could not be read"

run_case "$registry_one" "$stable" RELEASE_TAG=v1.0.0 "$signed" STUB_CREATE_FAIL=1
if ((code != 0)) && grep -q -- "retagging .* failed" <<<"$out" && [[ -z "$(registry_digest "${image}:latest")" && -z "$(registry_digest "${image}:1.0")" ]]; then
  pass "a retagging that fails fails the job and leaves no floating tag behind"
else
  fail "failed retagging (exit $code)"
fi

run_case "$registry_one" "$stable" RELEASE_TAG=v1.0.0 "$signed" "STUB_CREATE_WRONG=$d2"
if ((code != 0)) && grep -q -- "after the move" <<<"$out"; then
  pass "a tag that does not resolve to the signed digest after the move fails the job"
else
  fail "wrong digest after the move (exit $code)"
fi

# The input is read as v<semver> and nothing else.
for bad in "" "1.0.0" "v1.0" "v1.0.0+build.5" "v01.0.0" "latest" "v1.0.0-" 'v1.0.0; touch pwned' 'v1.0.0$(touch pwned)' "v1.0.0 " "main" "v1.0.0-$(printf 'a%.0s' {1..130})"; do
  run_case "$registry_one" "$stable" "RELEASE_TAG=$bad" "$signed"
  if ((code != 0)) && ! moved && grep -q -- "not v<semver>" <<<"$out" && [[ ! -s "$STUB_DIR/calls" && ! -e "$tmp/pwned" && ! -e "$STUB_DIR/pwned" ]]; then
    pass "the tag '${bad:0:40}' is refused before the API, the registry or cosign is asked"
  else
    fail "the tag '${bad:0:40}' (exit $code)"
  fi
done

run_case "$registry_one" "$stable" "$signed"
expect_refused "a missing RELEASE_TAG is refused" "not v<semver>"

run_case "$registry_one" "$stable" RELEASE_TAG=v1.0.0 GITHUB_REPOSITORY=nonsense "$signed"
expect_refused "a malformed GITHUB_REPOSITORY is refused" "owner/name"

run_case "$registry_one" "$stable" RELEASE_TAG=v1.0.0 "$signed" -- --retag
expect_refused "an unknown argument is refused" "usage"

# The publish job of the workflow, as written.
wf="$root/.github/workflows/release.yml"
publish_job="$(awk '/^  publish:$/ { inside = 1; print; next } inside && /^  [a-z-]+:$/ { inside = 0 } inside' "$wf")"
code_lines="$(grep -vE '^[[:space:]]*#' <<<"$publish_job")"
login_line="$(grep -n 'docker login' <<<"$code_lines" | head -1 | cut -d: -f1 || true)"
cosign_line="$(grep -n 'cosign-installer' <<<"$code_lines" | head -1 | cut -d: -f1 || true)"
script_line="$(grep -n 'run: bash scripts/release-publish.sh$' <<<"$code_lines" | head -1 | cut -d: -f1 || true)"
if [[ -n "$login_line" && -n "$cosign_line" && -n "$script_line" ]] && ((login_line < script_line && cosign_line < script_line)) \
  && grep -q 'RELEASE_TAG: ${{ github.event.release.tag_name }}' <<<"$code_lines" \
  && grep -qE '^    concurrency:$' <<<"$code_lines" \
  && grep -qE '^      group: release-publish$' <<<"$code_lines" \
  && grep -qE '^      cancel-in-progress: false$' <<<"$code_lines" \
  && ! grep -qE 'id-token|--dry-run|continue-on-error|\|\| true' <<<"$code_lines"; then
  pass "the publish job logs in, installs cosign and runs the script, with the tag in the environment and no id-token, in a concurrency group of its own with cancel-in-progress false"
else
  fail "publish job shape (login ${login_line:-none}, cosign ${cosign_line:-none}, script ${script_line:-none})"
fi

if ((failures > 0)); then
  printf '%s test(s) failed\n' "$failures" >&2
  exit 1
fi
