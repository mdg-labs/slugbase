#!/usr/bin/env bash
# Tests scripts/check-external-hosts.sh in throwaway directories under the OS
# temp dir, each holding a copy of the script, a packages/ folder and an apps/ folder.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
failures=0
out=""
code=0

new_tree() {
  local dir="$tmp/$1"
  mkdir -p "$dir/scripts" "$dir/packages/ui/src" "$dir/apps/web/src" "$dir/docs"
  cp "$here/check-external-hosts.sh" "$dir/scripts/"
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
  out="$(cd "$1" && bash scripts/check-external-hosts.sh 2>&1)" || code=$?
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

tree="$(new_tree clean)"
put "$tree" packages/ui/src/theme.css '@import "tailwindcss";' '@font-face { src: url("@fontsource/ibm-plex-sans/files/a.woff2"); }' \
  '.x { background: url(data:image/svg+xml;base64,AAAA); }'
put "$tree" packages/ui/src/index.ts 'export const home = "https://slugbase.example/docs";'
put "$tree" apps/web/index.html '<!doctype html><link rel="icon" href="/favicon.svg"><link rel="canonical" href="https://slugbase.example/">' \
  '<script type="module" src="/src/main.tsx"></script><a href="https://example.org/">link</a>'
check "$tree"
expect_pass "local fonts, relative assets and ordinary links pass"

tree="$(new_tree docs-ignored)"
put "$tree" docs/prototype.css "@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans');"
check "$tree"
expect_pass "docs/ is not scanned"

hosts=(
  fonts.googleapis.com fonts.gstatic.com use.typekit.net fonts.bunny.net use.fontawesome.com
  cdnjs.cloudflare.com cdn.jsdelivr.net unpkg.com esm.sh ajax.googleapis.com code.jquery.com
)
for host in "${hosts[@]}"; do
  tree="$(new_tree "host-$host")"
  put "$tree" packages/ui/src/fonts.ts "const first = 1;" "const url = \"https://$host/x\";"
  check "$tree"
  expect_hit "$host in a source file fails" "fonts.ts"
done

tree="$(new_tree host-in-app)"
put "$tree" apps/web/src/main.tsx 'import "https://unpkg.com/x";'
check "$tree"
expect_hit "a CDN host under apps/ fails" "apps/web/src/main.tsx"

tree="$(new_tree host-built-js)"
put "$tree" packages/ui/dist/index.js 'fetch("//cdn.jsdelivr.net/npm/x");'
check "$tree"
expect_hit "a CDN host in built output fails" "packages/ui/dist/index.js"

tree="$(new_tree host-ignored-in-node-modules)"
put "$tree" packages/ui/node_modules/dep/index.js 'const u = "https://unpkg.com/x";'
check "$tree"
expect_pass "node_modules is not scanned"

css_forms=(
  "@import url('https://example.org/a.css');"
  '@import "https://example.org/a.css";'
  "@import 'http://example.org/a.css';"
  '@import url(//example.org/a.css);'
  "@font-face { src: url(https://example.org/a.woff2); }"
  '@font-face { src: url( "//example.org/a.woff2" ); }'
  ".a { background: url('http://example.org/a.png'); }"
)
for i in "${!css_forms[@]}"; do
  tree="$(new_tree "css-$i")"
  put "$tree" packages/ui/src/theme.css "${css_forms[$i]}"
  check "$tree"
  expect_hit "absolute address in CSS fails: ${css_forms[$i]}" "theme.css"
done

tree="$(new_tree css-built)"
put "$tree" apps/web/dist/assets/app.css '@font-face{font-family:X;src:url(https://example.org/x.woff2)}'
check "$tree"
expect_hit "an absolute address in built CSS fails" "apps/web/dist/assets/app.css"

tree="$(new_tree html-link)"
put "$tree" apps/web/index.html '<link rel="stylesheet" href="https://example.org/a.css">'
check "$tree"
expect_hit "an external stylesheet link fails" "apps/web/index.html"

tree="$(new_tree html-link-href-first)"
put "$tree" apps/web/index.html '<link href="//example.org/a.css" rel="stylesheet">'
check "$tree"
expect_hit "an external stylesheet link with href first fails" "apps/web/index.html"

tree="$(new_tree html-link-multiline)"
put "$tree" apps/web/dist/index.html '<link' '  rel="preload"' '  as="font"' '  href="https://example.org/a.woff2">'
check "$tree"
expect_hit "a link tag split over several lines fails" "apps/web/dist/index.html"

tree="$(new_tree html-preconnect)"
put "$tree" apps/web/index.html "<LINK REL='preconnect' HREF='https://example.org'>"
check "$tree"
expect_hit "a preconnect in upper case fails" "apps/web/index.html"

tree="$(new_tree html-script)"
put "$tree" apps/web/index.html '<script src="https://example.org/lib.js"></script>'
check "$tree"
expect_hit "an external script fails" "apps/web/index.html"

tree="$(new_tree html-inline-style)"
put "$tree" apps/web/index.html '<style>@import url(https://example.org/a.css);</style>'
check "$tree"
expect_hit "an @import inside an HTML style element fails" "apps/web/index.html"

tree="$(new_tree no-scope)"
rm -r "$tree/apps"
check "$tree"
expect_error "a missing apps/ folder fails"

tree="$(new_tree no-packages)"
rm -r "$tree/packages"
check "$tree"
expect_error "a missing packages/ folder fails"

if ((failures > 0)); then
  printf '%d check(s) failed\n' "$failures" >&2
  exit 1
fi
