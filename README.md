<p align="center">
  <img src="packages/web/public/slugbase_icon.png" alt="SlugBase" width="80" height="80" />
</p>

<h1 align="center">SlugBase</h1>

<p align="center">
  Bookmark manager with built-in URL shortening and a keyboard-driven launcher.<br />
  Save links, assign short <strong>slugs</strong>, and jump to any destination from the address bar or command palette (<code>/go/&lt;slug&gt;</code>).
</p>

<p align="center">
  <a href="https://github.com/mdg-labs/slugbase/actions/workflows/pr.yml"><img src="https://github.com/mdg-labs/slugbase/actions/workflows/pr.yml/badge.svg" alt="CI" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue" alt="License: AGPL-3.0" /></a>
  <a href="package.json"><img src="https://img.shields.io/badge/node-%3E%3D22.12-brightgreen" alt="Node >=22.12" /></a>
  <a href="https://github.com/mdg-labs/slugbase/pkgs/container/slugbase-api"><img src="https://img.shields.io/badge/ghcr.io-slugbase--api-blue" alt="CE API image" /></a>
  <a href="https://github.com/mdg-labs/slugbase/pkgs/container/slugbase-web"><img src="https://img.shields.io/badge/ghcr.io-slugbase--web-blue" alt="CE web image" /></a>
  <a href="https://docs.slugbase.app"><img src="https://img.shields.io/badge/docs-docs.slugbase.app-informational" alt="Documentation" /></a>
</p>

<p align="center">
  <a href="https://slugbase.app"><strong>SlugBase Cloud</strong></a> — managed service ·
  <a href="https://docs.slugbase.app/ce/quick-start"><strong>Self-host</strong></a> — Community Edition (CE) container images
</p>

## Documentation

Customer and operator guides are published at **[docs.slugbase.app](https://docs.slugbase.app)**.

- [SlugBase Cloud](https://docs.slugbase.app/cloud/introduction) — sign up, workspaces, and billing on the hosted service
- [CE quick start](https://docs.slugbase.app/ce/quick-start) — install, configure, and verify your instance

Engineering specs, roadmaps, and design prototypes in this repo stay under **`docs/internal/`** and are not published as customer docs — see [`docs/README.md`](docs/README.md).

## Self-host with Docker Compose

Community Edition ships as **two GHCR images** — `slugbase-api` (NestJS API + migrations) and `slugbase-web` (React Router SSR client). Run them alongside PostgreSQL:

```yaml
services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_USER: slugbase
      POSTGRES_PASSWORD: CHANGE_ME
      POSTGRES_DB: slugbase
    volumes:
      - slugbase_pg:/var/lib/postgresql/data

  api:
    image: ghcr.io/mdg-labs/slugbase-api:1.0.0
    env_file: ./slugbase.env
    environment:
      SLUGBASE_EDITION: ce
      SERVE_WEB_CLIENT: "false"
    depends_on:
      - postgres

  web:
    image: ghcr.io/mdg-labs/slugbase-web:1.0.0
    environment:
      API_BASE_URL: http://api:3000
    ports:
      - "3000:3000"
    depends_on:
      - api

volumes:
  slugbase_pg:
```

Create `slugbase.env` with required API settings (`SESSION_SECRET`, `ENCRYPTION_KEY`, `DATABASE_URL`, `APP_BASE_URL`, `FRONTEND_ORIGIN`, and related keys). See the [CE quick start guide](https://docs.slugbase.app/ce/quick-start) for a complete compose file, environment reference, reverse-proxy notes, and independent image version pins for upgrades.

```bash
docker compose up -d
```

For a local smoke test against staging `:dev` tags, use [`dev.docker-compose.yml`](dev.docker-compose.yml).

## Repository layout

This monorepo contains the SlugBase application (API, web client, marketing site, shared packages) and internal engineering documentation. Package source lives under `packages/`.

## License

SlugBase Community Edition is licensed under the [GNU Affero General Public License v3.0](LICENSE) (AGPL-3.0). You may use, copy, distribute, modify, and prepare derivative works of the software under the AGPL terms — including self-hosting for yourself or others, provided you comply with the license (notably, network use requires making corresponding source available).

The SlugBase name, logo, and **SlugBase Cloud** are trademarks of MDG Labs — see [TRADEMARK.md](TRADEMARK.md).

Full terms: [LICENSE](LICENSE) · [TRADEMARK.md](TRADEMARK.md)
