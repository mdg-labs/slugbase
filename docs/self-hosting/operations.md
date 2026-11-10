---
title: "Run SlugBase Day to Day"
description: "Monitor a self-hosted SlugBase, rotate its secrets, know what data it deletes, and plan its database connections and size."
edition: ce
order: 70
---

This page covers what you do once SlugBase is running: watch its health, read its logs, rotate the keys that protect its data, know what it deletes by itself, and plan its database connections and capacity.

## Prerequisites

- A `compose.yml` installation, with the commands run in the directory that holds `compose.yml` and `.env`.
- Access to the `.env` file next to `compose.yml`.

## Check health

The server answers three probes. They need no sign-in, are not rate limited, and are never cached.

| Address | What it tells you | Answer |
| ------- | ----------------- | ------ |
| `/health` | The server process is running. It never asks the database. | `200` with `{"status":"ok"}`. |
| `/ready` | The server can reach the database, and the database is at the migration level the image expects. | `200` with `{"database":"ok","migrations":{"expected":<n>,"applied":<n>}}`, or `503`, with `"database":"unreachable"` or fewer applied migrations than expected. |
| `/version` | Which build runs. | `200` with `{"name","version","commit","builtAt"}` and nothing else. |

Use `/ready` for the container health check, and for a proxy or load balancer that decides where to send traffic. `compose.yml` already uses it for the `slugbase` service. A server that is up but cannot reach its database is not ready, and should get no requests. Use `/health` to decide whether to restart a process: it stays `200` while the database is down, so a database outage does not restart the server in a loop. For an uptime monitor outside your network, check `/health` of your public address. Use `/ready` too if you want to hear about a database outage.

A database that is ahead of the image, as after a rollback, stays ready, and the server logs a warning. `/ready` answers from a result that is at most 1.5 seconds old, so many probes do not load the database.

The worker has no web address. `docker compose ps` shows whether its container runs. An instance admin sees the number of jobs that wait for a worker and the number that failed in **Admin**, **Overview**, under **Background jobs**. A queue that only grows means the worker is not running or cannot keep up.

## Read the logs

SlugBase writes JSON, one object per line, to the standard error of each container. Read them with `docker compose logs slugbase` and `docker compose logs slugbase-worker`. Docker keeps them as long as the container exists unless you limit the log driver, so set a size limit for your containers in the Docker daemon or in `compose.yml`.

Every line has `level` (`info`, `warn` or `error`), `time` and `msg`, plus the fields of that message. `LOG_LEVEL` in `.env` sets the lowest level written: `fatal`, `error`, `warn`, `info` (the default), `debug`, `trace` or `silent`. The request log is `info`, so `warn` turns it off.

The server writes one line for every request, with the message `Request completed` and these fields:

| Field | What it holds |
| ----- | ------------- |
| `requestId` | A unique id. The same id is in the `X-Request-Id` header of the answer, and a proxy may send its own. |
| `method` | The HTTP method. |
| `route` | The route template, such as `/api/v1/bookmarks/{id}`. Never the real path, so a slug or an id is not in it. |
| `status` | The HTTP status of the answer. |
| `latencyMs` | How long the request took, in milliseconds. |
| `principalType` | Who asked: `session`, `api-token` or `anonymous`. |
| `workspaceId` | The id of the workspace, when there is one. Never its name. |

No secret, token, password, session cookie or second-factor code is logged. SlugBase names the request's route and never its body or its headers, and it blocks a list of field names, such as `password`, `token`, `cookie` and `authorization`, wherever they appear in a log line. The request line has no email address and no client address either. A startup error that names a bad key in your environment never prints its value. A message about mail names only the domain of the recipient. The threat model in the repository, `docs/internal/10-threat-model.md`, lists this as invariant T7.

## Send errors to an error tracker

SlugBase can report unexpected errors to an error tracker that speaks the Sentry protocol, such as your own Sentry or a compatible server. Set the address of your project in `.env`, and start the containers again. The server and the worker both read it.

```sh
ERROR_REPORT_DSN=<your project's DSN>
```

The server reports an error that ends a request with `500`, and the worker reports a job that fails. SlugBase removes personal data before anything leaves the process: it keeps no request data, headers, cookies, bodies or breadcrumbs, and it drops any value whose name looks like a password, token, key or code. An event that cannot be cleaned is dropped. With the key unset, errors go to the log and nowhere else. This is optional.

## Metrics

Set `METRICS_PORT` in `.env` to a port that is not `PORT`, and the server and the worker each open a second listener on that port. It answers `/metrics` in the Prometheus text format and nothing else. Without the key there is no listener.

The metrics hold request counts and durations for each route template and status, rate-limit rejections, the size of the database pool and the transactions in flight, and the depth and the age of the oldest ready job of each queue (`slugbase_job_queue_depth` and `slugbase_job_queue_oldest_ready_age_seconds`). They hold no member data.

