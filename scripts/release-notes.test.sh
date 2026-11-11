#!/usr/bin/env bash
# Tests scripts/release-notes.sh, which writes the body of the draft GitHub
# Release, in a throwaway copy of the repository layout (the script finds
# docs/releases/ next to its own scripts/ directory). It checks a version with a
# notes file and one without, the frontmatter, the refusals, and, with stand-ins
# for gh and docker, that scripts/release-publish.sh reads the build's digest from
# a body whose notes carry digest-like text. It also generates the body for the
# real docs/releases/1.0.0.md. Nothing leaves this machine.
# Fixtures hold shell syntax that must stay literal.
# shellcheck disable=SC2016
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
failures=0
out=""
code=0

image="ghcr.io/mdg-labs/slugbase"
digest="sha256:$(printf 'a%.0s' {1..64})"
other="sha256:$(printf 'b%.0s' {1..64})"
sha="$(printf 'c%.0s' {1..40})"

pass() { printf 'ok: %s\n' "$1"; }
fail() {
  printf 'FAIL: %s\n%s\n' "$1" "$out" >&2
  failures=$((failures + 1))
}

# The body the build wrote before it read any notes file.
image_lines() {
  cat <<LINES
Image: $image@$digest

Tags: $image:$1

Publishing this release points the tags latest and <major>.<minor> at this image after the signature is verified again. A pre-release moves neither.

Built from $sha with an SPDX SBOM and provenance attestations. The image and both attestations are signed with cosign, keyless, by the release workflow of this repository on main.

Verify the image before you run it, with scripts/verify-image.sh from this release: bash scripts/verify-image.sh $image@$digest
LINES
}

# A repository layout with the script in it, and a fresh output file. Sets repo and body.
n=0
make_repo() {
  n=$((n + 1))
  repo="$tmp/repo-$n"
  mkdir -p "$repo/scripts" "$repo/docs/releases"
  cp "$root/scripts/release-notes.sh" "$repo/scripts/release-notes.sh"
  body="$tmp/body-$n.md"
}

# Runs the script as the workflow does, with a clean environment.
run_notes() {
  local version="$1"
  shift
  code=0
  out="$(cd "$repo" && env -i PATH="$PATH" HOME="$tmp" VERSION="$version" IMAGE="$image" DIGEST="$digest" \
    TAGS="$image:$version" SHA="$sha" "$@" bash "$repo/scripts/release-notes.sh" "$body" 2>&1)" || code=$?
}

# A version without a notes file: the body is the image lines and nothing else.
make_repo
run_notes 1.0.0-rc.2
if ((code == 0)) && [[ "$(cat "$body")" == "$(image_lines 1.0.0-rc.2)" ]]; then
  pass "a version without a notes file gets the image lines alone"
else
  fail "no notes file (exit $code)"
fi

# A version with a notes file: the notes first, without the frontmatter, then the image lines.
make_repo
cat > "$repo/docs/releases/1.2.0.md" <<'NOTES'
---
title: "SlugBase 1.2.0"
description: "What is new."
edition: ce
since: 1.2.0
---

First line of the notes.

- A list item.
NOTES
run_notes 1.2.0
expected="$(printf 'First line of the notes.\n\n- A list item.\n\n---\n\n%s\n' "$(image_lines 1.2.0)")"
if ((code == 0)) && [[ "$(cat "$body")" == "$expected" ]]; then
  pass "a version with a notes file gets its notes, without the frontmatter, then the image lines"
else
  fail "notes file (exit $code)"
fi
if ! grep -qE '^(title|description|edition|since):' "$body" && [[ "$(grep -c '^Image: ' "$body")" == 1 ]]; then
  pass "no frontmatter field reaches the body, and the body names one image"
else
  fail "frontmatter fields in the body"
fi

# The notes of another version are not used.
make_repo
printf -- '---\ntitle: "x"\ndescription: "x"\nedition: ce\n---\n\nNotes of 1.2.0.\n' > "$repo/docs/releases/1.2.0.md"
run_notes 1.2.1
if ((code == 0)) && [[ "$(cat "$body")" == "$(image_lines 1.2.1)" ]]; then
  pass "only the notes file of the built version is used"
else
  fail "another version's notes (exit $code)"
fi

# Windows line endings and a byte order mark are read like plain text.
make_repo
printf '\xEF\xBB\xBF---\r\ntitle: "x"\r\ndescription: "x"\r\nedition: ce\r\n---\r\n\r\nCRLF notes.\r\n' > "$repo/docs/releases/1.3.0.md"
run_notes 1.3.0
if ((code == 0)) && [[ "$(head -1 "$body")" == "CRLF notes." ]] && ! grep -q $'\r' "$body"; then
  pass "a notes file with CRLF and a byte order mark loses neither its text nor its frontmatter"
else
  fail "CRLF notes (exit $code)"
fi

# Refusals: nothing is written, and the reason is named.
expect_refused() {
  local name="$1" words="$2"
  if ((code != 0)) && grep -q -- "release-notes: refused" <<<"$out" && grep -qF -- "$words" <<<"$out" && [[ ! -e "$body" ]]; then
    pass "$name"
  else
    fail "$name (exit $code)"
  fi
}

