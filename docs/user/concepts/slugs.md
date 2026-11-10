---
title: "Slugs and /go"
description: "Learn what a slug is, how go opens a bookmark from it, and what happens when several bookmarks share a slug."
edition: both
order: 10
---

A slug is a short word you give a bookmark, such as `mail`. Type `go mail` in your browser's address bar, or `go mail` in the command palette, and SlugBase opens that bookmark. This is called forwarding, or go.

## How a slug works

A slug follows a few rules:

- It uses lower-case letters, digits and hyphens.
- It has 1 to 64 characters and does not start with a hyphen.
- If you type capital letters, SlugBase lowers them. `Mail` and `mail` are the same slug.
- Anything else is refused, and the **Slug** field tells you what to change.

A bookmark has at most one slug, and a slug is optional.

A slug is unique per owner inside a workspace. Two members can each have a bookmark with the slug `mail`. You cannot have two. If you try to save a slug you already use, the **Slug** field says **You already use this slug on another bookmark.** and asks you to choose a different one. When you delete a bookmark, its slug is free again at once.

**Forwarding** is a switch on the bookmark. It turns on when you enter a slug, and it needs a slug to be on. If you turn it off, the bookmark keeps its slug, but go no longer opens it. The slug still finds the bookmark in search and in the command palette.

The bookmark dialog shows the **Go address** for the slug, with **Copy go address** next to it.

## What go does

When you open a go address, SlugBase looks for bookmarks that fit all of these:

- They are in the workspace you have open.
- They have this slug and forwarding is on.
- You can read them. These are your own bookmarks and the ones shared with you, whether directly, through a team or through a shared folder.

Then SlugBase opens the bookmark's saved destination. Only `http` and `https` addresses open. SlugBase does not scan the destination page.

A slug opens only the saved address. If you add a path or a query after the slug, such as `go/mail?x=1`, SlugBase shows the not-found page and does not pass anything on to the destination.

Go works for signed-in members of the workspace. If you are signed out, SlugBase sends you to sign in and then takes you back to the same go address. Nobody can open a slug without signing in, and a slug is never public.

## When several bookmarks have the same slug

SlugBase picks the bookmark in this order:

1. The choice you remembered for this slug, if that bookmark is still available to you.
2. Your own bookmark with this slug.
3. The only bookmark shared with you that has this slug.
4. If several shared bookmarks have it, a page that asks you to choose.
5. If none has it, the not-found page.

The choosing page says, for example, **go/mail matches 2 bookmarks**. Each bookmark shows its title, its destination host, its owner and how it reached you: **directly**, **through a team** or **through a shared folder**. Choose one to open it.

Select **Always use this for mail** before you choose to remember your pick. A remembered choice is yours alone and applies in that workspace. You list and remove your remembered choices on the **Forwarding** page, under **Remembered choices**. SlugBase removes a remembered choice for you when:

- the bookmark is deleted,
- its slug changes or its forwarding is turned off, or
- you lose access to the bookmark by every route. If you can still read it another way, the choice stays.

## When nothing is found

The not-found page says **No bookmark has the slug mail in** and then the name of the workspace. It offers **Create a bookmark with this slug**. If a slug with that name works in another of your workspaces, the page also lists it as **Found in** with a link to switch and continue. SlugBase never forwards you across workspaces by itself.

You see this page when the slug does not exist, forwarding is off, the bookmark is not shared with you, or you added something after the slug.

## What it means for you

- Pick slugs you can type fast. The short ones, such as `mail` or `wiki`, are the most useful.
- Your own bookmark always wins over a shared one with the same slug, unless you remembered another choice.
- To stop a slug from opening without losing it, turn **Forwarding** off.
- Add SlugBase to your browser as a search engine once to use go from the address bar. [Getting started](../getting-started.mdx) shows how.

## Related pages

- [Getting started](../getting-started.mdx)
- [Organising bookmarks](organising-bookmarks.md)
