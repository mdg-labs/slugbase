#!/usr/bin/env bash
# The few GitHub operations that need more than one plain `gh` call: a
# blocked-by edge with the dependent's status, a PR's checks with their
# output, its review threads (GraphQL), code scanning alerts, and repository
# security advisories. Everything else is a plain
# `gh` call in the skill that needs it, always with the repository named
# (`-R <repo>`, or a `repos/<repo>/…` path for `gh api`); check-gh-repo.sh
# enforces that.
#
# Every call here is scoped to workflow.json's `repo`, never to what `gh`
# infers from the working directory: orchestrate's agents run from scratch
# clones whose `origin` is a local path. Each subcommand builds its argv with
# `-f`/`-F` (never `sh -c`, never a string-built JSON body).
#
# Usage: gh-helpers.sh <subcommand> [args...]
set -euo pipefail

HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=workflow-config.sh
source "$HERE/workflow-config.sh"
REPO=$(wf_repo)

die() { printf 'gh-helpers: %s\n' "$*" >&2; exit 1; }

# Every page of a GET list endpoint (a path rooted at "repos/$REPO/...") as
# one JSON array. `--paginate` follows the response's `Link` header, which
# works for page-numbered and cursor-paged endpoints alike.
gh_list() {
  local out
  out=$(gh api --paginate --slurp "$1") || return 1
  jq -c 'add // []' <<<"$out"
}

# Prints $1 (a JSON value) as-is, or filtered through $2 (a --jq-style
# filter) when non-empty — the same shape `gh ... --jq` callers are used to.
print_json() {
  local out=$1 jqf=$2
  if [[ -n $jqf ]]; then
    jq -cr "$jqf" <<<"$out"
  else
    printf '%s\n' "$out"
  fi
}

# Consumes a trailing "--jq <filter>" from the remaining args into $JQF.
# Dies on anything else so a typo'd flag doesn't silently do nothing.
JQF=""
parse_optional_jq() {
  JQF=""
  while [[ $# -gt 0 ]]; do
    case $1 in
      --jq) JQF=$2; shift 2 ;;
      *) die "unrecognized argument: $1" ;;
    esac
  done
}


# --- relationships -------------------------------------------------------

