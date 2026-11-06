#!/usr/bin/env bash
# Tests scripts/check-workflow-triggers.sh in throwaway directories under the OS
# temp dir, each holding a copy of the script and a .github/workflows folder.
# The fixture workflows hold ${{ ... }} expressions and backslashes that must stay literal.
# shellcheck disable=SC2016,SC1003
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
failures=0
out=""
code=0

new_tree() {
  local dir="$tmp/$1"
  mkdir -p "$dir/scripts" "$dir/.github/workflows"
  cp "$here/check-workflow-triggers.sh" "$dir/scripts/"
  printf '%s' "$dir"
}

put() {
  local dir="$1" file="$2"
  shift 2
  mkdir -p "$(dirname "$dir/$file")"
  printf '%s\n' "$@" > "$dir/$file"
}

check() {
  code=0
  out="$(cd "$1" && bash scripts/check-workflow-triggers.sh 2>&1)" || code=$?
}

fail() {
  printf 'FAIL: %s\n%s\n' "$1" "$out" >&2
  failures=$((failures + 1))
}

pass() {
  printf 'ok: %s\n' "$1"
}

expect_pass() {
  if ((code == 0)) && [[ -z "$out" ]]; then pass "$1"; else fail "$1 (exit $code, expected 0 and no output)"; fi
}

expect_hit() {
  local name="$1" location="$2"
  if ((code != 0)) && grep -q -- "$location" <<<"$out"; then
    pass "$name"
  else
    fail "$name (exit $code, expected non-zero naming $location)"
  fi
}

expect_error() {
  if ((code != 0)); then pass "$1"; else fail "$1 (exit 0, expected non-zero)"; fi
}

pinned='contributor-assistant/github-action@ca4a40a7d1004f18d9960b404b97e5f30a505a08 # v2.6.1'

# The CLA workflow as it stands: allow-listed, one pinned action, the workflow token.
write_cla() {
  put "$1" .github/workflows/cla.yml \
    'name: CLA' \
    '# Runs on pull_request_target; it never checks out pull request code.' \
    'on:' \
    '  issue_comment:' \
    '    types: [created]' \
    '  pull_request_target:' \
    '    types: [opened, closed, synchronize]' \
    'jobs:' \
    '  cla:' \
    "    if: github.event_name == 'pull_request_target'" \
    '    runs-on: ubuntu-latest' \
    '    steps:' \
    '      - name: CLA Assistant Lite' \
    "        uses: $pinned" \
    '        env:' \
    '          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}'
}

write_ci() {
  put "$1" .github/workflows/ci.yml \
    'name: CI' \
    '# The workflow never runs on pull_request_target, so a fork run holds a read-only token.' \
    'on:' \
    '  pull_request:' \
    '    types: [opened, synchronize]' \
    'jobs:' \
    '  lint:' \
    '    runs-on: ubuntu-latest' \
    '    steps:' \
    '      - uses: actions/checkout@08eba0b27e820071cde6df949e0beb9ba4906955 # v4.3.0' \
    '      - run: pnpm lint'
}

tree="$(new_tree clean)"
write_cla "$tree"
write_ci "$tree"
check "$tree"
expect_pass "the allow-listed workflow and a pull_request workflow that checks out code pass"

tree="$(new_tree comment-only)"
write_ci "$tree"
check "$tree"
expect_pass "pull_request_target in a comment passes"

tree="$(new_tree yaml-extension)"
write_cla "$tree"
put "$tree" .github/workflows/other.yaml 'on:' '  pull_request_target:' 'jobs: {}'
check "$tree"
expect_hit "a .yaml workflow other than the allow-listed one fails" "other.yaml"

tree="$(new_tree other-trigger)"
write_cla "$tree"
put "$tree" .github/workflows/labeler.yml \
  'name: Labeler' \
  'on:' \
  '  pull_request_target:' \
  '    types: [opened]' \
  'jobs:' \
  '  label:' \
  '    runs-on: ubuntu-latest' \
  "    steps:" \
  "      - uses: $pinned"
