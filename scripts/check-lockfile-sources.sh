#!/usr/bin/env bash
# Fails when a package of pnpm-lock.yaml resolves from anywhere but the
# configured registry (doc 10 section 2.11, T16). pnpm takes each `resolution`
# of a frozen lockfile as written, so a tarball URL, a git source or a
# directory with a matching integrity would install and ship in the image, and
# neither the audit nor automated review reads the lockfile for it. Every
# resolution must be exactly the integrity-only flow mapping pnpm writes for a
# registry package:
#
#   resolution: {integrity: sha512-<base64>}
#
# Any line that holds the word `resolution` and is not that exact entry fails:
# block mappings, quoted keys, keys nested in a flow mapping, explicit `?` keys,
# anchors, extra keys such as `tarball`, `type`, `repo`, `directory`. YAML can
# spell a key without writing it at its use (an alias `*k : {...}` of an anchor
# `&k resolution`), so the check does not look for a key in position: the word
# must occur literally on some line, and every such line must be the exact
# registry entry. A backslash anywhere fails too, since a double-quoted key can
# spell the word with an escape. A lockfile with no resolution at all fails.
# Workspace links in the importers are not resolutions and are not checked here.
#
#   bash scripts/check-lockfile-sources.sh [lockfile]    (default: pnpm-lock.yaml)
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
lockfile="${1:-$root/pnpm-lock.yaml}"

if [[ ! -f "$lockfile" ]]; then
  printf 'lockfile-sources: %s not found\n' "$lockfile" >&2
  exit 1
fi

key='resolution'
registry_entry='^[[:space:]]+resolution:[[:space:]]+\{integrity:[[:space:]]+sha(1|256|384|512)-[A-Za-z0-9+/]+={0,2}\}[[:space:]]*$'

status=0
count=0
number=0
while IFS= read -r line || [[ -n "$line" ]]; do
  number=$((number + 1))
  if [[ "$line" == *\\* ]]; then
    printf 'lockfile-sources: %s: line %d holds a backslash: %s\n' "$lockfile" "$number" "${line#"${line%%[![:space:]]*}"}" >&2
    status=1
    continue
  fi
  [[ "$line" =~ $key ]] || continue
  count=$((count + 1))
  if [[ ! "$line" =~ $registry_entry ]]; then
    printf 'lockfile-sources: %s: line %d is not an integrity-only registry resolution: %s\n' "$lockfile" "$number" "${line#"${line%%[![:space:]]*}"}" >&2
    status=1
  fi
done < "$lockfile"

if ((count == 0)); then
  printf 'lockfile-sources: no resolution found in %s\n' "$lockfile" >&2
  exit 1
fi

exit "$status"
