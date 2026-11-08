# Performance budgets

The measurement of doc 08 section 5.3 and doc 01 section 9.3: against a database filled with the large instance, with PostgreSQL on
the same machine, `/go` has a p95 server time under 30 ms and the bookmark list and search under 100 ms. It is opt-in: it is not part of
`pnpm test:*` or `pnpm gate`, and an exceeded budget never fails a developer's gate. `.github/workflows/nightly.yml` runs it every week
and on a pull request to `main`, against the CE image built from the commit under test, and files an issue when a budget is exceeded or `/go` writes more than the usage buffer allows (see "What is filed"). The last phase of the run imports the largest files while `/go` and the list are requested, and has `/go` and list budgets of its own (see "The import phase"). The older, narrower measurement of the `/go` query alone
under row-level security and transaction pooling is `packages/db/test/perf/` (`pnpm --filter @slugbase/db perf:go`).

## Run it

```sh
pnpm dev:services     # the development Postgres of compose.dev.yml, which the test harness builds its databases on
pnpm perf             # builds the server and the seed, then runs scripts/perf/run.mjs against the built server
node scripts/perf/run.mjs --bookmarks 5000 --workspaces 20 --duration 10   # a small instance, for trying the scripts
node scripts/perf/run.mjs --import-window 90   # the seconds of /go and list load the two imports have to end in (default 60)

docker build -f apps/slugbase/Dockerfile --build-arg BUILD_COMMIT="$(git rev-parse HEAD)" -t slugbase:perf .
pnpm turbo run build --filter=@slugbase/testing
node scripts/perf/run.mjs --image slugbase:perf   # the server is the image, as in nightly.yml
```

It needs `psql` and Docker. k6 runs from a pinned image (`K6_IMAGE` in `run.mjs`, by tag and digest) on the host network; nothing is installed
on the host. The run creates a database through the test harness, seeds it, starts the server against it as `slugbase_app` on a free port, and drops the database,
stops the server and removes the k6 containers when it ends or is interrupted. Without `--image` the server is `apps/slugbase/dist/main.js server`. With
`--image <ref>` it is that image run with `server` (`docker run --network host`, the same environment, `MIGRATE_ON_START=false` and `DATABASE_URL` as `slugbase_app`), which
is stopped, so that it flushes the usage buffer, and removed with the rest; `nightly.yml` builds the image from the commit under test and never pulls one. The variables go to
`docker run` by name, so no value is in its arguments.
`--out <dir>` keeps `k6-summary.json` and `result.json` there; without it they go to a new directory under the temporary directory.
Before the server starts, the run applies `migrate` (the same command the image runs before every start) to the database, because the harness's database has the schema and not the pg-boss queues that a create and an import enqueue their events to; as the harness's own role for the database, with the connection string handed to the command by name.
`--commit <sha>` names the commit measured (a full hash); without it `result.json` records the `HEAD` of the checkout, or `null` outside one. `nightly.yml` passes the head of a pull request, otherwise `github.sha`.
The exit status is 0 when every budget holds and the write load is within its limit, 10 when one is exceeded and 1 when the run itself failed.

## The instance

`packages/testing/src/seed/large.ts` builds it deterministically from a fixed seed: 50 000 bookmarks in one workspace of three members (the
instance admin owns eight in ten), 2 000 further workspaces with an owner and ten bookmarks each. About 12 % of the rows have a slug (85 % of
those forward), 40 % are tagged and 35 % filed in a folder. The two other members share forwarding bookmarks with the admin by every route (directly, through a folder of theirs and through a team of all three), so
their slugs, which come from the same words as the admin's, collide with the admin's own, and two slugs exist only as shared bookmarks: `perf-shared-one` (one member shares
it) and `perf-shared-many` (both do, and the admin has none). One bookmark in fifty of the large workspace is plan-archived (`plan_archived_at` set, doc 05 section 2.2) and is
left out of `bookmark_count`, of every slug list and of the shares; `archivedSlugs` of `fixtures.json` names up to 20 of the admin's own archived slugs that would forward but for the archive. `packages/testing/src/seed/perf.ts` writes it. The seed takes the handle of a
database that the test harness created and nothing else, so it cannot be pointed at another database: it refuses any name other than
`test_` and 16 hex digits, a server that is neither on this machine (a loopback host) nor the host of the server the harness is
configured with (`SLUGBASE_TEST_PG_URL`, which CI reaches by its service name), a handle that is not connected to the database it names, and a database
that already has an account. It then runs `VACUUM (ANALYZE)` so that the planner knows the data.

## The scenarios

`scenarios.js` signs in once in `setup()` with the admin's password, which is made for the run and handed to the k6 container by name. The
scenarios run one after another so that a budget is measured without the load of the others, at a constant arrival rate (`--rate`, default 40
a second, for `--duration` seconds each):

