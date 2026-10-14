# Known escapes

Defect patterns that passed a `task-verifier` PASS and were later confirmed
real in review (CodeRabbit on a promotion or unit PR). `task-executor` checks
its change against this list before committing; `task-verifier` checks each
commit against it under layers 6 and 7. `cr-review` appends a line whenever it
fixes a confirmed finding whose pattern is not here yet.

One line per pattern: **category** — what goes wrong — where it was seen.
Keep it to patterns, not individual bugs; merge a new instance into an
existing line by adding its PR number.

## Guards and checks

- **regex guard** — a pattern keeps false positives out with length caps instead of anchoring, so a long but realistic input carrying the term passes — PR 354
- **regex guard** — sibling patterns for one thing disagree on an optional detail (one allows a space, the next does not), so the variant slips through — PR 354
- **AST guard** — a lint rule inspects only one syntax form of a value (a string `Literal`) and misses an equivalent form (a static template literal), so the banned construct passes (calls of a function matched, but an alias or a value handed on missed) — PR 365, 397
- **regex guard** — an HTML-matching pattern in a check is case-sensitive or excludes characters a real tag body can hold, so the tag it guards against escapes the match — PR 397
- **safe by keyword** — a fail-closed lint marks a statement family safe from its leading keywords without reading the rest, or its safe list holds a form the design doc places in a later phase, so unsafe members of the family pass — PR 381
- **replace read as create** — a fail-closed lint reads a `CREATE OR REPLACE` form like the plain `CREATE` and drops the flag and the object's identity, so a statement that replaces an existing object of another shape (in effect a drop the lint rejects when written out) passes — PR 456
- **label-gated check** — a CI step reads a pull request's labels, but the workflow trigger omits the `labeled`/`unlabeled` events, so adding or removing the label never re-runs it — PR 381
- **regex guard** — a line-based check of a structured file (YAML) matches a key only in its block form, or judges a line as a whole, so the same key in flow or quoted form, or a bad value beside a good one on the line, passes — PR 444
- **floating image** — a rig meant for repeatable measurement pulls a floating tag (`latest`), so a re-run can measure a different build than the recorded baseline — PR 381

- **uniqueness by raw string** — a duplicate check compares raw strings that the consumer normalises (a router path with and without a trailing slash), so two entries the consumer treats as one pass and one shadows the other — PR 422

- **runtime floor** — code relies on a runtime API newer than the declared engine floor (`import.meta.main` under `engines` `>=24.0.0`), so a permitted runtime silently skips the code it guards — PR 409

## Design docs

- **cache key** — a cached value depends on a scope the key omits (an account-scoped value in a workspace-keyed cache) — PR 354
- **doc consistency** — one change states the same fact differently in two docs (when a field exists), ignoring the precedence order — PR 354
- **external behaviour** — a doc or comment states a third-party system's behaviour more broadly than that system documents it (a database "waits for every older transaction" where it waits only for writers and older snapshots) — PR 365

- **comment vs check** — a comment summarising what a check rejects states the rule more broadly than the check enforces ("a secret" where the workflow token is allowed), so the next editor misreads the guard — PR 444

## Processes

- **signal exit code** — a wrapper process maps every signal that ended its child to one fixed exit code (130), so a SIGTERM is reported as an interrupt instead of 128 plus its signal number — PR 422

## Database sessions and migrations

- **per-request resource** — a public, unthrottled endpoint opens a database connection per request whose work outlives the request's timeout, so concurrent requests exhaust the database's connections — PR 397

- **timeout scope** — a session-wide timeout meant for one kind of wait also covers a statement whose normal work is that wait (`lock_timeout` on `CREATE INDEX CONCURRENTLY`), so a routine wait fails and leaves a half-state no re-run recovers from — PR 365
- **lock wait snapshot** — waiting for a lock inside a statement holds a snapshot that the lock holder's own work waits for, so the two deadlock — PR 365
- **non-atomic group** — several durable steps share one unit that is recorded only when all succeed, so a part-failure leaves finished steps that make every retry fail — PR 365

## Tests

- **vacuous wait** — a test waits for a later event (a late answer, a timer) but asserts nothing after it, so it passes whatever that event does — PR 397
- **stale fixture** — a test reads a draft copy of a shipped artifact (a migration) instead of the file that ships, so it checks content that never runs — PR 409
- **stale workaround** — a test keeps a workaround for a harness gap the same change closes, with a comment that is no longer true and a tool requirement no other test has — PR 409
- **start-time race** — a test takes a background trigger out of play (a cron schedule) only after starting the component that fires it, so a fire in the window before the removal (the start's own first pass, a row an earlier test left) breaks the test — PR 457
- **leaked starting state** — a test asserts a starting state that persisted browser state (saved localStorage) or a late emulation decides, instead of setting it before the page loads — PR 457
