#!/usr/bin/env bash
# Tests scripts/release-check-tags.sh with a stub for docker: the stub records
# every call and answers the registry lookup of each tag as the test asks, so no
# request leaves this machine. It also runs the "Build and push" step of
# .github/workflows/release.yml as written, against the same stub, and proves the
# step pushes nothing when a tag exists or when the registry cannot be asked: the
# step fails without the check (#838).
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
cat > "$tmp/bin/docker" <<'STUB'
#!/usr/bin/env bash
# A stand-in for `docker`: one line of arguments per call.
# `buildx imagetools inspect <ref>` answers as STUB_LOOKUP says for that ref: a
# space-separated list of <suffix>=<answer> pairs matched against the end of the
# ref, where the answer is present (exit 0), absent (the registry's "not found",
# the default), error (a server error, exit 1) or missing (exit 127, as a shell
# says of a command it cannot find). `buildx build` is a push when --push is
# among its arguments; it writes the metadata file the workflow reads.
printf '%s\n' "$*" >> "$STUB_DIR/calls"
if [[ "${1:-}" == "buildx" && "${2:-}" == "imagetools" && "${3:-}" == "inspect" ]]; then
  ref="${4:-}"
  answer="absent"
  for pair in ${STUB_LOOKUP:-}; do
    if [[ "$ref" == *"${pair%%=*}" ]]; then answer="${pair#*=}"; fi
  done
  case "$answer" in
    present) printf 'Name: %s\nMediaType: application/vnd.oci.image.index.v1+json\n' "$ref"; exit 0 ;;
    absent) printf 'ERROR: %s: not found\n' "$ref"; exit 1 ;;
    error) printf 'ERROR: unexpected status from HEAD request: 500 Internal Server Error\n'; exit 1 ;;
    missing) printf 'docker: command not found\n'; exit 127 ;;
  esac
fi
if [[ "${1:-}" == "buildx" && "${2:-}" == "build" ]]; then
  if [[ " $* " == *" --push "* ]]; then
    : > "$STUB_DIR/pushed"
    for arg in "$@"; do
      if [[ "${prev:-}" == "--metadata-file" ]]; then
        printf '{"containerimage.digest":"sha256:%064d"}\n' 1 > "$arg"
      fi
      prev="$arg"
    done
  fi
  exit 0
fi
exit 99
STUB
chmod +x "$tmp/bin/docker"

image="ghcr.io/mdg-labs/slugbase"
final_tags="${image}:1.2.3,${image}:1.2"
rc_tags="${image}:1.0.0-rc.1"

n=0
setup_case() {
  n=$((n + 1))
  STUB_DIR="$tmp/case-$n"
  mkdir -p "$STUB_DIR/runner"
  code=0
}

run_check() {
  setup_case
  out="$(env -i PATH="$tmp/bin:$PATH" STUB_DIR="$STUB_DIR" "$@" \
    bash "$here/release-check-tags.sh" 2>&1)" || code=$?
}

# The "Build and push" step of the workflow, as written, with the environment the
# workflow gives it.
wf="$root/.github/workflows/release.yml"
step_script="$tmp/build-and-push.sh"
awk '
  /^      - name: Build and push$/ { inside = 1; next }
  inside && /^        run: \|$/ { body = 1; next }
  body && /^          / { sub(/^          /, ""); print; next }
  body && /^$/ { print; next }
  body { exit }
' "$wf" > "$step_script"

run_step() {
  setup_case
  out="$(cd "$root" && env -i PATH="$tmp/bin:$PATH" STUB_DIR="$STUB_DIR" RUNNER_TEMP="$STUB_DIR/runner" \
    GITHUB_ENV="$STUB_DIR/github-env" VERSION="1.2.3" BUILD_COMMIT="0123456789abcdef0123456789abcdef01234567" \
    "$@" bash "$step_script" 2>&1)" || code=$?
}

pass() {
  printf 'ok: %s\n' "$1"
}

fail() {
  printf 'FAIL: %s\n%s\n' "$1" "$out" >&2
  failures=$((failures + 1))
}

pushed() {
  [[ -f "$STUB_DIR/pushed" ]]
}

lookups() {
  if [[ -f "$STUB_DIR/calls" ]]; then grep -c 'imagetools inspect' "$STUB_DIR/calls" || true; else printf '0'; fi
}

