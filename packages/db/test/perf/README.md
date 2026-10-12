# `/go` resolution under row-level security and transaction pooling

`go-resolution.ts` answers the end-of-Phase-1 kill criterion of doc 12 section 5
and risk R3: can forced row-level security through PgBouncer in transaction
pooling mode serve the `/go` candidate query of doc 05 section 4 at a p95 under
30 ms? It is an opt-in measurement. It is not part of `pnpm test:*` or `pnpm gate`.

## Run it

```sh
cd packages/db
docker compose -p slugbase-perf -f test/perf/rig/compose.perf.yml up -d --wait
pnpm perf:go                      # defaults: PostgreSQL on 54330, PgBouncer on 64330
pnpm perf:go --slug-type text     # the same measurement with a text slug column
pnpm perf:go --jit off            # jit = off for the application role (the server default is on)
docker compose -p slugbase-perf -f test/perf/rig/compose.perf.yml down -v
```

The rig is a throwaway PostgreSQL and a PgBouncer 1.x in transaction pooling mode
(`rig/pgbouncer.ini`) on their own network, apart from the development stack. The
script creates a scratch database `perf_go_<random>` and a login role
`slugbase_perf_app` (`NOBYPASSRLS`) on the server it is pointed at. It removes the
database when it ends (`--keep` leaves it) and always removes the role, also with
`--keep` (the role's privileges in the kept database are dropped first) and when it is
interrupted by SIGINT, SIGTERM or SIGHUP; an interrupted run drops the database too. A
step of the cleanup that fails is printed with the statement to run by hand. The script
refuses to start when `slugbase_perf_app` already exists, as a run killed with SIGKILL
may have left it, and prints the statements that remove it.

Point it at another instance with `--pg-url` (a superuser URL) and `--pooler
host:port` (a PgBouncer that forwards any database name), or the environment variables
`SLUGBASE_PERF_PG_URL` and `SLUGBASE_PERF_POOLER`. The rig's role password is committed
with the rig (`rig/userlist.txt`) and is used only when both addresses are loopback
and the ports are the rig's (`PERF_PG_PORT` and `PERF_POOLER_PORT`, default 54330 and
64330). For any other target set `SLUGBASE_PERF_APP_PASSWORD` to a password of your own
(at least 16 characters, not the committed one) and use the same password for
`slugbase_perf_app` in that PgBouncer's auth file; the script refuses to run otherwise. The
PgBouncer console password is read from `SLUGBASE_PERF_POOLER_ADMIN_PASSWORD` (or
`--pooler-admin`); off the rig the console is not read without it. `pnpm perf:go
--help` lists every option (request counts, rounds, offered rate, `--jit`, output file).

To size the database container like the instance under test, set `PERF_PG_CPUS`,
`PERF_PG_MEMORY`, `PERF_PG_SHARED_BUFFERS`, `PERF_PG_EFFECTIVE_CACHE_SIZE` and
`PERF_PG_IMAGE` (the PostgreSQL major, 17 or 18) before `docker compose up`. For a
production-sized instance, point `--pg-url` and `--pooler` at that instance and
state its specification with the results.

## What it measures

- The scratch tables are synthetic copies of the six tables of the doc 05 section 4
  query (`bookmarks`, `bookmark_shares`, `folder_bookmarks`, `folder_shares`,
  `team_members`, `slug_preferences`) with the documented indexes, including
  `bookmarks_slug_idx` with `INCLUDE`, and `FORCE`d policies of the shape of doc 05
  section 3.2. They are not the shipped migrations. `app_workspace_id()` and
  `app_account_id()` are read from `src/sql/020-tenant-context.sql`.
- Seeded data (deterministic, at the default `--bookmarks 50000 --workspaces 2000`): 50 000
  bookmarks in one workspace of 50 members and 10 teams, 100 slugs each carried by 2 to
  50 members, 6 999 bookmark shares (5 000 of them in the large workspace, so that one
  workspace holds 71 % of the table), 500 folders with 10 000 filed bookmarks, 1 000
  folder shares, 300 slug preferences, and 1 999 small workspaces. A smaller
  `--bookmarks` scales the colliding slugs, the shares and the preferences down with it.
  Identifiers are UUIDv7 generated in the script.
- Requests run through `createDatabase().withTenant()` of `src/tenant.ts`, the
  production path, in four configurations: direct or through PgBouncer, with row-level
  security on or off (`NO FORCE` and `DISABLE` on the same tables and data). The mix is
  40 % the member's own slug, 20 % a slug shared with the member, 25 % a colliding
  slug, 15 % a miss.
- "Server time" is two things here, both reported: the time the client observes for
  one request (`BEGIN`, the `set_config` statement, the query and `COMMIT`, split into
  those phases), and the planning and execution time `EXPLAIN (ANALYZE)` reports for
  the query. The client-observed time includes the network hop and the Node client.
- Sequential phase: one connection, one request after the other. Load phase: requests
  offered at a fixed rate (open loop) over a pool of client connections, timed from
  their scheduled arrival, so a backlog shows in the latency.
- `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` for one request of each kind: whether the
  candidate scan is an `Index Only Scan` on `bookmarks_slug_idx`, whether the slug is
  part of its index condition, the rows its filter removed, the plan's estimated cost
  and any sequential scan. Over the EXPLAIN runs the execution time is reported with its
  JIT compilation time (`JIT.Timing.Total` of the plan, which "Execution Time" includes)
  and without it, and how many runs were compiled. PostgreSQL compiles a plan with JIT when its
  estimated cost exceeds `jit_above_cost`, and that compilation can dominate the request:
  read the JIT lines before attributing a slow plan to its scans. `--jit off`
  sets `jit = off` on the application role, so a run with and a run without separate the
  two; the `jit` the application role runs with is listed under the rig.
- The separate cost of the `set_config` statement: a transaction with no statement
  (`BEGIN` and `COMMIT` only), the statement alone inside an open transaction and the
  transaction with it, direct and pooled.
- A probe that row-level security applies to the role and pool measured: a request for
  the large workspace from another workspace's context sees no row with the policies on.

The script prints a summary and, with `--out <file>`, writes all numbers as JSON. A
result is valid for the instance it ran on only. Percentiles over several rounds are
reported as the median of the rounds' percentiles, with each round's own value listed.
