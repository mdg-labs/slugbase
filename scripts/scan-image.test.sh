#!/usr/bin/env bash
# Tests scripts/scan-image.sh without the network: the policy on recorded
# OSV-Scanner results in scripts/fixtures/image-scan/, and the script's handling of
# a scanner that fails, answers nonsense or finds nothing (a stub stands in for the
# scanner). The description of each case says what the script must do.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
script="$here/scan-image.sh"
fx="$here/fixtures/image-scan"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
failures=0
out=""
code=0

run() {
  code=0
  out="$("$@" 2>&1)" || code=$?
}

pass() {
  printf 'ok: %s\n' "$1"
}

fail_test() {
  printf 'FAIL: %s\n%s\n' "$1" "$out" >&2
  failures=$((failures + 1))
}

expect_ok() {
  if ((code == 0)); then pass "$1"; else fail_test "$1 (exit $code, expected 0)"; fi
}

expect_failed() {
  if ((code != 0)); then pass "$1"; else fail_test "$1 (exit 0, expected non-zero)"; fi
}

expect_text() {
  if [[ "$out" == *"$2"* ]]; then pass "$1"; else fail_test "$1 (the output lacks: $2)"; fi
}

# filter <result fixture> <allowlist fixture>
filter() {
  IMAGE_SCAN_ALLOWLIST="$fx/$2" bash "$script" --filter "$fx/$1"
}

# A stub scanner: prints the given file, exits with the given status, and records
# its arguments.
stub() {
  local name="$1" status="$2" output="$3"
  cat >"$tmp/$name" <<STUB
#!/usr/bin/env bash
printf '%s\n' "\$@" >"$tmp/$name.args"
if [[ -n "$output" ]]; then cat "$output"; fi
exit $status
STUB
  chmod +x "$tmp/$name"
}

# with_stub <stub> <allowlist fixture> <sbom> [flag]
with_stub() {
  OSV_SCANNER="$tmp/$1" IMAGE_SCAN_ALLOWLIST="$fx/$2" bash "$script" ${4:+"$4"} "$3"
}

cp "$fx/canary.spdx.json" "$tmp/sbom.spdx.json"
: >"$tmp/empty.spdx.json"

# The policy.
run filter high-with-fix.osv.json allowlist-empty.json
expect_failed "a High finding with a fix fails"
expect_text "the failing finding is named" "GHSA-aaaa-bbbb-cccc"

run filter high-with-fix.osv.json allowlist-live-id.json
expect_ok "the same finding passes with a live entry for its id"
expect_text "an allowed finding is printed" "ALLOWED"

run filter high-with-fix.osv.json allowlist-live-alias.json
expect_ok "a live entry for an alias of the advisory covers it"

run filter high-with-fix.osv.json allowlist-live-other.json
expect_failed "a live entry for another advisory does not cover it"

run filter high-with-fix.osv.json allowlist-expired.json
expect_failed "an expired entry fails, and the finding is not covered"
expect_text "the expired entry is named" "expired on 2000-01-01"

run filter none.osv.json allowlist-expired-unmatched.json
expect_failed "an expired entry fails when no finding matches it"

run filter none.osv.json allowlist-live-and-expired.json
expect_failed "one expired entry among live ones fails"

run filter critical-no-fix.osv.json allowlist-empty.json
expect_ok "a Critical finding without a fix passes"
expect_text "a finding without a fix is printed" "NOFIX"

run filter medium-with-fix.osv.json allowlist-empty.json
expect_ok "a Medium finding with a fix passes"
expect_text "a finding below High is printed" "BELOW"

run filter unscored-high-with-fix.osv.json allowlist-empty.json
expect_failed "a finding with no score and a HIGH rating, with a fix, fails"

run filter unscored-no-rating.osv.json allowlist-empty.json
expect_ok "a finding with neither score nor rating passes"
expect_text "an unscored finding is printed" "UNSCORED"

run filter debian-fix-in-release.osv.json allowlist-empty.json
expect_failed "a Debian finding with a fix in its own release fails"

run filter debian-fix-in-release.osv.json allowlist-live-debian.json
expect_ok "the same Debian finding passes with a live entry for its id"

run filter debian-fix-other-release.osv.json allowlist-empty.json
expect_ok "a Debian finding fixed only in another release, or for another package, passes"
expect_text "that finding is reported as having no fix" "NOFIX"

run filter duplicate-package.osv.json allowlist-empty.json
expect_text "a package the result lists twice is counted once" "1 finding(s), 1 failing"

run filter no-groups.osv.json allowlist-empty.json
expect_failed "a vulnerability that no group names is still judged"

run filter none.osv.json allowlist-empty.json
expect_ok "a result without findings passes"

run filter group-without-record.osv.json allowlist-empty.json
expect_failed "a group with no vulnerability record fails"

run filter no-results.osv.json allowlist-empty.json
expect_failed "a result without a results list fails"

