# Tracker: GitHub issues

The issues on `workflow.json` `repo` are the whole plan. Every call is a plain `gh` call (gh 2.104 or later) that names that repository: `-R <repo>` on a `gh issue`/`gh pr`/`gh run` command, `--repo <repo>` on `gh search`, a `repos/<repo>/…` path for `gh api`, where `<repo>` is `workflow.json` `repo`. Never let `gh` infer the repository from the working directory: in orchestrate's scratch clones `origin` is a local path, and the inferred repository is wrong or missing. `.claude/scripts/check-gh-repo.sh` fails the lint on a `gh` call that does not name its repository.

A list command returns 30 items unless told otherwise: pass `--limit 1000` to `gh issue list` and `gh pr list` whenever you need all of them, and `--paginate` to `gh api` on a list endpoint (`--paginate --slurp` and then `jq` for one array; `--slurp` cannot be combined with `--jq`).

`.claude/scripts/gh-helpers.sh` covers the few operations that need more than one call: a blocked-by edge with the dependent's status, a PR's checks with their output, review threads, code scanning alerts and security advisories. `gh-helpers.sh help` lists them.

## Labels

| Family | Values |
|--------|--------|
| Type (exactly one) | `feat`, `bug`, `chore`, `docs`, `spike` |
| Area (one or more) | `area:*` from `workflow.json` `labels.areas` |
| Status (exactly one, machine-managed) | `status:new`, `ready`, `blocked`, `in-progress`, `in-review`, `implemented`, `closed`, `cancelled` |
| Extras | `epic`, `security`, `regression`, `dependencies`, plus the repo's `labels.risk`, `labels.maintainerOnly` and `labels.extra` |

To create or update the whole set, run `.claude/scripts/bootstrap-labels.sh`.

## Resolve

```bash
gh issue view <n> -R <repo> --json number,title,body,labels,state,milestone,url
gh issue view <n> -R <repo> --comments
gh issue view <n> -R <repo> --json parent,subIssues,blockedBy,blocking   # parent is null when there is none
```

The ref is the issue number. A URL contributes only its number.

## Search

```bash
gh issue list -R <repo> --state all --limit 1000 --search "<terms>" --json number,title,state,labels
gh issue list -R <repo> --state open --limit 1000 --label <label> --json number,title,labels
```

`--search` is GitHub's issue search. Its index lags a few seconds behind a newly created issue, so to check whether something was just filed, list the issues and match the text yourself.

## Create

Write the body to a file first, then:

```bash
gh issue create -R <repo> --title "<title>" --body-file <f> --label feat --label area:api [--milestone "<title>"] [--parent <epic>]
gh issue edit <epic> -R <repo> --add-sub-issue <n>
.claude/scripts/gh-helpers.sh add-blocked-by <n> <dependency>
.claude/scripts/issue-status.sh <n> ready
```

`gh issue create` prints the new issue's URL; its number is the last path segment. Link a blocker only through `gh-helpers.sh add-blocked-by`, never with `gh`'s own `--blocked-by` or `--add-blocked-by`: the helper also sets the dependent's `status:blocked`, which nothing else does for a new edge (see below).

The `issue-status.yml` workflow sets `status:new` on a new issue and assigns the maintainer. When triage sets `ready` straight away, the workflow notices that and keeps `ready`. On a reopen it sets `status:new`, unless an agent has already set a status other than `closed` or `cancelled`. It only adds or removes the `status:*` labels that change, so a label someone adds while it runs survives.

`status:blocked` is set while an issue has a native blocked-by link to an issue that is open and not at `status:implemented` (an implemented blocker has landed on the integration branch, which executors branch from). Only an issue at `new` or `ready` is moved there; one at any other status is left alone. When the last blocker closes or reaches `implemented`, the issue goes back to `ready`, or to `new` when it has no `## Original report` section. `gh-helpers.sh add-blocked-by` applies this to the dependent right after adding the edge, since GitHub's docs do not list a dependency event an Actions workflow can use. The workflow also closes a milestone once nothing in it is open, and reopens it when an issue in it is reopened. An external blocker is tracked as its own issue, linked with a blocked-by edge; there is no `blocked` label.

## Edit

```bash
gh issue edit <n> -R <repo> [--title t] [--body-file f] [--milestone t] [--add-label l]... [--remove-label l]...
```

Never pass a `status:*` label to `gh issue edit`. Status goes only through `issue-status.sh`.

## Set status

```bash
.claude/scripts/issue-status.sh <n> <status>   # one PATCH; keeps every non-status label; retries
.claude/scripts/epic-status.sh <epic>          # recompute the epic from its sub-issues
```

Never read a status label back to confirm your own change; `issue-status.sh` already checks the PATCH response. The `issue-status.yml` workflow owns `closed` and `cancelled`.

## Comment

```bash
gh issue comment <n> -R <repo> --body-file <f>
```

## Forbidden

- Closing, reopening, deleting or transferring an issue by hand (`gh issue close`, `gh issue reopen`, `gh issue delete`, `gh issue transfer`), and merging a pull request (`gh pr merge`). Issues close only when their `Fixes #n` commit reaches the production branch; merging is the maintainer's.
- A `gh` call that does not name the repository (no `-R`/`--repo`, or a `gh api` path with `{owner}`/`{repo}`).
- Setting `status:closed`, `status:cancelled` or `status:new`.
- Applying a maintainer-applied label: `labels.maintainerOnly`, or a `labels.extra` entry with `maintainerApplied`. Only the maintainer applies it, because a CI gate or skill reads it as the maintainer's approval. The `guard-maintainer-labels.sh` hook refuses a `gh` command that adds one, but removing it is allowed. Propose the label to the maintainer instead.
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
| `{{POST_VERDICT}}` | `gh issue comment <n> -R <repo> --body-file <file>`, with `<repo>` spelled out |
| `{{SET_PASS}}` / `{{SET_FAIL}}` | `{{TOOLS}}/issue-status.sh <n> implemented` / `… in-progress` |
| `{{TRACKER_WRITES}}` | "Your only GitHub writes are the status scripts named below. Never edit, close or comment on an issue any other way." (verifier: "…the status scripts and the one verdict comment named below…") |