# The script on its own.
run_check TAGS="$final_tags"
if ((code == 0)) && (($(lookups) == 2)) && grep -qx "buildx imagetools inspect ${image}:1.2" "$STUB_DIR/calls"; then
  pass "no tag in the registry: every tag is looked up and the check passes"
else
  fail "free tags (exit $code, lookups $(lookups))"
fi

run_check TAGS="$final_tags" STUB_LOOKUP="1.2.3=present"
if ((code != 0)) && [[ "$out" == *"${image}:1.2.3 already exists"* && "$out" == *"bump the version"* ]]; then
  pass "an existing version tag is refused, naming the tag and asking for a version bump"
else
  fail "existing version tag (exit $code)"
fi

run_check TAGS="$final_tags" STUB_LOOKUP="1.2.3=absent :1.2=present"
if ((code != 0)) && [[ "$out" == *"${image}:1.2 already exists"* ]]; then
  pass "an existing minor tag is refused, though the version tag is free"
else
  fail "existing minor tag (exit $code)"
fi

run_check TAGS="$rc_tags" STUB_LOOKUP="rc.1=error"
if ((code != 0)) && [[ "$out" == *"could not tell whether ${rc_tags} exists"* ]]; then
  pass "a registry error is not read as a free tag"
else
  fail "registry error (exit $code)"
fi

run_check TAGS="$rc_tags" STUB_LOOKUP="rc.1=missing"
if ((code != 0)) && [[ "$out" == *"could not tell whether"* ]]; then
  pass "a docker that cannot run (command not found) is not read as a free tag"
else
  fail "docker missing (exit $code)"
fi

run_check TAGS=""
if ((code != 0)) && [[ "$out" == *"TAGS is empty"* ]] && (($(lookups) == 0)); then
  pass "an empty tag list is refused"
else
  fail "empty tags (exit $code)"
fi

run_check TAGS="${image}:1.2.3,"
if ((code != 0)) && [[ "$out" == *"empty or malformed"* ]]; then
  pass "an empty entry in the tag list is refused"
else
  fail "empty entry (exit $code)"
fi

# The step as the workflow runs it.
if [[ -s "$step_script" ]] && grep -q -- '--push' "$step_script"; then
  pass "the Build and push step was read from release.yml"
else
  fail "the Build and push step could not be read from release.yml"
fi

run_step TAGS="$final_tags"
if ((code == 0)) && pushed && grep -q '^DIGEST=sha256:' "$STUB_DIR/github-env"; then
  pass "the step pushes when no tag exists"
else
  fail "the step with free tags (exit $code)"
fi

run_step TAGS="$final_tags" STUB_LOOKUP="1.2.3=present"
if ((code != 0)) && ! pushed && [[ "$out" == *"${image}:1.2.3 already exists"* ]]; then
  pass "the step pushes nothing when the version tag exists (a re-run after a published push)"
else
  fail "the step with an existing tag (exit $code, pushed $(pushed && echo yes || echo no))"
fi

run_step TAGS="$final_tags" STUB_LOOKUP="1.2.3=error"
if ((code != 0)) && ! pushed; then
  pass "the step pushes nothing when the registry cannot be asked"
else
  fail "the step with a registry error (exit $code, pushed $(pushed && echo yes || echo no))"
fi

# The workflow: the check is in the step that pushes, before the push.
code_lines="$(grep -vE '^[[:space:]]*#' "$wf")"
check_line="$(grep -n 'bash scripts/release-check-tags.sh' <<<"$code_lines" | head -1 | cut -d: -f1 || true)"
push_line="$(grep -n -- '--push' <<<"$code_lines" | head -1 | cut -d: -f1 || true)"
step_line="$(grep -n 'name: Build and push' <<<"$code_lines" | head -1 | cut -d: -f1 || true)"
tag_line="$(grep -n 'bash scripts/release-tag.sh' <<<"$code_lines" | head -1 | cut -d: -f1 || true)"
if [[ -n "$check_line" && -n "$push_line" && -n "$step_line" && -n "$tag_line" ]] \
  && ((step_line < check_line && check_line < push_line && push_line < tag_line)); then
  pass "release.yml checks the tags in the Build and push step, before the push"
else
  fail "release.yml order (step ${step_line:-none}, check ${check_line:-none}, push ${push_line:-none}, tag ${tag_line:-none})"
fi

if ((failures > 0)); then
  printf '%s test(s) failed\n' "$failures" >&2
  exit 1
fi
