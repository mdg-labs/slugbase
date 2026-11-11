---
title: "Frequently Asked Questions"
description: "Short answers to the questions people ask most about signing in, slugs, privacy, your data and getting help."
edition: both
order: 130
---

This page answers what people most often get stuck on, and links to the page that has the steps.

## Signing in

### Why does go ask me to sign in?

A slug is private. It opens a bookmark only for a signed-in member of the workspace that owns it, so `go/mail` is never a public link. When you are signed out, SlugBase asks you to sign in and then takes you back to the same go address. If your account has two-step verification, the sign-in includes that step. A personal API token cannot open a go address, because go is made for your browser.

See [Slugs and /go](concepts/slugs.md) and [Sign In](access/sign-in.mdx).

### I lost my authenticator app and my backup codes. What do I do?

SlugBase cannot let you in without a code, and it cannot recover the codes for you.

- **Self-hosted:** ask an instance admin to reset two-factor authentication for your account. Where email is set up, SlugBase emails you when they do. An instance admin cannot reset their own account, so another instance admin does it.
- **SlugBase Cloud:** contact support. Support checks who you are before it resets anything.

After the reset, you are signed out everywhere. You sign in with your password or through your sign-in provider, whichever your account uses. Set up two-factor authentication again in [Security](account/security.mdx). Save the new backup codes this time.

See [Accounts](admin/accounts.mdx) for what the instance admin does.

## Slugs and go

### Why does go say no bookmark has the slug, when I know it exists?

Go looks only in the workspace you have open. The slug may be in another of your workspaces. The page then shows a button that begins **Found in:** with the workspace's name. Choose it to switch and continue. SlugBase never forwards across workspaces on its own.

Other reasons:

- Forwarding is off for that bookmark. A slug opens only while forwarding is on.
- The bookmark is another member's and it is not shared with you. You can open only your own bookmarks and the ones shared with you.
- You typed something after the slug, such as `go/mail/inbox`. Go does not pass that on, and shows **This page doesn't exist**.

Capital letters do not matter: `Mail` and `mail` are the same slug.

See [Go Pages](go.mdx) and [Forwarding](forwarding.mdx).

### Why do open counts lag behind?

SlugBase records an open in the background, so opening a bookmark never waits for it. It writes the opens in batches. A count and the **Last opened** time can therefore trail what you did by up to about ten seconds. If the server stops unexpectedly, the opens of the last few seconds can be lost. Counts are statistics, not a record.

When you open a bookmark that was shared with you, the open adds to the owner's count, because the count belongs to the bookmark.

See [Bookmarks](bookmarks.mdx).

## Privacy

### Who can see my bookmarks?

- **You.** Your own bookmarks are visible to you alone, until you share one.
- **People you share with.** A member, or a team, that you share a bookmark or a folder with can read it and open it. They cannot change it. They do not see your tags, which folders it is in or whether you pinned it.
- **Admins and owners.** Their role lets them manage people, teams and settings. It does not let them read your private bookmarks.
- **Other members.** Everyone in a workspace can see who else is a member, with their names and email addresses. They need that to share.
- **The operator.** Whoever runs the server can read everything stored on it. On a self-hosted SlugBase that is the person or team that runs it. On SlugBase Cloud it is the operator of the service, and the privacy policy says what they do and do not do with that access.

See [Sharing](concepts/sharing.mdx) and [Workspaces and Roles](concepts/workspaces-and-roles.mdx).

### Why do favicons come from the server?

SlugBase's server fetches a site's icon once, stores it and shows it from its own address. Your browser never contacts a bookmarked site just to draw a list, so the sites you saved do not see you load them. A site with no icon shows a monogram instead.

The trade is that the bookmarked site can see a request from the server, with the server's network address and the time. The server reads a site's page title and description in the same way when you save a bookmark.

See [Add and Edit Bookmarks](add-and-edit-bookmarks.mdx).

### Does a self-hosted SlugBase report usage to SlugBase's makers?

No. A self-hosted SlugBase sends no usage pings and makes no update check that reports back. To see whether a newer version exists, the instance admin opens the public releases page from **Overview**. See [Overview](admin/overview.mdx).

## Your data

### What happens to my content when I leave?

Your bookmarks and folders stay in the workspace. They never move to another workspace. The person who ends your membership chooses what happens to them. When you leave on your own, you choose.

- **Transfer.** Your bookmarks and folders go to another member and keep their slugs. A slug the new owner already uses is cleared on the transferred bookmark.
- **Delete.** Your bookmarks and folders are deleted with your membership.

Your tags and your remembered choices for slugs are deleted either way. Shares you received end. Your API tokens for the workspace stop working.

If you delete your account instead, a workspace where you are the only member is deleted with it. In every other workspace, your bookmarks and folders stay without an owner, and an admin can reassign or delete them.

To keep a copy first, export your bookmarks. See [General](workspace/general.mdx) and [Profile](account/profile.mdx).

### How do I export everything?

1. Open the account menu in the top bar and choose **Account settings**.
2. Under **Account**, choose **Import & export**.
3. Under **Export bookmarks**, choose **SlugBase JSON (recommended)**.
4. Choose **Download**.

The file holds your own bookmarks of the workspace you have open, with their folders, tags, slugs, forwarding and pins, and your remembered choices for slugs. Importing it into an empty workspace gives you the same bookmarks. It does not hold bookmarks that other members own, except the readable list you get when you select **Include bookmarks shared with me**.

An export covers one workspace. If you belong to several, switch to each one and export again. **Netscape HTML** is for browsers and keeps less.

See [Import and Export](account/import-and-export.mdx).

## Getting help

### Where do I ask a question or report a bug?

- **Questions** about using or running SlugBase go to [GitHub Discussions](https://github.com/mdg-labs/slugbase/discussions). They are public and searchable.
- **Bugs and feature requests** go to the [issue forms](https://github.com/mdg-labs/slugbase/issues/new/choose). Use an issue only for those, not for questions.
- On SlugBase Cloud, contact support.

### How do I report a security problem?

Do not open a public issue. Report it privately, as the [security policy](https://github.com/mdg-labs/slugbase/security/policy) explains. It names how to send a private report and how fast you can expect an answer.

### What do the error pages mean?

See [Error Pages](error-pages.md) for **This page doesn't exist**, **You don't have access**, **Something went wrong**, the offline banner and the sign-in prompt when your session ends.

## Related pages

- [Getting started](getting-started.mdx)
- [Error Pages](error-pages.md)
- [Slugs and /go](concepts/slugs.md)
- [Sharing](concepts/sharing.mdx)
