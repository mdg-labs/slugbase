---
id: plans-billing
title: Plans and Billing
sidebar_position: 3
---

# Plans and Billing

SlugBase Cloud offers several plans to fit different needs.

## Plans (overview)

| Plan | Description |
|------|-------------|
| **Free** | Limited usage for trying out SlugBase Cloud. AI suggestions not available. |
| **Personal** | For individual users with more bookmarks and features. AI suggestions available. |
| **Team** | For teams with shared folders and collaboration. AI suggestions available. |
| **Early Supporter Lifetime** | One-time purchase for early supporters; access as long as the service is offered. AI suggestions available. |

Pricing, limits, and feature details will be published when billing is fully available. This page will be updated with current plan names, limits, and how to upgrade or manage billing.

## AI Suggestions

AI-powered suggestions for title, tags, and slug when creating bookmarks are available on Personal, Team, and Early Supporter plans. They are not available on the Free plan.

- **Organization admins** can enable or disable AI for the organization in Admin > Billing & Plan.
- **Users** can disable AI suggestions for themselves in Profile > Preferences (toggle only visible when AI is enabled for the org).
- When AI is disabled globally by an org admin, user-level toggles have no effect.
- AI is configured via environment variables: `AI_OPENAI_API_KEY` (required for AI) and optionally `AI_OPENAI_MODEL` (default: gpt-4o-mini).

## Billing and payments

- Billing (when enabled) is handled through our payment provider.
- You can upgrade, downgrade, or cancel from your account or billing settings in the app.
- For Early Supporter Lifetime, payment is one-time; no recurring subscription.

## Related

- [What is SlugBase Cloud](overview)
- [Data and privacy](data-privacy)
