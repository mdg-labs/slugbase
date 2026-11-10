#!/usr/bin/env bash
# Tests scripts/verify-image.sh with stand-ins for cosign and docker: the stand-ins
# record their arguments and answer as the test asks, so no request leaves this
# machine and no signature is needed. The cosign stand-in behaves like the real
# one where it matters here: `verify` and `verify-attestation` succeed only for an
# image that was signed, under the identity and issuer the caller names, and
# `verify-attestation` only for a predicate type that was attested. It also checks
# the shape of the signing steps in .github/workflows/release.yml.
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
cat > "$tmp/bin/cosign" <<'STUB'
#!/usr/bin/env bash
# A stand-in for cosign. STUB_SIGNED_IDENTITY and STUB_SIGNED_ISSUER say who signed
# the image ("" is unsigned); STUB_ATTESTED lists the predicate types attested
# under that identity, comma separated.
if [[ "${1:-}" == version ]]; then
  # STUB_COSIGN_VERSION_STATUS makes `cosign version` fail, as a version-manager
  # shim without a selected version does.
  if [[ -n "${STUB_COSIGN_VERSION_STATUS:-}" ]]; then
    echo 'cosign: no version is set' >&2
    exit "$STUB_COSIGN_VERSION_STATUS"
  fi
  printf 'cosign: A tool for Container Signing\n\nGitVersion:    %s\nGitCommit:     0000\n' "${STUB_COSIGN_VERSION:-v3.1.4}"
  exit 0
fi
printf '%s\n' "$*" >> "$STUB_DIR/cosign-calls"
sub="$1"
identity=""
issuer=""
type=""
shift
while (($# > 1)); do
  case "$1" in
    --certificate-identity) identity="$2" ;;
    --certificate-oidc-issuer) issuer="$2" ;;
    --type) type="$2" ;;
  esac
  shift
done
if [[ -z "${STUB_SIGNED_IDENTITY:-}" ]]; then
  echo 'Error: no signatures found' >&2
  exit 1
fi
if [[ "$identity" != "$STUB_SIGNED_IDENTITY" || "$issuer" != "${STUB_SIGNED_ISSUER:-}" ]]; then
  echo 'Error: none of the expected identities matched what was in the certificate' >&2
  exit 1
fi
if [[ "$sub" == "verify-attestation" && ",${STUB_ATTESTED:-}," != *",$type,"* ]]; then
  echo "Error: no matching attestations of type $type" >&2
  exit 1
fi
printf '{"payload":"not printed by the script"}\n'
STUB
cat > "$tmp/bin/docker" <<'STUB'
#!/usr/bin/env bash
# A stand-in for `docker buildx imagetools inspect <ref>`: it knows the images
# named in STUB_REGISTRY ("ref=digest", space separated) and prints the block the
# real command prints, the index's own digest first and a manifest's after it.
printf '%s\n' "$*" >> "$STUB_DIR/docker-calls"
ref="$4"
for entry in ${STUB_REGISTRY:-}; do
  if [[ "${entry%%=*}" == "$ref" ]]; then
    printf 'Name:      %s\nMediaType: application/vnd.oci.image.index.v1+json\nDigest:    %s\n\nManifests:\n  Name:        %s@sha256:%064d\n  Digest:    sha256:%064d\n' \
      "$ref" "${entry#*=}" "$ref" 1 1
    exit 0
  fi
done
echo "ERROR: $ref: not found" >&2
exit 1
STUB
chmod +x "$tmp/bin/cosign" "$tmp/bin/docker"

# A directory with docker and the tools the script needs, but no cosign.
mkdir -p "$tmp/no-cosign"
cp "$tmp/bin/docker" "$tmp/no-cosign/docker"

image="ghcr.io/mdg-labs/slugbase"
digest="sha256:$(printf 'a%.0s' {1..64})"
other_digest="sha256:$(printf 'b%.0s' {1..64})"
identity="https://github.com/mdg-labs/slugbase/.github/workflows/release.yml@refs/heads/main"
issuer="https://token.actions.githubusercontent.com"
registry="${image}:1.0.0=${digest} ${image}:1.0.0-rc.1=${other_digest}"

n=0
run_case() {
  n=$((n + 1))
  STUB_DIR="$tmp/case-$n"
  mkdir -p "$STUB_DIR"
  code=0
  out="$(env -i PATH="$tmp/bin:$PATH" STUB_DIR="$STUB_DIR" STUB_REGISTRY="$registry" "$@" 2>&1)" || code=$?
}

pass() {
  printf 'ok: %s\n' "$1"
}

fail() {
  printf 'FAIL: %s (exit %s)\n%s\n' "$1" "$code" "$out" >&2
  failures=$((failures + 1))
}