check "$tree"
expect_hit "another workflow on pull_request_target fails" "labeler.yml"

tree="$(new_tree flow-list)"
put "$tree" .github/workflows/flow.yml 'on: [push, pull_request_target]' 'jobs: {}'
check "$tree"
expect_hit "pull_request_target in a flow list fails" "flow.yml"

tree="$(new_tree quoted)"
put "$tree" .github/workflows/quoted.yml 'on:' '  "pull_request_target":' 'jobs: {}'
check "$tree"
expect_hit "a quoted pull_request_target key fails" "quoted.yml"

tree="$(new_tree scalar)"
put "$tree" .github/workflows/scalar.yml 'on: pull_request_target' 'jobs: {}'
check "$tree"
expect_hit "a scalar pull_request_target trigger fails" "scalar.yml"

tree="$(new_tree trailing-comment)"
put "$tree" .github/workflows/trailing.yml 'on: [push] # never pull_request_target' 'jobs: {}'
check "$tree"
expect_hit "a trailing comment naming the event fails closed" "trailing.yml"

tree="$(new_tree checkout)"
write_cla "$tree"
put "$tree" .github/workflows/cla.yml \
  'on:' \
  '  pull_request_target:' \
  'jobs:' \
  '  cla:' \
  '    steps:' \
  '      - uses: actions/checkout@08eba0b27e820071cde6df949e0beb9ba4906955 # v4.3.0' \
  "      - uses: $pinned"
check "$tree"
expect_hit "the allow-listed workflow that checks out code fails" "cla.yml"
if grep -q "actions/checkout" <<<"$out"; then pass "the checkout failure names actions/checkout"; else fail "the checkout failure names actions/checkout"; fi

tree="$(new_tree checkout-ref)"
write_cla "$tree"
put "$tree" .github/workflows/cla.yml \
  'on:' \
  '  pull_request_target:' \
  'jobs:' \
  '  cla:' \
  '    steps:' \
  '      - uses: "actions/checkout@v4"' \
  '        with:' \
  '          ref: ${{ github.event.pull_request.head.sha }}'
check "$tree"
expect_hit "a quoted, unpinned checkout of the pull request head fails" "cla.yml"

tree="$(new_tree run-step)"
put "$tree" .github/workflows/cla.yml \
  'on:' \
  '  pull_request_target:' \
  'jobs:' \
  '  cla:' \
  '    steps:' \
  "      - uses: $pinned" \
  '      - run: git fetch origin pull/1/head && git checkout FETCH_HEAD'
check "$tree"
expect_hit "a run step in the allow-listed workflow fails" "cla.yml"

tree="$(new_tree unpinned)"
put "$tree" .github/workflows/cla.yml \
  'on:' \
  '  pull_request_target:' \
  'jobs:' \
  '  cla:' \
  '    steps:' \
  '      - uses: contributor-assistant/github-action@v2.6.1'
check "$tree"
expect_hit "an action pinned to a tag fails" "cla.yml"

tree="$(new_tree flow-pinned)"
put "$tree" .github/workflows/cla.yml \
  'on:' \
  '  pull_request_target:' \
  'jobs:' \
  '  cla:' \
  '    steps:' \
  '      - { name: CLA, uses: contributor-assistant/github-action@ca4a40a7d1004f18d9960b404b97e5f30a505a08 }' \
  '      - {"uses": "contributor-assistant/github-action@ca4a40a7d1004f18d9960b404b97e5f30a505a08", with: {}}'
check "$tree"
expect_pass "pinned actions in flow mappings, quoted or not, pass"

tree="$(new_tree flow-unpinned)"
put "$tree" .github/workflows/cla.yml \
  'on:' \
  '  pull_request_target:' \
  'jobs:' \
  '  cla:' \
  '    steps:' \
  '      - { uses: contributor-assistant/github-action@v2.6.1 }'
check "$tree"
expect_hit "an action pinned to a tag inside a flow mapping fails" "github-action@v2.6.1"

