#!/usr/bin/env bash
# Tests scripts/check-forbidden-terms.sh in throwaway git repositories under the
# OS temp dir. Every forbidden term is assembled at run time, so this file never
# contains one and the repository still passes its own check.
set -euo pipefail

unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
failures=0
out=""
code=0

new_repo() {
  local dir="$tmp/$1"
  mkdir -p "$dir/scripts"
  git -C "$dir" init -q
  cp "$here/check-forbidden-terms.sh" "$dir/scripts/"
  cp "$here/forbidden-terms.txt" "$dir/scripts/"
  printf '%s' "$dir"
}

seed() {
  local dir="$1" file="$2"
  shift 2
  printf '%s\n' "$@" > "$dir/$file"
  git -C "$dir" add "$file"
}

check() {
  code=0
  out="$(cd "$1" && GIT_CEILING_DIRECTORIES="$tmp" bash scripts/check-forbidden-terms.sh 2>&1)" || code=$?
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
  if ((code != 0)) && grep -q -- "^$location:" <<<"$out"; then
    pass "$name"
  else
    fail "$name (exit $code, expected non-zero with a $location: line)"
  fi
}

expect_error() {
  if ((code != 0)); then pass "$1"; else fail "$1 (exit 0, expected non-zero)"; fi
}

term="cool""ify"

repo="$(new_repo clean)"
seed "$repo" notes.md "nothing to see" "plain text"
check "$repo"
expect_pass "a clean repository passes"

repo="$(new_repo hit)"
seed "$repo" notes.md "first line" "uses $term here" "last line"
check "$repo"
expect_hit "a hit fails and prints file:line" "notes.md:2"

repo="$(new_repo missing-list)"
rm "$repo/scripts/forbidden-terms.txt"
seed "$repo" notes.md "uses $term here"
check "$repo"
expect_error "a missing list fails"

repo="$(new_repo empty-list)"
printf '# only a comment\n\n' > "$repo/scripts/forbidden-terms.txt"
seed "$repo" notes.md "nothing to see"
check "$repo"
expect_error "a list without patterns fails"

repo="$(new_repo bad-pattern)"
printf '(unclosed\n' > "$repo/scripts/forbidden-terms.txt"
seed "$repo" notes.md "nothing to see"
check "$repo"
expect_error "a pattern git cannot compile fails"

repo="$(new_repo no-trailing-newline)"
printf 'harmless-first\nzz-last-pattern' > "$repo/scripts/forbidden-terms.txt"
seed "$repo" notes.md "nothing to see" "zz-last-pattern is here"
check "$repo"
expect_hit "a last pattern without a trailing newline is enforced" "notes.md:2"

mkdir -p "$tmp/no-git/scripts"
cp "$here/check-forbidden-terms.sh" "$here/forbidden-terms.txt" "$tmp/no-git/scripts/"
check "$tmp/no-git"
expect_error "a directory outside a git repository fails"

# Prices. Amounts are synthetic, and the currency signs and codes are kept apart
# from the digits in this file so it does not match the patterns it tests.
d='$'
pound="£"
forms=(
  "${d}11.11" "${d} 11.11" "${d}1,111" "${d}111"
  "${d}1/month" "${d}1 / mo" "${d}1/user" "${d}1 per year" "${d}1 a month" "${d}1 each seat"
  "${d}1 monthly" "${d}1 yearly"
  "${pound}11.11" "${pound} 11.11" "11.11${pound}" "11.11 ${pound}"
)
for code in USD EUR GBP usd; do
  forms+=(
    "11 ${code}" "11${code}" "${code} 11" "${code}11.11" "costs 11.11 ${code}." "(${code} 11)"
    "11 ${code}/month" "11${code}/mo" "${code} 11/month" "${code} 11/year" "${code} 11/user"
    "11 ${code}+VAT" "11 ${code}/Monat" "${code} 11+VAT"
    "11 ${code}/user/month" "${code} 11/user/month" "11${code}/seat/mo" "${code} 11/mo/user"
    "11 ${code}/month+VAT" "11 ${code}/Nutzer/Monat"
  )
done
repo="$(new_repo prices)"
seed "$repo" price.md "${forms[@]}"
check "$repo"
for i in "${!forms[@]}"; do
  expect_hit "price form ${forms[$i]}" "price.md:$((i + 1))"
done

# Positional parameters up to $99 cannot be told from a price written without a
# decimal part, a unit or a currency code, so these must pass.
# shellcheck disable=SC2016
not_prices=(
  'SET LOCAL app.workspace_id = $1, app.account_id = $2'
  'VALUES ($1,$2,$3)' 'WHERE id = $1 AND owner = $9' 'f($1, $2)' 'set_config($1, true)' '$10'
  'echo "$HOME" "${VAR}" "$(pwd)" "$1/dir" "$1.txt" "$#" "$@"'
  "awk '{s+=\$1+\$2} END {print s}'"
)
repo="$(new_repo not-prices)"
seed "$repo" code.sql "${not_prices[@]}"
check "$repo"
expect_pass "positional parameters and shell variables pass"

# A currency code or a digit inside a base64 run, as in an integrity hash of a
# lockfile, is not a price. The runs are built here so none is committed.
pad="Zq7Kd2Lm9Xw4Rt8Vb3Nc6Hj1Fg5Ps0Ya"
integrity=()
for code in usd eur gbp USD Eur; do
  integrity+=(
    "  resolution: {integrity: sha512-${pad}Q5${code}+${pad}${pad}==}"
    "  resolution: {integrity: sha512-${pad}+${code}9${pad}${pad}==}"
    "  resolution: {integrity: sha512-${pad}/${code}5${pad}${pad}==}"
    "  resolution: {integrity: sha512-${pad}7${code}/${pad}${pad}==}"
    "  resolution: {integrity: sha512-${pad}${pad}8${code}=}"
    "  resolution: {integrity: sha512-${code}5${pad}${pad}==}"
    "  resolution: {integrity: sha512-9${code}${pad}${pad}==}"
    "${pad}${pad}${pad}=${code}5"
    "  resolution: {integrity: sha512-37${code}/${pad}${pad}==}"
    "  resolution: {integrity: sha512-${code}5/${pad}${pad}==}"
    "  resolution: {integrity: sha512-37${code}+${pad}${pad}==}"
  )
done
repo="$(new_repo integrity)"
seed "$repo" pnpm-lock.yaml "${integrity[@]}"
check "$repo"
expect_pass "currency codes inside base64 integrity hashes pass"

if ((failures > 0)); then
  printf '%d check(s) failed\n' "$failures" >&2
  exit 1
fi