- `go`: `GET /go/<slug>` for a slug of the admin (six in ten), for a slug the admin has and a member shares as well (the admin's own is followed), for the slug only one
  member shares (followed), for the slug several members share (the single-page app, status 200, which asks to choose), for a slug nobody has (not found) and for the slug of one of the admin's
  plan-archived bookmarks (`archivedSlugs` of `fixtures.json`; not found as well).
- `list`: `GET /api/v1/bookmarks` for each of the six sorts, the first page and a deep page (the 400th of 48).
- `list_q`: `GET /api/v1/bookmarks?q=<term>` for the seven terms of the seed, the first page and a deep page (the 20th of 48, or the last page a term has when it matches fewer; a cursor is valid only
  for the text it was issued for, so `setup()` follows each term's pages on its own).
- `list_filter`: `GET /api/v1/bookmarks?tag=<id>` and `?folderId=<id>` for the admin's own tags and folders (`tagIds` and `folderIds` of `fixtures.json`), the first page.
- `search`: `GET /api/v1/search` for terms found in titles, slugs, tags and folders, and for the slugs of the shared bookmarks, which only the shares let the admin find. Each request is tagged with its
  term (`budgets.js` lists the seven of the seed, which `tooling/test/perf-budgets.test.ts` holds to `searchTerms` of `large.ts`) or with `shared` for those slugs, and the run reports the p95 of each, so a regression names the term.

A second set of scenarios, `go-hot`, runs first, in a k6 run of its own (`SCENARIO_SET=go-hot`): 10 000 `GET /go/<slug>` for one forwarding slug of the admin, 20 at a time. `/go` counts an open in the server's memory and writes the counts once
every 10 s (doc 01 section 8.1), so the one bookmark may be updated once for each interval that began during the requests and once more for the flush that follows them (`writeLoadLimit` in `budgets.js`).
`run.mjs` reads `pg_stat_user_tables.n_tup_upd` of `bookmarks` as the server's user of the harness before the requests and after them (waiting 15 s for the last flush and the statistics to arrive), and puts the
requests, the updates, the time and the limit in `result.json` (`writeLoad`) and the job summary. More updates than the limit are reported like an exceeded budget (exit status 10); a reading that fails, or no update at all
after 10 000 requests, is a failed run (status 1), never a zero. It runs before the budgets so that the flush of the `go` scenario's many slugs does not fall in its window.

## The import phase

The import phase (doc 02 section 13.1, doc 08 section 5.3) is the `import` set of `scenarios.js`, a k6 run of its own that comes last, after the budgets, so that the 10 000 bookmarks it adds change none of their measurements. An import is synchronous, one transaction in batches of at most 5 000 bookmarks and 5 MiB, under the workspace row lock, and it queues no metadata job, so
there is no job whose queue could be measured: the phase measures what the import costs the requests beside it.

- The files come from `packages/testing/src/seed/import-files.ts` (unit test `packages/testing/test/import-files.test.ts`): a Netscape file of 5 000 links in 40 folders, tagged, of 5 MiB less 1 KiB, and a SlugBase JSON file of 5 000 bookmarks with folders, tags and slugs. Every address is its own, so nothing is skipped or refused. Some slugs of the JSON file are ones the importer already has or the file repeats or that are
  outside the grammar, so that the import drops them. `tooling/test/perf-budgets.test.ts` holds the two caps to those of `@slugbase/contracts`.
- `scenarios.js` signs in as `perf-member-1` (the importer), `perf-member-2` (the member that creates) and the admin in `setup()`. After `--duration` seconds of creates by `perf-member-2` with no import (5 a second, the baseline), `perf-member-1` imports the Netscape file and then the JSON file, each with an `Idempotency-Key` of its own, while the admin's `/go` (the `go` mix) and list traffic goes on at `--rate`.
  The rate limits of the `bulk` bucket (20 imports an hour) and of the `write` bucket are raised through `RATE_LIMIT_BULK_*` and `RATE_LIMIT_WRITE_*` like the others; every request still takes a token.
- k6 VUs cannot share a variable, so `run.mjs` holds the state of the import (`before`, `importing`, `between`, `after`, `failed`) at a loopback address that lives as long as the run: the importer sets it, and the other scenarios read it at every arrival and make, and tag, their request by it. So `/go` and the list are requested only while an import is in flight, and the creates are
  tagged `without` (before the first import) or `during` (while one is in flight); a request that arrives between the imports or after them is not made.
- Budgets: `go during import` under 30 ms and `list during import` under 100 ms (p95 of the server time of the requests made while an import is in flight), like the others in `budgets.js`; crossing one is an exceeded budget (exit status 10). Both are filed under the `import` issue, not `go` or `list`: the cause is the import and its load, and `go` and `list` hold with no import (see "What is filed").
- Reported without a threshold (`importPhase` of `result.json`, the job summary and the log): each import's size, duration (the time to the answer), created, skipped and failed counts, slugs dropped (taken by the importer or the file, and outside the grammar), and folders and tags created, all from the response; and the p95 of `POST /api/v1/bookmarks` by `perf-member-2` without an import and while an import holds the
  workspace row lock, with the number of requests of each and the arrivals k6 dropped (a create that was not measured).
- Fail closed: an import that is not answered 200, is replayed from an earlier answer, is not over within `--import-window` seconds of the load, creates fewer than the bookmarks of its file or skips or refuses any, or a JSON file that drops no slug, ends the run as failed (status 1), never a time. So does a scenario that made no request (a `/go` or list request during an import included, which k6 would otherwise report as a p95 of 0), a phase without a create, or a missing p95.

The thresholds are on `http_req_waiting`, k6's time to the first byte, which is the server time. Every list shape and every search term has a threshold of its own (`list q first`, `list q deep`, `list filter tag`, `list filter folder`, each sort on each page, each term), so a
regression names the shape and the page, the sort or the term. `budgets.js` holds the sorts, the pages, the terms and the limits once: `scenarios.js` makes the thresholds from it and
`run.mjs` reports every one of them, so a threshold that is crossed is always an exceeded budget (exit status 10); only a failed `checks`
threshold, a response that was not what a scenario asked for, ends the run as failed. The server runs with its rate limits raised to the highest value, so that the run measures the server
and not its limiter; a token is still taken on every request. It runs with `NODE_ENV=development` because the harness's databases use the
development role passwords that production refuses.

## Reading a saturated run

The scenarios are open-loop: k6 starts `--rate` requests a second whether or not the server has answered the last ones. A server that serves fewer than that a second makes the rest wait, in k6's connection queue
and in the server's, and `http_req_waiting` counts the wait: the p95 of such a scenario grows with its length and is the queue, not the time of a statement. So the run reports the load of each scenario beside its budgets, in `result.json` (`scenarios`), the job summary and the issue body of `nightly.yml`:

- `completed`: the requests that were answered (`http_reqs` of the scenario);
- `dropped`: the arrivals k6 dropped (`dropped_iterations`) because all `maxVUs` VUs were busy; k6 leaves the metric out when it dropped none, which reads as 0;
- `peakVus`: the most VUs active at the start of an iteration, of `maxVus` (100).

A scenario is `saturated` when it dropped an arrival or used all its VUs, and every budget row of it is then marked saturated. Read the budget of a saturated scenario as "the server did not keep up with this rate", not as the cost
of one request: take the per-term (or per-sort) p95 from a run at a rate where nothing queues (`--rate 5`), and find the highest rate with no dropped arrival by raising `--rate`. These are not thresholds: they put the load in the summary and
no value fails them, so they cannot end k6 with 99.

## What is filed

`report.mjs` decides what `nightly.yml` files when a run exits with status 10, and the job only executes its actions. It reads `result.json` and the open issues (`gh issue list --state open --json number,title`) and prints
the actions as JSON: `create` with a title, or `comment` on an issue number, each with its body. Nothing in it calls GitHub, so
`node scripts/perf/report.mjs --result <result.json> --issues <issues.json> --run-url <https address>` is a dry run (add `--body-dir <dir>` to write the bodies to files, as the job does, and `--expect-action` to fail when nothing is exceeded).

Each exceeded budget is filed under one issue, titled exactly `Performance budget exceeded: <name>`:

| Issue | What it holds |
|---|---|
| `go` | the `go` budget |
| `list` | the `list` budget and its sorts and pages, and the list narrowed by a text (`list q first`, `list q deep`) and under a filter (`list filter tag`, `list filter folder`): they are all the bookmark list |
| `search` | the `search` budget and each of its terms |
| `import` | the `go during import` and `list during import` budgets: `/go` and the list while an import is in flight (see "The import phase") |
| `write load` | the write-load check of `/go` (`writeLoad` in `result.json`), which is a count of updates and no p95, so it has an issue of its own and not a place under `go` |

A run that exceeds a budget whose issue is open comments on the issue with exactly that title (the lowest number when it is on several); otherwise it creates the issue, labelled `area:ci`. It never creates a second open issue for a name and never comments on another name's:
an issue that names several scenarios (the one the job opened before it knew the scenarios, `go, search`) is not extended. The body lists every exceeded shape with its p95, its limit and its saturation flag, the load of the scenarios of the issue, the commit, the dataset and the link to the run.
A result that cannot be read, a budget of a scenario with no issue, a list of issues that is not one and a `gh` call that failed all fail the step, and every action is tried before it does, so one issue that cannot be filed does not hide the others.
`tooling/test/perf-report.test.ts` holds this.