cosign_calls() {
  if [[ -f "$STUB_DIR/cosign-calls" ]]; then cat "$STUB_DIR/cosign-calls"; fi
}

signed=(STUB_SIGNED_IDENTITY="$identity" STUB_SIGNED_ISSUER="$issuer" STUB_ATTESTED="spdxjson,slsaprovenance1")
verify=(bash "$here/verify-image.sh")

expect_verified() {
  local name="$1" subject="${2:-${image}@${digest}}"
  if ((code == 0)) && [[ "$out" == *"verified. Run it by digest: ${subject}"* ]]; then
    pass "$name"
  else
    fail "$name"
  fi
}

expect_not_verified() {
  local name="$1" words="${2:-NOT VERIFIED}"
  if ((code == 1)) && [[ "$out" == *"$words"* ]] && [[ "$out" != *"verified. Run it"* ]]; then
    pass "$name"
  else
    fail "$name"
  fi
}

expect_usage() {
  local name="$1" words="$2"
  if ((code == 2)) && [[ "$out" == *"$words"* ]] && [[ -z "$(cosign_calls)" ]]; then
    pass "$name"
  else
    fail "$name"
  fi
}

run_case "${signed[@]}" "${verify[@]}" 1.0.0
expect_verified "a signed image given by a bare tag is verified"
if grep -qxF "verify --certificate-identity ${identity} --certificate-oidc-issuer ${issuer} ${image}@${digest}" "$STUB_DIR/cosign-calls" \
  && grep -qxF "verify-attestation --type spdxjson --certificate-identity ${identity} --certificate-oidc-issuer ${issuer} ${image}@${digest}" "$STUB_DIR/cosign-calls" \
  && grep -qxF "verify-attestation --type slsaprovenance1 --certificate-identity ${identity} --certificate-oidc-issuer ${issuer} ${image}@${digest}" "$STUB_DIR/cosign-calls"; then
  pass "cosign verifies the signature and both attestations by digest, with the release workflow's identity and the GitHub issuer"
else
  fail "cosign calls: $(tr '\n' ';' < "$STUB_DIR/cosign-calls")"
fi
if [[ "$(wc -l < "$STUB_DIR/cosign-calls")" == 3 ]] && ! grep -q -- ':1\.0\.0' "$STUB_DIR/cosign-calls"; then
  pass "nothing is verified by tag: the tag is resolved once and every check names the digest"
else
  fail "a cosign call named a tag: $(tr '\n' ';' < "$STUB_DIR/cosign-calls")"
fi
if [[ "$out" != *"payload"* ]]; then
  pass "the output of cosign is not printed on success"
else
  fail "the output of cosign was printed"
fi

run_case "${signed[@]}" "${verify[@]}" "${image}:1.0.0"
expect_verified "a signed image given as image:tag is verified"

run_case "${signed[@]}" "${verify[@]}" "${image}@${digest}"
expect_verified "a signed image given by digest is verified"
if [[ ! -f "$STUB_DIR/docker-calls" ]]; then
  pass "an image given by digest is not looked up in the registry"
else
  fail "docker was called for an image given by digest"
fi

run_case "${signed[@]}" "${verify[@]}" --digest "$digest" 1.0.0
expect_verified "--digest accepts the digest the tag resolves to"

run_case "${signed[@]}" "${verify[@]}" --digest "$other_digest" 1.0.0
expect_not_verified "--digest fails when the tag resolves to another digest" "not ${other_digest}"
if [[ -z "$(cosign_calls)" ]]; then pass "no signature is checked for a digest that was not expected"; else fail "cosign ran on a digest that was not expected"; fi

run_case "${signed[@]}" "${verify[@]}" --digest "$other_digest" "${image}@${digest}"
expect_not_verified "--digest fails when the image is given by another digest" "not ${other_digest}"

# The failure scenarios of the item: an image that is not signed (one built on the
# machine and pushed to a registry of its own, or a release candidate built before
# signing) and an image signed by another identity.
run_case STUB_REGISTRY="localhost:5000/slugbase:dev=${digest}" "${verify[@]}" "localhost:5000/slugbase:dev"
expect_not_verified "an image built locally and not signed fails" "has no signature by"
if [[ "$out" == *"Error: no signatures found"* ]] && ! grep -q verify-attestation "$STUB_DIR/cosign-calls"; then
  pass "an unsigned image fails on the signature and never reaches the attestations"
else
  fail "the unsigned image reached the attestations"
fi

run_case STUB_SIGNED_IDENTITY="" "${verify[@]}" 1.0.0-rc.1
expect_not_verified "a release candidate built before signing, with no signature, fails"

