# SlugBase local/CI environment bootstrap — source or use via scripts/with-ci-env.sh
#
# Root cause (Cursor Remote SSH): the agent prepends ~/.cursor-server/.../ to PATH with a
# bundled `node` (v20). That wins over nvm even after `nvm use`. Fix: remove those entries,
# then load nvm normally. See docs/local-development.md

_slugbase_repo_root() {
  local dir="${SLUGBASE_REPO_ROOT:-${PWD}}"
  while [[ "${dir}" != "/" ]]; do
    if [[ -f "${dir}/.nvmrc" && -f "${dir}/pnpm-workspace.yaml" ]]; then
      printf '%s\n' "${dir}"
      return 0
    fi
    dir="$(dirname "${dir}")"
  done
  printf 'ci-env: could not find repo root (.nvmrc + pnpm-workspace.yaml)\n' >&2
  return 1
}

_slugbase_strip_cursor_path() {
  local cleaned=""
  cleaned="$(
    printf '%s' "${PATH}" | tr ':' '\n' | grep -v '/\.cursor-server/' | paste -sd: -
  )"
  if [[ -n "${cleaned}" ]]; then
    PATH="${cleaned}"
    export PATH
    hash -r 2>/dev/null || true
  fi
}

_slugbase_check_node() {
  node -e "
    const [maj, min] = process.versions.node.split('.').map(Number);
    if (maj < 22 || (maj === 22 && min < 12)) {
      console.error('Node >=22.12.0 required. Current:', process.version);
      console.error('which node:', require('child_process').execSync('command -v node',{encoding:'utf8'}).trim());
      process.exit(1);
    }
  " || return 1
}

_slugbase_activate_nvm() {
  export NVM_DIR="${NVM_DIR:-${HOME}/.nvm}"
  if [[ ! -s "${NVM_DIR}/nvm.sh" ]]; then
    return 1
  fi
  # shellcheck disable=SC1091
  . "${NVM_DIR}/nvm.sh"
  if [[ -f "${REPO_ROOT}/.nvmrc" ]]; then
    nvm install >/dev/null 2>&1 || true
    nvm use --silent
  else
    nvm use default --silent 2>/dev/null || true
  fi
  return 0
}

_slugbase_activate_corepack() {
  if command -v corepack >/dev/null 2>&1; then
    corepack enable >/dev/null 2>&1 || true
    corepack prepare pnpm@9.15.4 --activate >/dev/null 2>&1 || true
  fi
}

_slugbase_resolve_infisical() {
  if command -v infisical >/dev/null 2>&1; then
    return 0
  fi
  local node_bin candidate
  node_bin="$(command -v node 2>/dev/null || true)"
  for candidate in \
    "${HOME}/.local/bin/infisical" \
    "${node_bin:+$(dirname "${node_bin}")/infisical}"; do
    [[ -z "${candidate}" ]] && continue
    if [[ -x "${candidate}" ]]; then
      PATH="$(dirname "${candidate}"):${PATH}"
      export PATH
      return 0
    fi
  done
}

REPO_ROOT="$(_slugbase_repo_root)" || return 1
export SLUGBASE_REPO_ROOT="${REPO_ROOT}"
cd "${REPO_ROOT}" || return 1

# Cursor Remote / agent shells: must run before nvm so `nvm use` prepends the real Node.
_slugbase_strip_cursor_path

_slugbase_activate_nvm || {
  printf 'ci-env: nvm not found (%s). Install nvm or use Node >=22.12 on PATH.\n' "${NVM_DIR}" >&2
}

_slugbase_check_node || return 1
_slugbase_activate_corepack
_slugbase_resolve_infisical

export SLUGBASE_CI_ENV=1

if [[ "${SLUGBASE_CI_ENV_VERBOSE:-}" == "1" ]]; then
  printf 'ci-env: repo=%s node=%s pnpm=%s infisical=%s\n' \
    "${REPO_ROOT}" \
    "$(node -v 2>/dev/null || echo missing)" \
    "$(command -v pnpm 2>/dev/null || echo missing)" \
    "$(command -v infisical 2>/dev/null || echo missing)"
fi
