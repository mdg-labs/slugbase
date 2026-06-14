# Examples — good vs bad

Side-by-side excerpts for SlugBase public docs. Formatting details: `slugbase-docs/.cursor/rules/documentation.ai.mdc`.

---

## Vocabulary

### Bad

> Mark your bookmarks as favorites so they appear on the home screen. Each organization has its own collection of aliases.

**Problems:** "favorites", "organization", "collection", "aliases" — all forbidden terms (spec §3).

### Good

> **Pin** bookmarks to surface them on your dashboard. Each **workspace** has its own **slugs** — short keywords for **forwarding** to saved URLs.

---

## Deployment-mode branching

### Bad

> When `DEPLOYMENT_MODE=cloud`, the billing module renders the upgrade button. Self-hosted users skip this branch.

**Problems:** Exposes implementation; useless to readers.

### Good

> On **SlugBase Cloud**, open **Settings → Billing** to compare plans and upgrade. Self-hosted instances do not include cloud billing screens — plan limits are configured by your operator.

---

## Guessing behaviour

### Bad

> Click **Export** in the sidebar to download all bookmarks as CSV.

**Problems:** Invented UI — not verified against routes or `en.json`.

### Good

> Open **Settings → Account → API tokens** to create a token for programmatic access. Use the export API described in the API reference when bulk export is available.

*(Only after discovery confirms export entry points.)*

---

## Internal engineering leakage

### Bad

> SlugBase stores sessions in PostgreSQL via Drizzle ORM. The NestJS backend validates CSRF on mutating routes except the allowlist in `csrf.middleware.ts`.

**Problems:** Belongs in `slugbase/docs/internal/` — readers are not SlugBase developers (spec §2.4).

### Good

> SlugBase keeps you signed in with a secure browser session. Sign out from **Settings → Account** to end your session on this device.

---

## Frontmatter and headings

### Bad

```mdx
# Quick Start

Welcome to SlugBase!!! This page tells you everything about the product.
```

**Problems:** Missing frontmatter; uses H1 in body; vague title; promotional tone.

### Good

```mdx
---
title: "Quick start with self-hosted SlugBase"
description: "Install SlugBase, complete first-run setup, and save your first bookmark."
---

## What you'll accomplish

You will have a running instance and one saved bookmark with a slug.
```

---

## Screenshot placeholders

### Bad

```mdx
The settings page looks like a sidebar on the left with four groups stacked vertically, approximately 212 pixels wide, with uppercase labels.
```

**Problems:** Unmaintainable pixel prose; no asset tracking.

### Good

```mdx
## Open SMTP settings

<!-- screenshot:settings-workspace-smtp -->

Go to **Settings → Workspace → Email / SMTP**.
```

---

## Links

### Bad

```mdx
See [folders](../cloud/folders) for details.
```

**Problems:** Relative path — breaks after Documentation.AI publish mirror.

### Good

```mdx
See [Folders](/cloud/folders) for how to organize bookmarks.
```

---

## Language scope

### Bad

```mdx
---
title: "Schnellstart"
description: "SlugBase in wenigen Minuten einrichten."
---
```

**Problems:** German public doc — out of scope; app German lives in `de.json` only.

### Good

```mdx
---
title: "Quick start"
description: "Set up SlugBase and save your first bookmark in minutes."
---
```

English only for all `slugbase-docs/**/*.mdx`.

---

## Security examples

### Bad

```mdx
Use this API token in your scripts: `sb_live_a1b2c3d4e5f6g7h8`.
```

**Problems:** Looks like a real secret; encourages committing tokens.

### Good

```mdx
Use a token with the minimum scope needed:

\`\`\`bash
curl -H "Authorization: Bearer YOUR_API_TOKEN" \
  https://your-instance.example.com/api/bookmarks
\`\`\`

<Callout kind="danger">
API tokens are shown once at creation. Store them in a secrets manager — never commit tokens to git.
</Callout>
```

---

## Procedure structure

### Bad

> You might want to enable MFA. It's a good idea. There are various apps. Also remember passwords.

**Problems:** No steps, no verification, no prerequisites.

### Good

```mdx
## Prerequisites

- Signed in to your account
- An authenticator app (for example, 1Password, Authy, or Google Authenticator)

## Enable two-factor authentication

<Steps>
  <Step title="Open security settings">
    Go to **Settings → Account → Two-factor auth**.
  </Step>
  <Step title="Scan the QR code">
    Add the entry to your authenticator app, then enter the six-digit code.
  </Step>
  <Step title="Save backup codes">
    Download your backup codes and store them offline.
  </Step>
</Steps>

## Verify it worked

Sign out and sign in again — you should be prompted for a verification code.
```

---

## IA inventory row

### Bad

| Page | Notes |
|------|-------|
| Stuff about bookmarks | important |

### Good

| path | title | type | audience | product | prerequisites |
|------|-------|------|----------|---------|---------------|
| selfhosted/bookmarks | Create and organize bookmarks | how-to | end-user | selfhosted | selfhosted/introduction |
