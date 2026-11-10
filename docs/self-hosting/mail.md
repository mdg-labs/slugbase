---
title: "Set Up Mail"
description: "Connect SlugBase to your own SMTP relay, set up the sending domain, test the connection, and run SlugBase without mail."
edition: ce
order: 40
---

SlugBase sends a few transactional emails, such as address verification, password reset and invitations. It sends them through an SMTP relay that you provide. Mail is optional. Without it, SlugBase runs fully, and an instance admin hands out the links that the emails would have carried.

## Prerequisites

- An SMTP relay that you can send through: your own mail server, or the SMTP service of a mail provider.
- A sending domain whose DNS you control.
- Access to the `.env` file next to `compose.yml`.

## Connect an SMTP relay

SlugBase has one mail adapter, a generic SMTP client. There is no provider-specific setup. Set the keys in `.env`, then start the containers again. The server and the worker both read them, and `compose.yml` passes them to both.

```sh
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURITY=starttls
SMTP_USER=<your SMTP user name>
SMTP_PASS='<your SMTP password>'
SMTP_FROM=SlugBase <slugbase@example.com>
```

Put the password in single quotes, as shown. Compose replaces a `$` and the name after it in a value without quotes, so a password that holds one reaches SlugBase changed and the relay refuses the login. Single quotes keep the value as it is. If the password holds a single quote itself, set a new password without one.

```sh
docker compose up -d
```

| Key | Required | What it sets |
| --- | -------- | ------------ |
| `SMTP_HOST` | With the other three required keys | The host name or IP address of the relay, with no scheme, port or path. |
| `SMTP_PORT` | With the other three required keys | The port of the relay, a whole number from 1 to 65535. |
| `SMTP_SECURITY` | With the other three required keys | How the connection is secured: `tls`, `starttls` or `none`. See below. |
| `SMTP_FROM` | With the other three required keys | The sender of every message: an address such as `slugbase@example.com`, or a name and an address such as `SlugBase <slugbase@example.com>`. |
| `SMTP_USER` | Together with `SMTP_PASS` | The login for the relay. Leave both unset for a relay that takes no login. |
| `SMTP_PASS` | Together with `SMTP_USER` | The password for the relay. Set it only in `.env`, never in a file you share. |

`SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURITY` and `SMTP_FROM` are set together. `SMTP_USER` and `SMTP_PASS` are a pair: both or neither. If you set any SMTP key without the others it needs, SlugBase does not start and names the missing keys. The log never prints a value. [Environment Settings](environment.md) lists the other keys.

### Connection security

| `SMTP_SECURITY` | What it does | Usual port |
| --------------- | ------------ | ---------- |
| `tls` | Connects over TLS from the first byte. | 465 |
| `starttls` | Connects in plain text and upgrades to TLS. SlugBase refuses to send if the relay does not offer the upgrade. | 587 |
| `none` | Stays in plain text, and does not use TLS even when the relay offers it. | 25 |

SlugBase checks the certificate of the relay against its host name and needs TLS 1.2 or later. A relay with a self-signed or expired certificate, or one reached under another name, fails. Use `none` only for a relay on a network that you trust, such as a mail server on the same host. A login sent with `none` travels unencrypted.

The relay is your own configuration. The connection goes to the host and port you set and to nothing else, so a relay on a private address works without an extra setting.

## Set up the sending domain

SlugBase hands each message to your relay with the address in `SMTP_FROM` as the sender. Receiving servers then decide whether to trust the message by looking at the DNS records of that address's domain. SlugBase does not set these records and does not sign messages. They are yours to configure, with the help of your relay's documentation.

| Record | What it does | What you set |
| ------ | ------------ | ------------ |
| SPF | Lists the servers that may send mail for the domain. | A `TXT` record on the domain of `SMTP_FROM` that includes your relay. Your relay's documentation names what to include. |
| DKIM | Lets the receiver check that your relay signed the message. | The `TXT` or `CNAME` record that your relay gives you, under `<selector>._domainkey` on the domain. Turn on signing at the relay. |
| DMARC | Tells receivers what to do with a message that fails SPF and DKIM. | A `TXT` record at `_dmarc` on the domain. Start with a policy of `none` and read the reports before you tighten it. |

A DMARC record that only watches looks like this. Replace the address with a mailbox of yours.

```text
_dmarc.example.com.  TXT  "v=DMARC1; p=none; rua=mailto:dmarc-reports@example.com"
```

Without these records most large mail providers put the messages of SlugBase in the spam folder or refuse them. A password-reset email that lands in spam is the usual first symptom.

## Send a test email

An instance admin can check the connection from the app.