make_repo
printf -- '---\ntitle: "x"\ndescription: "x"\nedition: ce\n---\n\nText.\n%s\n' "Image: $image@$other" > "$repo/docs/releases/1.4.0.md"
run_notes 1.4.0
expect_refused "notes with a line that names an image digest are refused" 'starts with "Image:"'

make_repo
printf -- '---\ntitle: "x"\ndescription: "x"\nedition: ce\n---\n\nText.\r\nImage: elsewhere/app@%s\r\n' "$other" > "$repo/docs/releases/1.4.1.md"
run_notes 1.4.1
expect_refused "an Image line with a carriage return, for another image, is refused too" 'starts with "Image:"'

make_repo
printf 'Just text.\n' > "$repo/docs/releases/1.5.0.md"
run_notes 1.5.0
expect_refused "notes without frontmatter are refused" "no frontmatter"

make_repo
printf -- '---\ntitle: "x"\n\nText.\n' > "$repo/docs/releases/1.5.1.md"
run_notes 1.5.1
expect_refused "notes with an unclosed frontmatter are refused" "not closed"

make_repo
printf -- '---\ntitle: "x"\ndescription: "x"\nedition: ce\n---\n\n   \n' > "$repo/docs/releases/1.5.2.md"
run_notes 1.5.2
expect_refused "notes with no body are refused" "no body"

make_repo
mkdir "$repo/docs/releases/1.5.3.md"
run_notes 1.5.3
expect_refused "a notes path that is not a readable file is refused" "cannot be read"

make_repo
run_notes "1.0.0/../x"
expect_refused "a version that is not semver is refused" "not semver"

make_repo
run_notes 1.0.0 DIGEST="sha256:abc"
expect_refused "a digest that is not 64 hex digits is refused" "DIGEST"

make_repo
run_notes 1.0.0 TAGS=
expect_refused "a missing input is refused" "TAGS"

# The body, read by scripts/release-publish.sh, still names the digest of the build.
# The notes carry a bare sha256 of another image and an "Image:" that is not at the
# start of a line. The stand-ins stop the run at the signature check, after the
# script has printed the digest it read from the notes.
mkdir -p "$tmp/bin"
cat > "$tmp/bin/gh" <<'STUB'
#!/usr/bin/env bash
if [[ "$*" == *"/releases?"* ]]; then
  jq -c '[.]' "$STUB_DIR/release.json"
else
  cat "$STUB_DIR/release.json"
fi
STUB
cat > "$tmp/bin/docker" <<'STUB'
#!/usr/bin/env bash
echo "ERROR: $4: not found" >&2
exit 1
STUB
chmod +x "$tmp/bin/gh" "$tmp/bin/docker"

make_repo
cat > "$repo/docs/releases/1.6.0.md" <<NOTES
---
title: "x"
description: "x"
edition: ce
---

Pin it with sha256:$other, or with the line "Image: $image@$other" in an older release.
    Image: $image@$other
NOTES
run_notes 1.6.0
if ((code != 0)); then fail "notes with digest-like text (exit $code)"; fi
export STUB_DIR="$tmp/stub-publish"
mkdir -p "$STUB_DIR"
jq -n --rawfile body "$body" '{tag_name: "v1.6.0", draft: false, prerelease: false, body: $body}' > "$STUB_DIR/release.json"
out="$(env -i PATH="$tmp/bin:$PATH" HOME="$tmp" STUB_DIR="$STUB_DIR" GITHUB_REPOSITORY=mdg-labs/slugbase RELEASE_TAG=v1.6.0 \
  bash "$here/release-publish.sh" --dry-run 2>&1)" || true
if grep -qF "release-publish: verifying $image:1.6.0 against $digest" <<<"$out" && ! grep -qF "$other" <<<"$out"; then
  pass "release-publish.sh reads the build's digest from a body whose notes carry digest-like text"
else
  fail "release-publish.sh and a body with digest-like notes"
fi

# The real notes of 1.0.0 produce a body that names the digest once.
real="$tmp/body-real.md"
code=0
out="$(env -i PATH="$PATH" HOME="$tmp" VERSION=1.0.0 IMAGE="$image" DIGEST="$digest" TAGS="$image:1.0.0" SHA="$sha" \
  bash "$here/release-notes.sh" "$real" 2>&1)" || code=$?
if ((code == 0)) && [[ "$(grep -c '^Image: ' "$real")" == 1 ]] && grep -qx "Image: $image@$digest" "$real" \
  && [[ "$(head -c 3 "$real")" != "---" ]] && grep -q '^## What is in 1.0.0$' "$real"; then
  pass "docs/releases/1.0.0.md becomes a draft body that names the image digest once"
else
  fail "the notes of 1.0.0 (exit $code)"
fi

# The workflow builds the draft body with this script, and release.yml has no copy of it.
wf="$root/.github/workflows/release.yml"
code_lines="$(grep -vE '^[[:space:]]*#' "$wf")"
out="$wf"
if grep -qE '^[[:space:]]+bash scripts/release-notes\.sh "\$notes"$' <<<"$code_lines" \
  && grep -qE -- '--notes-file "\$notes"' <<<"$code_lines" \
  && ! grep -qE 'echo "Image: ' <<<"$code_lines"; then
  pass "the draft release step of release.yml takes its notes from scripts/release-notes.sh"
else
  fail "release.yml does not use scripts/release-notes.sh"
fi

if ((failures > 0)); then
  printf '%s test(s) failed\n' "$failures" >&2
  exit 1
fi