In the one-container mode, `server --with-worker` (see [One container or two](install.md#one-container-or-two)), there is one listener, the server's, and it serves both sides in one response. The server's samples have no `process` label. The worker's samples carry `process="worker"`: the two job queue series, the worker's pool of 5 connections and its transactions in flight. The server's pool series describe its pool of 10 connections. The worker's job queue series appear once the worker has started. If the worker cannot read the queues, the scrape fails with `500` and returns no samples at all.

**Do not expose this port to the internet.** `compose.yml` does not publish it. Scrape it from a container on the same Docker network, such as `slugbase:<METRICS_PORT>` and `slugbase-worker:<METRICS_PORT>`. In the one-container mode, scrape `slugbase:<METRICS_PORT>` only. Never add a rule for `/metrics` to your reverse proxy. See [Put SlugBase Behind a Reverse Proxy](reverse-proxy.md).

## Rotate secrets

Plan for rotation before you need it. Keep every secret in your password manager, never beside a backup of the database. See [Back Up and Restore SlugBase](backup-restore.md).

### Rotate the encryption key

`ENCRYPTION_KEY` seals the secrets that SlugBase keeps in the database: the secret of each member's two-step verification, and the short-lived state of a sign-in through a provider. `ENCRYPTION_KEY_ID` is the name of the current key. SlugBase writes the name with each value it seals, so it knows which key opens it. `ENCRYPTION_KEY_PREVIOUS` lists earlier keys that SlugBase may still use to open values, and never to seal new ones.

1. Take a backup of the database and of your `.env` file.
2. Make a new key and choose a name for it that you have not used. A name is 1 to 64 letters, digits, dots, hyphens or underscores.

   ```sh
   openssl rand -base64 32
   ```

3. Edit `.env`. Move the current key into `ENCRYPTION_KEY_PREVIOUS` as `<name>:<key>`, separated by commas when there are several. Then put the new key and its name in `ENCRYPTION_KEY` and `ENCRYPTION_KEY_ID`.

   ```sh
   ENCRYPTION_KEY=<the new key>
   ENCRYPTION_KEY_ID=<the new name>
   ENCRYPTION_KEY_PREVIOUS=<the old name>:<the old key>
   ```

4. Start the containers again. The server and the worker read the keys at start.

   ```sh
   docker compose up -d
   ```

5. Keep the old key until nothing is sealed with it. The worker runs a job named `secrets.reseal` once an hour, at 40 minutes past, which seals the secret of every member with the new key. It includes members who do not sign in and accounts that are disabled. The worker has to be running for it to happen. Within about an hour after the start, the stored secrets use the new key alone. The job writes a log line, `Secret reseal finished`, with the number of secrets it sealed and the names of the keys that are still in use. See [Read the logs](#read-the-logs). The short-lived state of a sign-in through a provider needs no sweep: it is gone after ten minutes. List which keys the stored secrets still use. The command reads the database as its administrator and changes nothing.

   ```sh
   docker compose exec -T postgres psql -U slugbase -d slugbase -c "SELECT mfa_secret_key_id AS key_name, count(*) FROM accounts WHERE mfa_secret IS NOT NULL GROUP BY 1 ORDER BY 1"
   ```

6. When only the new name shows, remove the old pair from `ENCRYPTION_KEY_PREVIOUS` and start the containers again. Do not remove it earlier: a member whose secret is still under the old key then cannot use their code. If a row with the old name stays after several runs of the job, the job could not open that secret, for example because its key is not in `ENCRYPTION_KEY_PREVIOUS`. It logs a warning with the account and leaves the secret as it is. Add the key it was sealed with, or, if you no longer have it, an instance admin chooses **Reset two-factor authentication** for that member in **Admin**, **Accounts**. They can then enrol again.

A dump of the database made before the rotation holds secrets sealed with the old key. To restore it, you need that key as the current key or in `ENCRYPTION_KEY_PREVIOUS`. Keep the old key with the backups that need it.

### Rotate the session secret

`SESSION_SECRET` signs the paging links of lists and the state of a sign-in through a provider while it is in progress. It must have at least 32 characters.

1. Make a new value.

   ```sh
   openssl rand -base64 48
   ```

2. Put it in `SESSION_SECRET` in `.env`, and start the containers again.

SlugBase accepts one session secret at a time, so the change takes effect for every request at once. Members stay signed in, because a session is a random token that the database holds, and their API tokens keep working. A list that someone had open fails to load its next page until they reload the list. A sign-in through a provider that was in progress fails, and the person tries again.

### Other secrets

Change the value in `.env` and start the containers again. This holds for the key of the AI endpoint, the SMTP password and the client secret of an OIDC provider. For the database passwords, also change the login in PostgreSQL with `ALTER ROLE`. Changing the password in `.env` alone does not change the role, because the role gets its password when the database is first created.

## What SlugBase deletes by itself

The worker runs a purge every hour. It deletes at most 5,000 rows of each kind per run, so a large backlog is cleared over several runs. The worker has to be running for it to happen.

| Data | Deleted when |
| ---- | ------------ |
| Sessions | They have expired. |
| API tokens | 30 days after they were revoked or expired. A token with no expiry that nobody revoked is kept. |
| One-time links (verification, reset, email change) | 7 days after they were used or expired. |
| Invitations that were accepted or revoked | 30 days after they closed. A pending invitation is kept, expired or not. |
| Sign-in state of a provider | 10 minutes after it was made. |
| Page titles, site icons | When they expire, after 7 days. They are fetched again when needed. |
| AI suggestions | After 30 days. The record of which fields used a suggestion, without content, goes after 90 days. |
| Audit events | After `AUDIT_RETENTION_DAYS` days, which is 365 by default. `0` keeps them forever. The event of the first-run setup is always kept. |
| Finished background jobs | After 30 days. |

Idle rate-limit counters are deleted every 15 minutes. Bookmarks, folders, tags and workspaces are never deleted by age. Deleting an account or a workspace is an action of a person. Your backups keep what they held. See [Back Up and Restore SlugBase](backup-restore.md).

## Database connections

Each process keeps a pool of connections. The server's pool for requests has 10 connections, and the worker's has 5. Both open a few more small connections for their own tasks. You cannot change these sizes with an environment key. PostgreSQL's default limit of 100 connections is enough for one server and one worker. Check `max_connections` before you run more.

Under `server --with-worker` (see [One container or two](install.md#one-container-or-two)), one process holds both pools, so that one process uses up to 10 + 5 = 15 connections in these pools, plus the few small connections each side opens for its own tasks.

SlugBase sets the tenant of a request with settings that last for one transaction, so it works behind PgBouncer in transaction mode. Put PgBouncer in front of PostgreSQL before you run more than about 8 processes of the server and the worker in all. The project's test run for pooling, which starts with `pnpm test:integration:pooled`, checks that one request's tenant never reaches another request on a shared connection. It runs PgBouncer 1.26 with these settings, and you should use the same:

- `pool_mode = transaction`
- `max_prepared_statements = 200` (SlugBase uses prepared statements, which PgBouncer must then track)
- `ignore_startup_parameters = extra_float_digits`

Point `DATABASE_URL` at PgBouncer. Leave `DATABASE_MIGRATE_URL` pointing at PostgreSQL directly, because the migration holds a lock on its own connection. `compose.yml` builds both URLs itself, so to use PgBouncer you edit the `DATABASE_URL` line of `compose.yml`.

## Size your server

Measured results for particular hardware are not published yet, and this page does not give them. What it gives you is what the project tests, and how SlugBase scales.

The project's performance run starts the image against PostgreSQL on the same machine and fills the database with a large instance: 50,000 bookmarks in one workspace, and 2,000 other workspaces with 10 bookmarks each. It then checks these limits on the 95th percentile of the time the server takes to answer, while requests arrive at a steady rate:

| Request | Limit |
| ------- | ----- |
| Opening a slug link (`/go/<slug>`) | 30 ms |
| Slug suggestions of the palette | 50 ms |
| A page of the bookmark list, a search and the home screen | 100 ms |
| Opening a slug link while someone imports a file | At most 8.4 times the 95th percentile of opening a slug link at the steady rate in the same run |
| A page of the bookmark list while someone imports a file | At most 9.0 times the 95th percentile of a page of the bookmark list at the steady rate in the same run |

The last two rows are ratios, not times. They compare the requests made while a member imports files of 5,000 bookmarks each with the same requests at the steady rate in the same run. An import slows the requests beside it by an amount that follows the speed of the machine, as the steady times do, so the run sets no time of its own for them.

These are targets that the project checks each week on a hosted build machine. They are not measurements of your hardware and not a guarantee. Your numbers depend on your hardware, your data and your traffic. Watch the request duration metric of the route `/go/{slug}`, and the pool and queue metrics above, on your own installation.

SlugBase is designed so that one well-sized machine, running the server, the worker and PostgreSQL, serves tens of thousands of accounts. That is a design estimate and has not been measured on specific hardware. The database is the first limit. When it is reached, grow in this order:

1. Give PostgreSQL more CPU, memory and fast storage.
2. Run more server containers behind your proxy, and more workers. Schedules run once whatever the number of workers.
3. Put PgBouncer in front of PostgreSQL, as described above.
4. Move PostgreSQL to a machine of its own.

## Related pages

- [Self-Hosting SlugBase](index.md)
- [Environment Settings](environment.md)
- [Back Up and Restore SlugBase](backup-restore.md)
- [Upgrade SlugBase](upgrade.md)
