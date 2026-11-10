---
title: "Error Pages"
description: "What the error pages, the offline banner and the sign-in prompt mean, and what to do about each."
edition: both
order: 120
---

SlugBase shows a page or a message of its own when an address does not exist, when you may not open a page, when something fails on the server, when your connection drops and when your session ends. This page says what each one means and what to do.

## Prerequisites

None.

## What you may see

| What you see | What it means | What to do |
| ------------ | ------------- | ---------- |
| **This page doesn't exist** | No page lives at this address. | Choose **Go home**. |
| **You don't have access** | Your role does not allow this page. | Ask an owner or admin, or choose **Go home**. |
| **Something went wrong** | The page could not be shown. | Choose **Reload**. If it continues, send the **Request ID** to your administrator. |
| **You are offline** | Your browser has no connection. | Wait for the connection. Nothing is saved until it is back. |
| **Your session has ended** | You are signed out. | Sign in again. SlugBase brings you back to the page. |

## This page doesn't exist

The page says "The address may be mistyped, or the page may have moved." Choose **Go home** to open Home.

It appears when:

- You mistype an address, or follow a link to a page that moved.
- You add a path or a query after a slug, such as `go/mail/inbox`. SlugBase never passes anything after the slug on to the destination. See [Go Pages](go.mdx).
- The text after `go/` is not a valid slug. A slug has lower-case letters, digits and hyphens. See [Slugs and /go](concepts/slugs.md).
- You open the first-run setup address of a server that is already set up.

When you are signed out, SlugBase asks you to sign in first and then takes you back to the address you asked for. If it still does not exist, you see this page.

A different page says "No bookmark has the slug" and a slug. That page means the slug is valid, but you have no bookmark with it. See [Go Pages](go.mdx).

## You don't have access

The page says "You are not a member of this workspace, or this page is only for administrators." Choose **Go home** to leave.

It appears when you open a page that your role does not allow:

- **Members**, **Audit log** and **AI suggestions** in the workspace settings are for admins and owners.
- The pages under **Admin** are for instance admins of a self-hosted SlugBase.

Ask an owner or an admin of the workspace to change your role, or ask the instance admin of your SlugBase. See [Workspaces and Roles](concepts/workspaces-and-roles.mdx). If you belong to several workspaces, check that the one you have open is the one you mean. Open the workspace switcher in the sidebar to change it.

If your role changes while a page is open, the page can say "You are no longer allowed to change this workspace." Reload the page.

## Something went wrong

The page says "This page could not be shown. Reload it, and tell your administrator if this continues." It fills the whole window, without the sidebar.

1. Choose **Reload**.
2. If the page appears again, continue.
3. If **Something went wrong** appears again, choose **Copy request ID** and send the **Request ID** to the person who runs your SlugBase, or to support on SlugBase Cloud. Tell them what you were doing.

**Result:** The request ID names the request that failed. SlugBase shows nothing else about the cause here. The operator of a self-hosted SlugBase can find that request in the server's logs. See [Run SlugBase Day to Day](/docs/self-hosting/operations).

The **Request ID** appears when the failure came from an answer of the server. When the failure happened in the page itself, there is no ID. Say what you were doing instead.

### When a change is not saved

A failed save does not open this page. A message appears instead, titled **The change was not saved**: "Try again. If this continues, tell your administrator." It ends with "Request ID:" and the ID, which you can read out in the same way.

## You are offline

When your browser goes offline, a banner says **You are offline**: "Changes cannot be saved until your connection is back." It disappears when the browser is online again.

While you are offline, SlugBase does not keep your changes to send later. A change fails at once with **The change was not saved**, and the message adds "You are offline. Check your connection and try again."

1. Check your connection.
2. When the banner is gone, make the change again.

## Your session has ended

When SlugBase finds that you are signed out, it opens **Sign in** and shows the message **Your session has ended**: "Sign in again to continue." After you sign in, SlugBase takes you back to the page you were on. If your account has two-step verification, the sign-in has its second step. See [Sign In](access/sign-in.mdx).

A session ends when:

- It runs out. A session lasts 30 days, or 90 days with **Remember me**, each counted from your last visit.
- You, or someone with your password, ends this session from another device with **Revoke** or **Sign out everywhere else** in [Security](account/security.mdx).
- You change your password on another device. SlugBase then signs out your other sessions.

## Field and option reference

| Field / option | Description | Required |
| -------------- | ----------- | -------- |
| Go home | Opens Home. On **This page doesn't exist** and **You don't have access**. | No |
| Reload | Loads the page again. On **Something went wrong**. | No |
| Request ID | The ID of the request that failed. Shown when the server answered the failed request. | No |
| Copy request ID | Copies the ID, so you can paste it into a message. | No |

## Troubleshooting

### Reload does not help

Send the **Request ID** to the person who runs your SlugBase, or to support on SlugBase Cloud.

### There is no request ID

The failure happened in the page, not in an answer of the server. Tell your administrator what you were doing and which page you were on.

## Related pages

- [Frequently Asked Questions](faq.md)
- [Sign In](access/sign-in.mdx)
- [Go Pages](go.mdx)
- [Workspaces and Roles](concepts/workspaces-and-roles.mdx)
