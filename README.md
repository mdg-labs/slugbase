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
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Elastic--2.0-blue" alt="License: Elastic-2.0" /></a>
  <a href="package.json"><img src="https://img.shields.io/badge/node-%3E%3D22.12-brightgreen" alt="Node >=22.12" /></a>
  <a href="https://github.com/mdg-labs/slugbase/pkgs/container/slugbase"><img src="https://img.shields.io/badge/ghcr.io-mdg--labs%2Fslugbase-blue" alt="Container image" /></a>
  <a href="https://docs.slugbase.app"><img src="https://img.shields.io/badge/docs-docs.slugbase.app-informational" alt="Documentation" /></a>
</p>

<p align="center">
  <a href="https://slugbase.app"><strong>SlugBase Cloud</strong></a> — managed service ·
  <a href="https://docs.slugbase.app/selfhosted/quick-start"><strong>Self-host</strong></a> — Community Edition (CE) container image
</p>

## Documentation

Customer and operator guides are published at **[docs.slugbase.app](https://docs.slugbase.app)**.

- [SlugBase Cloud](https://docs.slugbase.app/cloud/introduction) — sign up, workspaces, and billing on the hosted service
- [Self-hosted quick start](https://docs.slugbase.app/selfhosted/quick-start) — install, configure, and verify your instance

Engineering specs, roadmaps, and design prototypes in this repo stay under **`docs/internal/`** and are not published as customer docs — see [`docs/README.md`](docs/README.md).

## Self-host with Docker Compose

The CE image bundles the API and web client. Pull from GitHub Container Registry and run alongside PostgreSQL:

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

  slugbase:
    image: ghcr.io/mdg-labs/slugbase:latest
    env_file: ./slugbase.env
    ports:
      - "3000:3000"
    depends_on:
      - postgres

volumes:
  slugbase_pg:
```

Create `slugbase.env` with required settings (`SESSION_SECRET`, `ENCRYPTION_KEY`, `DATABASE_URL`, `APP_BASE_URL`, `FRONTEND_ORIGIN`, and related keys). See the [quick start guide](https://docs.slugbase.app/selfhosted/quick-start) for a complete compose file, environment reference, reverse-proxy notes, and production tagging guidance.

```bash
docker compose up -d
```

## Repository layout

This monorepo contains the SlugBase application (API, web client, marketing site, shared packages) and internal engineering documentation. Package source lives under `packages/`.

## License

SlugBase is licensed under the [Elastic License 2.0](LICENSE) (ELv2). You may use, copy, distribute, and prepare derivative works of the software, subject to ELv2 limitations — notably, you may **not** offer the software to third parties as a hosted or managed service that exposes a substantial set of its features.

Full terms: [LICENSE](LICENSE) · [Elastic License 2.0](https://www.elastic.co/licensing/elastic-license)
