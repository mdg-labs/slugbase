#!/usr/bin/env bash
# Fails when the sources or the built output under packages/ and apps/ reference
# an external font or CDN host (doc 03 "Fonts are bundled, never fetched", doc 08):
#   - a known font or CDN host in any text file;
#   - a CSS `url()` or `@import` that points at an absolute http(s) or
#     protocol-relative address, in .css and .html files;
#   - an HTML <link> that loads a stylesheet, preloads or preconnects to an
#     external address, or a <script> with an external src.
# Built CSS and HTML (dist, build, out folders) are covered because the scan is of
# the working tree, not of tracked files. docs/ and everything outside packages/
# and apps/ is not scanned: the design prototype imports web fonts. Any error
# inside the check (a missing folder, a grep failure) fails it as well.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

scopes=(packages apps)
for scope in "${scopes[@]}"; do
  if [[ ! -d "$scope" ]]; then
    printf 'external-hosts: %s/ not found under %s\n' "$scope" "$root" >&2
    exit 1
  fi
done

excludes=(--exclude-dir=node_modules --exclude-dir=.turbo --exclude-dir=coverage --exclude-dir=.git)

hosts='fonts\.googleapis\.com|fonts\.gstatic\.com|use\.typekit\.net|p\.typekit\.net|fonts\.adobe\.com|fonts\.bunny\.net|api\.fontshare\.com|cdn\.fontshare\.com|cdn\.fonts\.net|fast\.fonts\.net|use\.fontawesome\.com|kit\.fontawesome\.com|kit-free\.fontawesome\.com|ka-f\.fontawesome\.com|cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|fastly\.jsdelivr\.net|gcore\.jsdelivr\.net|unpkg\.com|esm\.sh|cdn\.skypack\.dev|ajax\.googleapis\.com|ajax\.aspnetcdn\.com|code\.jquery\.com|stackpath\.bootstrapcdn\.com|maxcdn\.bootstrapcdn\.com|netdna\.bootstrapcdn\.com|cdn\.tailwindcss\.com|cdn\.statically\.io|cdn\.rawgit\.com|rawgit\.com|raw\.githack\.com|cdn\.jsdelivr\.org'
host_pattern="(^|[^[:alnum:]-])(${hosts})"

# An absolute (http, https) or protocol-relative address as the target of url() or @import.
css_pattern="(url\\([[:space:]]*['\"]?|@import[[:space:]]+(url\\([[:space:]]*)?['\"]?)((https?:)?//)"

# Tags are matched across line breaks (grep -z reads a whole file as one record).
address="[[:space:]]*=[[:space:]]*[\"']?(https?:)?//"
rel_values="(stylesheet|preload|modulepreload|prefetch|preconnect|dns-prefetch)"
link_pattern="<link[^>]*[[:space:]]rel[[:space:]]*=[[:space:]]*[\"']?[^\"'>]*${rel_values}[^>]*[[:space:]]href${address}[^>]*>|<link[^>]*[[:space:]]href${address}[^>]*[[:space:]]rel[[:space:]]*=[[:space:]]*[\"']?[^\"'>]*${rel_values}[^>]*>"
script_pattern="<script[^>]*[[:space:]]src${address}[^>]*>"

status=0

# Runs a grep that prints hits; exit 1 means no hit, anything above that is a failure.
report() {
  local label="$1"
  shift
  local rc=0 hits
  hits="$("$@")" || rc=$?
  case "$rc" in
    0)
      printf 'external host (%s):\n%s\n' "$label" "$hits"
      status=1
      ;;
    1) ;;
    *)
      printf 'external-hosts: grep failed (exit %s) for %s\n' "$rc" "$label" >&2
      status=1
      ;;
  esac
}

report "font or CDN host" \
  grep -rnIiE "${excludes[@]}" -e "$host_pattern" "${scopes[@]}"

report "absolute address in CSS" \
  grep -rnIiE "${excludes[@]}" --include='*.css' --include='*.html' --include='*.htm' -e "$css_pattern" "${scopes[@]}"

# -z reads each file as one record, so a tag may span lines; -o prints only the
# matched tag and a NUL ends each hit. pipefail keeps grep's own exit code.
# shellcheck disable=SC2317  # run through report
html_tags() {
  grep -rzIioE "${excludes[@]}" --include='*.html' --include='*.htm' -e "$link_pattern" -e "$script_pattern" "${scopes[@]}" |
    tr '\0' '\n'
}

report "external <link> or <script> in HTML" html_tags

exit "$status"
