---
title: "Environment Settings"
description: "Set up AI suggestions, audit retention and rate limits on a self-hosted SlugBase, and see which limits are fixed."
edition: ce
order: 20
---

SlugBase reads its settings from environment keys. This page covers the keys for AI suggestions, audit retention and the rate limits of the `go`, `fetch`, `ai` and `bulk` buckets, and lists the limits that are built in and cannot be changed. It is not the complete reference: the other keys are described in `.env.example`.

## Prerequisites

- A `compose.yml` installation. `compose.yml` hands each key listed below to the containers that read it.
- Access to the `.env` file next to `compose.yml`.

## Change a setting

1. Set the key in the `.env` file. `.env.example` shows every key.
2. Start the containers again so that they read it.

   ```sh
   docker compose up -d
   ```

A value that is not valid, or an AI key without the keys it needs, stops SlugBase from starting. The log names the key and never prints its value.

## AI suggestions

SlugBase can suggest a title, a slug and tags when a member saves a bookmark. It sends the request to an OpenAI-compatible chat completions endpoint that you choose: a provider you pay, or a model you run yourself. The server reads these keys. The worker does not.

| Key | Required | What it sets |
| --- | -------- | ------------ |
| `AI_BASE_URL` | With `AI_MODEL` and `AI_PROVIDER_NAME` | The base URL the endpoint documents, such as one that ends in `/v1`. SlugBase adds `/chat/completions`. It has no credentials, query or fragment. |
| `AI_MODEL` | With `AI_BASE_URL` and `AI_PROVIDER_NAME` | The name of the model to ask, up to 200 visible characters with no space. |
| `AI_PROVIDER_NAME` | With `AI_BASE_URL` and `AI_MODEL` | The name members see when SlugBase says who processes a request, 1 to 64 characters. |
| `AI_API_KEY` | No | The credential for the endpoint, sent as a bearer token. Leave it unset for an endpoint that takes none. Set it only in `.env`, never in a file you share. |
| `AI_ALLOWED_PRIVATE_HOST` | Only for an endpoint on a private address, or one that uses plain `http` | The one host that may be private, and the only host that may use plain `http`, public or not. See the rule below. |

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

| Key | Default | What it sets |
| --- | ------- | ------------ |
| `AUDIT_RETENTION_DAYS` | `365` | How many days SlugBase keeps audit events before it deletes them. A whole number from 0 to 36500. `0` keeps them forever. |

The server and the worker read this key. The worker deletes the events that are older than the period every hour, in batches. It applies to the events of every workspace and to the events of the instance. The one event that records the completed first-run setup is kept.

A database backup holds the audit events too. [Back up and restore](backup-restore.md) explains what that means for old dumps.

## Rate limits

SlugBase limits how often one client can use each kind of operation. Each limit is a count and a period, written `<count>/<period>`, where the period is `sec`, `min` or `hour`. The count is a whole number of 1 or more. A request over the limit gets the answer `429` with a `Retry-After` header.

A key ends in the scope it limits. `IP` is the address of the client. `ACCOUNT` is the signed-in account. `WORKSPACE` is the workspace the account acts in. Whichever limit runs out first applies. The server and the worker read these keys.

The client address is the address SlugBase sees. Behind a reverse proxy, set `TRUSTED_PROXY_HOPS` to the number of proxies in front of the server. At its default of `0` every client shares the proxy's address, so one client can use up an `IP` limit for everyone.

| Key | Default | What it limits |
| --- | ------- | -------------- |
| `RATE_LIMIT_GO_IP` | `600/min` | Opening a slug link, choosing between bookmarks that share a slug, slug suggestions and recording an open, for each address. |
| `RATE_LIMIT_GO_ACCOUNT` | `300/min` | The same, for each account. |
| `RATE_LIMIT_FETCH_IP` | `120/min` | Fetching a page's title and description while a bookmark is added, and fetching site icons that are not stored yet, for each address. |
| `RATE_LIMIT_FETCH_ACCOUNT` | `60/min` | The same, for each account. |
| `RATE_LIMIT_AI_IP` | `60/hour` | AI suggestions, for each address. |
| `RATE_LIMIT_AI_ACCOUNT` | `60/hour` | AI suggestions, for each account. |
| `RATE_LIMIT_AI_WORKSPACE` | `600/hour` | AI suggestions, for each workspace. |
| `RATE_LIMIT_BULK_IP` | `20/hour` | Bulk actions on bookmarks, imports and exports, for each address. |
| `RATE_LIMIT_BULK_ACCOUNT` | `20/hour` | The same, for each account. |

The other buckets, such as sign-in, reading and writing, have keys of the same form. Their defaults are in `.env.example`.

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
