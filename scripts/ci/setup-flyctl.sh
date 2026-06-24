#!/usr/bin/env bash
# Install a pinned flyctl release with SHA256 verification (spec §22.5).
set -euo pipefail

FLYCTL_VERSION="0.4.59"
FLYCTL_INSTALL="${FLYCTL_INSTALL:-${HOME}/.fly}"
BIN_DIR="${FLYCTL_INSTALL}/bin"

if command -v flyctl >/dev/null 2>&1; then
  if flyctl version 2>/dev/null | grep -q "v${FLYCTL_VERSION}"; then
    flyctl version
    exit 0
  fi
fi

arch="$(uname -m)"
case "${arch}" in
  x86_64 | amd64)
    asset="flyctl_${FLYCTL_VERSION}_Linux_x86_64.tar.gz"
    ;;
  aarch64 | arm64)
    asset="flyctl_${FLYCTL_VERSION}_Linux_arm64.tar.gz"
    ;;
  *)
    echo "Unsupported architecture for flyctl install: ${arch}" >&2
    exit 1
    ;;
esac

release_base="https://github.com/superfly/flyctl/releases/download/v${FLYCTL_VERSION}"
checksums_url="${release_base}/flyctl_${FLYCTL_VERSION}_checksums.txt"
archive_url="${release_base}/${asset}"

tmpdir="$(mktemp -d)"
trap 'rm -rf "${tmpdir}"' EXIT

curl -fsSL "${checksums_url}" -o "${tmpdir}/checksums.txt"
expected_sha256="$(grep " ${asset}$" "${tmpdir}/checksums.txt" | awk '{print $1}')"
if [[ -z "${expected_sha256}" ]]; then
  echo "Checksum entry not found for ${asset}" >&2
  exit 1
fi

curl -fsSL "${archive_url}" -o "${tmpdir}/${asset}"
(
  cd "${tmpdir}"
  echo "${expected_sha256}  ${asset}" | sha256sum -c -
)

mkdir -p "${BIN_DIR}"
tar -xzf "${tmpdir}/${asset}" -C "${BIN_DIR}"

# GITHUB_PATH only affects subsequent workflow steps — always update PATH for this step.
export PATH="${BIN_DIR}:${PATH}"
if [[ -n "${GITHUB_PATH:-}" ]]; then
  echo "${BIN_DIR}" >> "${GITHUB_PATH}"
fi

flyctl version
