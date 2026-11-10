---
title: "Install SlugBase"
description: "Start a self-hosted SlugBase from the published compose file and finish first-run setup."
edition: ce
order: 5
---

This page takes you from an empty server to a running SlugBase with its first account. You start the stack from the `compose.yml` file in the SlugBase repository, check that it is ready, and create the first account and workspace in the browser.

## Prerequisites

- A server with Docker Engine and the Docker Compose plugin, version 2.24 or later. Check it with `docker compose version`. The compose file reads an optional `.env.oidc` file, which needs that version.
- `git` and `openssl` on the server.
- A domain name for SlugBase and a reverse proxy that serves it over HTTPS. The compose file has no TLS and no proxy. SlugBase refuses to start with a `APP_ORIGIN` that is not an `https` origin.
- Outbound access to `ghcr.io` and Docker Hub, to pull the images the first time.

## What the stack runs

`compose.yml` starts three services. Two of them run the same SlugBase image.

| Service | Image | What it does |
| ------- | ----- | ------------ |
| `slugbase` | the SlugBase image, command `server` | Runs the database migration, then serves the web app, the API and the `/go/<slug>` links on port 3000. |
| `slugbase-worker` | the SlugBase image, command `worker` | Runs the background jobs: mail, the hourly retention purge and the other scheduled jobs. It starts after `slugbase` is healthy. |
| `postgres` | `postgres:18`, pinned by digest | The database. It publishes no port, so only the other two services reach it. |

The database is the only state SlugBase keeps. The data lives in the `postgres-data` volume. The SlugBase containers run read-only, as an unprivileged user, with no extra Linux capabilities.

The server port is published on `127.0.0.1` only, so the reverse proxy on the same server reaches it and nothing else does. Set `SLUGBASE_BIND` to another address if the proxy runs on another machine.

## Install

