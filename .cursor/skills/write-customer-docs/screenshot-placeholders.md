# Screenshot placeholders

Use placeholders in MDX drafts until screenshots are uploaded via the **Documentation.AI web editor** (CDN URLs on `blob-cdn.documentation.ai`).

## Placeholder syntax

```mdx
<!-- screenshot:<asset-slug> -->
```

| Part | Rule |
|---|---|
| `screenshot:` | Fixed prefix — distinguishes from other comments |
| `<asset-slug>` | Lowercase kebab-case describing the screen |

**Placement:** On its own line, typically after the section heading or before `<Steps>`.

### Examples

```mdx
## Open workspace settings

<!-- screenshot:settings-workspace-general -->

From the sidebar, choose **Settings**, then **Workspace**.
```

## Replacing placeholders

1. Upload the screenshot in the Documentation.AI web editor (`/image`).
2. Copy the `blob-cdn.documentation.ai` URL from image properties.
3. Replace the comment with `<Image>`:

```mdx
<Image
  src="https://blob-cdn.documentation.ai/org-…/settings-workspace-general.png?q=85&fm=auto&auto=compress%2Cformat"
  alt="Workspace settings general tab"
  width="1200"
  height="800"
/>
```

| Placeholder slug | Suggested capture | Product |
|---|---|---|
| `bookmarks-list-overview` | Bookmarks list with sample data | both |
| `bookmark-modal-edit` | Edit bookmark modal with slug field | both |
| `command-palette-go-mode` | Palette open in `go ` mode | both |
| `go-disambiguation` | Slug collision chooser | both |
| `settings-workspace-smtp` | Workspace → Email / SMTP section | selfhosted |
| `settings-account-mfa` | Account → Two-factor auth enroll | both |
| `login-error-generic` | Sign-in with generic error state | both |
| `dashboard-pinned-row` | Dashboard with pinned bookmarks | both |

Do **not** use `![alt](/assets/…)` — repo `/assets/` paths are not served on the live site.

## Optional: visible callout placeholder

```mdx
<Callout kind="info">
**Screenshot pending:** `settings-workspace-smtp` — capture Workspace → Email / SMTP on a self-hosted instance with mail admin UI enabled.
</Callout>
```

## What not to do

- Do not commit proprietary or customer data in screenshots — use demo workspaces.
- Do not use relative image paths — CDN URLs must be absolute.
- Do not skip placeholders and leave long prose descriptions of pixel layout.
- Do not embed base64 images in MDX.