run filter not-json.osv.json allowlist-empty.json
expect_failed "output that is not JSON fails"

# The allowlist is checked as a whole, before anything is read.
for name in no-reason blank-reason no-expires no-id extra-key bad-date date-format not-array bare-array not-json; do
  run filter none.osv.json "allowlist-$name.json"
  expect_failed "an allowlist that is malformed ($name) fails"
done
run env IMAGE_SCAN_ALLOWLIST="$tmp/missing.json" bash "$script" --filter "$fx/none.osv.json"
expect_failed "a missing allowlist fails"

# The scan, with a stub for the scanner.
stub clean 0 "$fx/none.osv.json"
stub found 1 "$fx/high-with-fix.osv.json"
stub found-below 1 "$fx/medium-with-fix.osv.json"
stub found-nothing 1 "$fx/none.osv.json"
stub broken 127 ""
stub failed-with-output 127 "$fx/none.osv.json"
cat >"$tmp/needs-spdx" <<STUB
#!/usr/bin/env bash
jq -e '.spdxVersion' "\$6" >/dev/null || exit 3
cat "$fx/high-with-fix.osv.json"
exit 1
STUB
chmod +x "$tmp/needs-spdx"
cat >"$tmp/records-spdx" <<STUB
#!/usr/bin/env bash
cp "\$6" "$tmp/seen.spdx.json"
cat "$fx/none.osv.json"
STUB
chmod +x "$tmp/records-spdx"
sed 's/none.osv.json/high-with-fix.osv.json/' "$tmp/records-spdx" >"$tmp/records-spdx-found"
printf 'exit 1\n' >>"$tmp/records-spdx-found"
chmod +x "$tmp/records-spdx-found"
stub garbled 0 "$fx/not-json.osv.json"
stub garbled-found 1 "$fx/not-json.osv.json"

run with_stub clean allowlist-empty.json "$tmp/sbom.spdx.json"
expect_ok "a scan with nothing found passes"
args="$(tr '\n' ' ' <"$tmp/clean.args")"
if [[ "$args" == "scan source --format json -L "*"/sbom.spdx.json " ]]; then pass "the scanner is called on the SBOM"; else out="$args"; fail_test "the scanner is called on the SBOM"; fi

run with_stub found allowlist-empty.json "$tmp/sbom.spdx.json"
expect_failed "a scan that finds a High finding with a fix fails"

run with_stub found allowlist-live-id.json "$tmp/sbom.spdx.json"
expect_ok "the scan passes with a live allowlist entry"

run with_stub found allowlist-expired.json "$tmp/sbom.spdx.json"
expect_failed "the scan fails with an expired entry"

run with_stub found-below allowlist-empty.json "$tmp/sbom.spdx.json"
expect_ok "a scan that finds only a finding below High passes"

run with_stub found-nothing allowlist-empty.json "$tmp/sbom.spdx.json"
expect_failed "a scanner that exits 1 and reports no finding fails"

run with_stub broken allowlist-empty.json "$tmp/sbom.spdx.json"
expect_failed "a scanner that fails fails the scan"

run with_stub failed-with-output allowlist-empty.json "$tmp/sbom.spdx.json"
expect_failed "a scanner that fails fails the scan even when it wrote a result"

run with_stub garbled allowlist-empty.json "$tmp/sbom.spdx.json"
expect_failed "a scanner whose output is not a result fails the scan"

run with_stub garbled-found allowlist-empty.json "$tmp/sbom.spdx.json"
expect_failed "a scanner that exits 1 with output that is not a result fails the scan"

run with_stub needs-spdx allowlist-live-id.json "$fx/canary.spdx.json"
expect_ok "the scanner gets an SPDX document as it is"

run with_stub needs-spdx allowlist-live-id.json "$fx/canary-statement.spdx.json"
expect_ok "the scanner gets the SPDX document of the in-toto statement BuildKit writes"

run with_stub needs-spdx allowlist-empty.json "$fx/canary-statement.spdx.json"
expect_failed "a finding in a wrapped SBOM fails the scan"

# The Debian packages of BuildKit's SBOM are rewritten into what OSV matches: the
# source package, its version when the SBOM gives one, and the major release.
run with_stub records-spdx allowlist-empty.json "$fx/debian-forms.spdx.json"
expect_ok "an SBOM with Debian packages is scanned"
expect_text "the packages handed to the scanner are counted by ecosystem" "4 Debian:12, 1 npm"
purls="$(jq -r '.packages[] | "\(.name) \(.versionInfo) \(.externalRefs[0].referenceLocator)"' "$tmp/seen.spdx.json")"
want='util-linux 2.38.1-5+deb12u3 pkg:deb/debian/util-linux@2.38.1-5%2Bdeb12u3?arch=amd64&distro=debian-12
libcap-ng 0.8.3-1 pkg:deb/debian/libcap-ng@0.8.3-1?arch=amd64&distro=debian-12
dash 0.5.12-2 pkg:deb/debian/dash@0.5.12-2?arch=amd64&distro=debian-12
adduser 3.134 pkg:deb/debian/adduser@3.134?arch=all&distro=debian-12
lodash 4.17.15 pkg:npm/lodash@4.17.15'
if [[ "$purls" == "$want" ]]; then pass "each Debian package is named by its source package and release"; else out="$purls"; fail_test "each Debian package is named by its source package and release"; fi

