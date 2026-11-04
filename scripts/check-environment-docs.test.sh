#!/usr/bin/env bash
# Tests scripts/check-environment-docs.mjs against copies of the real page and of
# .env.example in throwaway directories under the OS temp dir. Each case changes
# one thing in a copy and names the problem the check must report; a case whose
# change does not alter the copy fails, so no case passes by changing nothing.
# The fixtures hold backticks, which are literal text and not command substitutions.
# shellcheck disable=SC2016
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
failures=0
out=""
code=0

page="docs/self-hosting/environment.md"
example=".env.example"

# A copy of the page and of .env.example under $tmp/<name>.
new_tree() {
  local dir="$tmp/$1"
  mkdir -p "$dir/docs/self-hosting"
  cp "$root/$page" "$dir/$page"
  cp "$root/$example" "$dir/$example"
  printf '%s' "$dir"
}

check() {
  code=0
  out="$(node "$here/check-environment-docs.mjs" "$1" 2>&1)" || code=$?
}

fail() {
  printf 'FAIL: %s\n%s\n' "$1" "$out" >&2
  failures=$((failures + 1))
}

pass() {
  printf 'ok: %s\n' "$1"
}

# Removes every line of $2 (under $1) that contains the fixed text $3.
drop_lines() {
  local dir="$1" file="$2" text="$3" before
  before="$(cat "$dir/$file")"
  grep -vF -- "$text" "$dir/$file" >"$dir/$file.new" || true
  mv "$dir/$file.new" "$dir/$file"
  [[ "$(cat "$dir/$file")" != "$before" ]] || { printf 'FAIL: setup: no line of %s contains %s\n' "$file" "$text" >&2; failures=$((failures + 1)); }
}

# Replaces the fixed text $3 by $4 in $2 (under $1).
replace_text() {
  local dir="$1" file="$2" from="$3" to="$4" before
  before="$(cat "$dir/$file")"
  FROM="$from" TO="$to" perl -0pi -e 's/\Q$ENV{FROM}\E/$ENV{TO}/g' "$dir/$file"
  [[ "$(cat "$dir/$file")" != "$before" ]] || { printf 'FAIL: setup: %s does not contain %s\n' "$file" "$from" >&2; failures=$((failures + 1)); }
}

expect_pass() {
  if ((code == 0)); then pass "$1"; else fail "$1 (exit $code, expected 0)"; fi
}

# The check must fail with status 1 and say $2.
expect_problem() {
  local name="$1" text="$2"
  if ((code == 1)) && grep -qF -- "$text" <<<"$out"; then
    pass "$name"
  else
    fail "$name (exit $code, expected 1 and the text: $text)"
  fi
}

dir="$(new_tree base)"
check "$dir"
expect_pass "the page and the schema agree"

dir="$(new_tree unknown-key)"
printf '\nSet `AI_UNKNOWN_SETTING` to change it.\n' >>"$dir/$page"
check "$dir"
expect_problem "a key in a code span that no schema declares is reported" "AI_UNKNOWN_SETTING is on the page but no process schema declares it"

dir="$(new_tree unknown-key-in-text)"
printf '\nSet AI_UNKNOWN_SETTING to change it.\n' >>"$dir/$page"
check "$dir"
expect_problem "a key in plain text that no schema declares is reported" "AI_UNKNOWN_SETTING is on the page but no process schema declares it"

dir="$(new_tree unknown-key-in-block)"
printf '\n```sh\nAI_UNKNOWN_SETTING=1\n```\n' >>"$dir/$page"
check "$dir"
expect_problem "a key in a code block that no schema declares is reported" "AI_UNKNOWN_SETTING is on the page but no process schema declares it"

dir="$(new_tree pattern)"
printf '\nEvery bucket has keys named `RATE_LIMIT_<BUCKET>_<SCOPE>`, and `OIDC_<SLUG>_*` keys.\n' >>"$dir/$page"
check "$dir"
expect_pass "a pattern with a placeholder is not read as a key"

dir="$(new_tree missing-ai-model)"
drop_lines "$dir" "$page" "AI_MODEL"
check "$dir"
expect_problem "an AI key the page does not name is reported" "AI_MODEL is a setting the page covers but the page does not name it"

