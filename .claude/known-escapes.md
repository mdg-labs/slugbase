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

## Design docs

- **cache key** — a cached value depends on a scope the key omits (an account-scoped value in a workspace-keyed cache) — PR 354
- **doc consistency** — one change states the same fact differently in two docs (when a field exists), ignoring the precedence order — PR 354
