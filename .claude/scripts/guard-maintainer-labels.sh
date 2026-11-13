#!/usr/bin/env bash
# PreToolUse hook on Bash: refuses a `gh` command that adds a label only the
# maintainer applies — workflow.json labels.maintainerOnly, and every
# labels.extra entry marked maintainerApplied. Agents call GitHub with the
# maintainer's own credential, so a label added by an agent shows the
# maintainer as its actor, and a CI gate that reads it as the maintainer's
# approval (e.g. migration:contract) could not tell the difference.
#
# Covers `gh issue|pr create --label/-l`, `gh issue|pr edit --add-label`, and
# `gh api` with a `labels[]=`/`labels=` field. Compared case-insensitively,
# as GitHub matches label names. Removing such a label stays allowed. A
# guard against accidents, not a security boundary: a body sent with
# `gh api --input`, or any other client using the same credential, can
# still apply the label.
#
# Reads the hook's JSON on stdin; exit 2 with a reason on stderr blocks the
# call, exit 0 lets it through. Registered by setup in .claude/settings.json.
set -euo pipefail

HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=workflow-config.sh
source "$HERE/workflow-config.sh"

input=$(cat)
command=$(jq -r 'if .tool_name == "Bash" then .tool_input.command // "" else "" end' <<<"$input" 2>/dev/null || true)
[[ $command == *gh* ]] || exit 0

labels=$(wf_get_json '[ (.labels.maintainerOnly.name // empty),
  ((.labels.extra // [])[] | select(.maintainerApplied == true) | .name) ]' '[]' 2>/dev/null || echo '[]')
[[ $labels != '[]' ]] || exit 0

# shellcheck disable=SC2016
python3 -I -c '
import json, os, re, shlex, sys

command, labels = sys.argv[1], json.loads(sys.argv[2])
protected = {l.lower(): l for l in labels}
SEPARATORS = {";", "&&", "||", "|", "&", "(", ")"}
ADD_FLAGS = {"--label", "-l", "--add-label"}

def tokens(text):
    lex = shlex.shlex(text.replace("\\\n", " "), posix=True, punctuation_chars=";&|()")
    lex.whitespace_split = True
    lex.commenters = ""
    return list(lex)

def segments(toks):
    seg = []
    for t in toks:
        if t in SEPARATORS:
            if seg:
                yield seg
            seg = []
        else:
            seg.append(t)
    if seg:
        yield seg

def added_labels(seg):
    # Skips leading VAR=value assignments and wrappers such as `command`.
    while seg and (re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", seg[0]) or seg[0] in ("command", "exec", "env", "time")):
        seg = seg[1:]
    if not seg or os.path.basename(seg[0]) != "gh":
        return []
    args, found = seg[1:], []
    if len(args) >= 2 and args[0] in ("issue", "pr") and args[1] in ("create", "edit"):
        i = 2
        while i < len(args):
            a = args[i]
            if a in ADD_FLAGS and i + 1 < len(args):
                found += args[i + 1].split(","); i += 2; continue
            for f in ADD_FLAGS:
                if f.startswith("--") and a.startswith(f + "="):
                    found += a[len(f) + 1:].split(",")
            if a.startswith("-l") and len(a) > 2 and not a.startswith("--"):
                found += a[2:].split(",")
            i += 1
    elif args and args[0] == "api":
        for a in args[1:]:
            m = re.match(r"^labels(\[\])?=(.*)$", a, re.S)
            if m:
                found += m.group(2).split(",")
    return [f.strip() for f in found]

try:
    segs = list(segments(tokens(command)))
except ValueError:
    # Unbalanced quotes: fall back to the whole command, one word at a time.
    segs = [command.split()]
hits = sorted({l for seg in segs for l in added_labels(seg) if l.lower() in protected})
if hits:
    sys.stderr.write(
        "guard-maintainer-labels: refusing to add %s: only the maintainer applies %s "
        "(workflow.json labels.maintainerOnly / maintainerApplied). Ask the maintainer to add it.\n"
        % (", ".join(hits), "it" if len(hits) == 1 else "them"))
    sys.exit(2)
' "$command" "$labels"