tree="$(new_tree flow-quoted-key)"
put "$tree" .github/workflows/cla.yml \
  'on:' \
  '  pull_request_target:' \
  'jobs:' \
  '  cla:' \
  '    steps:' \
  "      - \"uses\": 'contributor-assistant/github-action@v2.6.1'"
check "$tree"
expect_hit "an unpinned action under a quoted uses key fails" "github-action@v2.6.1"

tree="$(new_tree flow-same-line)"
put "$tree" .github/workflows/cla.yml \
  'on:' \
  '  pull_request_target:' \
  'jobs:' \
  '  cla:' \
  '    steps: [{ uses: contributor-assistant/github-action@ca4a40a7d1004f18d9960b404b97e5f30a505a08 }, { uses: octo/action@v1 }]'
check "$tree"
expect_hit "an unpinned action beside a pinned one on the same line fails" "octo/action@v1"

tree="$(new_tree uses-next-line)"
put "$tree" .github/workflows/cla.yml \
  'on:' \
  '  pull_request_target:' \
  'jobs:' \
  '  cla:' \
  '    steps:' \
  '      - uses:' \
  '          octo/action@v1'
check "$tree"
expect_hit "a uses value on the next line fails closed" "cla.yml"

tree="$(new_tree flow-run)"
put "$tree" .github/workflows/cla.yml \
  'on:' \
  '  pull_request_target:' \
  'jobs:' \
  '  cla:' \
  '    steps:' \
  "      - uses: $pinned" \
  '      - { name: fetch, run: git fetch origin pull/1/head }'
check "$tree"
expect_hit "a run step inside a flow mapping fails" "run: step"

tree="$(new_tree secret)"
put "$tree" .github/workflows/cla.yml \
  'on:' \
  '  pull_request_target:' \
  'jobs:' \
  '  cla:' \
  '    steps:' \
  "      - uses: $pinned" \
  '        env:' \
  '          TOKEN: ${{ secrets.REGISTRY_PUSH_TOKEN }}'
check "$tree"
expect_hit "a secret other than the workflow token fails" "cla.yml"

tree="$(new_tree secret-bracket)"
put "$tree" .github/workflows/cla.yml \
  'on:' \
  '  pull_request_target:' \
  'jobs:' \
  '  cla:' \
  '    steps:' \
  "      - uses: $pinned" \
  '        env:' \
  "          TOKEN: \${{ secrets['REGISTRY_PUSH_TOKEN'] }}"
check "$tree"
expect_hit "a secret read by index fails" "cla.yml"

tree="$(new_tree inherit)"
put "$tree" .github/workflows/cla.yml \
  'on:' \
  '  pull_request_target:' \
  'jobs:' \
  '  cla:' \
  '    uses: octo/repo/.github/workflows/x.yml@ca4a40a7d1004f18d9960b404b97e5f30a505a08' \
  '    secrets: inherit'
check "$tree"
expect_hit "secrets: inherit fails" "cla.yml"

tree="$(new_tree secrets-json-with)"
put "$tree" .github/workflows/cla.yml \
  'on:' \
  '  pull_request_target:' \
  'jobs:' \
  '  cla:' \
  '    steps:' \
  "      - uses: $pinned" \
  '        with:' \
  '          dump: ${{ toJSON(secrets) }}'
check "$tree"
expect_hit "the whole secrets context in a with input fails" "cla.yml"

tree="$(new_tree secrets-json-env)"
put "$tree" .github/workflows/cla.yml \
  'on:' \
  '  pull_request_target:' \
  'jobs:' \
  '  cla:' \
  '    steps:' \
  "      - uses: $pinned" \
  '        env:' \
  '          ALL: ${{ toJSON(secrets) }}'
check "$tree"
expect_hit "the whole secrets context in env fails" "cla.yml"

