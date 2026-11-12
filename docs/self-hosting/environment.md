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

| Key | Read by | Required | Default | Type | What it sets |
| --- | ------- | -------- | ------- | ---- | ------------ |
| `NODE_ENV` | server, worker, migrate | Yes | None | one of `development`, `test`, `production` | The environment. `production` applies the refusals of a production start; `compose.yml` sets it to `production`. |
| `LOG_LEVEL` | server, worker, migrate | No | `info` | one of `fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent` | The lowest level the process logs. |

## Public address and HTTP

| Key | Read by | Required | Default | Type | What it sets |
| --- | ------- | -------- | ------- | ---- | ------------ |
| `APP_ORIGIN` | server, worker | Yes | None | origin URL | The origin members open in the browser, such as `https://bookmarks.example.com`, with no path. It is used in links in mail and in cookie names. In production it must use `https`. |
| `PORT` | server | No | `3000` | whole number, 1 to 65535 | The port the server listens on. |
| `TRUSTED_PROXY_HOPS` | server | No | `0` | whole number, 0 to 32 | How many reverse proxies in front of the server write `X-Forwarded-For`. Behind one proxy set it to `1`. At `0` every client shares the proxy's address; a value above the real number lets a client choose its own address. |
| `API_DOCS_ENABLED` | server | No | `true` | boolean | Whether the server serves the API reference. |
| `DOCS_BASE_URL` | server | No | `https://slugbase.app/docs` | http or https URL | The address the in-app links to the documentation point to. |

The client address is the address SlugBase sees. Behind a reverse proxy, set `TRUSTED_PROXY_HOPS` to the number of proxies in front of the server. At its default of `0` every client shares the proxy's address, so one client can use up an `IP` rate limit for everyone. A production start with `0` logs a warning.

## Database and migration

| Key | Read by | Required | Default | Type | What it sets |
| --- | ------- | -------- | ------- | ---- | ------------ |
| `DATABASE_URL` | server, worker | Yes | None | PostgreSQL URL | The connection of the `slugbase_app` role, for the server and the worker, such as `postgres://slugbase_app:<your password>@db:5432/slugbase`. Production refuses the development password. |
| `DATABASE_MIGRATE_URL` | server, migrate | Always for `migrate`; for the server while `MIGRATE_ON_START` is `true` | None | PostgreSQL URL | The connection of the `slugbase_migrator` role, which applies the migrations. The server needs it only to migrate on start; the worker never reads it. |
| `MIGRATE_ON_START` | server | No | `true` | boolean | Whether the server applies pending migrations before it starts. Set it to `false` when a deploy step runs `migrate` instead; the server then needs no migrator connection. |
| `SLUGBASE_ALLOW_OWNER_CONNECTION` | server, worker | No | `false` | boolean | Whether a `DATABASE_URL` role that is a superuser, owns the database or has `BYPASSRLS` may start in production, with a warning. `false` refuses each of them. |

## Secrets

| Key | Read by | Required | Default | Type | What it sets |
| --- | ------- | -------- | ------- | ---- | ------------ |
| `SESSION_SECRET` | server, worker | Yes | None | text, at least 32 characters in production | The secret that signs sessions. Generate a long random value, such as `<your secret>`, and keep it only in `.env`. |
| `ENCRYPTION_KEY` | server, worker | Yes | None | base64 of 32 bytes | The key that seals stored secrets. Generate 32 random bytes and write them as base64, such as `<your key>`. Production refuses the development key. |
| `ENCRYPTION_KEY_ID` | server, worker | Yes | None | 1 to 64 letters, digits, dots, hyphens or underscores | A name for the current `ENCRYPTION_KEY`, kept with every value it seals so that a rotation finds the right key. |
| `ENCRYPTION_KEY_PREVIOUS` | server, worker | No | None | comma-separated `id:key` pairs | After a key rotation, the old keys as `<id>:<base64 key>` pairs, such as `<old id>:<old key>`. They only open values sealed before the rotation. An id must not repeat. |

## Accounts and sign-in

