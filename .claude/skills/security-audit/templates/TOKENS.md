# Template tokens

What the orchestrating session fills each `{{…}}` token in the dispatch
templates (`reviewer-prompt.md`, `verifier-prompt.md`,
`triage-verifier-prompt.md`) with, and where the value comes from.

- **`{{IF X:}}…{{END IF}}`** — keep the block when `X` holds, otherwise drop it
  whole.
- **A token whose source is absent** drops its `{{IF}}` block. It is never
  filled with a guess or a placeholder.
- **A token with a description** (`{{FILE_LIST — …}}`) is replaced whole,
  description included, by the value it describes.

## Repo and run

| Token | Value |
|-------|-------|
| `PROJECT_NAME` | The repo name from `workflow.json` `repo` (the part after `/`), or the name `### Project` gives |
| `PROJECT_BLURB` | CLAUDE.md `### Project`, verbatim |
| `HAZARDS` | CLAUDE.md `### Hazards`, verbatim. Drop the block when it is absent |
| `GO_DOC` | The clone has a `go.mod` at its root |
| `RUN_ID` | The run id (step 1) |
| `BRANCH` | `branches.integration` |
| `SHA` | The full SHA the clone was made at (`RUN_SHA`) |
| `CLONE_PATH` | The read-only clone's absolute path (`$SNAP/src`) |
| `THREAT_MODEL` | `workflow.json` `threatModel` |
| `THREAT_MODEL_SECTIONS` | The threat model's text from its `## 1.` heading up to, not including, its `## 7.` heading, read from the clone, verbatim |
| `AREA_LABELS` | `labels.areas` names, comma-separated in backticks; `none` alone when the repo has none |
| `RISK_SCOPE` | `riskPaths` as a backticked list, plus "anything CLAUDE.md `### Risk review` names"; "nothing in this repo (always false)" when the repo has neither |
| `KNOWN_ITEMS_KIND` | "GitHub issues labelled `security`", or "Kaneo tasks about security" |
| `KNOWN_ITEMS` | Step 3's list of open security items, one `<ref> — <title>` per line, or `none` |
| `KNOWN_ADVISORIES` | Step 3's list of draft and triage advisories, one `<GHSA id> — <summary>` per line, or `none`. In triage, without the report being verified |

## Reviewer

| Token | Value |
|-------|-------|
| `UNIT_NAME` | The unit's name from `### Security units` (`auth`, `auth-2` for a split part, `sweep-exec`, `unassigned`) |
| `UNIT_ONE_LINE` | The unit's one-line description from the table |
| `UNIT_ATTACKERS` / `UNIT_INVARIANTS` | The table's attacker numbers / invariant ids for the unit |
| `SCOPED`, `SCOPE` | The run has a scope, and the scope items, comma-separated |
| `SWEEP`, `SWEEP_LOOKS_FOR` | The unit is a sweep, and its "looks for" text |
| `FILE_COUNT`, `FILE_LIST` | The unit's files after the coverage check and scope narrowing |

## Verifier

| Token | Value |
|-------|-------|
| `VERIFY_ID` | `v<n>` in dispatch order; a second verifier for the same candidate gets a new id |
| `UNIT_NAME` | The unit the candidates came from |
| `CANDIDATE_COUNT`, `CANDIDATES` | The batch, each candidate's YAML block verbatim under its id |

## Triage verifier

| Token | Value |
|-------|-------|
| `VERIFY_ID` | `t<n>` in dispatch order |
| `GHSA_ID` | The advisory being verified |
| `TOKEN` | A fresh random value per dispatch (`od -An -N8 -tx1 /dev/urandom \| tr -d ' \n'`), redrawn if the report text contains it |
| `REPORT_TEXT` | The advisory's summary, description, severity and CWE ids exactly as returned, verbatim |
