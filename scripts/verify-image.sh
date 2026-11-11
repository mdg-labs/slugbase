#!/usr/bin/env bash
# Verifies a SlugBase image the way an operator should before running it (doc 08
# section 6.2, doc 10 T16, Q92): the image is signed by this repository's release
# workflow, and its SBOM and provenance attestations are signed by it too.
#
#   bash scripts/verify-image.sh [--digest sha256:<64 hex>] <image>
#
# <image> is one of
#   1.0.0                              a tag of ghcr.io/mdg-labs/slugbase
#   ghcr.io/mdg-labs/slugbase:1.0.0    a tag of an image, in any registry
#   ghcr.io/mdg-labs/slugbase@sha256:<64 hex>
#                                      an image by digest
# A tag is resolved to its digest once, and everything after that is checked by
# that digest, so a tag that moves while the script runs cannot change what is
# verified. The last line names the image by digest: run that one. Without a tag
# or a digest the script refuses to guess; it never assumes :latest.
#
# The checks, all by digest, each of which has to pass:
#   cosign verify              a signature made by the keyless identity
#                              https://github.com/mdg-labs/slugbase/.github/workflows/release.yml@refs/heads/main
#                              under the GitHub Actions OIDC issuer
#                              https://token.actions.githubusercontent.com
#   cosign verify-attestation  an SPDX SBOM (spdxjson) and a SLSA provenance
#                              (slsaprovenance1) attestation, each signed by that identity
# The identity is not an option: an image signed by another workflow, another
# repository or another branch fails, as does an image that is not signed at all
# (one built on your own machine, or a release candidate built before signing).
# A copy of the image in another registry verifies when its signature and
# attestations were copied with it.
#
#   --digest <sha256:...>   fails unless the image resolves to this digest (the
#                           release workflow uses it to check that every tag it
#                           pushed points at the digest it signed)
#
# Exit status: 0 verified; 1 not verified or the digest could not be read;
# 2 usage, or cosign is missing or older than 3.0, or docker is missing.
#
# Needs cosign 3.x (the release workflow signs with cosign 3, which stores the
# signature and the attestations as Sigstore bundles that cosign 2.x does not
# read by default), and docker with buildx to resolve a tag (not needed for an
# image given by digest). No secret is read: a registry login, if the image is
# private, is the one docker already holds.
set -euo pipefail

DEFAULT_IMAGE="ghcr.io/mdg-labs/slugbase"
IDENTITY="https://github.com/mdg-labs/slugbase/.github/workflows/release.yml@refs/heads/main"
ISSUER="https://token.actions.githubusercontent.com"
# The predicate types the release workflow attests (cosign's names for them).
ATTESTATION_TYPES=(spdxjson slsaprovenance1)

usage() {
  printf 'Usage: verify-image.sh [--digest sha256:<64 hex>] <image>\n  <image>: a tag of ghcr.io/mdg-labs/slugbase (1.0.0), an image with a tag (host/name:tag) or an image by digest (host/name@sha256:<64 hex>)\n' >&2
}

die() {
  printf 'verify-image: %s\n' "$1" >&2
  exit "${2:-1}"
}

expect_digest=""
ref=""
while (($# > 0)); do
  case "$1" in
    -h | --help)
      usage
      exit 0
      ;;
    --digest)
      (($# >= 2)) || die "--digest needs a value." 2
      expect_digest="$2"
      shift 2
      ;;
    --digest=*)
      expect_digest="${1#--digest=}"
      shift
      ;;
    -*)
      usage
      die "unknown option $1." 2
      ;;
    *)
      [[ -z "$ref" ]] || die "give one image, not several." 2
      ref="$1"
      shift
      ;;
  esac
done
[[ -n "$ref" ]] || {
  usage
  die "name an image, such as 1.0.0 or ghcr.io/mdg-labs/slugbase:1.0.0." 2
}

digest_pattern='^sha256:[0-9a-f]{64}$'
tag_pattern='^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$'
name_pattern='^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]+)?(/[a-z0-9]+([._-][a-z0-9]+)*)+$'
if [[ -n "$expect_digest" && ! "$expect_digest" =~ $digest_pattern ]]; then
  die "--digest is not sha256:<64 hex characters>." 2
fi

