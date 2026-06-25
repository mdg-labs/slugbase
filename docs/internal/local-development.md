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
| `scripts/ci/run-migrate.sh` | `@slugbase/backend` | `public` (product tables) |
| `scripts/ci/run-migrate-admin.sh` | `@slugbase/db-admin` | `admin` (operator portal) |

Local generate/migrate:

```bash
bash scripts/with-ci-env.sh pnpm --filter @slugbase/backend db:generate
bash scripts/with-ci-env.sh pnpm --filter @slugbase/backend db:migrate

bash scripts/with-ci-env.sh pnpm --filter @slugbase/db-admin db:generate
bash scripts/with-ci-env.sh pnpm --filter @slugbase/db-admin db:migrate
```

## Versioning (deploy packages)

Deployable packages (`@slugbase/backend`, `@slugbase/web`, `@slugbase/marketing`, `@slugbase/admin`) are versioned independently in each package's `package.json`. Shared libraries (`shared-types`, `ui`, `email-templates`, `db-admin`) stay at `0.0.0`.

**Bump before push, not per commit.** Multiple local commits are fine; run the bump helper once before pushing:

```bash
pnpm setup:hooks   # once per clone: git config core.hooksPath .githooks

pnpm bump:versions              # interactive: patch / minor / major per package
pnpm bump:versions --dry-run    # preview without writing
git add packages/*/package.json && git commit -m "chore(repo)[#N]: bump versions for push"
```

A **pre-push** hook (not pre-commit) blocks pushes to `staging`/`main` when deploy-relevant source changed since the remote but semver did not increase. On failure, stderr points to `pnpm bump:versions`.

| Command | Purpose |
|---|---|
| `pnpm bump:versions` | Detect changes + bump consumers |
| `pnpm check:push-version-bumps` | Manual check (upstream..HEAD) |
| `SKIP_DEPLOY_VERSION_BUMP_CHECK=1 git push --no-verify` | Skip once (operator only) |

| Shared package | Affected deployables |
|---|---|
| `shared-types` | backend, web, marketing, admin |
| `ui` | web, marketing |
| `email-templates` | backend |
| `db-admin` | admin |

Root `package.json` `version` is workspace metadata only. Deploy uses each deployable's `package.json` version (live `/version` probe gate). See spec §22.6 and rule `15-deploy-version-bumps.mdc`.

## Deploy pipeline (CI)

Staging and production deploys use a **live `/version` probe gate** — not Turborepo affected output, path rules, or `DEPLOYED_STATE_*` repository variables (removed).

| Trigger | Workflow | Deploy |
|---------|----------|--------|
| PR → `staging` | `pr.yml` | No (CI only) |
| Push → `staging` | `staging.yml` | Staging (`deploy.yml`) |
| Push → `main` | `main.yml` | Production (`deploy.yml`) after CI |

**Deploy plan:** `scripts/ci/resolve-deploy-plan.mjs` probes `GET {origin}/version` on each surface and deploys when `semver_gt(V_intended, V_live)`. `V_intended` comes from the deployable package's `package.json` at the deploy ref; `V_live` from the live endpoint. Staging probes send Cloudflare Access service-token headers (`CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` in the GHA `staging` environment).

**Manual override:** `workflow_dispatch` on `staging.yml` with `deploy_mode=manual` skips live compare.

**E2E:** `.github/workflows/e2e.yml` is unchanged — Playwright runs on staging→main release-candidate PRs (and `workflow_dispatch`), not on every PR to `staging`.

Authoritative design: [`docs/internal/ci-cd-deployment-refactor-proposal.md`](ci-cd-deployment-refactor-proposal.md). Supersedes `docs/internal/granular-deployment-recommendations.md` (retired).

## preinstall guard

`pnpm install` runs `scripts/check-node-version.mjs` and exits if Node is below 22.12.
