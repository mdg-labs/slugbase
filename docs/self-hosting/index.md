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
| [Back up and restore](backup-restore.md) | Back up the database and your secrets, and restore them into an empty database. |
| [Environment settings](environment.md) | Set up AI suggestions, audit retention and rate limits, and see which limits are fixed. |
| [Check the bookmark counter](check-bookmark-counter.md) | Find workspaces whose bookmark counter differs from the number of their bookmarks, without changing anything. |

## Next steps

- [View the source and report an issue](https://github.com/mdg-labs/slugbase)
- [Try SlugBase Cloud instead](https://cloud.slugbase.app)
