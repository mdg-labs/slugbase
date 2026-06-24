# SlugBase

SlugBase is a bookmark manager with built-in URL shortening and a keyboard-driven launcher. Save links, assign short **slugs**, and jump to any destination from the address bar or command palette (`/go/<slug>`).

**SlugBase Cloud** — managed service at [cloud.slugbase.app](https://cloud.slugbase.app). **Self-hosted** — run the same product on your own infrastructure with the Community Edition (CE) container image.

## Documentation

Customer and operator guides live at **[docs.slugbase.app](https://docs.slugbase.app)**.

- [Self-hosted quick start](https://docs.slugbase.app/selfhosted/quick-start) — install, configure, and verify your instance
- [SlugBase Cloud](https://cloud.slugbase.app) — sign up for the hosted service

To contribute to public documentation, use the separate **[mdg-labs/slugbase-docs](https://github.com/mdg-labs/slugbase-docs)** repository. Engineering specs, roadmaps, and design prototypes in this repo stay under **`docs/internal/`** and are not published as customer docs — see [`docs/README.md`](docs/README.md).

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