run with_stub records-spdx allowlist-empty.json "$fx/debian-bad-distro.spdx.json"
expect_failed "a Debian package whose distro is not a release number fails the scan"

run with_stub records-spdx allowlist-empty.json "$fx/debian-no-version.spdx.json"
expect_failed "a Debian package without a version fails the scan"

run with_stub records-spdx allowlist-empty.json "$fx/canary-statement.spdx.json"
expect_ok "the packages of a wrapped SBOM are counted too"
expect_text "an npm package is counted" "1 npm"

run with_stub records-spdx allowlist-empty.json "$fx/canary-debian-statement.spdx.json"
expect_ok "a wrapped SBOM with a Debian package is scanned"
seen="$(jq -r '.packages[0].externalRefs[0].referenceLocator' "$tmp/seen.spdx.json")"
if [[ "$seen" == "pkg:deb/debian/openssl@3.0.11-1~deb12u1?arch=amd64&distro=debian-12" ]]; then pass "a Debian package of a wrapped SBOM is rewritten too"; else out="$seen"; fail_test "a Debian package of a wrapped SBOM is rewritten too"; fi

run with_stub clean allowlist-empty.json "$fx/not-spdx.json"
expect_failed "a file that is not an SPDX document fails the scan"

run with_stub needs-spdx allowlist-empty.json "$fx/canary-statement.spdx.json" --canary
expect_ok "the canary reads a wrapped SBOM too"

run with_stub clean allowlist-empty.json "$tmp/empty.spdx.json"
expect_failed "an empty SBOM fails the scan"

run with_stub clean allowlist-empty.json "$tmp/missing.spdx.json"
expect_failed "a missing SBOM fails the scan"

run env OSV_SCANNER="$tmp/no-such-scanner" bash "$script" "$tmp/sbom.spdx.json"
expect_failed "a missing scanner fails the scan"

rm -f "$tmp/clean.args"
run with_stub clean allowlist-no-reason.json "$tmp/sbom.spdx.json"
expect_failed "a malformed allowlist fails the scan"
if [[ ! -e "$tmp/clean.args" ]]; then pass "a malformed allowlist is refused before the scanner runs"; else fail_test "a malformed allowlist is refused before the scanner runs"; fi

# The canary: the scanner must find the known vulnerability in the fixture SBOM.
run with_stub found allowlist-empty.json "$fx/canary.spdx.json" --canary
expect_ok "the canary passes when the scanner reports a finding"

run with_stub clean allowlist-empty.json "$fx/canary.spdx.json" --canary
expect_failed "the canary fails when the scanner finds nothing"

run with_stub found-nothing allowlist-empty.json "$fx/canary.spdx.json" --canary
expect_failed "the canary fails when the scanner exits 1 and reports nothing"

run with_stub broken allowlist-empty.json "$fx/canary.spdx.json" --canary
expect_failed "the canary fails when the scanner fails"

run with_stub found allowlist-empty.json "$fx/canary-debian.spdx.json" --canary
expect_ok "the Debian canary passes when the scanner reports a finding"

run with_stub records-spdx-found allowlist-empty.json "$fx/canary-debian.spdx.json" --canary
expect_ok "the canary scans a Debian package under the source package and release OSV knows"
seen="$(jq -r '.packages[0].externalRefs[0].referenceLocator' "$tmp/seen.spdx.json")"
if [[ "$seen" == "pkg:deb/debian/openssl@3.0.11-1~deb12u1?arch=amd64&distro=debian-12" ]]; then pass "the Debian canary reaches the scanner rewritten"; else out="$seen"; fail_test "the Debian canary reaches the scanner rewritten"; fi

# The pin of the scanner is the one the audit job of ci.yml downloads.
for key in OSV_SCANNER_VERSION OSV_SCANNER_SHA256_AMD64 OSV_SCANNER_SHA256_ARM64; do
  in_script="$(sed -n "s/^$key=//p" "$script")"
  in_ci="$(sed -n "s/^      $key: //p" "$here/../.github/workflows/ci.yml" | head -n 1)"
  if [[ -n "$in_script" && "$in_script" == "$in_ci" ]]; then
    pass "$key is the pin the audit job uses"
  else
    out="script: $in_script ci.yml: $in_ci"
    fail_test "$key is the pin the audit job uses"
  fi
done

if ((failures > 0)); then
  printf '%d test(s) failed\n' "$failures" >&2
  exit 1
fi
