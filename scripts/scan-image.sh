#!/usr/bin/env bash
# Scans the SPDX SBOM of the built image for known vulnerabilities with the pinned
# OSV-Scanner (doc 08 section 6.2, doc 10 T16, Q17) and fails on a High or
# Critical finding that has a fix and that no live allowlist entry covers.
#
#   bash scripts/scan-image.sh <sbom.spdx.json>     scan the SBOM
#   bash scripts/scan-image.sh --canary <sbom>      pass only when the scanner reports
#                                                   a finding in the given SBOM, which
#                                                   shows that it finds something
#   bash scripts/scan-image.sh --filter <json>      apply the policy to a recorded
#                                                   OSV-Scanner JSON result (no scanner)
#   bash scripts/scan-image.sh --install <dir>      download the pinned scanner to
#                                                   <dir>/osv-scanner, checked against
#                                                   its SHA-256
#
# A finding counts as High or Critical when the CVSS base score the scanner reports
# for it is 7.0 or more, or, with no score, when the advisory's own rating is HIGH
# or CRITICAL. It has a fix when an affected entry of the advisory for the finding's
# own ecosystem and package (for Debian, the release and the source package) names a
# fixed version; a fix that exists only for another release or another package does
# not count. A finding without a fix, below High, or with no score and no rating is
# printed and does not fail.
#
# BuildKit names a Debian package by its binary name and the point release of the
# image (pkg:deb/debian/libuuid1@...?distro=debian-12.15&upstream=util-linux), and
# OSV keys its Debian advisories by source package and release (ecosystem Debian:12,
# package util-linux), so the scanner would match none of them. The SBOM is rewritten
# before it is scanned: each Debian package takes its source package, its source
# version when the SBOM gives one, and distro=debian-<major>. A Debian package the
# rewrite cannot read fails the script, and the script prints how many packages of
# each ecosystem it handed to the scanner.
#
# The allowlist (scripts/image-scan-allowlist.json, or IMAGE_SCAN_ALLOWLIST) lists
# reviewed false positives as {"entries": [{"id", "reason", "expires"}]}: the id of
# an advisory (an alias counts), why it does not apply, and the last day (YYYY-MM-DD,
# UTC) the entry holds. It is read and checked before anything is scanned: an entry
# with a missing, empty or unknown field, a date that is not a date, or a date in the
# past fails the script, whether or not a finding still matches it.
#
# Everything unexpected fails: a scanner that is missing, exits with any status but
# 0 (nothing found) or 1 (findings), writes output that is not an OSV-Scanner result,
# or exits 1 without reporting a finding.
#
# Environment:
#   OSV_SCANNER            The scanner binary (default: osv-scanner on PATH).
#   IMAGE_SCAN_ALLOWLIST   The allowlist file (default: scripts/image-scan-allowlist.json).
set -euo pipefail

# Keep in step with the audit job of .github/workflows/ci.yml, which
# scripts/scan-image.test.sh checks.
OSV_SCANNER_VERSION=v2.6.0
OSV_SCANNER_SHA256_AMD64=ca69b3d3cd08f889a49dc0a383122f71cc528b83803671df5fd874d97485b108
OSV_SCANNER_SHA256_ARM64=2c71403eb443d05891c4f268c3ad771cf4f16e5443463fd7851ef8f454d3c7e4

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work_dir=""

say() {
  printf 'scan-image: %s\n' "$*"
}

fail() {
  printf 'scan-image: %s\n' "$*" >&2
  exit 1
}

install_scanner() {
  local dest="$1" arch sha bin
  [[ -n "$dest" ]] || fail "--install needs a directory"
  case "$(uname -m)" in
    x86_64) arch=amd64; sha="$OSV_SCANNER_SHA256_AMD64" ;;
    aarch64) arch=arm64; sha="$OSV_SCANNER_SHA256_ARM64" ;;
    *) fail "unsupported architecture: $(uname -m)" ;;
  esac
  mkdir -p "$dest"
  bin="$dest/osv-scanner"
  curl -fsSL --retry 3 -o "$bin" \
    "https://github.com/google/osv-scanner/releases/download/${OSV_SCANNER_VERSION}/osv-scanner_linux_${arch}"
  echo "${sha}  ${bin}" | sha256sum --check --strict - >/dev/null \
    || { rm -f "$bin"; fail "the downloaded scanner does not match its pinned checksum"; }
  chmod +x "$bin"
  say "installed osv-scanner ${OSV_SCANNER_VERSION} in $dest"
}