image=""
tag=""
digest=""
if [[ "$ref" != */* ]]; then
  # A bare word is a tag of the SlugBase image.
  [[ "$ref" =~ $tag_pattern ]] || die "'$ref' is not a tag. Give a tag such as 1.0.0, or the whole image." 2
  image="$DEFAULT_IMAGE"
  tag="$ref"
else
  name="$ref"
  if [[ "$ref" == *@* ]]; then
    name="${ref%@*}"
    digest="${ref##*@}"
    [[ "$digest" =~ $digest_pattern ]] || die "the digest in '$ref' is not sha256:<64 hex characters>." 2
  fi
  last="${name##*/}"
  if [[ "$last" == *:* ]]; then
    tag="${last##*:}"
    name="${name%:*}"
    [[ "$tag" =~ $tag_pattern ]] || die "the tag in '$ref' is not valid." 2
  fi
  [[ "$name" =~ $name_pattern ]] || die "'$ref' is not an image name." 2
  image="$name"
  if [[ -z "$digest" && -z "$tag" ]]; then
    die "'$ref' names neither a tag nor a digest, and this script does not assume :latest." 2
  fi
fi

if ! command -v cosign > /dev/null 2>&1; then
  die "cosign is not installed, so nothing was verified. Install cosign 3.x (https://docs.sigstore.dev/cosign/system_config/installation/) and run this again." 2
fi
# The signatures are Sigstore bundles that cosign 3 makes and reads; cosign 2.x
# looks for the older signature tags, finds none and would report a signed image
# as unsigned, so an older cosign is refused before anything is checked.
cosign_output="$(cosign version 2>&1)" || die "the version of cosign could not be read (cosign version failed), so nothing was verified. Install cosign 3.x (https://docs.sigstore.dev/cosign/system_config/installation/) and run this again." 2
cosign_version="$(sed -nE 's/^GitVersion:[[:space:]]+v?([0-9]+)\..*$/\1/p' <<<"$cosign_output" | head -n 1)"
[[ "$cosign_version" =~ ^[0-9]+$ ]] || die "the version of cosign could not be read, so nothing was verified. Install cosign 3.x (https://docs.sigstore.dev/cosign/system_config/installation/) and run this again." 2
((cosign_version >= 3)) || die "cosign ${cosign_version}.x cannot read the signatures of the release workflow, so nothing was verified. Install cosign 3.x (https://docs.sigstore.dev/cosign/system_config/installation/) and run this again." 2

# A tag is resolved to the digest of its manifest or index, which is what the
# release workflow signed. The first Digest line of the output is the image's own;
# the ones of the manifests it lists come after it.
if [[ -z "$digest" ]]; then
  command -v docker > /dev/null 2>&1 || die "docker is not installed, so the tag ${tag} cannot be resolved to a digest. Give the image by digest, ${image}@sha256:<64 hex>." 2
  if ! inspected="$(docker buildx imagetools inspect "${image}:${tag}" 2>&1)"; then
    die "the digest of ${image}:${tag} could not be read, so nothing was verified: ${inspected}"
  fi
  digest="$(sed -nE 's/^Digest:[[:space:]]+(sha256:[0-9a-f]{64})[[:space:]]*$/\1/p' <<<"$inspected" | head -n 1)"
  [[ "$digest" =~ $digest_pattern ]] || die "the digest of ${image}:${tag} was not in the answer of the registry, so nothing was verified."
fi
if [[ -n "$expect_digest" && "$digest" != "$expect_digest" ]]; then
  die "${ref} is ${digest}, not ${expect_digest}."
fi
subject="${image}@${digest}"

printf 'verify-image: checking %s\n' "$subject"

if ! cosign_errors="$(cosign verify \
  --certificate-identity "$IDENTITY" \
  --certificate-oidc-issuer "$ISSUER" \
  "$subject" 2>&1 > /dev/null)"; then
  printf 'verify-image: NOT VERIFIED. %s has no signature by %s.\n%s\n' "$subject" "$IDENTITY" "$cosign_errors" >&2
  exit 1
fi
printf 'verify-image: signature ok, made by %s\n' "$IDENTITY"

for type in "${ATTESTATION_TYPES[@]}"; do
  if ! cosign_errors="$(cosign verify-attestation \
    --type "$type" \
    --certificate-identity "$IDENTITY" \
    --certificate-oidc-issuer "$ISSUER" \
    "$subject" 2>&1 > /dev/null)"; then
    printf 'verify-image: NOT VERIFIED. %s has no %s attestation signed by %s.\n%s\n' "$subject" "$type" "$IDENTITY" "$cosign_errors" >&2
    exit 1
  fi
  printf 'verify-image: %s attestation ok\n' "$type"
done

printf 'verify-image: verified. Run it by digest: %s\n' "$subject"
