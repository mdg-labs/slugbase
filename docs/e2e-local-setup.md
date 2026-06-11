# Local Playwright e2e tests (optional)

Playwright e2e tests are **not** part of the per-task local CI gate (spec §22.4).
They run automatically on the `staging → main` release-candidate PR in CI.

You can still run them locally when needed — the wrapper script handles everything.

## Prerequisites (one-time)

```bash
npx playwright install --with-deps chromium
```

## Run all hosted tests

```bash
pnpm test:e2e
```

That single command:
1. Spins up an ephemeral Postgres container on a **random host port**
2. Runs `pnpm build`
3. Runs all Playwright specs
4. **Tears down** everything — container, volumes, and Docker build cache — via a `trap` cleanup handler

## Options

```bash
# Specific project
pnpm test:e2e -- --project=self-hosted

# Single spec file
pnpm test:e2e -- specs/bookmarks.spec.ts

# UI mode (interactive)
pnpm test:e2e -- --ui

# Debug mode
pnpm test:e2e -- --debug
```

Pass everything after `--` directly to Playwright. The database lifecycle is always
automatic.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `E2E_BASE_URL_API` | `http://localhost:4001` | API base URL |
| `E2E_BASE_URL_WEB` | `http://localhost:4002` | Web client base URL |
| `E2E_BASE_URL_MARKETING` | `http://localhost:4003` | Marketing site base URL |
| `E2E_BASE_URL_SELF_HOSTED` | `http://localhost:3000` | Self-hosted combined service URL |
| `DATABASE_URL` | *(set automatically)* | Postgres connection string (random port) |

`DATABASE_URL` is injected into the Playwright `webServer` subprocesses
automatically — no manual configuration needed.

## Self-hosted mode locally

The `pnpm test:e2e` wrapper only covers the hosted project. For self-hosted mode:

```bash
# Build the combined image first
pnpm build

# Start ephemeral Postgres (the wrapper does this too, but for
# self-hosted you need to know the port to wire DATABASE_URL)
bash scripts/e2e.sh --project=self-hosted
```

## Writing tests

- Place spec files in `e2e/specs/`.
- Use `test` from `../fixtures/auth` (not `@playwright/test` directly) for authenticated tests.
- Use the `seed` fixture helper to create test data before browser interactions.
- See `fixtures/auth.ts` and `fixtures/seed.ts` for fixture API.