# Page templates

Skeletons for common public doc page types. Apply [tone-and-vocabulary.md](tone-and-vocabulary.md) and insert [screenshot placeholders](screenshot-placeholders.md) where noted.

**Format details** (frontmatter, components, links): defer to `slugbase-docs/.cursor/rules/documentation.ai.mdc`.

## Shared frontmatter

Every page starts with:

```yaml
---
title: "Specific, keyword-rich title"
description: "One sentence: what this page covers and who it helps."
---
```

Body starts with `##` — H1 comes from `title`.

---

## How-to (task guide)

**Use for:** Single procedure the reader completes in one sitting (create a bookmark, enable MFA, run first-time setup).

```mdx
---
title: "Create and organize bookmarks"
description: "Save URLs, add titles, and pin important bookmarks in your workspace."
---

## What you'll accomplish

After this guide, you can save a bookmark, edit its details, and pin it for quick access.

## Prerequisites

- Signed in to SlugBase
- Active workspace selected

<!-- screenshot:bookmarks-list-overview -->

## Steps

<Steps>
  <Step title="Open Bookmarks">
    From the sidebar, select **Bookmarks**.
  </Step>
  <Step title="Add a bookmark">
    Click **Add bookmark**, paste the URL, and save.
  </Step>
  <Step title="Pin a bookmark">
    Open the bookmark menu and choose **Pin** to surface it on your dashboard.
  </Step>
</Steps>

## Verify it worked

Your new bookmark appears in the list. Pinned bookmarks show on the dashboard.

## Troubleshooting

### The URL was rejected

SlugBase validates URLs for safety. Ensure the address uses `http://` or `https://` and is reachable.

### I don't see Pin

You need permission to edit the bookmark. Shared bookmarks follow the owner's sharing rules.
```

---

## Concept (explain a feature)

**Use for:** What/why without a single procedure (slugs, workspaces, plans, forwarding).

```mdx
---
title: "Slugs and forwarding"
description: "How short slugs let you jump to bookmarks from the address bar or command palette."
---

## Overview

A **slug** is a short keyword on a bookmark. When **forwarding** is enabled, you can open `/go/<slug>` to jump to the destination URL.

## How it works in your workspace

- Slugs are unique per member within a workspace — two members can each use `docs` on their own bookmarks.
- Forwarding requires you to be signed in; slugs are not public short links.

<!-- screenshot:go-forwarding-settings -->

## Related topics

- [Create bookmarks](/selfhosted/bookmarks) — assign a slug when saving
- [Command palette](/selfhosted/command-palette) — type `go <slug>` to forward

## Common questions

### Can I share a slug with someone outside my workspace?

No. Slugs resolve only for signed-in workspace members in v1.
```

---

## Operator runbook

**Use for:** Self-hosted install, config, upgrades — reader is the deployment operator.

```mdx
---
title: "Configure outbound email (SMTP)"
description: "Set SMTP settings so SlugBase can send verification and notification email on your instance."
---

## When you need this

Configure SMTP when your instance is not using operator-managed mail. Without SMTP, password reset and verification email will not send.

## Prerequisites

- Instance administrator access
- SMTP server hostname, port, and credentials
- TLS requirements from your mail provider

<!-- screenshot:settings-workspace-smtp -->

## Configure SMTP

<Steps>
  <Step title="Open workspace settings">
    Sign in as an administrator and go to **Settings → Workspace → Email / SMTP**.
  </Step>
  <Step title="Enter server details">
    Fill in host, port, username, and password. Use **Test connection** before saving.
  </Step>
  <Step title="Save and verify">
    Save settings, then trigger a test email from the account password reset flow.
  </Step>
</Steps>

<Callout kind="danger">
Never paste real SMTP passwords into documentation or commit them to the repository. Use placeholders in examples.
</Callout>

## Verify it worked

A test message arrives at the recipient inbox within a few minutes.

## Rollback

Restore previous SMTP settings from your configuration backup or clear the fields to disable outbound mail.
```

---

## Troubleshooting

**Use for:** Symptom → cause → fix tables; link to deeper how-tos.

```mdx
---
title: "Troubleshooting sign-in"
description: "Resolve common sign-in, MFA, and session issues on SlugBase Cloud."
---

## Quick checks

1. Confirm you are using the correct email address.
2. Clear site cookies for `cloud.slugbase.app` and try again.
3. Check whether your organization requires SSO.

<!-- screenshot:login-error-generic -->

## Symptoms and fixes

| Symptom | Likely cause | What to do |
|---------|--------------|------------|
| "Incorrect email or password" | Wrong credentials | Reset password; verify caps lock |
| MFA code rejected | Clock drift or used code | Use a fresh code from your authenticator app |
| Redirect loop after sign-in | Cookie blocked | Allow third-party cookies or try another browser |

## Still stuck?

Contact your workspace admin or, for cloud accounts, use the support channel listed on your plan page.
```

---

## Reference (short lookup)

**Use for:** Limits tables, keyboard shortcuts, glossary entries — scannable, minimal prose.

```mdx
---
title: "Keyboard shortcuts"
description: "Default keyboard shortcuts for navigation and the command palette."
---

## Global shortcuts

| Shortcut | Action |
|----------|--------|
| `⌘K` / `Ctrl+K` | Open command palette |
| `?` | Show shortcut help |

## Command palette prefixes

| Prefix | Mode |
|--------|------|
| `go ` | Forward to a slug |
| `> ` | Run commands |

See [Command palette](/selfhosted/command-palette) for full usage.
```

---

## Template selection

| Reader goal | Template |
|---|---|
| "How do I …?" | How-to |
| "What is …?" | Concept |
| "Install / configure / upgrade …" | Operator runbook |
| "It doesn't work …" | Troubleshooting |
| "What are the limits / keys …?" | Reference |

## Screenshot placeholders in templates

Every template marks `<!-- screenshot:… -->` where a visual helps. See [screenshot-placeholders.md](screenshot-placeholders.md) for the full convention and asset naming.
