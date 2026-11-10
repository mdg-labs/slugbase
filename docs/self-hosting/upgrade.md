---
title: "Upgrade SlugBase"
description: "Upgrade a self-hosted SlugBase to a new release, run migrations yourself if you want to, roll back, and see which image tags and PostgreSQL versions are supported."
edition: ce
order: 60
---

A SlugBase upgrade is a new image and a restart. The server migrates the database as it starts, and does not serve requests until the database is at the level the new image expects. This page explains the image tags, the steps to upgrade a `compose.yml` installation, what the migration does, how to run it yourself, and what a rollback can and cannot do.

## Prerequisites

- A `compose.yml` installation, with the commands run in the directory that holds `compose.yml` and `.env`.
- A recent backup. See [Back Up and Restore SlugBase](backup-restore.md).

## Image tags

SlugBase is published as one image, `ghcr.io/mdg-labs/slugbase`, which runs as the server, the worker or the migration. Release numbers follow semantic versioning: `<major>.<minor>.<patch>`.

| Tag | What it points at |
| --- | ----------------- |
| `:<semver>`, such as `:1.2.3` | Exactly that release. It never moves. A pre-release such as `1.0.0-rc.1` has this tag only. |
| `:<major>.<minor>`, such as `:1.2` | The newest patch release of that minor version, so it moves from one patch release to the next. A pre-release never has it. |
| `:latest` | The newest published release. It moves only when a release is published, never because of a build, and never for a pre-release. |

`compose.yml` runs the `:latest` tag unless you set `SLUGBASE_IMAGE`. Pin a version instead. A pinned installation changes only when you decide to, and you know which release a backup belongs to.

```sh
SLUGBASE_IMAGE=ghcr.io/mdg-labs/slugbase:1.2.3
```