other_identity="https://github.com/someone-else/slugbase/.github/workflows/release.yml@refs/heads/main"
run_case STUB_SIGNED_IDENTITY="$other_identity" STUB_SIGNED_ISSUER="$issuer" STUB_ATTESTED="spdxjson,slsaprovenance1" "${verify[@]}" 1.0.0
expect_not_verified "an image signed by the workflow of another repository fails"

other_branch="https://github.com/mdg-labs/slugbase/.github/workflows/release.yml@refs/heads/feature"
run_case STUB_SIGNED_IDENTITY="$other_branch" STUB_SIGNED_ISSUER="$issuer" STUB_ATTESTED="spdxjson,slsaprovenance1" "${verify[@]}" 1.0.0
expect_not_verified "an image signed by this workflow on another ref fails"

other_workflow="https://github.com/mdg-labs/slugbase/.github/workflows/other.yml@refs/heads/main"
run_case STUB_SIGNED_IDENTITY="$other_workflow" STUB_SIGNED_ISSUER="$issuer" STUB_ATTESTED="spdxjson,slsaprovenance1" "${verify[@]}" 1.0.0
expect_not_verified "an image signed by another workflow of this repository fails"

run_case STUB_SIGNED_IDENTITY="$identity" STUB_SIGNED_ISSUER="https://accounts.example.test" STUB_ATTESTED="spdxjson,slsaprovenance1" "${verify[@]}" 1.0.0
expect_not_verified "an image signed under another OIDC issuer fails"

run_case STUB_SIGNED_IDENTITY="$identity" STUB_SIGNED_ISSUER="$issuer" STUB_ATTESTED="slsaprovenance1" "${verify[@]}" 1.0.0
expect_not_verified "a signed image without an SBOM attestation fails" "no spdxjson attestation"

run_case STUB_SIGNED_IDENTITY="$identity" STUB_SIGNED_ISSUER="$issuer" STUB_ATTESTED="spdxjson" "${verify[@]}" 1.0.0
expect_not_verified "a signed image without a provenance attestation fails" "no slsaprovenance1 attestation"

run_case "${signed[@]}" "${verify[@]}" 9.9.9
expect_not_verified "a tag the registry does not have fails before anything is verified" "could not be read"
if [[ -z "$(cosign_calls)" ]]; then pass "no signature is checked for a tag that does not resolve"; else fail "cosign ran for a tag that does not resolve"; fi

# cosign missing: the script says so and exits 2, instead of reading a missing tool as success.
code=0
STUB_DIR="$tmp/case-nocosign"
mkdir -p "$STUB_DIR"
out="$(env -i PATH="$tmp/no-cosign:/usr/bin:/bin" STUB_DIR="$STUB_DIR" STUB_REGISTRY="$registry" bash "$here/verify-image.sh" 1.0.0 2>&1)" || code=$?
if PATH="/usr/bin:/bin" command -v cosign > /dev/null 2>&1; then
  printf 'skip: cosign is installed in /usr/bin here, the missing-cosign case cannot run\n'
elif ((code == 2)) && [[ "$out" == *"cosign is not installed, so nothing was verified"* ]] && [[ "$out" != *"verified. Run it"* ]]; then
  pass "a machine without cosign gets a clear message and exit status 2"
else
  fail "the missing-cosign case"
fi

# cosign older than 3.0 cannot read the Sigstore bundles the workflow makes and would
# call a signed image unsigned: refuse it with exit status 2 before any check.
for old in v2.6.1 v2.0.0; do
  run_case STUB_COSIGN_VERSION="$old" "${signed[@]}" "${verify[@]}" 1.0.0
  expect_usage "cosign ${old} is refused with exit status 2 and nothing is verified" "Install cosign 3.x"
done
run_case STUB_COSIGN_VERSION="garbage" "${signed[@]}" "${verify[@]}" 1.0.0
expect_usage "a version of cosign that cannot be read is refused with exit status 2" "could not be read"
for status in 1 3; do
  run_case STUB_COSIGN_VERSION_STATUS="$status" "${signed[@]}" "${verify[@]}" 1.0.0
  expect_usage "a cosign whose version command fails (status ${status}) is refused with exit status 2" "could not be read"
done
run_case STUB_COSIGN_VERSION="v3.0.0" "${signed[@]}" "${verify[@]}" 1.0.0
expect_verified "cosign 3.0.0 is accepted"

