# Known escapes

Defect patterns that passed a `task-verifier` PASS and were later confirmed
real in review (CodeRabbit on a promotion or unit PR). `task-executor` checks
its change against this list before committing; `task-verifier` checks each
commit against it under layers 6 and 7. `pr-review` appends a line whenever it
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
- **deny list by spelling** — a command deny list names one spelling of a forbidden form (`git add .`, `HEAD:main`) and misses an equivalent one (`git add ./`, a `+`-prefixed force refspec), so the forbidden command passes — PR 462
- **two clocks** — a freshness check compares an instant stamped by one host's clock (the database) with one read from another (the application) and allows no difference, so a session stamped a moment ago reads as in the future and is refused — PR 462
- **repeat erases the record** — a fail-closed lint records an object's prior state each time a statement names it, so a repeat that is valid SQL (a second `DROP … IF EXISTS`) overwrites the record with "unknown" and the later comparison and end-of-file check skip it — PR 506
- **new branch skips the gate** — a handler gates some branches of a state-changing request with a cross-site check (Fetch Metadata) and a newly added branch that also changes state (an OIDC start intent that accepts an invitation) is left out, so a hostile page can drive that branch — PR 520
- **one scheme for many** — a check for a script address (in a guard or a test's injection detector) matches `javascript:` only, so `vbscript:` and `data:` addresses pass — PR 577
- **floating image** — a rig meant for repeatable measurement pulls a floating tag (`latest`), so a re-run can measure a different build than the recorded baseline — PR 381

- **uniqueness by raw string** — a duplicate check compares raw strings that the consumer normalises (a router path with and without a trailing slash), so two entries the consumer treats as one pass and one shadows the other — PR 422

- **runtime floor** — code relies on a runtime API newer than the declared engine floor (`import.meta.main` under `engines` `>=24.0.0`), so a permitted runtime silently skips the code it guards — PR 409

## Design docs

- **cache key** — a cached value depends on a scope the key omits (an account-scoped value in a workspace-keyed cache) — PR 354
- **doc consistency** — one change states the same fact differently in two docs (when a field exists), ignoring the precedence order — PR 354, 558
- **external behaviour** — a doc or comment states a third-party system's behaviour more broadly than that system documents it (a database "waits for every older transaction" where it waits only for writers and older snapshots) — PR 365

- **comment vs check** — a comment summarising what a check rejects states the rule more broadly than the check enforces ("a secret" where the workflow token is allowed), so the next editor misreads the guard — PR 444
- **invariant vs feature** — a feature the spec settles (a credential returned once in an API response) contradicts the literal wording of a threat-model invariant, and the invariant is not amended with a narrow, named exception in the same change — PR 471
- **planned as current** — an operator-facing comment describes a setting's intended end state (a sign-in block) that a later item enforces, so an operator relies on a guard the build does not have yet — PR 491

## Processes

- **signal exit code** — a wrapper process maps every signal that ended its child to one fixed exit code (130), so a SIGTERM is reported as an interrupt instead of 128 plus its signal number — PR 422

## Database sessions and migrations

- **per-request resource** — a public, unthrottled endpoint opens a database connection per request whose work outlives the request's timeout, so concurrent requests exhaust the database's connections — PR 397

- **timeout scope** — a session-wide timeout meant for one kind of wait also covers a statement whose normal work is that wait (`lock_timeout` on `CREATE INDEX CONCURRENTLY`), so a routine wait fails and leaves a half-state no re-run recovers from — PR 365
- **lock wait snapshot** — waiting for a lock inside a statement holds a snapshot that the lock holder's own work waits for, so the two deadlock — PR 365
- **non-atomic group** — several durable steps share one unit that is recorded only when all succeed, so a part-failure leaves finished steps that make every retry fail — PR 365
- **cleanup replaces the error** — a cleanup step in a catch block (a ROLLBACK on a new connection) can itself reject, so its error replaces the one the caller rethrows or skips the recovery check that follows — PR 491
- **lock order** — two functions lock the same pair of rows in opposite orders (a child row through an `UPDATE`, then its parent `FOR UPDATE`, against parent first, then a `DELETE` of its children), so concurrent calls for one parent deadlock and one aborts — PR 494
- **race settled in one shape only** — a re-read after racing writes reconciles the case where both writers' values are present but not the case where the racer replaced ours, so the racer's value stands and the log reports ours as applied — PR 500
- **policies disagree on visibility** — a write that one table's RLS policy still admits reads a related row through another table's policy that already hides it (a workspace being deleted), so the result carries NULL where its type promises a value and the job using it fails on every retry — PR 514

## Optional capabilities

- **renewal assumes delivery** — a write path replaces a credential on the assumption that an optional capability (mail) delivers the new one, so where the capability is off it ends the only working credential (a copied link) and delivers nothing, while a sibling path refuses the same case — PR 514

## Client state

- **refreshed only on refusal** — a client cache of a server-decided grant (the entitlements behind a UI gate) never goes stale and is refreshed only when the client itself is refused, so a grant made elsewhere (another tab, an upgrade) leaves the gate closed until a reload — PR 541

## Input handling

- **quadratic regex** — a regular expression with an end-anchored repetition (a trim's `[\s]+$` branch) runs on input whose length the function itself does not bound, relying on a caller's cap, so a long run of the repeated character followed by another one takes quadratic time — PR 558

## Shared helpers

- **copy drops side duties** — a second copy of a shared routine (a rate-limit take) keeps its answers but leaves out the original's side duties (the rejection metric, the error report), so the copy's refusals and failures never reach monitoring — PR 520

## Tests

- **vacuous wait** — a test waits for a later event (a late answer, a timer) but asserts nothing after it, so it passes whatever that event does — PR 397
- **stale fixture** — a test reads a draft copy of a shipped artifact (a migration) instead of the file that ships, so it checks content that never runs — PR 409
- **stale workaround** — a test keeps a workaround for a harness gap the same change closes, with a comment that is no longer true and a tool requirement no other test has — PR 409
- **start-time race** — a test takes a background trigger out of play (a cron schedule) only after starting the component that fires it, so a fire in the window before the removal (the start's own first pass, a row an earlier test left) breaks the test — PR 457
- **leaked starting state** — a test asserts a starting state that persisted browser state (saved localStorage) or a late emulation decides, instead of setting it before the page loads — PR 457
- **ignored declaration key** — a test fixture declares a field under a key the consuming type does not read (a top-level `body` where the stage reads `request.body`), the extra key compiles, and the declared check never runs — PR 479
- **URL by prefix** — a check that a URL points at an expected host tests a string prefix (`startsWith(issuer)`) instead of the parsed origin, so a look-alike host (`https://idp.example.test.evil/`) passes — PR 484
- **race window at the wrong point** — a concurrency test widens the race with a pause before the read it needs to overlap rather than between that read and the commit, so the overlap lasts only as long as one commit and the test flakes on a slow runner — PR 506
- **lookup of a fresh key** — a negative assertion ("nothing resolves any more") looks up a freshly generated key (a new token hash) that was never stored, instead of the keys the fixture seeded, so it passes whatever the code under test does — PR 510
- **wait on a promise that may never settle** — a test helper awaits a completion promise of every object of a kind (an animation's `finished`) without filtering out the states in which it never settles on its own (paused, idle), so one such object blocks the helper until the test times out — PR 524
- **unescaped literal in a pattern** — a test builds a `RegExp` from a literal value (an origin, a hostname) without escaping it, so each `.` matches any character and the assertion accepts look-alike values — PR 529

## Web UI

- **degraded capability not gated** — a screen offers a flow whose server side silently does nothing when an optional capability is off (mail), instead of reading the feature flag the API publishes for it, so the user waits for a result that never comes — PR 500
- **possessive in a shared string** — one catalog string serves two flows (acting on another member, and on oneself) but carries a third-person possessive ("their"), so the self flow addresses the viewer as someone else — PR 510
- **data loaded for every viewer** — a component loads a whole paged list (walking every page) for every role, although it reads the result only for one role, so other viewers make every request for nothing — PR 510
- **sibling page skips the shared reaction** — one page of a group omits a hook its siblings all call on a failed request (re-reading the account after a 403), so on that page alone a lost permission shows a retry that keeps failing instead of the access page — PR 532
- **word-for-word state label** — a short toggle label ("Forwarding on") is translated word for word, and in the target language the particle reads as a direction ("Weiterleitung an", forwarding to …) rather than a state; a label naming a state uses that language's state adjective — PR 569
