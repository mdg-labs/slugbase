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

`scripts/ci-env.sh` applies the same PATH cleanup, then `nvm use` from `.nvmrc`, and resolves the **Phase CLI** on `PATH`. Wrap commands:

```bash
bash scripts/with-ci-env.sh pnpm typecheck
bash scripts/with-ci-env.sh pnpm i18n:validate
bash scripts/with-ci-env.sh pnpm test:integration   # no Phase wrapper on integration
```

Or: `source scripts/ci-env.sh` once per shell.

Sanity: `pnpm env:check`

## Secrets (Phase)

Local development injects environment variables from the Phase **`Development`** environment via `phase run`. CI and deploy read secrets from **GitHub Actions environments** (Phase syncs operator edits automatically) — no Phase CLI in CI (spec §22.9).

### One-time setup

1. **Install the Phase CLI** — [docs.phase.dev/cli/install](https://docs.phase.dev/cli/install)
2. **Authenticate** — `phase auth` (opens browser; stores credentials locally)
3. **Link the repo** — already committed as `.phase.json` (`SlugBase` app, default env `Development`). Re-link only if missing:

```bash
phase init --app-id 5bfbf715-f340-44c3-8945-171fe92688a9 --env Development --monorepo
```

### Running commands that need secrets

Prefix the command with `phase run --` so Phase decrypts and injects the `Development` environment:

```bash
phase run -- pnpm dev
phase run -- pnpm --filter @slugbase/backend dev
```

Combine with the Node bootstrap when Cursor/agent shells need the correct Node version:

```bash
bash scripts/with-ci-env.sh phase run -- pnpm dev
bash scripts/with-ci-env.sh phase run -- pnpm build
```

**Do not** wrap integration tests — they use their own `validTestEnv` (see rule `06-local-ci-before-commit.mdc`).

### Managing Development secrets

Operators edit secrets in the [Phase Console](https://console.phase.dev) or via CLI. New keys follow the 4-step workflow in rule `05-env-vars.mdc` (Phase `Development` + `.env.example` + Zod config schema + `environment-variables.md`).

```bash
# Create with a literal value (stdin)
printf 'postgresql://slugbase:slugbase@localhost:5432/slugbase' | \
  phase secrets create DATABASE_URL --env Development

# Create a generated secret
phase secrets create SESSION_SECRET --env Development --random hex --length 32

# Update an existing key (stdin)
printf 'false' | phase secrets update PUBLIC_REGISTRATION --env Development

# Existence check without printing the value (agents)
phase secrets get SESSION_SECRET --env Development >/dev/null && echo "SESSION_SECRET: set"
```

Phase syncs `Staging` / `Production` edits to the matching GHA environments. **Do not set staging or production secrets from a developer machine** unless you are the operator — use the Phase Console.

Key inventory (Cloud vs CE, GHA environments, platform sync): [`docs/internal/environment-variables.md`](environment-variables.md).

## Database migrations

Product and admin portal use **separate Drizzle migration histories** on the same Postgres instance:

| Script | Package | Schema |
|--------|---------|--------|
| `.github/scripts/run-migrate.sh` | `@slugbase/backend` | `public` (product tables) |
| `.github/scripts/run-migrate-admin.sh` | `@slugbase/db-admin` | `admin` (operator portal) |

Local generate/migrate:

```bash
bash scripts/with-ci-env.sh pnpm --filter @slugbase/backend db:generate
bash scripts/with-ci-env.sh pnpm --filter @slugbase/backend db:migrate

bash scripts/with-ci-env.sh pnpm --filter @slugbase/db-admin db:generate
bash scripts/with-ci-env.sh pnpm --filter @slugbase/db-admin db:migrate
```

## preinstall guard

`pnpm install` runs `scripts/check-node-version.mjs` and exits if Node is below 22.12.
