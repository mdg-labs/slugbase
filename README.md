# SlugBase

A keyboard-driven bookmark manager where every link can get a short, private slug: save it once, then reach it from the address bar with `go <slug>` or from the `⌘K` command palette.

- **Bookmarks and folders.** Save links, organise them in folders and tags, and pin the ones you use most.
- **Private slugs.** Give a bookmark a slug and it forwards through `/go/<slug>` on your own SlugBase.
- **A command palette.** Press `⌘K` (or `Ctrl K`) to search, jump and act without leaving the keyboard.
- **Workspaces and sharing.** Keep work and personal links apart in workspaces, and share what you choose with the people you invite.

This repository is the **Community Edition (CE)**: open source under AGPL-3.0, self-hostable as one container image plus PostgreSQL, with every feature unlocked. SlugBase Cloud, the managed EU-hosted service, is built on the same code.

## Editions

| | Community Edition | SlugBase Cloud |
|---|---|---|
| **What** | Self-hosted: one container image plus PostgreSQL, on your own server | Managed by MDG Labs, hosted in the EU |
| **Cost** | Free, AGPL-3.0, every feature unlocked | Free plan, plus Personal and Team plans ([pricing](https://slugbase.app/pricing)) |
| **Operations** | Updates, backups and mail are yours | Updates, backups and mail are ours |
| **Availability** | Available now: see the [releases](https://github.com/mdg-labs/slugbase/releases) | Coming soon — see [slugbase.app](https://slugbase.app) |

Both run the same code from this repository; Cloud adds hosting and billing, not a different product.

## Quick start

You need a server with Docker and the Docker Compose plugin (2.24 or later), `git` and `openssl`, and a domain with a reverse proxy that serves SlugBase over HTTPS. Replace `<version>` with the release you want to run, as listed on the [releases page](https://github.com/mdg-labs/slugbase/releases).

```sh
git clone --depth 1 --branch v<version> https://github.com/mdg-labs/slugbase.git
cd slugbase

(umask 077; cat > .env <<EOF
SLUGBASE_IMAGE=ghcr.io/mdg-labs/slugbase:<version>
APP_ORIGIN=https://links.example.com
TRUSTED_PROXY_HOPS=1
SESSION_SECRET=$(openssl rand -base64 48)
ENCRYPTION_KEY=$(openssl rand -base64 32)
ENCRYPTION_KEY_ID=key-1
POSTGRES_PASSWORD=$(openssl rand -hex 24)
APP_DB_PASSWORD=$(openssl rand -hex 24)
MIGRATOR_DB_PASSWORD=$(openssl rand -hex 24)
EOF
)

docker compose up -d
curl -fsS http://127.0.0.1:3000/ready
```

`SLUGBASE_IMAGE` names a version tag, so the same file starts the same SlugBase every time. Once `/ready` answers, put your reverse proxy in front of port 3000 and open `APP_ORIGIN` in a browser to create the first account and workspace. The [install guide](docs/self-hosting/install.md) has the complete steps, including the reverse proxy and first-run setup.

## Verify the image

Before you run an image, check that the release workflow of this repository built and signed it, and that its SBOM and provenance attestations are signed too. You need [cosign](https://docs.sigstore.dev/cosign/system_config/installation/) 3.x and Docker with `buildx`.

```sh
bash scripts/verify-image.sh <version>
```

The script exits with `0` only when the signature and both attestations hold. Do not run an image it rejects. [Verify the image](docs/self-hosting/upgrade.md#verify-the-image) explains each step and every exit status, and [Image tags](docs/self-hosting/upgrade.md#image-tags) lists the tags that exist and what each one points at.

## Documentation and help

- **Using SlugBase:** the [documentation](https://slugbase.app/docs), starting with [Getting started](docs/user/getting-started.mdx).
- **Running SlugBase:** the [self-hosting guides](docs/self-hosting/index.md): install, upgrade, backup and restore, mail, sign-in providers and the reverse proxy.
- **Questions and help:** [GitHub Discussions](https://github.com/mdg-labs/slugbase/discussions).
- **Bugs and feature requests:** [open an issue](https://github.com/mdg-labs/slugbase/issues/new/choose) with the matching template.
- **Security vulnerabilities:** report them privately, as [SECURITY.md](SECURITY.md) describes. Never open a public issue for one.
- **Contributing:** see [CONTRIBUTING.md](CONTRIBUTING.md).

## SlugBase Cloud

If you would rather not run a server, SlugBase Cloud is the managed alternative: the same SlugBase, hosted in the EU by MDG Labs, with updates, backups and mail taken care of. Read about it at [slugbase.app](https://slugbase.app), see the [plans and pricing](https://slugbase.app/pricing), or sign in or sign up at [cloud.slugbase.app](https://cloud.slugbase.app).

## Design

The design of SlugBase is in [`docs/internal/`](docs/internal/), starting with [00-overview.md](docs/internal/00-overview.md).

## Licence

Copyright (C) 2026 Michael David Guggenbichler (MDG Labs). Licensed under AGPL-3.0-only — see [LICENSE](LICENSE).
