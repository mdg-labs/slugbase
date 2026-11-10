---
title: "Environment Settings"
description: "Look up every environment key of a self-hosted SlugBase: what it sets, its default, its type and which process reads it."
edition: ce
order: 20
---

SlugBase reads its settings from environment keys. This page lists every key. It is generated from the settings the processes check when they start, so it names exactly the keys SlugBase reads and nothing else.

A SlugBase installation runs three kinds of process. The `server` answers requests. The `worker` runs the background jobs. `migrate` applies the database migrations. The **Read by** column says which of them read a key. `compose.yml` hands each key to the containers that read it.

## Prerequisites

- A `compose.yml` installation.
- Access to the `.env` file next to `compose.yml`.

## Change a setting

1. Set the key in the `.env` file. `.env.example` lists every key on this page with its development value.
2. Start the containers again so that they read it.

   ```sh
   docker compose up -d
   ```

A value that is not valid stops SlugBase from starting. The log names the key and never prints its value.

How to read the tables:

- **Required** says whether the process refuses to start without the key. The schemas have no development defaults: in development, the values in `.env.example` supply the required keys. A key that is required only together with other keys says so.
- **Default** is the value SlugBase uses when the key is unset or empty.
- A boolean is `true`, `false`, `1` or `0`, parsed with the `envBoolean()` rule: `false` is false. Any other text, including `yes` and an empty value, is not valid and stops SlugBase from starting.
- A secret has no default. Where an example is shown, it is a placeholder such as `<your secret>`. Set secrets only in `.env`, never in a file you share.

Production refuses the development values that `.env.example` carries for `APP_ORIGIN`, `DATABASE_URL`, `DATABASE_MIGRATE_URL`, `SESSION_SECRET`, `ENCRYPTION_KEY` and `ENCRYPTION_KEY_ID`.

A key that starts with `SLUGBASE_` and is not on this page is ignored. SlugBase writes one warning to the log at start that names those keys and never their values, so a misspelled key does not go unnoticed.

## Runtime

{{keys:runtime}}

## Public address and HTTP

{{keys:http}}

The client address is the address SlugBase sees. Behind a reverse proxy, set `TRUSTED_PROXY_HOPS` to the number of proxies in front of the server. At its default of `0` every client shares the proxy's address, so one client can use up an `IP` rate limit for everyone. A production start with `0` logs a warning.

## Database and migration

{{keys:database}}

## Secrets

{{keys:secrets}}

## Accounts and sign-in

{{keys:accounts}}

## OIDC sign-in

The server reads the keys of an OIDC provider. The worker does not. `<SLUG>` in a key is a name you choose for the provider: upper-case letters and digits in groups joined by single underscores, such as `GOOGLE` or `COMPANY_SSO`. These keys are not lines of `.env.example`, because the slug is yours. Set them in `.env` for `pnpm dev`, or in `.env.oidc` next to `compose.yml`, which passes that file to the server container.

{{oidc}}

An enabled provider that lacks a required key stops SlugBase from starting and names the key. A provider that cannot be reached is left off the sign-in page and logged. Nothing else is affected. The slug that the sign-in page uses is the `<SLUG>` in lower case, with its underscores written as hyphens.

## Mail

{{keys:mail}}

`SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURITY` and `SMTP_FROM` are set together. `SMTP_USER` and `SMTP_PASS` are an optional pair, both or neither. If you set any mail key without the ones it needs, SlugBase does not start and names the missing keys.

## AI suggestions

SlugBase can suggest a title, a slug and tags when a member saves a bookmark. It sends the request to an OpenAI-compatible chat completions endpoint that you choose: a provider you pay, or a model you run yourself. The server reads these keys. The worker does not.

{{keys:ai}}

`AI_BASE_URL`, `AI_MODEL` and `AI_PROVIDER_NAME` are set together. If you set any AI key without them, SlugBase does not start and names the missing keys.

Only the page address, the public title and description fetched from it, the language and the member's tag names go to the provider. SlugBase sends no other bookmark and no workspace name. It keeps a result for 30 days for the same member, workspace, address and language, and never shows it to anyone else.

### Where the endpoint may be

