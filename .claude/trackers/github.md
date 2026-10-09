# Tracker: GitHub issues

The issues on `workflow.json` `repo` are the whole plan. Every call goes through `.claude/scripts/gh-rest.sh`. It uses repository-scoped REST and pages results itself. That is because a Claude Code cloud session's egress proxy refuses three things outright:

- GraphQL, which is how `gh issue …`, `gh pr …`, `gh repo view`, `gh label list` and `gh release list` work underneath
- `search/issues`
- the `repositories/{id}` links that `--paginate` follows

`.claude/scripts/check-gh-rest.sh` fails the lint if any of those patterns comes back. `gh-rest.sh help` lists every subcommand.

## Labels

| Family | Values |
|--------|--------|
| Type (exactly one) | `feat`, `bug`, `chore`, `docs`, `spike` |
| Area (one or more) | `area:*` from `workflow.json` `labels.areas` |
| Status (exactly one, machine-managed) | `status:new`, `ready`, `in-progress`, `in-review`, `implemented`, `closed`, `cancelled` |
| Extras | `epic`, `blocked`, `security`, `regression`, `dependencies`, plus the repo's `labels.risk`, `labels.maintainerOnly` and `labels.extra` |

To create or update the whole set, run `.claude/scripts/bootstrap-labels.sh`.

## Resolve

```bash
.claude/scripts/gh-rest.sh issue-view <n>        # title, body, labels, state
.claude/scripts/gh-rest.sh issue-comments <n>
.claude/scripts/gh-rest.sh parent <n>            # prints nothing when there is no parent
.claude/scripts/gh-rest.sh sub-issues <n>
.claude/scripts/gh-rest.sh blocked-by <n>
```

The ref is the issue number. A URL contributes only its number.

## Search

```bash
.claude/scripts/gh-rest.sh issue-search "<terms>" --state all
.claude/scripts/gh-rest.sh issue-list --label <label> --state open
```

`issue-search` lists every issue and matches all the terms against title and body. It is not GitHub's relevance search.

## Create

Write the body to a file first, then:

```bash
.claude/scripts/gh-rest.sh issue-create --title "<title>" --body-file <f> --label feat --label area:api [--milestone "<title>"]
.claude/scripts/gh-rest.sh add-sub-issue <epic> <n>
.claude/scripts/gh-rest.sh add-blocked-by <n> <dependency>
.claude/scripts/issue-status.sh <n> ready
```

The `issue-status.yml` workflow sets `status:new` on a new issue and assigns the maintainer. When triage sets `ready` straight away, the workflow notices that and keeps `ready`.

## Edit

```bash
.claude/scripts/gh-rest.sh issue-edit <n> [--title t] [--body-file f] [--add-label l]... [--remove-label l]...
```

Never pass a `status:*` label to `issue-edit`. Status goes only through `issue-status.sh`.

## Set status

```bash
.claude/scripts/issue-status.sh <n> <status>   # one PATCH; keeps every non-status label; retries
.claude/scripts/epic-status.sh <epic>          # recompute the epic from its sub-issues
```

Never read a status label back to confirm your own change; `issue-status.sh` already checks the PATCH response. The `issue-status.yml` workflow owns `closed` and `cancelled`.

## Comment

```bash
.claude/scripts/gh-rest.sh issue-comment <n> --body-file <f>
```

## Forbidden

- Closing or reopening an issue by hand. Issues close only when their `Fixes #n` commit reaches the production branch.
- Any GraphQL-backed `gh` subcommand, `gh api graphql`, `gh search`, `search/` paths, or `--paginate`.
- Setting `status:closed`, `status:cancelled` or `status:new`.
- Writing dependencies or epic membership as body prose instead of native links.

## In dispatch prompts

The orchestrate templates are tracker-neutral. The orchestrator fills these tokens for each item, with `{{TOOLS}}` set to the `.claude/scripts` directory the agent may run (`<workspace>/.claude/scripts`, or the real repo's for a cross-repo landing):

| Token | GitHub fill |
|-------|-------------|
| `{{ITEM_REF}}` | `#<n>` |
| `{{TRAILER_REF}}` | `#<n>`, or `<repo>#<n>` for a cross-repo landing |
| `{{CLAIM}}` | `{{TOOLS}}/issue-status.sh <n> in-progress` |
| `{{ROLLUP}}` | `{{TOOLS}}/epic-status.sh <epic>`. Omitted when the item has no epic. |
| `{{HAND_OFF}}` | `{{TOOLS}}/issue-status.sh <n> in-review` |
| `{{POST_VERDICT}}` | `{{TOOLS}}/gh-rest.sh issue-comment <n> --body-file <file>` |
| `{{SET_PASS}}` / `{{SET_FAIL}}` | `{{TOOLS}}/issue-status.sh <n> implemented` / `… in-progress` |
| `{{TRACKER_WRITES}}` | "Your only GitHub writes are the status scripts named below. Never edit, close or comment on an issue any other way." (verifier: "…the status scripts and the one verdict comment named below…") |
