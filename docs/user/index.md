---
title: "SlugBase"
description: "Save bookmarks once and open the ones you give a short, private slug straight from the address bar."
edition: both
order: 0
---

SlugBase is a keyboard-driven bookmark manager where every link can get a short, private slug.

## What SlugBase is

SlugBase gives you bookmarks with private short links and a keyboard launcher. You save a bookmark once. If you give it a slug, such as `mail`, its go address is `go/mail`. Once you add SlugBase as a search engine in your browser, you open it by typing `go mail` in the address bar. The command palette, which you open with `⌘K` or `Ctrl K`, searches everything you saved and also accepts `go mail`.

Two properties set SlugBase apart:

- **Self-hostable.** SlugBase is open source (AGPL-3.0). You can run it on your own server.
- **EU-hosted.** SlugBase Cloud is the managed service. It is hosted in the EU and built from the same code.

## How it works

1. Save a bookmark and give it a slug, such as `mail`.
2. Add SlugBase to your browser as a search engine with the keyword `go`.
3. Type `go mail` in the address bar, or in the command palette, and the bookmark opens.

## Who it is for

SlugBase is for people who save and open links every day, alone or in a team: individuals, workspace members, admins and owners, and operators who run their own SlugBase. It removes the hunt for a link you open again and again.

## What it is not

- SlugBase is not a public URL shortener. A slug opens only for a signed-in member of the workspace that owns it.
- A slug opens the bookmark's saved address and nothing more. A path or a query after the slug is not passed on.
- SlugBase has no browser extension. You add it to your browser as a search engine instead.

## Next steps

- [Get started](getting-started.mdx)
- [Run SlugBase on your own server](/docs/self-hosting/install)
- [Try SlugBase Cloud](https://cloud.slugbase.app)
- [See pricing](https://slugbase.app/pricing)
- [View the source](https://github.com/mdg-labs/slugbase)