For the strictest pin, use the digest of the image. The notes of each release on the [releases page](https://github.com/mdg-labs/slugbase/releases) name it. You can also ask the registry.

```sh
docker buildx imagetools inspect ghcr.io/mdg-labs/slugbase:1.2.3
SLUGBASE_IMAGE=ghcr.io/mdg-labs/slugbase@sha256:<the digest>
```

The server and the worker run the same image, and `compose.yml` hands `SLUGBASE_IMAGE` to both, so they always change together. Run them on the same release.

Within `/api/v1`, SlugBase only adds things. A change that would break the API is published as `/api/v2` next to `v1`, and `v1` stays for at least six months, so integrations that use API tokens keep working through the overlap.

## Upgrade

1. Read the notes of the release on the [releases page](https://github.com/mdg-labs/slugbase/releases). They say what changed, and name anything you have to do yourself, such as a new key in `.env`. When a release changes `compose.yml` or `.env.example`, compare them with your own copies.
2. Take a backup, and check that it lists its contents. See [Back Up and Restore SlugBase](backup-restore.md).
3. Set the new version in `.env`.

   ```sh
   SLUGBASE_IMAGE=ghcr.io/mdg-labs/slugbase:1.2.4
   ```

4. Pull the new image and restart.

   ```sh
   docker compose pull
   docker compose up -d
   ```

   Compose recreates the server and the worker with the new image. The server runs the migration first, and only then starts. The worker starts after the server is ready.

5. Check that it is ready and on the version you expect. The port is the `PORT` of your `.env` file, `3000` by default.

   ```sh
   curl -fsS http://127.0.0.1:3000/ready
   curl -fsS http://127.0.0.1:3000/version
   ```

   `/ready` answers `200` with `"database":"ok"` and equal numbers of `expected` and `applied` migrations. `/version` answers with the name, version, commit and build time of the image: `{"name":"SlugBase","version":"1.2.4","commit":"<commit hash>","builtAt":"<build time>"}`. `docker compose ps` shows `slugbase` as healthy.

6. Sign in, open a workspace and open a slug link, as you do after a restore.

An instance admin also sees the version and the migration level in **Admin**, **Overview**, under **Version and database**.

## What happens during the migration

The image's entrypoint runs `migrate` with the database login `slugbase_migrator` before it starts the server. The server then starts without that login in its environment, so a compromised server cannot change the schema.

- **One migration at a time.** `migrate` holds a PostgreSQL advisory lock for the whole run. A second `migrate`, for example from a second server container that starts at the same moment, waits for the lock. It then finds the work done and applies nothing. It waits at most 15 minutes, then fails.
- **Fast steps.** Each migration waits at most 5 seconds for a lock on a table, and fails instead of queueing behind other traffic. A step that builds an index on a large table runs without a transaction, is bounded by a limit of 15 minutes per statement, and does not block reads and writes of that table. Changes to data that take long run later as background jobs of the worker, not in the migration.
- **A failed migration changes nothing from its own step, except for an index build.** An ordinary migration is applied in one transaction together with its entry in the version table. If it fails, it is rolled back and has no entry. A step that builds indexes without a transaction, as described above, is not rolled back. It has no entry until all its indexes exist. If it fails, any index it finished stays, and the build that failed can leave an invalid index under its name. The next run of `migrate` drops an invalid index of that name and builds it again, and keeps a finished index that belongs to the step. Migrations that finished earlier in the same run keep theirs, so the next run continues where it stopped. `migrate` exits with a non-zero status, and the server never starts. With `compose.yml`, the container is restarted and tries again. Read the reason with `docker compose logs slugbase`. The message names the migration and never prints a password.
- **Checks on what was applied.** `migrate` refuses to run when a migration it already applied differs from the one in the image, which means the database and the image do not belong together.
- **Readiness.** `/ready` answers `503` until the database is at the level the image expects. A database that is ahead of the image, as after a rollback, stays ready, and the server logs a warning that the database has migrations this build does not ship.

The job queue of the worker keeps its own tables. `migrate` installs and upgrades them as part of the same run. When a release raises the version of that schema, a database that has it can no longer be used with an older image. See [Roll back](#roll-back).

## Run the migration yourself

By default the server migrates when it starts. If you want the migration as a separate step, for example to run it before you stop the old containers, set `MIGRATE_ON_START=false` in `.env`. The server then never migrates, and it answers `/ready` with `503` until the database is at the level its image expects. Run the migration from the new image, then start the stack.

```sh
docker compose pull
docker compose run --rm slugbase migrate
docker compose up -d
```

`migrate` needs only `DATABASE_MIGRATE_URL`, which `compose.yml` gives the `slugbase` service. Run it from the image you are about to start, because each image applies the migrations it ships. A server that starts before the migration has run stays unready until you run it.

## Roll back

Migrations only go forward. SlugBase has no command that undoes one. A change that removes or renames something in the database is made in two releases. The first release stops using the old object, and a later release, never the same one, removes it. Because of this, **rolling back by one release is supported**. The previous release does not use what the newer release removed.

To go back one release:

1. Set the previous version in `.env`, and run `docker compose pull` and `docker compose up -d`.
2. Check `/ready` and `/version`, as in the upgrade.

The database keeps the migrations of the newer release. The older image does not apply them, and starts with a warning that the database is ahead.

A rollback by one release can still fail to start, and then you restore the backup:

- The newer release raised the version of the job queue schema. The older image refuses to start, and its log says that the pg-boss schema is newer than the version the build runs.
- You are going back further than one release. An older release may still use something that a later one removed.

To go back further, or when a rollback fails, restore the backup you took before the upgrade, with the older image. See [Restore from a dump](backup-restore.md#restore-from-a-dump). A restore returns the database to the time of the backup, so changes that members made since then are lost.

## Skipping releases

You can upgrade from any release straight to a later one. `migrate` applies every migration the database lacks, in order, in one run. A release that needs a step of your own says so in its notes, so read the notes of each release you skip. Take a backup first, because you can roll back by only one release.

## Supported versions

- **PostgreSQL.** SlugBase supports PostgreSQL 17 and 18, and its tests run against both. `compose.yml` ships PostgreSQL 18, pinned by digest. A new release of SlugBase can move that digest within version 18.
- **A new PostgreSQL major version.** A volume of one major version does not start under another. To move to a newer major version, make a dump, start a database of the new version with an empty volume, and restore the dump into it. See [Back Up and Restore SlugBase](backup-restore.md).
- **Node.** The image carries its own Node.js, version 24. You do not install Node on the host. A newer Node version arrives with a new image, and you do nothing for it.

## Troubleshooting

**`docker compose up -d` reports that `slugbase` is unhealthy while the migration still runs.** The health check gives the server about a minute and a half to answer, and a large migration can take longer. Wait until `docker compose ps` shows `slugbase` as healthy, and run `docker compose up -d` again to start the worker.

**The server starts again and again.** The migration fails, `compose.yml` restarts the container, and it fails again. Read `docker compose logs slugbase` for the migration that failed and why. A lock that another connection holds on a table is a common cause. Stop whatever holds it and the next try succeeds. If you cannot find the cause, roll back to the previous release, and report the message in an issue at https://github.com/mdg-labs/slugbase/issues.

**The log says the migration lock was not obtained in time.** Another `migrate` has run for more than 15 minutes. Check whether a migration is still running, such as an index build, with `docker compose ps` and the logs of every container that runs the image.

**`/ready` answers `503`.** The server is still migrating, the database is not reachable, or the database is behind the image. The body of the answer says which: `"database":"unreachable"`, or `applied` lower than `expected`.

## Related pages

- [Self-Hosting SlugBase](index.md)
- [Back Up and Restore SlugBase](backup-restore.md)
- [Put SlugBase Behind a Reverse Proxy](reverse-proxy.md)