1. Sign in as an instance admin and open **Admin**, then **Settings & status**.
2. In **Test email**, choose **Send test email**.

The test message goes to the address of the admin who sends it. The page then says that a test email to that address was queued. Sending is a job for the worker, so the message can arrive a moment after the page says so.

If mail is not configured, the page says **No test email was queued** and that the server has no mail configured. Set the keys, start the containers again and try once more.

The page cannot tell you whether the relay took the message, because the worker sends it afterwards. If the test email does not arrive:

1. Wait a minute and check the spam folder of the admin's mailbox.
2. Read the log of the worker with `docker compose logs slugbase-worker`. If you run one container (see [One container or two](install.md#one-container-or-two)), there is no `slugbase-worker` service, and the worker's lines are in `docker compose logs slugbase`. A message that the relay refused or that could not be delivered shows as a `Job failed` line for the job `mail.send` with `MailError` as its error. SlugBase logs no more than that, because the answer of a relay can contain addresses. The log of your relay says why it refused the message.
3. Look at **Admin**, **Overview**, **Background jobs**. A message that failed every attempt counts under **Failed jobs**.
4. Check the keys against your relay's documentation: the host, the port, `SMTP_SECURITY` for that port, the login, and that the relay allows `SMTP_FROM` as a sender.

## What SlugBase sends

Every email is written in the language of the recipient (English or German), has a plain-text part, holds no tracking pixel, and links only to your `APP_ORIGIN`.

- Address verification, and the confirmation and the notice of an email change.
- Password reset, and a notice that the password was changed.
- A notice that two-factor authentication was turned on, turned off or reset by an instance admin.
- A notice of a sign-in from a new device. Each member can turn it off in their settings. It is sent for password sign-ins only.
- An invitation to a workspace, and a notice that someone made you an owner of a workspace.
- A notice that an instance admin disabled the account, or left it an export-only period.
- The test email.

Mail is queued and never makes a request wait. A request, such as a password reset, writes the job to the database and answers at once. The worker sends the message. If the relay refuses it or cannot be reached, the worker tries again up to three more times, waiting longer each time, starting at 10 seconds. After that the job is marked failed, and SlugBase does not try again. SlugBase can therefore send a message twice if a failure comes after the relay took it.

The messages that carry a link hold a one-time token. The worker makes the token when it sends, so the token is in no queue, request or log. A message that is sent again has a new token, and the new link replaces the old one.

Asking for a password reset or for a new verification link answers the same for an address that has an account and one that has none, so nobody can use the form to find out who has an account. Mail is sent only to an address that has an account that can use it.

## Run without mail

Leave all six `SMTP_*` keys unset. SlugBase then sends no mail. It writes a log line for each message it would have sent, with the domain of the recipient and the name of the template, and nothing else. The app shows instance admins a notice, **Email is not set up**, with a link to **Settings & status**.

**What works without mail**

- **First-run setup.** The first account is created as a verified instance admin. It needs no email. See [Self-Hosting SlugBase](index.md).
- **Sign-in** with a password, with a second factor, and with a sign-in provider.
- **Invitations.** Invite people as usual. SlugBase creates the invitation and sends no email. In **Settings**, **Members**, under **Invitations**, choose **Copy invitation link** for the invitation and send the link yourself. The link is shown once, works for 7 days, and ends any earlier link for that invitation. **Resend** does not work without mail.
- **Password resets.** On the page **Forgot your password?** a member sees that the server cannot send email and should ask an instance admin. The admin opens **Admin**, then **Accounts**, and chooses **Send reset link** for the account. The admin gets a dialog with the link and **Copy the reset link**. The link is shown once, works once and for one hour.
- **Unverified addresses.** An instance admin chooses **Mark as verified** for the account. The page warns that marking an address verified removes the password, sessions, two-factor authentication, API tokens and linked sign-ins of the account, because whoever registered the address might not own it, and that in each workspace the account owns alone it also removes the other members, teams, pending invitations and shares. The owner then gets in with a reset link or a sign-in provider. For an address you know belongs to its owner, this is the way when no mail exists. **Resend verification email** does not work without mail.

**What does not work without mail**

- No email is sent for verification, password reset, invitations, a sign-in from a new device, a changed password, two-factor changes, a disabled account or an export-only period. Members get none of these notices.
- A member cannot change their email address, because the change needs a confirmation link. The page says to ask an instance admin to set up email.
- With `EMAIL_VERIFICATION_REQUIRED=true`, registration answers `503`, because nobody could verify an address. Leave it unset, or set up mail first.

## Related pages

- [Self-Hosting SlugBase](index.md)
- [Environment Settings](environment.md)
- [Put SlugBase Behind a Reverse Proxy](reverse-proxy.md)
