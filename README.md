# SlugBase

A keyboard-driven bookmark manager where every link can get a short, private slug: save it once, then reach it from the address bar with `go <slug>` or from the `⌘K` command palette.

This repository is the **Community Edition (CE)**: open source under AGPL-3.0, self-hostable as one container image plus PostgreSQL. SlugBase Cloud, the managed EU-hosted service, is built on the same code.

## Editions

| | Community Edition | SlugBase Cloud |
|---|---|---|
| **What** | Self-hosted: one container image plus PostgreSQL, on your own server | Managed by MDG Labs, hosted in the EU |
| **Cost** | Free, AGPL-3.0, every feature unlocked | Free plan, plus Personal and Team plans ([pricing](https://slugbase.app/pricing)) |
| **Operations** | Updates, backups and mail are yours | Updates, backups and mail are ours |
| **Availability** | With the 1.0 release | Coming soon — see [slugbase.app](https://slugbase.app) |

Both run the same code from this repository; Cloud adds hosting and billing, not a different product.

**Status:** rebuild in planning. The design is in [`docs/internal/`](docs/internal/), starting with [00-overview.md](docs/internal/00-overview.md). Implementation follows the roadmap in [12-roadmap.md](docs/internal/12-roadmap.md). The first implementation was retired in October 2026.

## Licence

[AGPL-3.0](LICENSE). "SlugBase" is a trademark of MDG Labs.
