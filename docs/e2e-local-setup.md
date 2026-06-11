# Local Playwright e2e tests (optional)

Playwright e2e tests are **not** part of the per-task local CI gate (spec §22.4).
They run automatically on the `staging → main` release-candidate PR in CI.

You can still run them locally when needed — the wrapper script handles everything.

## Prerequisites (one-time)

```bash
npx playwright install --with-deps chromium
```

## Run all tests (both modes)

```bash
pnpm test:e2e
```

That single command:
1. Spins up an ephemeral Postgres container on a **random host port**
2. Runs `pnpm build`
3. Runs the **hosted** tests — Playwright `webServer` starts API, web, marketing on **random free ports**
4. Runs the **self-hosted** tests — builds the combined Docker image, runs the container on a **random free port**
5. **Tears down** everything — container, volumes, and Docker build cache — via a `trap` cleanup handler

Both modes run independently — if hosted fails, self-hosted still runs. You see results for both.

## Run one mode only

```bash
# Hosted only (skip self-hosted)
pnpm test:e2e -- --project=hosted

# Self-hosted only (skip hosted)
pnpm test:e2e -- --project=self-hosted
```

## Options

```bash
# Single spec file (runs in whichever modes are selected)
pnpm test:e2e -- specs/bookmarks/crud.spec.ts

# Single mode + single spec
pnpm test:e2e -- --project=self-hosted specs/bookmarks/crud.spec.ts

# UI mode (interactive)
pnpm test:e2e -- --ui

# Debug mode
pnpm test:e2e -- --debug
```

Pass everything after `--` directly to Playwright. The database and service lifecycle
is always automatic.

## How tests handle mode differences

The same spec files run under both modes. Tests use runtime checks to handle mode-specific
behaviour — no separate spec files per mode:

| Difference | How tests handle it |
|---|---|
| **Billing UI** disabled in self-hosted | Check for `billing-unavailable-gate` testid — if visible, skip interactive billing steps |
| **Analytics consent** requires Umami env vars | Check if banner is rendered — skip tests when Umami is absent |
| **Setup flow** (fresh DB) | Self-hosted setup test navigates to `/setup` — hosted tests skip it since users already exist |
| **API URL** (separate ports vs combined) | `resolveApiUrl` uses `process.env.E2E_BASE_URL_API` or `E2E_BASE_URL_SELF_HOSTED` set by the wrapper |

The key pattern: **detect the feature gate → adapt or skip**. No fragile `if (mode === 'self-hosted')` branches.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `E2E_BASE_URL_API` | `http://localhost:4001` | API base URL (hosted mode only) |
| `E2E_BASE_URL_WEB` | `http://localhost:4002` | Web client base URL (hosted mode only) |
| `E2E_BASE_URL_MARKETING` | `http://localhost:4003` | Marketing site base URL (hosted mode only) |
| `E2E_BASE_URL_SELF_HOSTED` | `http://localhost:3000` | Self-hosted combined service URL |
| `DATABASE_URL` | *(set automatically)* | Postgres connection string (random port) |

`DATABASE_URL` is injected into the Playwright `webServer` subprocesses
automatically — no manual configuration needed.

## Writing tests

- Place spec files in `e2e/specs/`.
- Use `test` from `../fixtures/auth` (not `@playwright/test` directly) for authenticated tests.
- Use the `seed` fixture helper to create test data before browser interactions.
- See `fixtures/auth.ts` and `fixtures/seed.ts` for fixture API.