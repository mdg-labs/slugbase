#!/usr/bin/env bash
# Tests scripts/release-tag.sh with a stub for the GitHub CLI: the stub records its
# arguments and the token it was given, and answers the tag lookup and the tag
# creation as the test asks, so no request leaves this machine. It also checks the
# order of the steps in .github/workflows/release.yml: the tag exists before the
# draft release is created from it.
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

mkdir -p "$tmp/bin"
cat > "$tmp/bin/gh" <<'STUB'
#!/usr/bin/env bash
# A stand-in for `gh api`: one line of arguments per call and the token it got.
# The lookup of a ref answers as STUB_REF says: absent (HTTP 404, the default),
# commit or annotated (a ref to a tag object, read through the tags endpoint) or
# error (HTTP 500). STUB_REF_SHA is the commit; STUB_CREATE_EXIT is the exit
# status of the creation, and STUB_REF_AFTER_CREATE_FAIL makes the ref exist
# from the first failed creation on, as if another run had made it.
printf '%s\n' "$*" >> "$STUB_DIR/args"
printf '%s' "${GH_TOKEN:-}" > "$STUB_DIR/token"
args="$*"
ref="${STUB_REF:-absent}"
if [[ "$args" == *"--method POST"* ]]; then
  if [[ "${STUB_CREATE_EXIT:-0}" != 0 ]]; then
    : > "$STUB_DIR/create-failed"
    echo 'gh: Reference already exists (HTTP 422)' >&2
  fi
  exit "${STUB_CREATE_EXIT:-0}"
fi
if [[ "$args" == "api repos/"*"/git/tags/"* ]]; then
  printf '%s\n' "${STUB_REF_SHA:-}"
  exit 0
fi
if [[ "$args" == "api repos/"*"/git/ref/tags/"* ]]; then
  if [[ -f "$STUB_DIR/create-failed" && -n "${STUB_REF_AFTER_CREATE_FAIL:-}" ]]; then
    ref="$STUB_REF_AFTER_CREATE_FAIL"
  fi
  case "$ref" in
    absent)
      echo 'gh: Not Found (HTTP 404)' >&2
      exit 1
      ;;
    error)
      echo 'gh: Server Error (HTTP 500)' >&2
      exit 1
      ;;
    annotated)
      printf '{"ref":"refs/tags/x","object":{"type":"tag","sha":"%s"}}\n' "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      ;;
    commit)
      printf '{"ref":"refs/tags/x","object":{"type":"commit","sha":"%s"}}\n' "${STUB_REF_SHA:-}"
      ;;
    blob)
      printf '{"ref":"refs/tags/x","object":{"type":"blob","sha":"%s"}}\n' "${STUB_REF_SHA:-}"
      ;;
  esac
  exit 0
fi
exit 99
STUB
chmod +x "$tmp/bin/gh"

sha="0123456789abcdef0123456789abcdef01234567"
other="fedcba9876543210fedcba9876543210fedcba98"
token="stub-token-value"
tag="v1.0.0-rc.1"

n=0
run_case() {
  n=$((n + 1))
  STUB_DIR="$tmp/case-$n"
  mkdir -p "$STUB_DIR"
  code=0
  out="$(env -i PATH="$tmp/bin:$PATH" STUB_DIR="$STUB_DIR" GH_TOKEN="$token" \
    GITHUB_REPOSITORY="example-org/example-repo" GIT_TAG="$tag" SHA="$sha" "$@" \
    bash "$here/release-tag.sh" 2>&1)" || code=$?
}

pass() {
  printf 'ok: %s\n' "$1"
}

fail() {
  printf 'FAIL: %s\n%s\n' "$1" "$out" >&2
  failures=$((failures + 1))
}

creations() {
  if [[ -f "$STUB_DIR/args" ]]; then grep -c -- '--method POST' "$STUB_DIR/args" || true; else printf '0'; fi
}

expect_created() {
  if ((code == 0)) && [[ "$(creations)" == 1 ]] \
    && grep -q -- "api --method POST repos/example-org/example-repo/git/refs -f ref=refs/tags/${tag} -f sha=${sha}" "$STUB_DIR/args"; then
    pass "$1"
  else
    fail "$1 (exit $code, creations $(creations))"
  fi
}

expect_went_on() {
  if ((code == 0)) && [[ "$(creations)" == 0 ]] && [[ "$out" == *"going on"* ]]; then
    pass "$1"
  else
    fail "$1 (exit $code, creations $(creations))"
  fi
}