tree="$(new_tree secrets-bare)"
put "$tree" .github/workflows/cla.yml \
  'on:' \
  '  pull_request_target:' \
  'jobs:' \
  '  cla:' \
  '    steps:' \
  "      - uses: $pinned" \
  '        env:' \
  "          ALL: \${{ format('{0}', secrets) }}"
check "$tree"
expect_hit "the bare secrets context in a function call fails" "cla.yml"

tree="$(new_tree secrets-upper)"
put "$tree" .github/workflows/cla.yml \
  'on:' \
  '  pull_request_target:' \
  'jobs:' \
  '  cla:' \
  '    steps:' \
  "      - uses: $pinned" \
  '        env:' \
  '          TOKEN: ${{ SECRETS.REGISTRY_PUSH_TOKEN }}'
check "$tree"
expect_hit "a secret read through an upper-case context name fails" "cla.yml"

tree="$(new_tree secrets-token-lookalike)"
put "$tree" .github/workflows/cla.yml \
  'on:' \
  '  pull_request_target:' \
  'jobs:' \
  '  cla:' \
  '    steps:' \
  "      - uses: $pinned" \
  '        env:' \
  '          TOKEN: ${{ secrets.GITHUB_TOKEN_PUSH }}'
check "$tree"
expect_hit "a secret whose name starts with GITHUB_TOKEN fails" "cla.yml"

tree="$(new_tree secrets-token-lower)"
put "$tree" .github/workflows/cla.yml \
  'on:' \
  '  pull_request_target:' \
  'jobs:' \
  '  cla:' \
  '    steps:' \
  "      - uses: $pinned" \
  '        env:' \
  '          GITHUB_TOKEN: ${{ secrets.github_token }}'
check "$tree"
expect_pass "the workflow token read in lower case passes"

tree="$(new_tree github-script)"
put "$tree" .github/workflows/cla.yml \
  'on:' \
  '  pull_request_target:' \
  'jobs:' \
  '  cla:' \
  '    steps:' \
  "      - uses: $pinned" \
  '      - uses: actions/github-script@60a0d83039c74a4aee543508d2ffcb1c3799cdea # v7.0.1' \
  '        with:' \
  '          script: core.setOutput("x", process.env.TOKEN)'
check "$tree"
expect_hit "a pinned github-script step in the allow-listed workflow fails" "actions/github-script"

tree="$(new_tree checkout-mixed-case)"
put "$tree" .github/workflows/cla.yml \
  'on:' \
  '  pull_request_target:' \
  'jobs:' \
  '  cla:' \
  '    steps:' \
  '      - uses: Actions/Checkout@08eba0b27e820071cde6df949e0beb9ba4906955'
check "$tree"
expect_hit "a pinned checkout under a different letter case fails" "Actions/Checkout"

tree="$(new_tree reusable-workflow)"
put "$tree" .github/workflows/cla.yml \
  'on:' \
  '  pull_request_target:' \
  'jobs:' \
  '  cla:' \
  '    uses: octo/repo/.github/workflows/x.yml@ca4a40a7d1004f18d9960b404b97e5f30a505a08'
check "$tree"
expect_hit "a pinned reusable workflow outside the allow-list fails" "octo/repo"

tree="$(new_tree workflow-run)"
write_cla "$tree"
put "$tree" .github/workflows/after-ci.yml \
  'name: After CI' \
  'on:' \
  '  workflow_run:' \
  '    workflows: [CI]' \
  '    types: [completed]' \
  'jobs:' \
  '  publish:' \
  '    runs-on: ubuntu-latest' \
  '    steps:' \
  '      - uses: actions/checkout@08eba0b27e820071cde6df949e0beb9ba4906955 # v4.3.0' \
  '        with:' \
  '          ref: ${{ github.event.workflow_run.head_sha }}' \
  '      - run: pnpm install && pnpm build'
check "$tree"
expect_hit "a workflow_run workflow that checks out code fails" "after-ci.yml"

tree="$(new_tree workflow-run-flow)"
put "$tree" .github/workflows/after.yml 'on: [push, workflow_run]' 'jobs: {}'
check "$tree"
expect_hit "workflow_run in a flow list fails" "after.yml"