# Links #$1 as blocked by #$2, then puts #$1 at status:blocked when it has an
# open blocker that is not at status:implemented, as the issue-status
# workflow does for every other trigger. It is done here because GitHub's
# docs do not list the issue_dependencies event as a trigger an Actions
# workflow can use, so nothing else would notice a new edge until the next
# open, close or label event. Only an open issue at status:new or
# status:ready is moved; anything else (an executor may own it) is left
# alone. The edge already exists by then, so a failure there warns instead
# of failing the command.
cmd_add_blocked_by() {
  [[ $# -eq 2 && $1 =~ ^[0-9]+$ && $2 =~ ^[0-9]+$ ]] || die "usage: add-blocked-by <n> <dep>"
  local n=$1 dep=$2
  gh issue edit "$n" -R "$REPO" --add-blocked-by "$dep" >/dev/null \
    || die "add-blocked-by: could not link #$n blocked-by #$dep"
  block_if_needed "$n"
}

block_if_needed() {
  local n=$1 issue blockers
  if ! issue=$(gh api "repos/$REPO/issues/$n" --jq '{open: (.state == "open"), status: [.labels[].name | select(startswith("status:"))]}') \
    || ! blockers=$(gh_list "repos/$REPO/issues/$n/dependencies/blocked_by?per_page=100" \
      | jq '[.[] | select(.state == "open" and (([.labels[]?.name] | index("status:implemented")) == null))] | length'); then
    printf 'gh-helpers: linked #%s, but could not check whether it is now blocked\n' "$n" >&2
    return 0
  fi
  if jq -e --argjson b "$blockers" '.open and $b > 0 and (.status == ["status:new"] or .status == ["status:ready"])' <<<"$issue" >/dev/null; then
    "$HERE/issue-status.sh" "$n" blocked >/dev/null \
      || printf 'gh-helpers: linked #%s, but could not set it to status:blocked\n' "$n" >&2
  fi
}

# --- pull requests -------------------------------------------------------

# A PR's review threads, from GraphQL (REST has no resolved state): one
# {id, resolved, outdated, path, line, commentId, author} per thread, where
# commentId is the REST id of the thread's first comment (what pr-reply
# takes) and author its login. Paged with the connection's cursor.
cmd_pr_threads() {
  [[ $# -ge 1 && $1 =~ ^[0-9]+$ ]] || die "usage: pr-threads <pr> [--jq f]"
  local n=$1; shift
  parse_optional_jq "$@"
  # $owner, $name, $n and $after are GraphQL variables, sent as -f/-F.
  # shellcheck disable=SC2016
  local query='query($owner: String!, $name: String!, $n: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $n) {
      reviewThreads(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id isResolved isOutdated path line
          comments(first: 1) { nodes { databaseId author { login } } }
        }
      }
    }
  }
}'
  local owner=${REPO%%/*} name=${REPO#*/} after="" page out pages_file
  pages_file=$(mktemp)
  while :; do
    local args=(graphql -f "query=$query" -f "owner=$owner" -f "name=$name" -F "n=$n")
    [[ -n $after ]] && args+=(-f "after=$after")
    if ! page=$(gh api "${args[@]}"); then
      rm -f "$pages_file"
      die "pr-threads: could not read the review threads of PR #$n"
    fi
    jq -e '.data.repository.pullRequest.reviewThreads' <<<"$page" >/dev/null \
      || { rm -f "$pages_file"; die "pr-threads: PR #$n not found"; }
    jq -c '[.data.repository.pullRequest.reviewThreads.nodes[] | {
        id, resolved: .isResolved, outdated: .isOutdated, path, line,
        commentId: .comments.nodes[0].databaseId, author: .comments.nodes[0].author.login }]' \
      <<<"$page" >>"$pages_file"
    [[ $(jq -r '.data.repository.pullRequest.reviewThreads.pageInfo.hasNextPage' <<<"$page") == true ]] || break
    local next
    next=$(jq -r '.data.repository.pullRequest.reviewThreads.pageInfo.endCursor // empty' <<<"$page")
    # More pages but no new cursor would request the same page forever.
    if [[ -z $next || $next == "$after" ]]; then
      rm -f "$pages_file"
      die "pr-threads: GitHub reported more threads of PR #$n but no new cursor"
    fi
    after=$next
  done
  out=$(jq -cs 'add // []' "$pages_file")
  rm -f "$pages_file"
  print_json "$out" "$JQF"
}

