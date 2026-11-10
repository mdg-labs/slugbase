---
title: "Account Recovery and Security Checklist"
description: "Get people back into locked accounts, understand what the instance admin and the operator can do, and check the security settings an operator must get right."
edition: ce
order: 80
---

This page has two parts. The first explains how to get someone back into an account they cannot sign in to, and what to do before the last instance admin loses access. The second is a checklist of the settings that decide how safe your installation is, and a plain statement of what you, the operator, can see.

## Prerequisites

- An account with the instance admin flag. The first account, which first-run setup creates, has it.
- For most of the recovery actions, a second factor (two-step verification) turned on for that account. See [Check what an instance admin can do](#check-what-an-instance-admin-can-do).

## Recover a locked-out account

Members who lose access can often help themselves. An instance admin does the rest in **Admin**, then **Accounts**. Most actions there ask you to confirm it is you again, and each one is written to the instance audit log, which workspace members cannot read.

| What happened | What the person does | What an instance admin does |
| ------------- | -------------------- | --------------------------- |
| Forgot the password | Chooses **Forgot your password?** on the sign-in page and opens the link in the email. The link works once and for one hour. Without mail, the page tells them to ask an instance admin. | Chooses **Send reset link** for the account. Where mail is set up, the account gets the email. Without mail, the admin sees the link once, in a dialog, and passes it on. The link works once and for one hour. |
| The verification link did not arrive, or expired | Asks for a new link on the sign-in page. | Chooses **Resend verification email**, which needs mail. Without mail, chooses **Mark as verified**, and reads the warning first. |
| Lost the phone with the authenticator app | Signs in with one of their backup codes. Then, in **Settings**, **Account**, **Security**, they turn two-step verification off, which asks for the password and an unused backup code, and set it up again. A backup code works once. | Chooses **Reset two-factor authentication**. The account is signed out everywhere, signs in with its password alone, and is told by email where mail is set up. |
| Account was disabled | Nothing. A disabled account cannot sign in. | Chooses **Enable account**. |

Some limits you should know:

- **Reset link.** The account must be enabled, with a verified address, and must have a password or no linked sign-in provider. An account that signs in only through a provider has no password to reset. Choose **Mark as verified** first for an account whose address nobody verified.
- **Reset two-factor authentication.** It is refused for a disabled account, and for your own account. You turn off your own second factor in your account settings, with the second factor.
- **Mark as verified** removes what the person who registered the address set up: the password, sessions, second factor, API tokens and linked sign-ins, and in workspaces the account owns alone, the other members, teams, invitations and shares. The owner then gets in through a reset link or a provider. Do it only for an address you know belongs to the person.
- **Mail.** Without mail, the reset link is the only email-free way. [Set Up Mail](mail.md) lists what else changes.

### When the last instance admin is locked out

At least one enabled instance admin must always exist. SlugBase refuses to remove, disable or delete the last one. That also means nobody else can step in when that one account is lost, so prepare before it happens.

**Prepare.**

1. Make a second account an instance admin, with **Make instance admin** in **Admin**, **Accounts**, and let that person turn on two-step verification. Two admins can reset each other's second factor and send each other a reset link.
2. Keep the backup codes of every instance admin where they cannot be lost with the phone.
3. Set up mail, so that an admin can reset their own password.

**If the only admin cannot get in.** Use the first of these that fits.

- **The password is lost, and mail is set up.** Use **Forgot your password?**. After the reset, the account still needs its second factor or a backup code.
- **The authenticator is lost, and at least two backup codes are left.** An admin cannot reset their own second factor in **Admin**. This needs two unused codes: signing in with a backup code uses it up, and turning two-step verification off asks for the password and another unused backup code. Sign in with the first code, turn two-step verification off in **Settings**, **Account**, **Security** with the second, and set it up again. With only one code left, that route is closed, but the password and the one code still sign you in. From that session, make a second account an instance admin with **Make instance admin**, and that admin chooses **Reset two-factor authentication** for your account. The second account needs two-step verification turned on before it can use the admin area. When no code is left, ask the second instance admin from **Prepare** to choose **Reset two-factor authentication** for your account, or, when a sign-in provider is linked, use the next case.
- **Both are lost, and a sign-in provider is linked to the account.** See [Set Up OIDC Sign-In](oidc.md). Signing in through the provider gives a full session without a code. From it, make a second account an instance admin. That admin chooses **Reset two-factor authentication** for the first one.
- **Both are lost, no provider is linked, and the account's address is verified.** You, the operator, can add a provider, as [Set Up OIDC Sign-In](oidc.md) describes, that asserts the address of the account as verified. The first sign-in through it links the identity to the account and gives a full session without a code. From it, make a second account an instance admin, who chooses **Reset two-factor authentication** for the first one. Only add a provider that verifies addresses.

If none of these fits, no operation in the app or command in the image gives the account back. This is on purpose: apart from a provider you add, nothing in the product lets the operator bypass the sign-in of the locked-out admin's own account, whose address is verified. This holds only for that account. On an instance without mail, an instance admin can take over another account that has a verified address and signs in with a password. The admin chooses **Reset two-factor authentication** for it, then **Send reset link**, receives the link and sets a new password with it. This needs a second factor on the admin's own account and a confirmation within the last 10 minutes, as [Check what an instance admin can do](#check-what-an-instance-admin-can-do) describes. Where mail is set up, the link goes to the account's own address and the admin does not receive it. Both actions are written to the audit log. First-run setup stays closed once an account exists. A person who holds the host and the database can change data directly, but SlugBase does not support that, does not record it in its audit log, and this page does not describe it. The threat model in the repository, `docs/internal/10-threat-model.md`, lists this as accepted residual 18 in its section 5.

## Check what an instance admin can do

- **A second factor is required for the actions that change the instance or who can reach it.** That covers deleting a workspace, managing accounts (including every recovery action above), promoting and demoting instance admins, and changing the settings. An admin who has not set one up can still read the status and settings, list the workspaces, create a workspace and send a test email. The admin area asks the admin to turn it on first.
- **Sensitive actions need a recent confirmation.** The person confirms with their password, or signs in again through their provider, within the last 10 minutes. For an account with a second factor, a current code works too. This holds for changing the password or email, turning two-step verification on or off, creating API tokens, unlinking a sign-in method, deleting an account or a workspace, changing who owns a workspace, and for the instance admin actions above. An API token can never do any of them.
- **An instance admin cannot read a workspace by being an admin.** To see a workspace they do not belong to, they choose **Add me as member**, which needs a confirmation and is visible to that workspace's owners.

## Security checklist

Go through this list when you install, and again after any change to `.env`.

1. **The origin is HTTPS.** `APP_ORIGIN` is the public `https` address, and production refuses to start otherwise. See [Put SlugBase Behind a Reverse Proxy](reverse-proxy.md).
2. **`TRUSTED_PROXY_HOPS` is right.** It is the number of reverse proxies in front of the server. A value that is too low makes every client share the rate limits. A value that is too high lets a client choose its own address. The same page explains how to count.
3. **The server's port is private.** `compose.yml` publishes it on `127.0.0.1`. Keep it that way, and let only your proxy reach it. Do not publish `METRICS_PORT` or the database.
4. **The secrets are generated and strong.** `SESSION_SECRET` has at least 32 characters, and `ENCRYPTION_KEY` is a random 32-byte key in base64. Make them with `openssl rand`, as in [Run SlugBase Day to Day](operations.md). Production refuses a short secret and the example values of the repository. Use a different value for each secret.
5. **The secrets stay out of the repository.** Keep `.env` and `.env.oidc` out of version control and readable by you only. Do not paste them in an issue or a chat.
6. **The database uses its two roles.** The server and the worker connect as `slugbase_app`, which row-level security binds. Only the migration connects as `slugbase_migrator`, and the worker never gets that login. `compose.yml` does this for you. Leave `SLUGBASE_ALLOW_OWNER_CONNECTION` at `false`: with it off, the server and the worker refuse to start when their database login is a superuser, owns the database or bypasses row-level security. Use passwords made of letters and digits, from `openssl rand -hex 24`, and never the development ones.
7. **Registration is off unless you want it.** In the Community Edition `PUBLIC_REGISTRATION` is off by default, so only people you invite can join. If you turn it on, also set up mail and consider `EMAIL_VERIFICATION_REQUIRED=true`. If you set `OIDC_<SLUG>_AUTO_CREATE=true` for a provider, limit it with `OIDC_<SLUG>_ALLOWED_DOMAINS`.
8. **The setup token stays on.** `SETUP_TOKEN_REQUIRED` is on by default. While there is no account, the server prints a token to its log, and first-run setup needs it, so a stranger who finds a new instance cannot claim it. Finish setup right after you start the instance, and do not turn the token off. After the first account exists, setup is closed.
9. **Breached passwords are refused.** `BREACHED_PASSWORD_CHECK` is on by default. It checks passwords against a list that ships in the image, and sends nothing anywhere. Leave it on.
10. **Instance admins use a second factor,** and there are at least two of them.
11. **Backups are offsite and complete.** Back up the database and, separately, your keys: `.env`, with `ENCRYPTION_KEY`, `ENCRYPTION_KEY_ID`, `ENCRYPTION_KEY_PREVIOUS` and `SESSION_SECRET`. Test a restore. See [Back Up and Restore SlugBase](backup-restore.md).
12. **You can upgrade.** Pin a version, and read [Upgrade SlugBase](upgrade.md) before you need it.

## What an instance contacts

SlugBase sends nothing to MDG Labs: it has no usage pings, no update check and no telemetry, and the web app asks for nothing from any origin but your own, so a browser fetches no font, script or image from a third party. Besides its connection to its database, a default instance, with none of the optional services of [Set Up the Environment](environment.md) configured, makes a network request for one reason only: a member gives it a link. SlugBase contacts the host of that link in three cases:

- **A member opens the bookmark form with an address, or enters one in it.** When the form opens with an address (chosen in the command palette, pasted onto the page, or carried by a link to the form), when the address field loses focus, and after a paste into it, the server fetches the page at once, to suggest a title and a description, whether or not the member saves the bookmark.
- **A member saves the bookmark, or changes its address.** Unless the workspace already has a fresh result for that page, the worker fetches the page in the background and caches its title and description for seven days.
- **A list shows a bookmark.** The worker fetches the icon of the site, once for each member and workspace, and then not again for seven days. SlugBase stores the icon and serves it from your own origin, so the browser never contacts the site.

Those fetches can reach other hosts than the one in the link. SlugBase follows up to five redirects, and the worker also tries the icon addresses that the site names on its home page, which can be on other hosts. Every one of these requests goes through the egress adapter, which resolves each host itself and refuses private and internal addresses. Besides the hosts that a link leads to this way, an instance contacts only what you configure: your mail server (`SMTP_HOST`), your AI endpoint (`AI_BASE_URL`), your sign-in providers, and the error reporting endpoint (`ERROR_REPORT_DSN`). The continuous integration runs a drill that proves this on the built image. It puts the server and the worker on a network with no route out, records every DNS question and every connection attempt that leaves their own network for minutes, and fails on a question for any name other than the database and, after a link is saved, the host of that link, and on any attempt to reach an address outside that network.

If your network does not let the server and the worker reach the Internet, SlugBase still works. The bookmark form suggests no title or description, so the member types them, and the list shows the first letter of the host on a coloured tile where the site's icon would be. A failed fetch is not reported as an error and changes no bookmark.

## What you can see as the operator

You own the deployment, so you can read everything in it: the database, which holds every member's bookmarks and the content of every workspace, the email addresses of your members, the logs and the environment. SlugBase does not hide content from you.

By design, the product does not give you the following. A member's password and the secret of their two-step verification are stored as a hash and as an encrypted value, never in plaintext. A session token is not readable. There is no way to act as a member through the application without an action that is recorded and that the member can see. Treat the database and its backups with the care that this access calls for, and tell your members who has it.

Rate limits slow guessing down. They are a cost for an attacker, not a wall. Someone with many addresses can still try one password after another against one account at the limit for that account. What stops that is the breached-password check, a long password and a second factor. Ask every member to turn on two-step verification, and require it of the admins.

## Report a vulnerability

If you find a security problem in SlugBase, do not open a public issue. Report it privately, as the [security policy](https://github.com/mdg-labs/slugbase/security/policy) explains.

## Related pages

- [Self-Hosting SlugBase](index.md)
- [Put SlugBase Behind a Reverse Proxy](reverse-proxy.md)
- [Set Up Mail](mail.md)
- [Run SlugBase Day to Day](operations.md)