# Prints the entries of the allowlist as a JSON array on stdout, or fails.
read_allowlist() {
  local file="${IMAGE_SCAN_ALLOWLIST:-$here/image-scan-allowlist.json}" today entries expires
  [[ -f "$file" ]] || fail "allowlist $file not found"
  jq -e . "$file" >/dev/null 2>&1 || fail "allowlist $file is not valid JSON"
  jq -e '
    type == "object" and (keys == ["entries"]) and (.entries | type == "array")
    and all(.entries[];
      type == "object"
      and (keys == ["expires", "id", "reason"])
      and all(.[]; type == "string")
      and (.id | test("^[A-Za-z0-9][A-Za-z0-9._:-]*$"))
      and (.reason | test("[^[:space:]]"))
      and (.expires | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}$")))
  ' "$file" >/dev/null 2>&1 \
    || fail 'allowlist is malformed: it must be {"entries": [{"id", "reason", "expires"}]} with exactly those three fields on each entry, a plain advisory id, a reason and an expiry date as YYYY-MM-DD'
  today="$(date -u +%F)"
  entries="$(jq -c '.entries' "$file")"
  while IFS= read -r expires; do
    [[ "$(date -u -d "$expires" +%F 2>/dev/null || true)" == "$expires" ]] \
      || fail "allowlist entry expires on $expires, which is not a date"
    if [[ "$expires" < "$today" ]]; then
      fail "allowlist entry for $(jq -r --arg e "$expires" '[.[] | select(.expires == $e) | .id] | join(", ")' <<<"$entries") expired on $expires"
    fi
  done < <(jq -r '.[].expires' <<<"$entries")
  printf '%s\n' "$entries"
}

# Applies the policy to an OSV-Scanner JSON result ($1) with the allowlist entries
# ($2, a JSON array). Prints each finding and fails when one is not covered.
apply_policy() {
  local result="$1" entries="$2" classified failing
  jq -e '(.results | type) == "array"' "$result" >/dev/null 2>&1 \
    || fail "the scanner's output is not an OSV-Scanner result"
  classified="$(jq -c --argjson allow "$entries" '
    def num: if type == "number" then . elif type == "string" then (tonumber? // 0) else 0 end;
    ($allow | map(.id | ascii_upcase)) as $allowed
    | [ .results[]? | .packages[]? | .package as $pkg | (.vulnerabilities // []) as $vulns
        | [ (.groups // [])[] | {ids: (.ids // []), score: .max_severity} ] as $groups
        | ($groups | map(.ids) | add // []) as $covered
        | ($groups + [ $vulns[] | select(.id as $i | $covered | index($i) | not) | {ids: [.id], score: null} ])[]
        | . as $grp
        | [ $vulns[] | select(.id as $i | $grp.ids | index($i)) ] as $recs
        | if ($recs | length) == 0
            then error("the group " + ($grp.ids | join(",")) + " of " + $pkg.name + " has no vulnerability record")
            else . end
        | (($grp.score | num)) as $score
        | ([ $recs[] | .database_specific.severity?, (.affected[]? | .ecosystem_specific.severity?) ]
            | map(select(type == "string") | ascii_upcase)) as $ratings
        | (if $score >= 9 then "critical"
           elif $score >= 7 then "high"
           elif $score > 0 then "below"
           elif ($ratings | index("CRITICAL")) then "critical"
           elif ($ratings | index("HIGH")) then "high"
           else "unscored" end) as $level
        | ([ $recs[] | .affected[]?
              | select((.package.ecosystem? // "") == ($pkg.ecosystem // "")
                       and (.package.name? // "") == $pkg.name)
              | .ranges[]? | .events[]?
              | select(type == "object" and has("fixed")) ]
            | length > 0) as $fixed
        | (([ $grp.ids[], ($recs[] | .id, (.aliases // [])[]) ] | map(ascii_upcase))
            | any(. as $x | $allowed | index($x))) as $allowed_here
        | {package: $pkg.name, version: ($pkg.version // ""), ids: $grp.ids, level: $level,
           score: $score, fixed: $fixed,
           class: (if ($level == "critical" or $level == "high")
                     then (if ($fixed | not) then "nofix" elif $allowed_here then "allowed" else "fail" end)
                   elif $level == "below" then "below"
                   else "unscored" end)} ]
    | unique_by([.package, .version, (.ids | join(","))])
  ' "$result")" || fail "could not read the scanner's output"
  jq -r '.[] | "  \(.class | ascii_upcase)\t\(.package)@\(.version)\t\(.ids | join(","))\t\(.level) (score \(.score))\(if .fixed then ", fix available" else ", no fix" end)"' <<<"$classified"
  failing="$(jq '[.[] | select(.class == "fail")] | length' <<<"$classified")"
  say "$(jq 'length' <<<"$classified") finding(s), $failing failing"
  if ((failing > 0)); then
    printf 'scan-image: %d High or Critical finding(s) with a fix and no live allowlist entry\n' "$failing" >&2
    return 1
  fi
}

# Rewrites the Debian packages of an SPDX document ($1) into the form OSV matches
# (see the header) and writes the result to $2. Fails on a Debian package whose purl
# or distro it cannot read, so that no package is silently left unmatched.
normalise_sbom() {
  jq '
    def urldecode:
      gsub("%(?<h>[0-9A-Fa-f]{2})";
           (.h | ascii_downcase | explode | map(if . >= 97 then . - 87 else . - 48 end)
            | .[0] * 16 + .[1] | [.] | implode));
    def is_deb: .referenceType == "purl" and (.referenceLocator | startswith("pkg:deb/"));
    def deb_parts:
      capture("^pkg:deb/debian/(?<name>[^@?/]+)(@(?<version>[^?]+))?\\?(?<qual>.*)$")
      | (.qual | split("&") | map(split("=") | {key: .[0], value: (.[1:] | join("="))}) | from_entries) as $q
      | ($q.upstream // "" | gsub("%40"; "@") | split("@")) as $up
      | ($q.distro // "" | capture("^debian-(?<major>[0-9]+)(\\.[0-9]+)?$").major) as $major
      | {name: (if ($up[0] // "") != "" then $up[0] else .name end),
         version: (if ($up[1] // "") != "" then $up[1] else .version end),
         arch: ($q.arch // "all"), major: $major}
      | select(.version != null);
    .packages |= map(
      if any(.externalRefs[]?; is_deb) then
        ([.externalRefs[] | select(is_deb) | .referenceLocator | deb_parts]) as $parts
        | if ($parts | length) != 1 then error("a Debian package with an unreadable purl") else . end
        | $parts[0] as $p
        | .externalRefs |= map(
            if is_deb
              then .referenceLocator = "pkg:deb/debian/\($p.name)@\($p.version)?arch=\($p.arch)&distro=debian-\($p.major)"
              else . end)
        | .name = $p.name
        | .versionInfo = ($p.version | urldecode)
      else . end)
  ' "$1" >"$2" 2>/dev/null \
    || fail "a Debian package of the SBOM has a purl or a distro that cannot be read"
}

# Prints how many packages of each ecosystem the SBOM ($1) hands to the scanner.
say_packages() {
  local counts
  counts="$(jq -r '
    [ .packages[]?
      | ([ .externalRefs[]? | select(.referenceType == "purl") | .referenceLocator ][0] // "") as $purl
      | if $purl == "" then "no purl"
        elif ($purl | startswith("pkg:deb/")) then
          "Debian:" + ($purl | capture("distro=debian-(?<m>[0-9]+)").m)
        else ($purl | capture("^pkg:(?<t>[^/]+)/").t) end ]
    | group_by(.) | map("\(length) \(.[0])") | join(", ")
  ' "$1")" || fail "could not count the packages of the SBOM"
  say "scanning the packages of the SBOM: ${counts:-none}"
}

# Runs the scanner on an SBOM ($1) and leaves its JSON in $2. Exit 0 and 1 are the
# scanner's own answers for "nothing found" and "findings"; the status is returned.
# BuildKit writes the SBOM as an in-toto statement whose predicate is the SPDX
# document, which the scanner does not read; the document is taken out of it.
run_scanner() {
  local sbom="$1" out="$2" scanner="${OSV_SCANNER:-osv-scanner}" err code=0 spdx
  [[ -s "$sbom" ]] || fail "the SBOM $sbom is missing or empty"
  command -v "$scanner" >/dev/null 2>&1 || fail "scanner $scanner not found"
  spdx="$work_dir/sbom.spdx.json"
  if jq -e 'type == "object" and (.spdxVersion | type) == "string"' "$sbom" >/dev/null 2>&1; then
    normalise_sbom "$sbom" "$spdx"
  elif jq -e '(.predicate | type) == "object" and (.predicate.spdxVersion | type) == "string"' "$sbom" >/dev/null 2>&1; then
    jq '.predicate' "$sbom" >"$work_dir/predicate.spdx.json"
    normalise_sbom "$work_dir/predicate.spdx.json" "$spdx"
  else
    fail "the SBOM $sbom is not an SPDX document"
  fi
  say_packages "$spdx"
  err="$(mktemp)"
  "$scanner" scan source --format json -L "$spdx" >"$out" 2>"$err" || code=$?
  cat "$err" >&2
  rm -f "$err"
  case "$code" in
    0 | 1) ;;
    *) fail "the scanner exited with status $code" ;;
  esac
  jq -e '(.results | type) == "array"' "$out" >/dev/null 2>&1 \
    || fail "the scanner's output is not an OSV-Scanner result"
  return "$code"
}

count_findings() {
  jq '[.results[]?.packages[]? | select(((.vulnerabilities // []) | length) > 0)] | length' "$1"
}

scan() {
  local sbom="$1" entries code=0
  entries="$(read_allowlist)"
  work_dir="$(mktemp -d)"
  run_scanner "$sbom" "$work_dir/result.json" || code=$?
  if ((code == 1)) && [[ "$(count_findings "$work_dir/result.json")" == 0 ]]; then
    fail "the scanner reported findings but its output holds none"
  fi
  apply_policy "$work_dir/result.json" "$entries"
}

canary() {
  local sbom="$1" code=0
  work_dir="$(mktemp -d)"
  run_scanner "$sbom" "$work_dir/result.json" || code=$?
  ((code == 1)) || fail "the scanner found nothing in $sbom, which names a package with a known vulnerability"
  [[ "$(count_findings "$work_dir/result.json")" != 0 ]] \
    || fail "the scanner exited 1 for $sbom but its output holds no finding"
  say "the scanner finds the known vulnerability in $sbom"
}

filter() {
  local entries
  entries="$(read_allowlist)"
  apply_policy "$1" "$entries"
}

main() {
  trap 'if [[ -n "$work_dir" ]]; then rm -rf "$work_dir"; fi' EXIT
  case "${1:-}" in
    --install) [[ $# -eq 2 ]] || fail "usage: scan-image.sh --install <dir>"; install_scanner "$2" ;;
    --canary) [[ $# -eq 2 ]] || fail "usage: scan-image.sh --canary <sbom>"; canary "$2" ;;
    --filter) [[ $# -eq 2 ]] || fail "usage: scan-image.sh --filter <osv-result.json>"; filter "$2" ;;
    "" | -*) fail "usage: scan-image.sh <sbom.spdx.json> | --canary <sbom> | --filter <result.json> | --install <dir>" ;;
    *) [[ $# -eq 1 ]] || fail "usage: scan-image.sh <sbom.spdx.json>"; scan "$1" ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
