# Performance budgets

The measurement of doc 08 section 5.3 and doc 01 section 9.3: against a database filled with the large instance, with PostgreSQL on
the same machine, `/go` has a p95 server time under 30 ms and the bookmark list and search under 100 ms. It is opt-in: it is not part of
`pnpm test:*` or `pnpm gate`, and an exceeded budget never fails a developer's gate. `.github/workflows/nightly.yml` runs it every week
and on a pull request to `main`, and opens an issue when a budget is exceeded. The older, narrower measurement of the `/go` query alone
under row-level security and transaction pooling is `packages/db/test/perf/` (`pnpm --filter @slugbase/db perf:go`).

## Run it

```sh
pnpm dev:services     # the development Postgres of compose.dev.yml, which the test harness builds its databases on
pnpm perf             # builds the server and the seed, then runs scripts/perf/run.mjs
node scripts/perf/run.mjs --bookmarks 5000 --workspaces 20 --duration 10   # a small instance, for trying the scripts
```

It needs `psql` and Docker. k6 runs from a pinned image (`K6_IMAGE` in `run.mjs`, by tag and digest) on the host network; nothing is installed
on the host. The run creates a database through the test harness, seeds it, starts `apps/slugbase/dist/main.js server` against it as
`slugbase_app` on a free port, and drops the database, stops the server and removes the k6 container when it ends or is interrupted.
`--out <dir>` keeps `k6-summary.json` and `result.json` there; without it they go to a new directory under the temporary directory.
The exit status is 0 when every budget holds, 10 when one is exceeded and 1 when the run itself failed.

## The instance

`packages/testing/src/seed/large.ts` builds it deterministically from a fixed seed: 50 000 bookmarks in one workspace of three members (the
instance admin owns eight in ten), 2 000 further workspaces with an owner and ten bookmarks each. About 12 % of the rows have a slug (85 % of
those forward), 40 % are tagged and 35 % filed in a folder. The two other members share forwarding bookmarks with the admin by every route (directly, through a folder of theirs and through a team of all three), so
their slugs, which come from the same words as the admin's, collide with the admin's own, and two slugs exist only as shared bookmarks: `perf-shared-one` (one member shares
it) and `perf-shared-many` (both do, and the admin has none). `packages/testing/src/seed/perf.ts` writes it. The seed takes the handle of a
database that the test harness created and nothing else, so it cannot be pointed at another database: it refuses any name other than
`test_` and 16 hex digits, a server that is neither on this machine (a loopback host) nor the host of the server the harness is
configured with (`SLUGBASE_TEST_PG_URL`, which CI reaches by its service name), a handle that is not connected to the database it names, and a database
that already has an account. It then runs `VACUUM (ANALYZE)` so that the planner knows the data.

## The scenarios

`scenarios.js` signs in once in `setup()` with the admin's password, which is made for the run and handed to the k6 container by name. The
scenarios run one after another so that a budget is measured without the load of the others, at a constant arrival rate (`--rate`, default 40
a second, for `--duration` seconds each):

- `go`: `GET /go/<slug>` for a slug of the admin (six in ten), for a slug the admin has and a member shares as well (the admin's own is followed), for the slug only one
  member shares (followed), for the slug several members share (the single-page app, status 200, which asks to choose), and for a slug nobody has (not found).
- `list`: `GET /api/v1/bookmarks` for each of the six sorts, the first page and a deep page (the 400th of 48).
- `search`: `GET /api/v1/search` for terms found in titles, slugs, tags and folders, and for the slugs of the shared bookmarks, which only the shares let the admin find. Each request is tagged with its
  term (`budgets.js` lists the seven of the seed, which `tooling/test/perf-budgets.test.ts` holds to `searchTerms` of `large.ts`) or with `shared` for those slugs, and the run reports the p95 of each, so a regression names the term.

The thresholds are on `http_req_waiting`, k6's time to the first byte, which is the server time. Every list shape and every search term has a threshold of its own, so a
regression names the sort and the page or the term. `budgets.js` holds the sorts, the pages, the terms and the limits once: `scenarios.js` makes the thresholds from it and
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
