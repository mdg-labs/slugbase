---
id: admin
title: Admin Page
sidebar_position: 14
---

# Admin Page (SlugBase Cloud)

## Overview

On SlugBase Cloud, the Admin page is available to organization **owners** and **admins**. It lets you manage members, teams (on Team or Early Supporter plans), and billing. Authentication providers (Google, Microsoft, GitHub) and AI are configured by SlugBase; you manage your plan and who has access to your organization.

![Admin Page](../assets/admin-overview.png)

## Route

- **Path**: **`/app/admin`** (default redirect to **`/app/admin/members`**)
- **Authentication**: Required
- **Authorization**: Organization owner or admin only. Non-admins are redirected to the dashboard.

## Tabs

Cloud Admin has three main sections (Teams is shown only on Team or Early Supporter plans):

1. **Members** – `/app/admin/members` – View and manage organization members; invite new members (on paid plans).
2. **Teams** – `/app/admin/teams` – Create and manage teams and team memberships (Team and Early Supporter plans only).
3. **Billing** – `/app/admin/billing` – Current plan, upgrade/downgrade, invoices, org-wide AI toggle, and member invites.

OIDC providers (Google, Microsoft, GitHub), SMTP, and AI provider configuration are **not** available in the Cloud UI; they are managed by SlugBase. To change how users sign in or to get help, see [Login and Auth Providers](auth) or contact support.

## Members Tab

- **View Members**: List of all members in your organization with name, email, and role.
- **Invite Members** (paid plans): Invite new users by email. They receive an email to join the organization. Invites are available when your plan includes more than one seat and you have seats available.
- **Roles**: Members have roles (e.g. owner, admin, member). Only owners/admins can access Admin.

Access: **Admin → Members** (or **Admin** from the sidebar, which opens Members by default).

## Teams Tab

- **View Teams**: List of teams in the organization.
- **Create / Edit / Delete Teams**: Manage team names and descriptions.
- **Manage Members**: Add or remove members from teams.

Teams are used to share bookmarks and folders with a group. This tab is only visible on **Team** and **Early Supporter** plans. On Free and Personal plans, the Teams tab is hidden.

Access: **Admin → Teams**.

## Billing Tab

- **Current Plan**: Shows your plan name (Free, Personal, Team, Early Supporter Lifetime) and seat usage (e.g. X of Y seats used).
- **Upgrade / Change Plan**: Buttons to upgrade or switch between plans (monthly/yearly where applicable). You are redirected to the payment provider to complete payment; after success you return to **Admin → Billing**.
- **Manage Subscription**: Link to the billing portal (e.g. Stripe Customer Portal) to update payment method, cancel, or change plan.
- **Invoice History**: List of past invoices with download (PDF) and view links when available.
- **Organization AI Toggle**: Enable or disable AI suggestions (title, tags, slug) for the whole organization. Only available on plans that include AI (Personal, Team, Early Supporter). When enabled, individual users can still turn off AI for themselves in [Profile](profile) → Preferences.
- **Invite Members**: On paid plans with available seats, invite new members by email from this tab as well.

Access: **Admin → Billing**.

For plan details, limits, and pricing, see [Plans and Billing](plans-billing).

## User Interactions

### Managing Members

1. Open **Admin** from the sidebar (or go to `/app/admin`).
2. You land on **Members**. View the list of members.
3. To invite (paid plans with available seats): Enter email in the invite field and submit. The user receives an invitation email.

### Managing Teams (Team / Early Supporter plans)

1. Click **Teams** in the Admin area.
2. Create a team, edit its name/description, or add/remove members.
3. Teams can then be selected when sharing bookmarks or folders.

### Managing Billing

1. Click **Billing** in the Admin area.
2. View current plan and seat usage.
3. Use **Upgrade** or plan buttons to change plan (redirect to payment provider).
4. Use **Manage Subscription** to open the billing portal.
5. Download or view invoices from the invoice list.
6. Toggle **AI for organization** on or off if your plan includes AI.

## Related Pages

- [Plans and Billing](plans-billing) – Plan names, limits, and AI availability
- [Login and Auth Providers](auth) – How users sign in (Google, Microsoft, GitHub, email/password)
- [Profile](profile) – User-level AI suggestions toggle and account settings