# Resolves one review thread by its GraphQL node id (pr-threads' `id`).
cmd_pr_thread_resolve() {
  [[ $# -eq 1 && -n $1 ]] || die "usage: pr-thread-resolve <thread-id>"
  local out
  # $id is a GraphQL variable, sent as -f.
  # shellcheck disable=SC2016
  out=$(gh api graphql \
    -f 'query=mutation($id: ID!) { resolveReviewThread(input: {threadId: $id}) { thread { id isResolved } } }' \
    -f "id=$1") || die "pr-thread-resolve: could not resolve thread $1"
  [[ $(jq -r '.data.resolveReviewThread.thread.isResolved' <<<"$out") == true ]] \
    || die "pr-thread-resolve: thread $1 is still unresolved"
}

# The checks on a PR's current head: every check run plus every legacy commit
# status, as one array of {name, status, conclusion, url}. `status` is
# completed / in_progress / queued (statuses map to completed or pending).
cmd_pr_checks() {
  [[ $# -ge 1 ]] || die "usage: pr-checks <n> [--jq f]"
  local n=$1; shift
  parse_optional_jq "$@"
  local sha runs statuses
  sha=$(gh api "repos/$REPO/pulls/$n" --jq '.head.sha') || die "pr-checks: could not read PR #$n"
  runs=$(gh api --paginate --slurp "repos/$REPO/commits/$sha/check-runs?per_page=100") \
    || die "pr-checks: could not read check runs for $sha"
  runs=$(jq -c '[.[].check_runs[] | {name, app: .app.slug, status, conclusion, title: .output.title, summary: .output.summary, url: .html_url}]' <<<"$runs")
  statuses=$(gh api "repos/$REPO/commits/$sha/status" \
    --jq '[.statuses[] | {name: .context, app: null, status: (if .state == "pending" then "pending" else "completed" end), conclusion: (if .state == "pending" then null else .state end), title: null, summary: .description, url: .target_url}]') \
    || die "pr-checks: could not read commit statuses for $sha"
  print_json "$(jq -c -n --argjson a "$runs" --argjson b "$statuses" '$a + $b')" "$JQF"
}

# --- security advisories -------------------------------------------------
#
# Repository security advisories: where a Critical or High finding is
# recorded instead of a public issue. Every write subcommand takes
# --dry-run, which prints the method, the path and the JSON body it would
# send and calls nothing — the way to check a write without creating or
# changing a real advisory. JSON bodies are built with jq from --arg and
# --rawfile values and sent with `gh api --input -`, never assembled as a
# string.

ADVISORY_STATES="triage draft published closed"
ADVISORY_SEVERITIES="critical high medium low"

require_ghsa() {
  [[ $2 =~ ^GHSA(-[2-9cfghjmpqrvwx]{4}){3}$ ]] || die "$1: not a GHSA id: $2"
}

require_one_of() {
  local what=$1 value=$2 allowed=$3 item
  for item in $allowed; do
    [[ $value == "$item" ]] && return 0
  done
  die "$what: '$value' is not one of: ${allowed// /, }"
}

# Sends one advisory write — or, with ADV_DRY_RUN=1, prints what it would
# send and sends nothing. $1 method, $2 path below repos/$REPO, $3 JSON body.
advisory_send() {
  local method=$1 path=$2 body=$3
  if [[ $ADV_DRY_RUN == 1 ]]; then
    printf '%s repos/%s/%s\n%s\n' "$method" "$REPO" "$path" "$body"
    return 0
  fi
  gh api --method "$method" "repos/$REPO/$path" --input - <<<"$body"
}

# GitHub pages this endpoint with before/after cursors, not page numbers;
# `--paginate` follows them.
cmd_advisory_list() {
  local state="" jqf=""
  while [[ $# -gt 0 ]]; do
    case $1 in
      --state) [[ $# -ge 2 ]] || die "advisory-list: --state needs a value"; state=$2; shift 2 ;;
      --jq) [[ $# -ge 2 ]] || die "advisory-list: --jq needs a value"; jqf=$2; shift 2 ;;
      *) die "advisory-list: unrecognized argument: $1" ;;
    esac
  done
  local path="repos/$REPO/security-advisories?per_page=100"
  if [[ -n $state ]]; then
    require_one_of "advisory-list --state" "$state" "$ADVISORY_STATES"
    path+="&state=$state"
  fi
  local out
  out=$(gh_list "$path") || die "advisory-list: could not list security advisories"
  print_json "$out" "$jqf"
}

cmd_advisory_get() {
  [[ $# -ge 1 ]] || die "usage: advisory-get <ghsa_id> [--jq f]"
  local id=$1; shift
  require_ghsa advisory-get "$id"
  parse_optional_jq "$@"
  local out
  out=$(gh api "repos/$REPO/security-advisories/$id") \
    || die "advisory-get: could not read $id"
  print_json "$out" "$JQF"
}

# Reads the field flags advisory-create and advisory-update share into
# ADV_SUMMARY, ADV_DESC_FILE, ADV_SEVERITY, ADV_CWES, ADV_PACKAGE and
# ADV_DRY_RUN; $1 names the calling subcommand for its errors.
parse_advisory_fields() {
  local who=$1; shift
  ADV_SUMMARY="" ADV_DESC_FILE="" ADV_SEVERITY="" ADV_PACKAGE="" ADV_DRY_RUN=0
  ADV_CWES=()
  while [[ $# -gt 0 ]]; do
    case $1 in
      --summary) [[ $# -ge 2 ]] || die "$who: --summary needs a value"; ADV_SUMMARY=$2; shift 2 ;;
      --description-file) [[ $# -ge 2 ]] || die "$who: --description-file needs a value"; ADV_DESC_FILE=$2; shift 2 ;;
      --severity) [[ $# -ge 2 ]] || die "$who: --severity needs a value"; ADV_SEVERITY=$2; shift 2 ;;
      --cwe) [[ $# -ge 2 ]] || die "$who: --cwe needs a value"; ADV_CWES+=("$2"); shift 2 ;;
      --package) [[ $# -ge 2 ]] || die "$who: --package needs a value"; ADV_PACKAGE=$2; shift 2 ;;
      --dry-run) ADV_DRY_RUN=1; shift ;;
      *) die "$who: unrecognized argument: $1" ;;
    esac
  done
  [[ -z $ADV_SEVERITY ]] || require_one_of "$who --severity" "$ADV_SEVERITY" "$ADVISORY_SEVERITIES"
  local cwe
  for cwe in ${ADV_CWES[@]+"${ADV_CWES[@]}"}; do
    [[ $cwe =~ ^CWE-[0-9]+$ ]] || die "$who --cwe: '$cwe' is not a CWE id like CWE-22"
  done
  [[ -z $ADV_DESC_FILE || -f $ADV_DESC_FILE ]] || die "$who: description file not found: $ADV_DESC_FILE"
}

# Prints the JSON body holding only the fields that were given. The
# description is read from its file by jq itself, so its text is never
# interpolated into anything.
advisory_fields_json() {
  local desc_args=()
  [[ -n $ADV_DESC_FILE ]] && desc_args=(--rawfile description "$ADV_DESC_FILE")
  local cwes_json='[]'
  if (( ${#ADV_CWES[@]} )); then
    cwes_json=$(printf '%s\n' "${ADV_CWES[@]}" | jq -R . | jq -cs .)
  fi
  jq -cn --arg summary "$ADV_SUMMARY" --arg severity "$ADV_SEVERITY" \
    --argjson cwes "$cwes_json" ${desc_args[@]+"${desc_args[@]}"} '
    {}
    + (if $summary != "" then {summary: $summary} else {} end)
    + (if $ARGS.named | has("description") then {description: $ARGS.named.description} else {} end)
    + (if $severity != "" then {severity: $severity} else {} end)
    + (if ($cwes | length) > 0 then {cwe_ids: $cwes} else {} end)'
}

cmd_advisory_create() {
  parse_advisory_fields advisory-create "$@"
  [[ -n $ADV_SUMMARY && -n $ADV_DESC_FILE && -n $ADV_SEVERITY ]] \
    || die "usage: advisory-create --summary <s> --description-file <f> --severity critical|high|medium|low [--cwe CWE-n]... [--package name] [--dry-run]"
  local fields body
  fields=$(advisory_fields_json) || die "advisory-create: could not build the request body"
  # --package names the affected product as one `vulnerabilities` entry in
  # the `other` ecosystem — what a repository's own code (not a published
  # package) is filed as. Without it the list is empty.
  body=$(jq -c --arg pkg "$ADV_PACKAGE" '. + {vulnerabilities: (
    if $pkg == "" then [] else [{package: {ecosystem: "other", name: $pkg}}] end)}' <<<"$fields")
  advisory_send POST security-advisories "$body" || die "advisory-create: failed"
}

cmd_advisory_update() {
  [[ $# -ge 1 ]] \
    || die "usage: advisory-update <ghsa_id> [--summary s] [--description-file f] [--severity s] [--cwe CWE-n]... [--dry-run]"
  local id=$1; shift
  require_ghsa advisory-update "$id"
  parse_advisory_fields advisory-update "$@"
  [[ -z $ADV_PACKAGE ]] || die "advisory-update: --package is only for advisory-create"
  if [[ -z $ADV_SUMMARY && -z $ADV_DESC_FILE && -z $ADV_SEVERITY ]] && (( ${#ADV_CWES[@]} == 0 )); then
    die "advisory-update: nothing to change"
  fi
  local body
  body=$(advisory_fields_json) || die "advisory-update: could not build the request body"
  advisory_send PATCH "security-advisories/$id" "$body" || die "advisory-update: could not update $id"
}

# Moves an advisory to a new state: triage to draft (accept), anything to
# closed (reject), a draft to published (publish).
advisory_set_state() {
  local who=$1 state=$2; shift 2
  local id="" dry=0
  while [[ $# -gt 0 ]]; do
    case $1 in
      --dry-run) dry=1; shift ;;
      -*) die "$who: unrecognized argument: $1" ;;
      *) [[ -z $id ]] || die "$who: unrecognized argument: $1"; id=$1; shift ;;
    esac
  done
  [[ -n $id ]] || die "usage: $who <ghsa_id> [--dry-run]"
  require_ghsa "$who" "$id"
  ADV_DRY_RUN=$dry
  advisory_send PATCH "security-advisories/$id" "$(jq -cn --arg s "$state" '{state: $s}')" \
    || die "$who: could not move $id to $state"
}

cmd_advisory_accept() { advisory_set_state advisory-accept draft "$@"; }
cmd_advisory_reject() { advisory_set_state advisory-reject closed "$@"; }
cmd_advisory_publish() { advisory_set_state advisory-publish published "$@"; }

cmd_advisory_fork() {
  local id="" dry=0
  while [[ $# -gt 0 ]]; do
    case $1 in
      --dry-run) dry=1; shift ;;
      -*) die "advisory-fork: unrecognized argument: $1" ;;
      *) [[ -z $id ]] || die "advisory-fork: unrecognized argument: $1"; id=$1; shift ;;
    esac
  done
  [[ -n $id ]] || die "usage: advisory-fork <ghsa_id> [--dry-run]"
  require_ghsa advisory-fork "$id"
  ADV_DRY_RUN=$dry
  advisory_send POST "security-advisories/$id/forks" '{}' || die "advisory-fork: could not fork $id"
}

# --- code scanning alerts -----------------------------------------------
#
# CodeQL (and any other code scanning tool) results for a pull request. A
# repository with no analysis answers 404 "no analysis found", and a private
# one without GitHub Code Security answers 403 "... must be enabled": both
# exit 4, while any other 403 (a missing permission) is a failure, so a caller
# can tell "code scanning is not set up here" from a failed read (exit 1),
# which must never pass for "no alerts".

CODE_SCANNING_UNAVAILABLE=4

cmd_code_scanning_alerts() {
  [[ $# -ge 1 && $1 =~ ^[0-9]+$ ]] || die "usage: code-scanning-alerts <pr> [--state open|closed|dismissed|fixed] [--jq f]"
  local n=$1; shift
  local state="open" jqf=""
  while [[ $# -gt 0 ]]; do
    case $1 in
      --state) [[ $# -ge 2 ]] || die "code-scanning-alerts: --state needs a value"; state=$2; shift 2 ;;
      --jq) [[ $# -ge 2 ]] || die "code-scanning-alerts: --jq needs a value"; jqf=$2; shift 2 ;;
      *) die "code-scanning-alerts: unrecognized argument: $1" ;;
    esac
  done
  require_one_of "code-scanning-alerts --state" "$state" "open closed dismissed fixed"
  local err
  err=$(mktemp)
  if ! gh api "repos/$REPO/code-scanning/analyses?per_page=1" >/dev/null 2>"$err"; then
    if grep -qiE 'no analysis found|(advanced|code) security must be enabled|code scanning is not enabled' "$err"; then
      printf 'gh-helpers: code-scanning-alerts: code scanning is not set up on %s (%s)\n' "$REPO" "$(tr '\n' ' ' <"$err")" >&2
      rm -f "$err"
      exit "$CODE_SCANNING_UNAVAILABLE"
    fi
    rm -f "$err"
    die "code-scanning-alerts: could not read the code scanning analyses"
  fi
  rm -f "$err"
  local out
  out=$(gh_list "repos/$REPO/code-scanning/alerts?pr=$n&state=$state&per_page=100") \
    || die "code-scanning-alerts: could not list the alerts of PR #$n"
  print_json "$out" "$jqf"
}

# Dismisses one alert as a false positive, won't fix or test-only code. Only
# ever after the maintainer said yes to that alert: dismissing hides a
# security result, and the API call carries the maintainer's identity.
cmd_code_scanning_dismiss() {
  local id="" reason="" comment_file="" dry=0
  while [[ $# -gt 0 ]]; do
    case $1 in
      --reason) [[ $# -ge 2 ]] || die "code-scanning-dismiss: --reason needs a value"; reason=$2; shift 2 ;;
      --comment-file) [[ $# -ge 2 ]] || die "code-scanning-dismiss: --comment-file needs a value"; comment_file=$2; shift 2 ;;
      --dry-run) dry=1; shift ;;
      -*) die "code-scanning-dismiss: unrecognized argument: $1" ;;
      *) [[ -z $id ]] || die "code-scanning-dismiss: unrecognized argument: $1"; id=$1; shift ;;
    esac
  done
  [[ $id =~ ^[0-9]+$ && -n $reason && -n $comment_file ]] \
    || die "usage: code-scanning-dismiss <alert-number> --reason 'false positive'|'won't fix'|'used in tests' --comment-file f [--dry-run]"
  case $reason in
    "false positive" | "won't fix" | "used in tests") ;;
    *) die "code-scanning-dismiss: --reason must be 'false positive', 'won't fix' or 'used in tests'" ;;
  esac
  [[ -f $comment_file ]] || die "code-scanning-dismiss: comment file not found: $comment_file"
  local body
  body=$(jq -cn --arg r "$reason" --rawfile c "$comment_file" \
    '{state: "dismissed", dismissed_reason: $r, dismissed_comment: ($c | rtrimstr("\n"))}') \
    || die "code-scanning-dismiss: could not build the request body"
  (( $(jq -r '.dismissed_comment | length' <<<"$body") <= 280 )) \
    || die "code-scanning-dismiss: the comment is longer than GitHub's 280 characters"
  ADV_DRY_RUN=$dry
  advisory_send PATCH "code-scanning/alerts/$id" "$body" || die "code-scanning-dismiss: could not dismiss alert #$id"
}


usage() {
  cat <<'USAGE_EOF'
Usage: gh-helpers.sh <subcommand> [args...]

Everything not listed here is a plain `gh` call with `-R <repo>`.

Relationships
  add-blocked-by <n> <dep>                   link the edge, then set #n to status:blocked when it now is
Pull requests
  pr-checks <n> [--jq f]                     check runs + statuses on the PR head, with their output
  pr-threads <n> [--jq f]                    review threads with their resolved state (GraphQL)
  pr-thread-resolve <thread-id>              resolve one review thread (GraphQL)
Security advisories (write subcommands take --dry-run, which prints the
method, path and JSON body and sends nothing)
  advisory-list [--state triage|draft|published|closed] [--jq f]
  advisory-get <ghsa_id> [--jq f]
  advisory-create --summary s --description-file f --severity critical|high|medium|low [--cwe CWE-n]... [--package name] [--dry-run]
  advisory-update <ghsa_id> [--summary s] [--description-file f] [--severity s] [--cwe CWE-n]... [--dry-run]
  advisory-accept <ghsa_id> [--dry-run]     triage to draft
  advisory-reject <ghsa_id> [--dry-run]     to closed
  advisory-fork <ghsa_id> [--dry-run]       temporary private fork
  advisory-publish <ghsa_id> [--dry-run]
Code scanning (exit 4: not set up on this repository)
  code-scanning-alerts <pr> [--state open|closed|dismissed|fixed] [--jq f]
  code-scanning-dismiss <alert> --reason "false positive"|"won't fix"|"used in tests" --comment-file f [--dry-run]
USAGE_EOF
}

main() {
  [[ $# -ge 1 ]] || { usage >&2; exit 1; }
  local sub=$1; shift
  case $sub in
    add-blocked-by) cmd_add_blocked_by "$@" ;;
    pr-checks) cmd_pr_checks "$@" ;;
    pr-threads) cmd_pr_threads "$@" ;;
    pr-thread-resolve) cmd_pr_thread_resolve "$@" ;;
    code-scanning-alerts) cmd_code_scanning_alerts "$@" ;;
    code-scanning-dismiss) cmd_code_scanning_dismiss "$@" ;;
    advisory-list) cmd_advisory_list "$@" ;;
    advisory-get) cmd_advisory_get "$@" ;;
    advisory-create) cmd_advisory_create "$@" ;;
    advisory-update) cmd_advisory_update "$@" ;;
    advisory-accept) cmd_advisory_accept "$@" ;;
    advisory-reject) cmd_advisory_reject "$@" ;;
    advisory-fork) cmd_advisory_fork "$@" ;;
    advisory-publish) cmd_advisory_publish "$@" ;;
    help | -h | --help) usage ;;
    *) die "unknown subcommand: $sub (gh-helpers.sh help lists them)" ;;
  esac
}

main "$@"
