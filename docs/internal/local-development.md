# Local development environment

SlugBase requires **Node.js >=22.12.0** (root `package.json` `engines`). GitHub Actions uses **22.12** (`.nvmrc` via setup action).

## Node version pin

| File | Purpose |
|------|---------|
| `.nvmrc` | `22.12.0` — matches CI |
| `.node-version` | fnm / asdf / mise |

```bash
nvm install    # installs .nvmrc if missing
nvm use
node -v        # must be v22.12.0 or newer (24.x is fine)
corepack enable
pnpm install
```

## Cursor Remote SSH — why `nvm use` “does nothing”

**You do not need to reinstall nvm.** On this setup, **Cursor’s remote agent** prepends directories like:

`~/.cursor-server/bin/linux-x64/<hash>/`

to `PATH`. That folder contains a **`node` binary (v20)**. It sits **before** nvm’s `versions/node/.../bin`, so:

- `nvm use 22.12.0` prints “Now using node v22.12.0”
- `node -v` still prints **v20.18.2**
- `nvm which current` may point at the Cursor bundle
- `nvm ls` shows `system -> v20.18.2`

Turbo can then **cache** marketing typecheck from an older good run while `node -v` is still 20 — looks random and “broken”.

### Real fix (your machine)

Add the snippet in [`docs/internal/shell/cursor-remote-bashrc.snippet`](shell/cursor-remote-bashrc.snippet) to **`~/.bashrc` immediately after** the block that loads `nvm.sh`, then open a **new terminal** or run `source ~/.bashrc`:

```bash
_slugbase_strip_cursor_from_path() {
  PATH="$(printf '%s' "${PATH}" | tr ':' '\n' | grep -v '/\.cursor-server/' | paste -sd: -)"
  export PATH
  hash -r 2>/dev/null || true
}
_slugbase_strip_cursor_from_path
nvm use default --silent 2>/dev/null || nvm use --silent 2>/dev/null || true
```

Verify:

```bash
command -v node   # should be under ~/.nvm/versions/node/...
node -v         # v22.12.0+ (not v20.x from .cursor-server)
```

To match CI exactly: `nvm alias default 22.12.0` (optional if you prefer 24 LTS for daily dev — both satisfy `engines`).

### Repo / agents

`scripts/ci-env.sh` applies the same PATH cleanup, then `nvm use` from `.nvmrc`. Wrap commands:

```bash
bash scripts/with-ci-env.sh pnpm typecheck
bash scripts/with-ci-env.sh pnpm i18n:validate
bash scripts/with-ci-env.sh pnpm test:integration   # no Phase wrapper on integration
```

Or: `source scripts/ci-env.sh` once per shell.

Sanity: `pnpm env:check`

## Secrets (Phase)

Local development injects environment variables from the Phase **`Development`** environment via `phase run`. Full Phase CLI setup and workflow are documented in issue **#475** (migrate local dev from Infisical).

```bash
phase run -- pnpm dev   # example — see #475 for login and app wiring
```

Key inventory (hosted vs self-hosted, GHA environments, platform sync): [`docs/internal/environment-variables.md`](environment-variables.md).

## preinstall guard

`pnpm install` runs `scripts/check-node-version.mjs` and exits if Node is below 22.12.
