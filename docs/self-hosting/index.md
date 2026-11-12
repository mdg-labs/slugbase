---
title: "Self-Hosting SlugBase"
description: "Learn what it means to run SlugBase on your own server and find the operator pages."
edition: ce
order: 0
---

Self-hosting means you run SlugBase on your own server. This section is for the person who does that: the operator.

## What self-hosting means

The self-hosted edition is the Community Edition. It is open source under AGPL-3.0 and has every feature unlocked. It runs as one container image together with PostgreSQL, and the repository ships a `compose.yml` that starts the stack.

SlugBase Cloud is the managed alternative. It is built from the same code. When you self-host, updates, backups and mail are yours to run.

## What you do as the operator

- Start SlugBase and its PostgreSQL database on your server.
- Finish first-run setup, which creates the first account and workspace.
- Invite the people who will use it. Public registration is off by default.
- Keep an eye on the health of the installation, as an instance admin.

The people you invite use SlugBase as described in [Get started](../user/getting-started.mdx).

## Operator pages

| Page | What it covers |
| ---- | -------------- |
| [Install SlugBase](install.md) | Start SlugBase from the published compose file and finish first-run setup. |
| [Back up and restore](backup-restore.md) | Back up the database and your secrets, and restore them into an empty database. |
| [Put SlugBase behind a reverse proxy](reverse-proxy.md) | Serve SlugBase over HTTPS with nginx or Caddy, and set the origin and the trusted proxy hops. |
| [Set up mail](mail.md) | Connect an SMTP relay, set up the sending domain, send a test email, and run without mail. |
| [Set up OIDC sign-in](oidc.md) | Add OpenID Connect providers, register the redirect address, and learn how accounts are linked and created. |
| [Upgrade SlugBase](upgrade.md) | Upgrade to a new release, run migrations yourself, roll back, and see the supported versions. |
| [Run SlugBase day to day](operations.md) | Check health, read logs, rotate secrets, see what is deleted by itself, and plan connections and size. |
| [Account recovery and security checklist](security.md) | Get people back into locked accounts, and check the security settings an operator must get right. |
| [Environment settings](environment.md) | Look up every environment key, its default and what it sets, and see which limits are fixed. |
| [Check the bookmark counter](check-bookmark-counter.md) | Find workspaces whose bookmark counter differs from the number of their bookmarks, without changing anything. |
| [Remove a bookmark as the operator](remove-bookmark.md) | Remove one bookmark of any workspace with SQL, whoever owns it, and record that you did. |

## Next steps

- [View the source and report an issue](https://github.com/mdg-labs/slugbase)
- [Try SlugBase Cloud instead](https://cloud.slugbase.app)
