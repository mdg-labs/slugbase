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

The file holds the member's own bookmarks in the workspace they exported from, with their folders, tags, slugs, forwarding and pinned state, and the slug choices they remembered. Importing it into an empty workspace brings back the same bookmarks, folders, tags, slugs, forwarding and pinned state.

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
- **The database logins.** `pg_dump` saves one database, not the roles of the PostgreSQL server. `slugbase_app` and `slugbase_migrator` are created when the database volume is first created, with the passwords `APP_DB_PASSWORD` and `MIGRATOR_DB_PASSWORD` from your `.env` file.

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

A snapshot of the `postgres-data` volume backs up the whole database cluster, roles included. The database must be stopped while you copy it. A snapshot restores only onto the same PostgreSQL major version, so a dump is the better choice when you plan to upgrade PostgreSQL.

```sh
install -d -m 700 backups
docker compose stop
docker run --rm --volumes-from "$(docker compose ps -aq postgres)" -v "$PWD/backups":/backup --entrypoint sh postgres:18 -c "umask 077 && tar czf /backup/postgres-data.tgz -C /var/lib/postgresql . && chown $(id -u):$(id -g) /backup/postgres-data.tgz"
docker compose start
```

The archive belongs to your account and only you can read it. Keep it apart from your `.env` secrets, as you do the dump.

To restore it, create an empty volume, unpack the archive into it and start the stack. This replaces the data in the volume.

```sh
docker compose down -v
docker compose up --no-start postgres
docker run --rm --volumes-from "$(docker compose ps -aq postgres)" -v "$PWD/backups":/backup --entrypoint tar postgres:18 xzf /backup/postgres-data.tgz -C /var/lib/postgresql
docker compose up -d
```

## Restore from a dump

You restore into an empty `slugbase` database that already has the four roles of SlugBase. The dump sets the owner of each object to `slugbase_owner`, so the restore fails when that role does not exist.

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

   A ready installation answers `200` and a body such as `{"database":"ok","migrations":{"expected":119,"applied":119}}`, with equal numbers. `docker compose ps` shows `slugbase` as healthy. Then sign in and open a workspace to see its bookmarks.

A restore brings back what the dump held on the day it was made. An account or a bookmark that someone deleted after that day is back, so delete it again if the deletion was asked for.

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
