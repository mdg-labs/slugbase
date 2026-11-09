---
title: "Back Up and Restore SlugBase"
description: "Back up a self-hosted SlugBase with member exports and a database dump, and restore it into an empty database."
edition: ce
order: 10
---

A self-hosted SlugBase has two kinds of backup. Each member can export their own bookmarks, and you, the operator, back up the database and the secrets that open it. This page explains both, and shows how to restore the database on a `compose.yml` installation.

## The two halves

| | Member export | Database backup |
| - | ------------- | --------------- |
| Who makes it | Each member, for their own bookmarks | You, for the whole installation |
| What it holds | The member's own bookmarks, folders, tags, slugs, forwarding and pinned state, and their remembered slug choices | Every account, workspace, bookmark, share, team, setting and audit event |
| What it leaves out | Usage counts, other members' content, and everything about the account itself | Nothing in the database. The secrets in your `.env` file are not in it |
| Restore with | The import page, into any workspace | `pg_restore`, into an empty database |
| Use it to | Keep a personal copy, or move a member's bookmarks to another SlugBase | Recover the installation after a failure, or move it to another server |

Use the database backup to protect the installation. Ask members to export as well when they want a copy that does not depend on you.

## What the member export holds

A member makes an export in **Settings**, **Account**, **Import & export**. The file format to choose is **SlugBase JSON**. It is generated when the member asks for it. SlugBase does not store it on the server.

The file holds the member's own bookmarks in the workspace they exported from, with their folders, tags, slugs, forwarding and pinned state, and the slug choices they remembered. It is lossless for that content: importing it into an empty workspace brings back the same bookmarks, folders, tags, slugs, forwarding and pinned state. It is the format to keep as a personal backup.

The other format, **Netscape HTML**, is lossy. It exists so that a browser can import the bookmarks, and the format has no place for everything SlugBase holds. It leaves out the description, the pinned state, the forwarding flag and the remembered slug choices. It has one level of folders, and it splits a tag name that holds a comma at the comma. Tell members not to use it as their backup.

The file leaves out:

- The usage counts: how often and when a bookmark was last opened.
- Other members' content. If the member ticks **Include bookmarks shared with me**, the file lists those bookmarks by their address, title, description, slug and owner's name. An import reads the list and ignores it, so it never copies someone else's bookmarks.
- The account itself: password, two-step verification, sessions and API tokens.
- Teams, shares, workspace settings and the audit log.

An export counts against the bulk limit of 20 per hour for each account.

## What the database backup holds

The database is the only state SlugBase keeps. The image stores no files: it runs with a read-only root filesystem and a temporary `/tmp`. Everything else is in the `slugbase` database, which includes the job queue and the audit log.

Two things are not in a database dump, and you must back them up separately:

