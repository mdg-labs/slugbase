# Local Playwright e2e tests (optional)

Playwright e2e tests are **not** part of the per-task local CI gate (spec §22.4).
They run automatically on the `staging → main` release-candidate PR in CI.

You can still run them locally when needed.

## Prerequisites

- All local dev servers running (API, web, marketing) **or** start them fresh.
- Docker Compose for ephemeral Postgres.
- Playwright browsers installed.

## 1. Install Playwright browsers (one-time)

```bash
npx playwright install --with-deps chromium
```

## 2. Start Postgres

```bash
docker compose -f docker-compose.e2e.yml up --wait
```

## 3. Build packages

```bash
pnpm build
```

## 4. Start services (separate terminals or background)

### API
```bash
PORT=4001 node packages/backend/dist/main.js
```

### Web (React Router v7)
```bash
PORT=4002 npx react-router-serve packages/web/build/server/index.js
```

### Marketing (Astro static files)
```bash
npx serve packages/marketing/dist -l 4003
```

## 5. Run tests

```bash
# All tests (hosted project, default)
pnpm test:e2e

# Specific project
pnpm test:e2e --project=hosted
pnpm test:e2e --project=self-hosted

# Single spec file
pnpm test:e2e specs/bookmarks.spec.ts

# UI mode (interactive)
pnpm test:e2e --ui

# Debug mode
pnpm test:e2e --debug
```

## 6. Tear down

```bash
docker compose -f docker-compose.e2e.yml down --volumes --remove-orphans
```

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `E2E_BASE_URL_API` | `http://localhost:4001` | API base URL |
| `E2E_BASE_URL_WEB` | `http://localhost:4002` | Web client base URL |
| `E2E_BASE_URL_MARKETING` | `http://localhost:4003` | Marketing site base URL |
| `E2E_BASE_URL_SELF_HOSTED` | `http://localhost:3000` | Self-hosted combined service URL |
| `E2E_TEST_EMAIL` | `e2e@slugbase.test` | Test account email |
| `E2E_TEST_PASSWORD` | `e2e-test-password` | Test account password |

## Self-hosted mode locally

For self-hosted mode, build the combined Docker image and run it with Postgres:

```bash
docker compose -f docker-compose.e2e.yml up --wait
docker build -t slugbase-e2e:self-hosted .
docker run -d \
  --name slugbase-e2e-self \
  --network host \
  -e DATABASE_URL=postgresql://slugbase:slugbase@localhost:5432/slugbase_e2e \
  -e SLUGBASE_E2E_MODE=true \
  slugbase-e2e:self-hosted
pnpm test:e2e --project=self-hosted
docker stop slugbase-e2e-self && docker rm slugbase-e2e-self
docker compose -f docker-compose.e2e.yml down --volumes --remove-orphans
```

## Writing tests

- Place spec files in `e2e/specs/`.
- Use `test` from `../fixtures/auth` (not `@playwright/test` directly) for authenticated tests.
- Use the `seed` fixture helper to create test data before browser interactions.
- See `fixtures/auth.ts` and `fixtures/seed.ts` for fixture API.