tree="$(new_tree issue-comment)"
write_cla "$tree"
put "$tree" .github/workflows/commands.yml \
  'name: Commands' \
  'on:' \
  '  issue_comment:' \
  '    types: [created]' \
  'jobs:' \
  '  run:' \
  '    runs-on: ubuntu-latest' \
  '    steps:' \
  '      - run: echo hi'
check "$tree"
expect_hit "an issue_comment workflow other than the allow-listed one fails" "commands.yml"

tree="$(new_tree issue-comment-checkout)"
put "$tree" .github/workflows/cla.yml \
  'on:' \
  '  issue_comment:' \
  '    types: [created]' \
  'jobs:' \
  '  cla:' \
  '    steps:' \
  '      - uses: actions/checkout@08eba0b27e820071cde6df949e0beb9ba4906955 # v4.3.0' \
  "      - uses: $pinned"
check "$tree"
expect_hit "the allow-listed workflow on issue_comment alone that checks out code fails" "cla.yml"
if grep -q "actions/checkout" <<<"$out"; then pass "the issue_comment checkout failure names actions/checkout"; else fail "the issue_comment checkout failure names actions/checkout"; fi

tree="$(new_tree issue-comment-run)"
put "$tree" .github/workflows/cla.yml \
  'on:' \
  '  issue_comment:' \
  '    types: [created]' \
  'jobs:' \
  '  cla:' \
  '    steps:' \
  '      - run: echo hi'
check "$tree"
expect_hit "the allow-listed workflow on issue_comment alone that has a run step fails" "run: step"

tree="$(new_tree escaped-hex)"
write_cla "$tree"
put "$tree" .github/workflows/esc.yml 'on:' '  "pull_request\x5ftarget":' 'jobs: {}'
check "$tree"
expect_hit "an event name spelled with a hex escape fails" "esc.yml"

tree="$(new_tree escaped-unicode)"
write_cla "$tree"
put "$tree" .github/workflows/esc.yml 'on:' '  "workflow\u005frun":' 'jobs: {}'
check "$tree"
expect_hit "an event name spelled with a unicode escape fails" "esc.yml"

tree="$(new_tree escaped-continuation)"
write_cla "$tree"
put "$tree" .github/workflows/esc.yml 'on:' '  "pull_request_\' '    target":' 'jobs: {}'
check "$tree"
expect_hit "an event name split by a line continuation fails" "esc.yml"

tree="$(new_tree escaped-run-key)"
put "$tree" .github/workflows/cla.yml \
  'on:' \
  '  pull_request_target:' \
  'jobs:' \
  '  cla:' \
  '    steps:' \
  "      - uses: $pinned" \
  '      - "ru\x6e": echo hi'
check "$tree"
expect_hit "a run key spelled with an escape fails" "run: step"

tree="$(new_tree escaped-secret)"
put "$tree" .github/workflows/cla.yml \
  'on:' \
  '  pull_request_target:' \
  'jobs:' \
  '  cla:' \
  '    steps:' \
  "      - uses: $pinned" \
  '        env:' \
  '          ALL: "${{ toJSON(secret\u0073) }}"'
check "$tree"
expect_hit "the secrets context spelled with an escape fails" "cla.yml"

tree="$(new_tree shell-continuation)"
write_cla "$tree"
put "$tree" .github/workflows/ci.yml \
  'on:' \
  '  push:' \
  'jobs:' \
  '  build:' \
  '    steps:' \
  '      - run: |' \
  '          docker build \' \
  '            -t x .'
check "$tree"
expect_pass "a shell line continuation in a run block passes"

tree="$(new_tree no-folder)"
rm -r "$tree/.github"
check "$tree"
expect_error "a missing .github/workflows folder fails"

tree="$(new_tree empty-folder)"
check "$tree"
expect_error "a folder with no workflow fails"

if ((failures > 0)); then
  printf '%d check(s) failed\n' "$failures" >&2
  exit 1
fi