- **The secrets.** Keep `ENCRYPTION_KEY` with `ENCRYPTION_KEY_ID`, and `ENCRYPTION_KEY_PREVIOUS` if you set it. Keep `SESSION_SECRET` too. SlugBase encrypts the two-step verification secrets of your members with the encryption key before it writes them to the database. A dump holds them, but nobody can read them without the key that sealed them. Without it, members who use two-step verification cannot sign in with their code. `SESSION_SECRET` signs paging links and sign-in steps in progress. The data in the dump does not depend on it, but keeping the same value means nothing in flight breaks.
- **The database roles.** `pg_dump` saves one database, not the roles of the PostgreSQL server. A restore needs the roles to exist first. See [The database roles](#the-database-roles).

## The database roles

SlugBase runs with separate database roles, so that the process that serves requests cannot change the schema and cannot see across workspaces.

| Role | Logs in | What it is for |
| ---- | ------- | -------------- |
| `slugbase_app` | Yes | What the server and the worker connect as. It reads and writes the tables, is bound by row-level security, owns nothing and cannot change the schema. Its password is `APP_DB_PASSWORD`. |
| `slugbase_migrator` | Yes | What the migration connects as. It does the schema changes as `slugbase_owner`. Its password is `MIGRATOR_DB_PASSWORD`. |
| `slugbase_owner` | No | Owns every object in the database. |
| `slugbase_system` | No | Owns the database functions that SlugBase uses where it has to read across workspaces. |

The roles belong to the PostgreSQL server, not to the database, so a dump does not contain them. It does contain the owner of each object and the privileges that `slugbase_app` has on each table. The roles themselves, their memberships and the connect and create privileges on the database come from the script `packages/db/provision/roles.sql`. On a `compose.yml` installation, the `postgres` service runs it once, when it first starts with an empty volume. It creates the four roles and gives the two login roles the passwords `APP_DB_PASSWORD` and `MIGRATOR_DB_PASSWORD` from your `.env` file. The script is safe to run again: it leaves the roles as they are and changes no password.

The roles must exist before you restore, with the memberships and privileges that the script gives. Step 2 of [Restore from a dump](#restore-from-a-dump) does this for a `compose.yml` installation. For a PostgreSQL server that you run yourself, run the script once as a superuser against the empty `slugbase` database before the restore. The two passwords are the ones in the `DATABASE_URL` and `DATABASE_MIGRATE_URL` of your installation.

```sh
psql -U <superuser> -d slugbase -v ON_ERROR_STOP=1 -v app_password=<the slugbase_app password> -v migrator_password=<the slugbase_migrator password> -f packages/db/provision/roles.sql
```

## Keep the secrets

Keep the whole `.env` file, and `.env.oidc` if you have one, in a password manager or an encrypted store that is not on the same server as the dump. A dump and the key that opens its secrets should not sit in the same place.

A dump or a volume snapshot is sensitive. It holds the password hashes, the API token hashes, the sealed two-step verification secrets, the email addresses of your members and all of their private bookmarks. Keep every copy unreadable to other users, on the server and wherever you store it.

## Prerequisites

- A `compose.yml` installation, with the commands run in the directory that holds `compose.yml` and `.env`.
- Disk space on the server, or on a machine you copy to, for the dump. A dump is compressed and usually much smaller than the database.

## Back up the database

The `postgres` service holds the database. Dump it as the database superuser `slugbase`, which the service starts with. The application logins cannot make a dump, and PostgreSQL refuses them.

1. Make the dump.

   ```sh
   install -d -m 700 backups
   (umask 077; docker compose exec -T postgres pg_dump -U slugbase -d slugbase --format=custom > "backups/slugbase-$(date +%F).dump")
   ```

   The directory and the dump are readable by your account only.

   The dump is a consistent snapshot, so SlugBase can keep running while it is made.

2. Check that the file lists its contents.

   ```sh
   docker compose exec -T postgres pg_restore --list < "backups/slugbase-$(date +%F).dump" | head
   ```

3. Copy the dump off the server to a storage that only you can read. Keep the secrets from your `.env` file in a different place, such as your password manager, never beside the dump.

### Take a volume snapshot instead

A snapshot of the `postgres-data` volume backs up the whole database cluster, roles included. The database must be stopped while you copy it, and so must the worker, so that no job is writing while you copy. The `docker compose stop` in the commands below stops the server and the worker as well as the database. If you take the snapshot with a tool that works on the volume while the database runs, stop `slugbase` and `slugbase-worker` first, and use a tool that takes one atomic snapshot of the whole volume. A snapshot restores only onto the same PostgreSQL major version, so a dump is the better choice when you plan to upgrade PostgreSQL.

The commands below start their helper container from the image of your `postgres` service, so they pull nothing new.

```sh
install -d -m 700 backups
docker compose stop
POSTGRES_CONTAINER="$(docker compose ps -aq postgres)"
POSTGRES_IMAGE="$(docker inspect --format '{{.Config.Image}}' "$POSTGRES_CONTAINER")"
docker run --rm --volumes-from "$POSTGRES_CONTAINER" -v "$PWD/backups":/backup --entrypoint sh "$POSTGRES_IMAGE" -c "umask 077 && tar czf /backup/postgres-data.tgz -C /var/lib/postgresql . && chown $(id -u):$(id -g) /backup/postgres-data.tgz"
docker compose start
```

The archive belongs to your account and only you can read it. Keep it apart from your `.env` secrets, as you do the dump.

To restore it, create an empty volume, unpack the archive into it and start the stack. This replaces the data in the volume.

```sh
docker compose down -v
docker compose up --no-start postgres
POSTGRES_CONTAINER="$(docker compose ps -aq postgres)"
POSTGRES_IMAGE="$(docker inspect --format '{{.Config.Image}}' "$POSTGRES_CONTAINER")"
docker run --rm --volumes-from "$POSTGRES_CONTAINER" -v "$PWD/backups":/backup --entrypoint tar "$POSTGRES_IMAGE" xzf /backup/postgres-data.tgz -C /var/lib/postgresql
docker compose up -d
```

## Restore from a dump

You restore into an empty `slugbase` database that already has the four roles of SlugBase. The dump sets the owner of each object to `slugbase_owner`, so the restore fails when that role does not exist.

The steps on this page are tested. Every week and before each release, the script `scripts/backup-restore-check.sh` takes the dump of this page from a seeded installation, restores it into a new database as step 2 and step 3 say, and starts the image against it. It checks that the restored database holds the same accounts, workspaces, bookmarks, folders, tags and shares, that `/ready`, a member's sign-in and a slug link work, that row-level security is still enforced, that a restore without the roles stops with the error named in [Troubleshooting](#troubleshooting), and that a changed `ENCRYPTION_KEY` locks out the members who use two-step verification.

1. Stop the application, so nothing writes while you restore.

   ```sh
   docker compose stop slugbase slugbase-worker
   ```

2. Get an empty database with the roles. Choose the case that fits.

   **A new server, or an empty volume.** Put your `.env` file back, with the same secrets. Start only the database. On its first start with an empty volume, it creates the `slugbase` database and the roles from your `.env` passwords.

   ```sh
   docker compose up -d postgres
   ```

   Wait until the database answers before you restore. The first start sets up the cluster on a temporary server, which `docker compose exec` can reach, and then restarts it. A restore that runs in that time fails with a missing role or a dropped connection. The final server is the only one that answers on the network address `127.0.0.1`, so the wait asks there. It ends with an error after 120 seconds, and then you read `docker compose logs postgres` instead of restoring.

   ```sh
   docker compose exec -T postgres timeout 120 sh -c 'until pg_isready -h 127.0.0.1 -U slugbase -d slugbase; do sleep 1; done'
   ```

   **The same server, with a database that has data you want to replace.** This deletes the current database. Make a dump first if you are unsure. Recreate the database, then run the script that creates the roles again. It is safe to run on a cluster that already has them, and it changes no password.

   ```sh
   docker compose exec -T postgres psql -U slugbase -d postgres -v ON_ERROR_STOP=1 -c 'DROP DATABASE slugbase WITH (FORCE)' -c 'CREATE DATABASE slugbase'
   docker compose exec -T postgres psql -U slugbase -d slugbase -v ON_ERROR_STOP=1 -q -f /docker-entrypoint-initdb.d/10-roles.sql
   ```

3. Restore the dump. The restore runs in one transaction and stops at the first error, so a failed restore leaves the database empty.

   ```sh
   docker compose exec -T postgres pg_restore -U slugbase -d slugbase --exit-on-error --single-transaction < backups/slugbase-2026-11-04.dump
   ```

   Use the name of your own file. Use a PostgreSQL server of the same major version as the one that made the dump, or a newer one.

4. Start the application.

   ```sh
   docker compose up -d
   ```

   The `slugbase` service runs the migration as it starts, before it serves anything. A dump from an older release is brought to the level of the image you run: the migration applies every step the dump is missing. Run the release that made the dump, or a newer one.

5. Check that SlugBase is ready. The port is the `PORT` of your `.env` file, `3000` by default.

   ```sh
   curl -fsS http://127.0.0.1:3000/ready
   ```

   A ready installation answers `200` and a body such as `{"database":"ok","migrations":{"expected":140,"applied":140}}`, with equal numbers. They show the migration level of the database against what the image expects. `docker compose ps` shows `slugbase` as healthy.

6. Check that people can use it. Sign in, including a member who uses two-step verification, and open a workspace to see its bookmarks. Then open a slug link that you know, in the form `https://<your host>/go/<slug>`. The browser must be sent to the bookmark.

A restore brings back what the dump held on the day it was made. An account or a bookmark that someone deleted after that day is back, so delete it again if the deletion was asked for. The same holds for every copy you keep: data that a member deleted stays in your dumps and snapshots until you delete them. Choose how long you keep them with that in mind, and tell your members how long it is.

## Plan your backups

The schedule below is a recommendation, not a rule of SlugBase. Adjust it to how much you can afford to lose and how much storage you have.

- **Daily dump.** Make one every day, at a quiet hour. At most a day of changes is lost.
- **Dump before an upgrade.** Make one right before you install a new release.
- **Retention.** Keep the last 14 daily dumps on the server. In your offsite storage, also keep one dump a month for 6 months. Delete the rest.
- **Offsite copy.** Copy each dump to a place that is not the server and not the storage of your `.env` secrets.
- **Restore drill.** Restore the newest dump into a scratch installation at least every quarter, and run the checks of step 5 and step 6. A backup that you have never restored is not yet a backup.

A crontab line for the daily dump on a `compose.yml` installation that lives in `/opt/slugbase`, which also deletes dumps older than 14 days:

```text
17 3 * * * cd /opt/slugbase && (umask 077; docker compose exec -T postgres pg_dump -U slugbase -d slugbase --format=custom > "backups/slugbase-$(date +\%F).dump") && find backups -name 'slugbase-*.dump' -mtime +14 -delete
```

The crontab line keeps 14 days on the server. Copying the dumps offsite, and keeping the monthly ones there, is yours to add with the tool you use for backups. Check now and then that the job still runs and that the newest file lists its contents, as in step 2 of [Back up the database](#back-up-the-database).

## Audit events and retention

The audit events are rows in the database, so they are in every dump. `AUDIT_RETENTION_DAYS` sets how many days SlugBase keeps them. It is 365 by default, and `0` keeps them forever. The worker deletes older events every hour, in batches. The one event that records the completed first-run setup is kept.

Two things follow:

- A dump keeps the events that were there when it was made, even after you shorten `AUDIT_RETENTION_DAYS`. Delete old dumps on your own schedule.
- After you restore an old dump, the events past the retention period are deleted again by the hourly purge, which removes up to 5,000 rows per table in each run.

## Troubleshooting

**The restore stops with `role "slugbase_owner" does not exist`.** The database has no SlugBase roles. Run step 2 first, then restore again.

**`pg_dump` stops with `permission denied`.** You connected as `slugbase_app` or `slugbase_migrator`. Use `-U slugbase`, as shown above.

**`/ready` answers `503`.** The service is still migrating, or cannot reach the database. Wait a minute, then read the log with `docker compose logs slugbase`.

**A member with two-step verification cannot sign in after the restore.** The `ENCRYPTION_KEY` of the new installation is not the one that sealed the secret. Put back the key from your backup, and `ENCRYPTION_KEY_PREVIOUS` if you used it, then restart the stack.

## Related pages

- [Self-Hosting SlugBase](index.md)
- [Check the Bookmark Counter](check-bookmark-counter.md)