| Key | Read by | Required | Default | Type | What it sets |
| --- | ------- | -------- | ------- | ---- | ------------ |
| `SETUP_ENABLED` | server | No | `true` | boolean | Whether first-run setup may create the first account. `false` closes it for the deployment. |
| `SETUP_TOKEN_REQUIRED` | server | No | `true` | boolean | Whether first-run setup needs the one-time token the server prints to its log at each start while no account exists. |
| `PUBLIC_REGISTRATION` | server | No | `false` (the Community Edition opens no registration) | boolean | Whether a visitor can create an account. Unset, the build you run decides. |
| `EMAIL_VERIFICATION_REQUIRED` | server | No | `false` (the Community Edition does not require it) | boolean | Whether an account must verify its address before it can sign in. It needs the mail keys: without mail, registration answers `503`. Unset, the build you run decides. |
| `BREACHED_PASSWORD_CHECK` | server | No | `true` | boolean | Whether a new password is refused when it is in the breached-password dataset shipped with the image. The lookup is local; nothing is sent. The length rules always apply. |
| `TOTP_ISSUER` | server | No | None | 1 to 64 characters, no colon | The name an authenticator app lists an account under. Unset, it is `SlugBase` followed by the host name of `APP_ORIGIN`, without its port. |

## OIDC sign-in

The server reads the keys of an OIDC provider. The worker does not. `<SLUG>` in a key is a name you choose for the provider: upper-case letters and digits in groups joined by single underscores, such as `GOOGLE` or `COMPANY_SSO`. These keys are not lines of `.env.example`, because the slug is yours. Set them in `.env` for `pnpm dev`, or in `.env.oidc` next to `compose.yml`, which passes that file to the server container.

| Key | Read by | Required | Default | Type | What it sets |
| --- | ------- | -------- | ------- | ---- | ------------ |
| `OIDC_<SLUG>_CLIENT_ID` | server | Yes, for an enabled provider | None | text | The client id registered at the provider. |
| `OIDC_<SLUG>_CLIENT_SECRET` | server | Yes, for an enabled provider | None | text | The client secret registered at the provider, such as `<your client secret>`. Set it only in the file the server reads. |
| `OIDC_<SLUG>_ISSUER_URL` | server | Yes, for an enabled provider | None | URL | The issuer, which the provider's discovery document must name exactly. It uses `https` in production and has no credentials, query or fragment. |
| `OIDC_<SLUG>_NAME` | server | No | The slug | 1 to 64 characters | The name on the provider's button. |
| `OIDC_<SLUG>_SCOPES` | server | No | `openid email profile` | scope names separated by spaces or commas | The scopes to ask for. They must include `openid`. |
| `OIDC_<SLUG>_ENABLED` | server | No | `true` | boolean | Whether the provider is on. |
| `OIDC_<SLUG>_AUTO_CREATE` | server | No | `false` | boolean | Whether a sign-in through the provider creates an account for an address that has none. |
| `OIDC_<SLUG>_ALLOWED_DOMAINS` | server | No | Any domain | comma-separated email domains | The email domains an automatically created account may have. |
| `OIDC_<SLUG>_ALLOWED_PRIVATE_HOST` | server | No | None: the provider must be on a public address | one bare host | The host of `OIDC_<SLUG>_ISSUER_URL`, when the provider is on a private address. SlugBase then reaches that one origin, and no other, on a loopback, private, CGNAT or unique-local address. It has no scheme, port, path, wildcard or range, and the issuer still uses `https` in production. |

An enabled provider that lacks a required key stops SlugBase from starting and names the key. A provider that cannot be reached is left off the sign-in page and logged. Nothing else is affected. The slug that the sign-in page uses is the `<SLUG>` in lower case, with its underscores written as hyphens.

## Mail

| Key | Read by | Required | Default | Type | What it sets |
| --- | ------- | -------- | ------- | ---- | ------------ |
| `SMTP_HOST` | server, worker | Together with `SMTP_PORT`, `SMTP_SECURITY` and `SMTP_FROM` | None | host name or IP address | The host of the SMTP relay, with no scheme, port or path. |
| `SMTP_PORT` | server, worker | Together with `SMTP_HOST`, `SMTP_SECURITY` and `SMTP_FROM` | None | whole number, 1 to 65535 | The port of the relay, usually 465 for `tls` and 587 for `starttls`. |
| `SMTP_SECURITY` | server, worker | Together with `SMTP_HOST`, `SMTP_PORT` and `SMTP_FROM` | None | one of `tls`, `starttls`, `none` | How SlugBase connects: `tls` from the first byte, `starttls` after a plain start, or `none` in plain text. The relay's certificate is verified. |
| `SMTP_USER` | server, worker | Together with `SMTP_PASS` | None | text | The user name for the relay. Leave it and `SMTP_PASS` unset for a relay without authentication. |
| `SMTP_PASS` | server, worker | Together with `SMTP_USER` | None | text | The password for the relay, such as `<your password>`. Set it only in `.env`. |
| `SMTP_FROM` | server, worker | Together with `SMTP_HOST`, `SMTP_PORT` and `SMTP_SECURITY` | None | address, or name and address | The sender of every message: an address, or a name and address such as `SlugBase <slugbase@example.com>`. |

`SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURITY` and `SMTP_FROM` are set together. `SMTP_USER` and `SMTP_PASS` are an optional pair, both or neither. If you set any mail key without the ones it needs, SlugBase does not start and names the missing keys.

## AI suggestions

SlugBase can suggest a title, a slug and tags when a member saves a bookmark. It sends the request to an OpenAI-compatible chat completions endpoint that you choose: a provider you pay, or a model you run yourself. The server reads these keys. The worker does not.

| Key | Read by | Required | Default | Type | What it sets |
| --- | ------- | -------- | ------- | ---- | ------------ |
| `AI_BASE_URL` | server | Together with `AI_MODEL` and `AI_PROVIDER_NAME` | None | http or https URL | The base URL the endpoint documents, such as one that ends in `/v1`. SlugBase adds `/chat/completions`. It has no credentials, query or fragment. |
| `AI_API_KEY` | server | No | None | up to 512 visible characters | The credential for the endpoint, sent as a bearer token, such as `<your API key>`. Leave it unset for an endpoint that takes none. Set it only in `.env`. |
| `AI_MODEL` | server | Together with `AI_BASE_URL` and `AI_PROVIDER_NAME` | None | up to 200 visible characters | The name of the model to ask, with no space. |
| `AI_PROVIDER_NAME` | server | Together with `AI_BASE_URL` and `AI_MODEL` | None | 1 to 64 characters | The name members see when SlugBase says who processes a request. |
| `AI_ALLOWED_PRIVATE_HOST` | server | No | None | one bare host | The one host of `AI_BASE_URL` that may be on a private address, and the only host that may use plain `http`. It has no scheme, port, path, wildcard or range. |

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

| Key | Read by | Required | Default | Type | What it sets |
| --- | ------- | -------- | ------- | ---- | ------------ |
| `AUDIT_RETENTION_DAYS` | server, worker | No | `365` | whole number, 0 to 36500 | How many days audit events are kept before the hourly retention purge deletes them. `0` keeps them forever. The event that records the completed first-run setup is kept. |

The worker deletes the events that are older than the period every hour, in batches. It applies to the events of every workspace and to the events of the instance.

A database backup holds the audit events too. [Back up and restore](backup-restore.md) explains what that means for old dumps.

## Rate limits

SlugBase limits how often one client can use each kind of operation. Each limit is a count and a period, written `<count>/<period>`, where the period is `sec`, `min` or `hour`. The count is a whole number of 1 or more. A request over the limit gets the answer `429` with a `Retry-After` header.

A key ends in the scope it limits. `IP` is the address of the client. `ACCOUNT` is the signed-in account. `WORKSPACE` is the workspace the account acts in. `EMAIL` is the email address the request names. Whichever limit runs out first applies. The server and the worker read these keys.