expect_refused() {
  local name="$1" words="$2"
  if ((code != 0)) && [[ "$(creations)" == 0 ]] && [[ "$out" == *"$words"* ]]; then
    pass "$name"
  else
    fail "$name (exit $code, creations $(creations))"
  fi
}

run_case
expect_created "a tag that does not exist is created on the pushed commit"
if [[ "$(cat "$STUB_DIR/token")" == "$token" ]] && [[ "$out" != *"$token"* ]]; then
  pass "the token reaches gh and is never printed"
else
  fail "the token handling"
fi

run_case STUB_REF=commit STUB_REF_SHA="$sha"
expect_went_on "a lightweight tag on the same commit lets the step go on"

run_case STUB_REF=annotated STUB_REF_SHA="$sha"
expect_went_on "an annotated tag that peels to the same commit lets the step go on"

run_case STUB_REF=commit STUB_REF_SHA="$other"
expect_refused "a tag on another commit fails" "$tag"
if [[ "$out" == *"$other"* && "$out" == *"$sha"* ]]; then
  pass "the failure names both commits"
else
  fail "the failure does not name both commits"
fi

run_case STUB_REF=annotated STUB_REF_SHA="$other"
expect_refused "an annotated tag on another commit fails" "$other"

run_case STUB_REF=error
expect_refused "an API error on the lookup is not read as a free tag" "did not complete"

run_case STUB_REF=blob STUB_REF_SHA="$sha"
expect_refused "a tag that points at no commit fails" "not a commit"

run_case STUB_CREATE_EXIT=1
if ((code != 0)) && [[ "$out" == *"could not be created"* ]]; then
  pass "a refused creation fails the step"
else
  fail "a refused creation (exit $code)"
fi

run_case STUB_CREATE_EXIT=1 STUB_REF_AFTER_CREATE_FAIL=commit STUB_REF_SHA="$sha"
if ((code == 0)) && [[ "$out" == *"going on"* ]]; then
  pass "a tag made by another run on the same commit meanwhile lets the step go on"
else
  fail "the race on the same commit (exit $code)"
fi

run_case STUB_CREATE_EXIT=1 STUB_REF_AFTER_CREATE_FAIL=commit STUB_REF_SHA="$other"
if ((code != 0)) && [[ "$out" == *"$other"* ]]; then
  pass "a tag made by another run on another commit meanwhile fails the step"
else
  fail "the race on another commit (exit $code)"
fi

run_case SHA="not-a-commit"
expect_refused "a malformed commit is refused before any call" "SHA"
if [[ ! -f "$STUB_DIR/args" ]]; then pass "a malformed commit makes no API call"; else fail "an API call was made"; fi

run_case GIT_TAG='v1.0.0; echo x'
expect_refused "a malformed tag is refused" "GIT_TAG"

# The workflow: the tag is made after the push and before the draft, and the
# draft is made from that tag.
wf="$root/.github/workflows/release.yml"
out="$wf"
code_lines="$(grep -vE '^[[:space:]]*#' "$wf")"
push_line="$(grep -n 'name: Build and push' <<<"$code_lines" | head -1 | cut -d: -f1 || true)"
tag_line="$(grep -n 'bash scripts/release-tag.sh' <<<"$code_lines" | head -1 | cut -d: -f1 || true)"
draft_line="$(grep -n 'gh release create' <<<"$code_lines" | head -1 | cut -d: -f1 || true)"
if [[ -n "$push_line" && -n "$tag_line" && -n "$draft_line" ]] && ((push_line < tag_line && tag_line < draft_line)); then
  pass "release.yml creates the tag after the push and before the draft"
else
  fail "release.yml step order (push ${push_line:-none}, tag ${tag_line:-none}, draft ${draft_line:-none})"
fi
if grep -q -- '--verify-tag' <<<"$code_lines" && grep -q -- '--draft' <<<"$code_lines"; then
  pass "release.yml creates the draft from the existing tag"
else
  fail "release.yml does not pass --verify-tag with --draft"
fi
if ! grep -q -- '--target' <<<"$code_lines"; then
  pass "release.yml names no target: the tag fixes the commit"
else
  fail "release.yml still passes --target"
fi

if ((failures > 0)); then
  printf '%s test(s) failed\n' "$failures" >&2
  exit 1
fi