# Arguments that are refused before anything runs.
run_case "${signed[@]}" "${verify[@]}"
expect_usage "no argument is refused" "name an image"
run_case "${signed[@]}" "${verify[@]}" "${image}"
expect_usage "an image without a tag or a digest is refused, never read as :latest" "names neither a tag nor a digest"
run_case "${signed[@]}" "${verify[@]}" "${image}:latest" --digest nonsense
expect_usage "a malformed --digest is refused" "--digest is not"
run_case "${signed[@]}" "${verify[@]}" "${image}@sha256:abc"
expect_usage "a short digest in the reference is refused" "digest in"
run_case "${signed[@]}" "${verify[@]}" "--help-me"
expect_usage "an unknown option is refused" "unknown option"
run_case "${signed[@]}" "${verify[@]}" "slugbase:dev"
expect_usage "a name with a colon and no slash is refused, not read as a tag" "is not a tag"
run_case "${signed[@]}" "${verify[@]}" 1.0.0 1.0.1
expect_usage "two images are refused" "one image"
run_case "${signed[@]}" "${verify[@]}" 'ghcr.io/mdg-labs/slugbase:1.0.0;touch x'
expect_usage "a tag with shell syntax is refused" "tag in"
run_case "${signed[@]}" "${verify[@]}" 'ghcr.io/MDG/slugbase:1.0.0'
expect_usage "an upper-case image name is refused" "not an image name"

# The workflow: the shape doc 10 T16 depends on, for the signing steps.
wf="$root/.github/workflows/release.yml"
out="$wf"
code=0
code_lines="$(grep -vE '^[[:space:]]*#' "$wf")"
line_of() {
  { grep -n -- "$1" <<<"$code_lines" || true; } | head -1 | cut -d: -f1
}
push_line="$(line_of 'name: Build and push')"
tag_line="$(line_of 'bash scripts/release-tag.sh')"
sign_line="$(line_of 'cosign sign ')"
attest_sbom_line="$(line_of 'cosign attest .*--type spdxjson')"
attest_prov_line="$(line_of 'cosign attest .*--type slsaprovenance1')"
verify_line="$(line_of 'bash scripts/verify-image.sh')"
draft_line="$(line_of 'gh release create')"
if [[ -n "$push_line" && -n "$tag_line" && -n "$sign_line" && -n "$attest_sbom_line" && -n "$attest_prov_line" && -n "$verify_line" && -n "$draft_line" ]] \
  && ((push_line < tag_line && tag_line < sign_line && sign_line < attest_sbom_line && attest_sbom_line < attest_prov_line && attest_prov_line < verify_line && verify_line < draft_line)); then
  pass "release.yml signs and attests after the push and the tag, verifies, and only then creates the draft"
else
  fail "release.yml step order (push ${push_line:-none}, tag ${tag_line:-none}, sign ${sign_line:-none}, attest ${attest_sbom_line:-none}/${attest_prov_line:-none}, verify ${verify_line:-none}, draft ${draft_line:-none})"
fi
if grep -qE 'cosign sign --yes "\$subject"' <<<"$code_lines" && grep -qE 'subject="\$IMAGE@\$DIGEST"' <<<"$code_lines"; then
  pass "release.yml signs the digest the build pushed, not a tag"
else
  fail "release.yml does not sign \$IMAGE@\$DIGEST"
fi
if ! grep -qE 'cosign (sign|attest)[^|]*(--key|COSIGN_KEY|COSIGN_PRIVATE_KEY|COSIGN_PASSWORD)' <<<"$code_lines" && ! grep -qE 'COSIGN_(KEY|PRIVATE_KEY|PASSWORD)' <<<"$code_lines"; then
  pass "release.yml signs keyless: no key and no key password"
else
  fail "release.yml names a signing key"
fi
if grep -qE '^[[:space:]-]*uses: sigstore/cosign-installer@[0-9a-f]{40} # v' <<<"$code_lines"; then
  pass "release.yml installs cosign from a pinned action"
else
  fail "release.yml does not install cosign from an action pinned to a full SHA"
fi
if grep -qF -- '--digest "$DIGEST"' <<<"$code_lines"; then
  pass "release.yml verifies the digest it pushed, and every tag against it"
else
  fail "release.yml does not pass the pushed digest to verify-image.sh"
fi
# The identity the script checks is the one the signed workflow has: this file, on main.
if grep -qF "IDENTITY=\"https://github.com/mdg-labs/slugbase/.github/workflows/release.yml@refs/heads/main\"" "$here/verify-image.sh" \
  && [[ "$(basename "$wf")" == "release.yml" ]] && grep -qE '^    branches: \[main\]$' "$wf" && grep -qE '^env:' "$wf" && grep -qE '^  IMAGE: ghcr.io/mdg-labs/slugbase$' "$wf" \
  && grep -qF 'DEFAULT_IMAGE="ghcr.io/mdg-labs/slugbase"' "$here/verify-image.sh"; then
  pass "verify-image.sh checks for release.yml of this repository on main and the image the workflow pushes"
else
  fail "verify-image.sh and release.yml disagree on the identity or the image"
fi

if ((failures > 0)); then
  printf '%s test(s) failed\n' "$failures" >&2
  exit 1
fi