1. Get the compose file. Clone the repository at the release you want to run. Use the release's version for `<version>`.

   ```sh
   git clone --depth 1 --branch v<version> https://github.com/mdg-labs/slugbase.git
   cd slugbase
   ```

   The compose file mounts a script from the repository, `packages/db/provision/roles.sql`, so keep the checkout as it is. The releases are listed at [github.com/mdg-labs/slugbase/releases](https://github.com/mdg-labs/slugbase/releases).

2. Create the `.env` file next to `compose.yml`. Replace `https://links.example.com` with the address your users open and `<version>` with the version you cloned. `TRUSTED_PROXY_HOPS=1` is right for one reverse proxy in front of the server; the [reverse proxy page](reverse-proxy.md#trusted-proxy-hops) explains how to count for more. The commands generate the secrets and the database passwords for you.

   ```sh
   (umask 077; cat > .env <<EOF
   SLUGBASE_IMAGE=ghcr.io/mdg-labs/slugbase:<version>
   APP_ORIGIN=https://links.example.com
   TRUSTED_PROXY_HOPS=1
   SESSION_SECRET=$(openssl rand -base64 48)
   ENCRYPTION_KEY=$(openssl rand -base64 32)
   ENCRYPTION_KEY_ID=key-1
   POSTGRES_PASSWORD=$(openssl rand -hex 24)
   APP_DB_PASSWORD=$(openssl rand -hex 24)
   MIGRATOR_DB_PASSWORD=$(openssl rand -hex 24)
   EOF
   )
   ```

   The file is readable by your account only. Keep a copy of it in a password manager, away from your database backups: the encryption key opens the two-step verification secrets of your members, and without it a restored database cannot be used. [Back up and restore](backup-restore.md) explains why.

   The database passwords go into database URLs, so they use letters and digits only. They are applied once, when the database is first created. Changing one in `.env` later does not change the database login.

3. Start the stack.

   ```sh
   docker compose up -d
   ```

   Compose pulls the images, starts the database and creates its roles, then starts the server, which migrates the database before it serves anything, and last the worker.

4. Check that SlugBase is ready.

   ```sh
   curl -fsS http://127.0.0.1:3000/ready
   ```

   A ready server answers `200` with a body such as `{"database":"ok","migrations":{"expected":140,"applied":140}}`. The two numbers are equal once the migration has run. While the migration is running, or when the database cannot be reached, the answer is `503`. `docker compose ps` shows `slugbase` as healthy when it is ready.

5. Put your reverse proxy in front of port 3000, so that `APP_ORIGIN` reaches the server. [Put SlugBase behind a reverse proxy](reverse-proxy.md) has complete nginx and Caddy files and explains how to count the hops. Do this before you finish setup. The server accepts a request that changes data, such as setup, only from the browser page it served at `APP_ORIGIN`, and the session cookie needs HTTPS.

6. Finish first-run setup, as the next section describes.

### Choose the image

`SLUGBASE_IMAGE` names the image that `slugbase` and `slugbase-worker` run. Set it to a version tag, such as `ghcr.io/mdg-labs/slugbase:<version>`, or to an image digest. Pin a version: the same file then starts the same SlugBase every time, and you decide when to change it. Each release has a tag with its full version. When a release without a pre-release suffix is published, it also gets a tag with its major and minor version only, and the tag `latest` points at it.

Do not rely on the default of the file, `ghcr.io/mdg-labs/slugbase:latest`. It moves to a new release whenever one is published, and it does not exist until the first release without a pre-release suffix is published. Pin a version.

The release workflow signs every release it publishes, except `1.0.0-rc.1`, which was pushed before signing was added and has no signature. A version whose signing step failed stays unsigned and is abandoned; do not run it, and use the next version. To check an image before you run it, see [Verify the image](upgrade.md#verify-the-image).

To run an image you built yourself, set `SLUGBASE_IMAGE` to its tag, or run `docker compose up -d --build`, which builds the image from the checkout.

## First-run setup

A new SlugBase has no account. The first visit opens the setup screen, which creates the first account, an instance admin, and its first workspace. Setup works exactly once: when any account exists, the setup endpoint is permanently closed, and a visit to the setup page tells you to sign in.

By default setup needs a one-time setup token, so that nobody who finds a freshly exposed server can claim it. The server prints the token to its log each time it starts while there is no account.

1. Read the token from the log of the server.

   ```sh
   docker compose logs --no-color --no-log-prefix slugbase | grep setupToken
   ```

   The line reads `First-run setup is pending`, and its `setupToken` field holds the token. Only the hash of the token is stored. A new start of the server prints a new token and replaces the old one, so copy the last one.

2. Open `APP_ORIGIN` in a browser. The page is titled **Set up SlugBase**.

3. Enter the setup token on the first step, **Setup token**.

4. On **Your account**, enter your name, your email address and a password. The password has 12 to 256 characters, and SlugBase refuses one that appears in a list of breached passwords. The check runs against a list inside the image, so nothing leaves your server.

5. On **Your first workspace**, name the workspace and choose **Create account**. You are signed in as the instance admin.

6. Open the security settings and turn on two-step verification. This account administers the whole server. [Account recovery and security checklist](security.md) lists the other settings to check now.

Two keys change how setup works. Set them in `.env` and run `docker compose up -d` again.

| Key | Default | What it does |
| --- | ------- | ------------ |
| `SETUP_TOKEN_REQUIRED` | `true` | Setup asks for the token from the log. Set `false` only when nobody but you can reach the server until setup is done. |
| `SETUP_ENABLED` | `true` | `false` closes setup for the whole deployment, for an instance that must never have an instance admin. |

Public registration is off. After setup, invite the people who will use SlugBase. See [Self-hosting SlugBase](index.md). SlugBase sends mail, such as invitations and password resets, only when you connect an SMTP relay: see [Set up mail](mail.md).

## The database roles

SlugBase connects to PostgreSQL with two different logins, and neither is the database superuser. `compose.yml` creates them on the first start of an empty database, with the script `packages/db/provision/roles.sql`, which the `postgres` service runs from its init directory.

| Role | Used by | What it can do |
| ---- | ------- | -------------- |
| `slugbase_app` | The server and the worker | Reads and writes the data of the tables. It owns nothing and cannot change the schema. Row-level security applies to it. |
| `slugbase_migrator` | `migrate`, run by the entrypoint of the `slugbase` service | Applies the migrations. It acts as the `slugbase_owner` role, which owns the tables, only for that. |

The script also creates two roles that nobody can log in as: `slugbase_owner`, which owns the schema, and `slugbase_system`, which owns a few internal functions.

Two database URLs carry the logins, and the compose file builds both from your passwords:

- `DATABASE_URL` is the `slugbase_app` login. The server and the worker both get it.
- `DATABASE_MIGRATE_URL` is the `slugbase_migrator` login. Only the `slugbase` container gets it, for the `migrate` step before the server starts. The entrypoint removes it from the environment before the server process starts, and the worker never receives it, so a flaw in either process cannot change the schema.

```yaml
x-slugbase-environment: &slugbase-environment
  DATABASE_URL: postgres://slugbase_app:${APP_DB_PASSWORD:?APP_DB_PASSWORD is required}@postgres:5432/slugbase
```

```yaml
  slugbase:
    environment:
      <<: *slugbase-environment
      DATABASE_MIGRATE_URL: postgres://slugbase_migrator:${MIGRATOR_DB_PASSWORD:?MIGRATOR_DB_PASSWORD is required}@postgres:5432/slugbase
```

The script runs only when the data volume is empty. It never changes a password afterwards. To change one, run `ALTER ROLE` in the database and update `.env`.

### Why the server refuses the database owner

Row-level security separates one workspace from another inside the database. It holds only for a login that is not a superuser, does not own the tables and does not have the `BYPASSRLS` attribute. A server that connects as such a role would still run, but nothing in the database would keep one workspace's rows from another's.

So in production the server and the worker check the role of `DATABASE_URL` when they start. If it is a superuser, owns the database or has `BYPASSRLS`, they stop with an error that names the role and explains the two-role setup. With `compose.yml` you never see it, because the file always connects as `slugbase_app`.

You meet it when you run the image yourself against a PostgreSQL you manage, with `DATABASE_URL` set to an owner login. The right fix is to run `roles.sql` there as a superuser and connect as `slugbase_app`:

Give the two passwords to `psql` in its environment, not on its command line. Other users on the server can read a command line, and a shell keeps what you type in its history. In bash or zsh, `read -rs` takes each password at a prompt without showing it or saving it. The script reads `PROVISION_APP_PASSWORD` and `PROVISION_MIGRATOR_PASSWORD` with the `\getenv` command of `psql`, which needs `psql` 15 or newer. Remove the variables when the script is done.

```sh
printf 'slugbase_app password: '; read -rs PROVISION_APP_PASSWORD; echo
printf 'slugbase_migrator password: '; read -rs PROVISION_MIGRATOR_PASSWORD; echo
export PROVISION_APP_PASSWORD PROVISION_MIGRATOR_PASSWORD
psql -h <your database host> -U <your superuser> -d <your database> -v ON_ERROR_STOP=1 -f packages/db/provision/roles.sql
unset PROVISION_APP_PASSWORD PROVISION_MIGRATOR_PASSWORD
```

Some managed PostgreSQL services make extra roles awkward. For those, set `SLUGBASE_ALLOW_OWNER_CONNECTION=true` in the environment of the server and the worker. They then start with a warning in the log, and the separation between workspaces rests on the application alone. `compose.yml` does not hand this key to the containers, because it never needs it.

## PostgreSQL versions

SlugBase supports PostgreSQL 17 and 18. The compose file ships 18. The test suite runs against both.

To keep the database of `compose.yml` on 17 instead, merge the override file of the repository over it. Do this before the first start: the two major versions keep different on-disk formats, so a volume made by one cannot be opened by the other. Never switch an installation that already holds data from one major version to the other with these commands.

`COMPOSE_FILE` lists the compose files Compose merges, separated by colons. `.env` must hold exactly one `COMPOSE_FILE` line, with every file you use, taken from this table.

| You use | `COMPOSE_FILE` |
| ------- | -------------- |
| PostgreSQL 18, two containers (the default) | no line |
| PostgreSQL 17, two containers | `compose.yml:compose.pg17.yml` |
| PostgreSQL 18, one container | `compose.yml:compose.single.yml` |
| PostgreSQL 17, one container | `compose.yml:compose.pg17.yml:compose.single.yml` |

For PostgreSQL 17 with two containers, this command writes the line. It copies `.env` without any `COMPOSE_FILE` line, adds the new one and then replaces `.env`, and it keeps the file readable by you only. It works with the `sh` of Linux and of macOS. If a step fails, `.env` stays as it was.

```sh
(umask 077; grep -v '^COMPOSE_FILE=' .env > .env.new; [ "$?" -le 1 ] && echo 'COMPOSE_FILE=compose.yml:compose.pg17.yml' >> .env.new) && mv .env.new .env
```

If you run one container, use the PostgreSQL 17 block under [One container or two](#one-container-or-two) instead.

**Never add a second `COMPOSE_FILE` line.** Compose reads the last one and ignores the first, so a line added with `echo >> .env` can undo the one before it. On a PostgreSQL 17 installation, a second line that lists only `compose.single.yml` silently brings back the PostgreSQL 18 image. It mounts the volume at another path and starts an empty database, and SlugBase shows the setup screen while your data sits unreachable in the old volume. If that happens, stop the stack, put the right line back and start it again: your data is still in the volume.

With a PostgreSQL you run yourself, any 17 or 18 server works. Provision the roles as above and give the server and the worker the two URLs. The documented stack is the one with its own `postgres` service, which is the one these pages describe.

## One container or two

The documented stack runs two containers from one image: `slugbase` runs `server` and `slugbase-worker` runs `worker`. The server answers requests and the worker runs the jobs, so a slow job never delays a page.

For an install that can run only one container, the image has a single-container mode. Its command is `server --with-worker`: the server and the worker run in one process, the same server and the same worker as in the two containers. The published `compose.yml` still runs two containers. To use one, add an override file that gives `slugbase` the other command and keeps the worker container from starting. This first block changes nothing else.

```sh
cat > compose.single.yml <<'EOF'
services:
  slugbase:
    command: ["server", "--with-worker"]
  slugbase-worker:
    profiles: ["two-containers"]
EOF
```

Then run one of the next two blocks, the one for the PostgreSQL version your database runs. Each writes the whole `COMPOSE_FILE` line, so it never changes the major version of the database. Do not run both, and do not run one that names a different major than your database.

PostgreSQL 18, the default:

```sh
(umask 077; grep -v '^COMPOSE_FILE=' .env > .env.new; [ "$?" -le 1 ] && echo 'COMPOSE_FILE=compose.yml:compose.single.yml' >> .env.new) && mv .env.new .env
docker compose rm --stop --force slugbase-worker
docker compose up -d
```

PostgreSQL 17:

```sh
(umask 077; grep -v '^COMPOSE_FILE=' .env > .env.new; [ "$?" -le 1 ] && echo 'COMPOSE_FILE=compose.yml:compose.pg17.yml:compose.single.yml' >> .env.new) && mv .env.new .env
docker compose rm --stop --force slugbase-worker
docker compose up -d
```

The first command of each block replaces the `COMPOSE_FILE` line of `.env`, as described under [PostgreSQL versions](#postgresql-versions), and the other two remove a worker container that an earlier start made and start the stack. Run the commands in the directory that holds `compose.yml`. Without Compose, run the image with the command `server --with-worker` and the environment of the `slugbase` service. Nothing else about the setup changes.

What differs from two containers:

- **Migration.** The entrypoint runs `migrate` first, as `slugbase_migrator`, and then starts the process without `DATABASE_MIGRATE_URL`, exactly as for `server`. The one process holds no migrator login.
- **Connections.** The process holds the pools of both sides: up to 10 connections for the server and 5 for the worker, 15 in these two pools, plus the few small connections each side opens for its own tasks. See [Run SlugBase day to day](operations.md) when you plan the connections of PostgreSQL.
- **Metrics.** With `METRICS_PORT` set, the process opens one metrics listener, the server's. `/metrics` shows the samples of the server and, in the same response, those of the worker, which carry the label `process="worker"`. [Run SlugBase day to day](operations.md) says what is there.
- **Lookups.** The server and the worker share one small budget of simultaneous host-name lookups, so a slow name server can slow both.
- **Load.** Jobs and requests share one process. Go back to two containers if jobs slow the pages down.

## Updates and privacy

SlugBase sends nothing to MDG Labs. It has no usage pings and no update check, so it never contacts anyone to ask whether a newer version exists. To learn about new versions, follow the [releases page](https://github.com/mdg-labs/slugbase/releases). The instance admin finds a link to it beside the version, in **Admin**, **Overview**, **Version and database**. The link only opens the page: SlugBase does not compare versions. Read the notes of a release before you change `SLUGBASE_IMAGE`. [Upgrade SlugBase](upgrade.md) has the steps, the image tags and the supported versions.

To see which version runs, open `/version` on your server. It answers with the name, version, commit and build time of the image. `/health` and `/ready` are the other two probes: [Run SlugBase day to day](operations.md) says which one to use for what.

```sh
curl -fsS http://127.0.0.1:3000/version
```

## Optional settings

`.env.example` lists every key. `compose.yml` hands each of them to the containers that read it, key by key, so a key that is not in the file or in `.env` is not passed on and the default applies. See [Environment settings](environment.md).

The keys of OIDC sign-in providers, `OIDC_<SLUG>_*`, cannot be listed, because the slug is yours. Put them in a file named `.env.oidc` next to `compose.yml`. [Set up OIDC sign-in](oidc.md) shows the keys. Only the server reads it. The file is optional, and without it the stack starts with no provider. Keep to `OIDC_<SLUG>_*` keys in it, because it is passed on as it is. Do not put the database passwords there. It is also why Compose 2.24 or later is required.

## Troubleshooting

**`docker compose up` stops with `APP_DB_PASSWORD is required`, or names another key.** `.env` is missing that key, or you ran the command in another directory. Run it next to `compose.yml` and `.env`.

**The server stops, and `docker compose logs slugbase` says `must be an https origin in production`.** `APP_ORIGIN` starts with `http://`. Use the `https` origin your users open.

**The server stops with a message about a development value.** A key still holds the value of `.env.example`. Generate the secrets as in step 2.

**`/ready` answers `503`.** The migration is still running, or the database cannot be reached. Wait a minute, then read `docker compose logs slugbase postgres`.

**The server stops because the login of `slugbase_app` fails.** You changed a database password in `.env` after the first start. The roles keep the password they were created with. Put the old value back, or change the role in the database with `ALTER ROLE`.

**The setup screen asks for a token you cannot find.** Run the `docker compose logs` command in step 1 of first-run setup again. Restart the server with `docker compose restart slugbase` if the line is gone from the log, and copy the new token.

**The setup page says setup was already completed.** An account exists. Sign in with it.

## Related pages

- [Self-hosting SlugBase](index.md)
- [Environment settings](environment.md)
- [Back up and restore](backup-restore.md)
- [Put SlugBase behind a reverse proxy](reverse-proxy.md)
- [Set up mail](mail.md)
- [Set up OIDC sign-in](oidc.md)
- [Upgrade SlugBase](upgrade.md)
- [Run SlugBase day to day](operations.md)
- [Account recovery and security checklist](security.md)

## SlugBase Cloud

If you would rather not run the server yourself, [SlugBase Cloud](https://slugbase.app) is the managed alternative, built from the same code. [Sign up for SlugBase Cloud](https://cloud.slugbase.app) to try it.