SlugBase makes every outbound request through one guarded path, and it refuses addresses that are not public. The rule for the AI endpoint is:

- An endpoint on a public address needs nothing more. It must use `https`.
- An endpoint on a loopback, private (RFC 1918), CGNAT or unique-local address is refused unless `AI_ALLOWED_PRIVATE_HOST` names its host. CGNAT covers the networks that tools like Tailscale use.
- `AI_ALLOWED_PRIVATE_HOST` is one bare host name or IP address. It has no scheme, port, path, wildcard or range. It must be the host of `AI_BASE_URL`. If it differs, SlugBase does not start.
- The allowance covers one origin: the scheme, host and port of `AI_BASE_URL`. The same host on another port is an ordinary address and is refused when it is not public.
- Link-local addresses stay refused, even for the named host. That includes the address that cloud providers use for instance metadata.
- Plain `http` is accepted only on the named host. Without `AI_ALLOWED_PRIVATE_HOST`, an `http` endpoint stops SlugBase from starting. Naming a public host there accepts plain `http` for it.

Here is a model server on a private network:

```sh
AI_BASE_URL=https://models.internal.example/v1
AI_MODEL=<the model name>
AI_PROVIDER_NAME=Our model server
AI_ALLOWED_PRIVATE_HOST=models.internal.example
```

### Who sees the suggestions

A member sees the suggestion control in the bookmark form when the endpoint is configured, the workspace has AI suggestions switched on, and the member has not opted out. An owner or admin switches it in **Settings**, **Workspace**, **AI suggestions**. It is on by default once the endpoint is configured. A member opts out in their preferences. A suggestion that takes longer than 5 seconds, or fails, leaves the fields as they are.

### Without AI

Leave all five AI keys unset to run without AI. The bookmark form then has no suggestion control, and the workspace page for AI suggestions says "Not available on this server". Nothing else changes, and nothing breaks because the keys are missing.

## Audit retention

{{keys:retention}}

The worker deletes the events that are older than the period every hour, in batches. It applies to the events of every workspace and to the events of the instance.

A database backup holds the audit events too. [Back up and restore](backup-restore.md) explains what that means for old dumps.

## Rate limits

SlugBase limits how often one client can use each kind of operation. Each limit is a count and a period, written `<count>/<period>`, where the period is `sec`, `min` or `hour`. The count is a whole number of 1 or more. A request over the limit gets the answer `429` with a `Retry-After` header.

A key ends in the scope it limits. `IP` is the address of the client. `ACCOUNT` is the signed-in account. `WORKSPACE` is the workspace the account acts in. `EMAIL` is the email address the request names. Whichever limit runs out first applies. The server and the worker read these keys.

{{keys:rate-limits}}

## Metrics and error reporting

{{keys:observability}}

## Built-in limits

These values are part of SlugBase. No key changes them.

| Item | Value |
| ---- | ----- |
| Bookmarks on a page of the list | 24, 48 or 96, as the member chooses. Without a choice, the grid shows 24 and the table 48. |
| Bookmarks one request can return | 100 |
| Bookmarks that "select all matching" can reach | 5,000. An export of a longer match is refused. |
| Bookmarks in one import | 5,000 |
| Size of an import file | 5 MiB |
| New folders and tags in one import | 10,000 together |
| Links from bookmarks to folders and tags in one import | 100,000 together |
| How long fetched page metadata is kept | 7 days |
| How long an AI suggestion is kept | 30 days |

## Without the optional services

SlugBase starts with none of these services configured. Each one is an adapter that you can leave out.

| Service | Keys | Without it |
| ------- | ---- | ---------- |
| AI suggestions | `AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL`, `AI_PROVIDER_NAME`, `AI_ALLOWED_PRIVATE_HOST` | No suggestion control. Nothing else changes. |
| Mail | `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURITY`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | SlugBase sends no mail. It logs each message by the recipient's domain and the template only. |
| Error reporting | `ERROR_REPORT_DSN` | Errors go to the log and nowhere else. |
| Metrics | `METRICS_PORT` | SlugBase opens no metrics listener. |

## Related pages

- [Self-Hosting SlugBase](index.md)
- [Back Up and Restore SlugBase](backup-restore.md)
