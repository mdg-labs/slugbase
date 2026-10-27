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
those forward), 40 % are tagged and 35 % filed in a folder. `packages/testing/src/seed/perf.ts` writes it. The seed takes the handle of a
database that the test harness created and nothing else, so it cannot be pointed at another database: it refuses any name other than
`test_` and 16 hex digits, a server that is not on this machine, a handle that is not connected to the database it names, and a database
that already has an account. It then runs `VACUUM (ANALYZE)` so that the planner knows the data.

## The scenarios

`scenarios.js` signs in once in `setup()` with the admin's password, which is made for the run and handed to the k6 container by name. The
scenarios run one after another so that a budget is measured without the load of the others, at a constant arrival rate (`--rate`, default 40
a second, for `--duration` seconds each):

- `go`: `GET /go/<slug>` for a slug of the admin, with one request in ten for a slug nobody has.
- `list`: `GET /api/v1/bookmarks` for each of the six sorts, the first page and a deep page (the 400th of 48).
- `search`: `GET /api/v1/search` for terms found in titles, slugs, tags and folders.

The thresholds are on `http_req_waiting`, k6's time to the first byte, which is the server time. Every list shape has a threshold of its own, so a
regression names the sort and the page. The server runs with its rate limits raised to the highest value, so that the run measures the server
and not its limiter; a token is still taken on every request. It runs with `NODE_ENV=development` because the harness's databases use the
development role passwords that production refuses.