dir="$(new_tree missing-retention)"
drop_lines "$dir" "$page" "AUDIT_RETENTION_DAYS"
check "$dir"
expect_problem "the audit retention key the page does not name is reported" "AUDIT_RETENTION_DAYS is a setting the page covers but the page does not name it"

dir="$(new_tree missing-bulk)"
drop_lines "$dir" "$page" "RATE_LIMIT_BULK_ACCOUNT"
check "$dir"
expect_problem "a rate limit key of a covered bucket that the page does not name is reported" "RATE_LIMIT_BULK_ACCOUNT is a setting the page covers but the page does not name it"

dir="$(new_tree wrong-rate-default)"
replace_text "$dir" "$page" '`RATE_LIMIT_FETCH_ACCOUNT` | `60/min`' '`RATE_LIMIT_FETCH_ACCOUNT` | `61/min`'
check "$dir"
expect_problem "a rate limit default that differs from the schema is reported" "RATE_LIMIT_FETCH_ACCOUNT has the default 61/min on the page, and 60/min in the schema"

dir="$(new_tree no-rate-default)"
replace_text "$dir" "$page" '`RATE_LIMIT_AI_WORKSPACE` | `600/hour`' '`RATE_LIMIT_AI_WORKSPACE` | six hundred an hour'
check "$dir"
expect_problem "a rate limit row without a default is reported" "RATE_LIMIT_AI_WORKSPACE has the default none on the page, and 600/hour in the schema"

dir="$(new_tree wrong-retention-default)"
replace_text "$dir" "$page" '`AUDIT_RETENTION_DAYS` | `365`' '`AUDIT_RETENTION_DAYS` | `90`'
check "$dir"
expect_problem "an audit retention default that differs from the schema is reported" "AUDIT_RETENTION_DAYS has the default 90 on the page, and 365 in the schema"

dir="$(new_tree not-in-example)"
drop_lines "$dir" "$example" "AI_PROVIDER_NAME="
check "$dir"
expect_problem "a documented key that is not a line of .env.example is reported" "AI_PROVIDER_NAME is on the page but is not a line of .env.example"

dir="$(new_tree secret-value)"
printf '\nFor example `AI_API_KEY=abc123`.\n' >>"$dir/$page"
check "$dir"
expect_problem "a value given to a secret key is reported" "the page gives a secret key a value: AI_API_KEY"

dir="$(new_tree secret-table-value)"
printf '\n| Key | Value |\n| --- | ----- |\n| `AI_API_KEY` | `abc123` |\n' >>"$dir/$page"
check "$dir"
expect_problem "a value given to a secret key in the next cell of a table row is reported" "the page gives a secret key a value: AI_API_KEY"

dir="$(new_tree secret-table-placeholder)"
printf '\n| Key | Value |\n| --- | ----- |\n| `AI_API_KEY` | `<your API key>` |\n' >>"$dir/$page"
check "$dir"
expect_pass "a placeholder for a secret key in a table row is accepted"

dir="$(new_tree secret-table-prose)"
printf '\n| Key | Value |\n| --- | ----- |\n| `AI_API_KEY` | Set it in `.env`, or use `abc123` there. |\n' >>"$dir/$page"
check "$dir"
expect_pass "a code span in prose after a secret key in a table row is not a value"

dir="$(new_tree secret-placeholder)"
printf '\nFor example `AI_API_KEY=<your API key>`.\n' >>"$dir/$page"
check "$dir"
expect_pass "a placeholder for a secret key is accepted"

dir="$tmp/no-page"
mkdir -p "$dir"
cp "$root/$example" "$dir/$example"
check "$dir"
if ((code == 2)); then pass "a missing page makes the check fail"; else fail "a missing page makes the check fail (exit $code, expected 2)"; fi

check "$root"
expect_pass "the page of this repository and its schema agree"

if ((failures > 0)); then
  printf '%d test(s) failed\n' "$failures" >&2
  exit 1
fi
printf 'all environment-docs tests passed\n'