| Key | Read by | Required | Default | Type | What it sets |
| --- | ------- | -------- | ------- | ---- | ------------ |
| `RATE_LIMIT_LOGIN_IP` | server, worker | No | `10/min` | count and period, such as `5/hour` | Signing in, for each address. |
| `RATE_LIMIT_LOGIN_EMAIL` | server, worker | No | `20/hour` | count and period, such as `5/hour` | Signing in, for each email address. |
| `RATE_LIMIT_MFA_IP` | server, worker | No | `10/min` | count and period, such as `5/hour` | Entering a second-factor code, for each address. |
| `RATE_LIMIT_MFA_ACCOUNT` | server, worker | No | `30/hour` | count and period, such as `5/hour` | Entering a second-factor code, for each account. |
| `RATE_LIMIT_REGISTER_IP` | server, worker | No | `5/hour` | count and period, such as `5/hour` | Creating an account by public registration, for each address. |
| `RATE_LIMIT_RESET_IP` | server, worker | No | `5/hour` | count and period, such as `5/hour` | Asking for a password reset, for each address. |
| `RATE_LIMIT_RESET_EMAIL` | server, worker | No | `3/hour` | count and period, such as `5/hour` | Asking for a password reset, for each email address. |
| `RATE_LIMIT_TOKEN_REDEEM_IP` | server, worker | No | `10/hour` | count and period, such as `5/hour` | Using a one-time link from an email, such as to verify an address or accept an invitation, for each address. |
| `RATE_LIMIT_TOKEN_REDEEM_ACCOUNT` | server, worker | No | `10/hour` | count and period, such as `5/hour` | Using a one-time link from an email, such as to verify an address or accept an invitation, for each account. |
| `RATE_LIMIT_TOKEN_CREATE_IP` | server, worker | No | `20/hour` | count and period, such as `5/hour` | Creating an API token, for each address. |
| `RATE_LIMIT_TOKEN_CREATE_ACCOUNT` | server, worker | No | `20/hour` | count and period, such as `5/hour` | Creating an API token, for each account. |
| `RATE_LIMIT_SETUP_IP` | server, worker | No | `10/hour` | count and period, such as `5/hour` | First-run setup, for each address. |
| `RATE_LIMIT_GO_IP` | server, worker | No | `600/min` | count and period, such as `5/hour` | Opening a slug link, choosing between bookmarks that share a slug, slug suggestions and recording an open, for each address. |
| `RATE_LIMIT_GO_ACCOUNT` | server, worker | No | `300/min` | count and period, such as `5/hour` | Opening a slug link, choosing between bookmarks that share a slug, slug suggestions and recording an open, for each account. |
| `RATE_LIMIT_READ_IP` | server, worker | No | `1200/min` | count and period, such as `5/hour` | Reading data through the API, for each address. |
| `RATE_LIMIT_READ_ACCOUNT` | server, worker | No | `1200/min` | count and period, such as `5/hour` | Reading data through the API, for each account. |
| `RATE_LIMIT_WRITE_IP` | server, worker | No | `300/min` | count and period, such as `5/hour` | Changing data through the API, for each address. |
| `RATE_LIMIT_WRITE_ACCOUNT` | server, worker | No | `120/min` | count and period, such as `5/hour` | Changing data through the API, for each account. |
| `RATE_LIMIT_BULK_IP` | server, worker | No | `20/hour` | count and period, such as `5/hour` | Bulk actions on bookmarks, imports and exports, for each address. |
| `RATE_LIMIT_BULK_ACCOUNT` | server, worker | No | `20/hour` | count and period, such as `5/hour` | Bulk actions on bookmarks, imports and exports, for each account. |
| `RATE_LIMIT_FETCH_IP` | server, worker | No | `120/min` | count and period, such as `5/hour` | Fetching a page's title and description while a bookmark is added, and fetching site icons that are not stored yet, for each address. |
| `RATE_LIMIT_FETCH_ACCOUNT` | server, worker | No | `60/min` | count and period, such as `5/hour` | Fetching a page's title and description while a bookmark is added, and fetching site icons that are not stored yet, for each account. |
| `RATE_LIMIT_AI_IP` | server, worker | No | `60/hour` | count and period, such as `5/hour` | AI suggestions, for each address. |
| `RATE_LIMIT_AI_ACCOUNT` | server, worker | No | `60/hour` | count and period, such as `5/hour` | AI suggestions, for each account. |
| `RATE_LIMIT_AI_WORKSPACE` | server, worker | No | `600/hour` | count and period, such as `5/hour` | AI suggestions, for each workspace. |
| `RATE_LIMIT_PUBLIC_IP` | server, worker | No | `300/min` | count and period, such as `5/hour` | Pages that need no sign-in, for each address. |

## Metrics and error reporting

| Key | Read by | Required | Default | Type | What it sets |
| --- | ------- | -------- | ------- | ---- | ------------ |
| `METRICS_PORT` | server, worker | No | None | whole number, 1 to 65535 | The port of the internal listener for `/metrics`. Unset opens no listener. Keep it off the public network. It must differ from `PORT`. |
| `ERROR_REPORT_DSN` | server, worker | No | None | Sentry-protocol DSN | The DSN of your own error tracker, such as `<your DSN>`. Unset reports nothing beyond the log. Personal data is scrubbed before anything is sent. |
| `ERROR_REPORT_TRACES_SAMPLE_RATE` | server, worker | No | None | a number from 0 to 1 | The share of requests, such as `0.1`, whose trace the server sends to the error tracker as a transaction. It needs `ERROR_REPORT_DSN`. Unset sends no trace. The worker opens no traces. Route templates are sent, never paths, queries, headers or bodies. |
| `ERROR_REPORT_CHECK_INS` | server, worker | No | `false` | boolean | Whether the worker reports each run of a scheduled job to the error tracker as a cron check-in, under a monitor slug made from the schedule's name, as the operations guide lists. It needs `ERROR_REPORT_DSN`. Create the monitors in the tracker; SlugBase does not. |

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
