#!/usr/bin/env python3
"""File docs/roadmap.md on GitHub as epics and sub-issues, then delete it.

The roadmap is a one-shot seed. Once every entry is an issue, the issues are
the plan and this file is removed (it stays in git history, so the script only
runs against a committed file). Epic membership, ordering and phases are
GitHub's native fields (sub-issue parent, blocked-by, milestone), never body
prose.

    scripts/roadmap-sync.py --validate        # parse and validate, no GitHub calls
    scripts/roadmap-sync.py                   # validate and show the plan (dry run)
    scripts/roadmap-sync.py --apply           # create, link, set ready, delete the file
    scripts/roadmap-sync.py --apply --yes     # no confirmation prompt
    scripts/roadmap-sync.py --apply --keep    # do not delete the file afterwards
    scripts/roadmap-sync.py --apply E1.1      # only these entries (and their epics)

Re-running is safe: every issue carries a `<!-- roadmap:ID -->` marker, so an
interrupted run resumes where it stopped and never duplicates.

Exit codes: 0 ok, 1 validation failed, 2 a GitHub call failed.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WORKFLOW = json.loads((ROOT / ".claude" / "workflow.json").read_text())
REPO = WORKFLOW["repo"]
DEFAULT_ROADMAP = ROOT / "docs" / "roadmap.md"

TYPES = {"feat", "bug", "chore", "docs", "spike"}
LABELS_CFG = WORKFLOW.get("labels", {})
AREAS = {a["name"] for a in LABELS_CFG.get("areas", [])}
RISK = (LABELS_CFG.get("risk") or {}).get("name")
MAINTAINER = (LABELS_CFG.get("maintainerOnly") or {}).get("name")
EXTRA = {x["name"] for x in LABELS_CFG.get("extra", [])}
KNOWN = TYPES | AREAS | EXTRA | {n for n in (RISK, MAINTAINER) if n}

FIELD = r"(Summary|Design references|Current state|Acceptance criteria|Out of scope|Scope|Done when|Goal|Product rules)"
FIELD_RE = re.compile(rf"^\*\*{FIELD}\*\*[ \t]*(.*)$")


# --------------------------------------------------------------------------
# gh plumbing (REST only, like .claude/scripts/gh-rest.sh)
# --------------------------------------------------------------------------


class GhError(RuntimeError):
    pass


def gh(method: str, path: str, payload: dict | None = None) -> object:
    args = ["gh", "api", "--method", method, path]
    if payload is not None:
        args += ["--input", "-"]
    for attempt in range(14):
        proc = subprocess.run(
            args, input=json.dumps(payload) if payload is not None else None,
            capture_output=True, text=True, cwd=ROOT,
        )
        if proc.returncode == 0:
            return json.loads(proc.stdout) if proc.stdout.strip() else None
        err = proc.stderr + proc.stdout
        if re.search(r"rate limit|secondary|HTTP 403|HTTP 429|abuse|HTTP 5\d\d", err, re.I) and attempt < 13:
            wait = min(60 * 2 ** min(attempt, 4), 600)  # 1, 2, 4, 8, 10, 10, ... minutes
            print(f"  GitHub asked us to slow down; waiting {wait}s (attempt {attempt + 1})", flush=True)
            time.sleep(wait)
            continue
        raise GhError(f"{method} {path}\n{err.strip()}")
    raise GhError(f"{method} {path}: gave up after retries")


def gh_list(path: str) -> list[dict]:
    out: list[dict] = []
    page = 1
    sep = "&" if "?" in path else "?"
    while True:
        chunk = gh("GET", f"{path}{sep}per_page=100&page={page}")
        out += chunk  # type: ignore[arg-type]
        if len(chunk) < 100:  # type: ignore[arg-type]
            return out
        page += 1


# --------------------------------------------------------------------------
# Parsing
# --------------------------------------------------------------------------


@dataclass
class Entity:
    kind: str  # "epic" | "item"
    ident: str
    title: str
    meta: dict[str, str]
    fields: dict[str, str]
    line: int
    items: list[str] = field(default_factory=list)

    def _list(self, key: str) -> list[str]:
        raw = self.meta.get(key, "[]").strip()
        return [x.strip() for x in raw.strip("[]").split(",") if x.strip()]

    @property
    def labels(self) -> list[str]:
        return self._list("labels")

    @property
    def depends(self) -> list[str]:
        return self._list("depends")

    @property
    def ready(self) -> bool:
        return self.meta.get("ready", "true").strip().lower() == "true"


def parse(text: str) -> tuple[dict[str, str], list[Entity], list[Entity]]:
    lines = text.splitlines()
    start = next((i for i, ln in enumerate(lines) if re.match(r"^## \S+ — ", ln)), None)
    if start is None:
        raise SystemExit("roadmap: no `## <id> — <title>` epic heading found")
    pm = re.search(r"^```phases\n(.*?)^```", "\n".join(lines[:start]), re.S | re.M)
    if not pm:
        raise SystemExit("roadmap: no ```phases block above the first epic")
    phases = dict(re.findall(r"^(\S+):[ \t]*(.+)$", pm.group(1), re.M))

    epics: list[Entity] = []
    items: list[Entity] = []
    current: Entity | None = None
    i = start
    while i < len(lines):
        m_epic = re.match(r"^## (\S+) — (.*)$", lines[i])
        m_item = re.match(r"^### (.+)$", lines[i])
        if not (m_epic or m_item):
            i += 1
            continue
        heading_line = i + 1
        kind = "epic" if m_epic else "item"
        title = m_epic.group(2).strip() if m_epic else m_item.group(1).strip()
        i += 1
        while i < len(lines) and not lines[i].strip():
            i += 1
        want = "```epic" if m_epic else "```meta"
        if i >= len(lines) or lines[i].strip() != want:
            raise SystemExit(f"roadmap:{heading_line}: '{title}' is not followed by a {want} block")
        i += 1
        block: list[str] = []
        while i < len(lines) and lines[i].strip() != "```":
            block.append(lines[i])
            i += 1
        i += 1
        meta = dict(re.findall(r"^(\w+):[ \t]*(.*)$", "\n".join(block), re.M))

        prose: list[str] = []
        in_fence = False
        while i < len(lines):
            nxt = lines[i]
            if nxt.lstrip().startswith("```"):
                in_fence = not in_fence
            elif not in_fence and (re.match(r"^#{2,3} ", nxt) or nxt.strip() == "---"):
                break
            prose.append(nxt)
            i += 1

        fields: dict[str, list[str]] = {}
        cur: str | None = None
        for ln in prose:
            fm = FIELD_RE.match(ln)
            if fm:
                cur = fm.group(1)
                fields[cur] = [fm.group(2)] if fm.group(2) else []
            elif cur:
                fields[cur].append(ln)
        ident = meta.get("id", "").strip()
        if not ident:
            raise SystemExit(f"roadmap:{heading_line}: '{title}' has no `id:`")
        ent = Entity(kind, ident, title, meta, {k: "\n".join(v).strip() for k, v in fields.items()}, heading_line)
        if kind == "epic":
            epics.append(ent)
            current = ent
        else:
            if current is None:
                raise SystemExit(f"{ident}: item appears before any epic")
            items.append(ent)
            current.items.append(ident)
    return phases, epics, items


# --------------------------------------------------------------------------
# Validation (mirrors .claude/scripts/issue-readiness.sh)
# --------------------------------------------------------------------------


def validate(phases: dict[str, str], epics: list[Entity], items: list[Entity]) -> list[str]:
    problems: list[str] = []
    by_id = {e.ident: e for e in (*epics, *items)}
    seen: set[str] = set()
    for e in (*epics, *items):
        if e.ident in seen:
            problems.append(f"{e.ident}: duplicate id")
        seen.add(e.ident)

    def labels_ok(e: Entity, need_type: bool) -> None:
        for lab in e.labels:
            if lab.startswith("status:"):
                problems.append(f"{e.ident}: `{lab}` is machine-managed and never declared here")
            elif lab not in KNOWN:
                problems.append(f"{e.ident}: label '{lab}' is not in .claude/workflow.json / the base set")
        types = [lab for lab in e.labels if lab in TYPES]
        if need_type and len(types) != 1:
            problems.append(f"{e.ident}: needs exactly one type label, has {types or 'none'}")
        if e.kind == "item" and not [lab for lab in e.labels if lab in AREAS]:
            problems.append(f"{e.ident}: needs at least one area:* label")

    for ep in epics:
        if ep.meta.get("phase", "").strip() not in phases:
            problems.append(f"{ep.ident}: phase '{ep.meta.get('phase')}' is not in the ```phases block")
        if not ep.items:
            problems.append(f"{ep.ident}: epic has no items")
        for req in ("Summary", "Done when"):
            if not ep.fields.get(req):
                problems.append(f"{ep.ident}: epic needs **{req}**")
        labels_ok(ep, need_type=False)

    for it in items:
        parent = it.meta.get("epic", "").strip()
        if parent not in {e.ident for e in epics}:
            problems.append(f"{it.ident}: epic '{parent}' does not exist")
        elif not it.ident.startswith(parent + "."):
            problems.append(f"{it.ident}: item ids are `{parent}.<n>`")
        if "epic" in it.labels:
            problems.append(f"{it.ident}: `epic` belongs on epics only")
        if MAINTAINER and (MAINTAINER in it.labels) != (it.meta.get("maintainer", "false").strip() == "true"):
            problems.append(f"{it.ident}: `maintainer:` disagrees with label `{MAINTAINER}`")
        for dep in it.depends:
            if dep == it.ident:
                problems.append(f"{it.ident}: depends on itself")
            elif dep not in by_id:
                problems.append(f"{it.ident}: depends on unknown id '{dep}'")
        for req in ("Summary", "Design references", "Acceptance criteria", "Scope"):
            if not it.fields.get(req):
                problems.append(f"{it.ident}: needs **{req}**")
        if set(it.labels) & {"feat", "bug", "chore"} and not it.fields.get("Out of scope"):
            problems.append(f"{it.ident}: needs **Out of scope** (write `none` if nothing)")
        crit = it.fields.get("Acceptance criteria", "")
        if "- [ ]" not in crit:
            problems.append(f"{it.ident}: **Acceptance criteria** must be a `- [ ]` checklist")
        if set(it.labels) & {"feat", "bug"} and "dependencies" not in it.labels and not re.search(r"Reachable via", crit, re.I):
            problems.append(f"{it.ident}: feat/bug needs a `Reachable via:` criterion")
        if len(it.title) > 80:
            problems.append(f"{it.ident}: title is {len(it.title)} characters (max 80)")
        labels_ok(it, need_type=True)

    for e in (*epics, *items):
        text = render_body(e)
        for rule in WORKFLOW.get("readiness", {}).get("stale", []):
            for ln in text.splitlines():
                if re.search(rule["pattern"], ln) and not (rule.get("exempt") and re.search(rule["exempt"], ln)):
                    problems.append(f"{e.ident}: stale term /{rule['pattern']}/ — {rule['reason']}")
                    break

    state: dict[str, int] = {}

    def visit(node: str, stack: list[str]) -> None:
        if state.get(node) == 1:
            problems.append("dependency cycle: " + " -> ".join(stack + [node]))
            return
        if state.get(node) == 2:
            return
        state[node] = 1
        for dep in by_id[node].depends:
            if dep in by_id:
                visit(dep, stack + [node])
        state[node] = 2

    for it in items:
        visit(it.ident, [])
    return problems


# --------------------------------------------------------------------------
# Rendering
# --------------------------------------------------------------------------


def marker(ident: str) -> str:
    return f"<!-- roadmap:{ident} -->"


def render_body(e: Entity) -> str:
    f = e.fields
    out: list[str] = []
    if e.kind == "epic":
        out += ["## Original report", "", f.get("Done when", ""), ""]
        out += ["## Summary", "", f.get("Summary", ""), ""]
        if f.get("Design references"):
            out += ["## Design references", "", f["Design references"], ""]
        out += ["## Goal", "", f.get("Goal") or f.get("Done when", ""), ""]
        if f.get("Product rules"):
            out += ["## Product rules", "", f["Product rules"], ""]
        out += ["## Out of scope", "", f.get("Out of scope") or "none", ""]
    else:
        out += ["## Original report", "", f.get("Summary", ""), ""]
        out += ["## Summary", "", f.get("Summary", ""), ""]
        out += ["## Design references", "", f.get("Design references", ""), ""]
        out += ["## Current state", "", f.get("Current state") or "nothing yet", ""]
        out += ["## Acceptance criteria", "", f.get("Acceptance criteria", ""), ""]
        if f.get("Out of scope"):
            out += ["## Out of scope", "", f["Out of scope"], ""]
        out += ["## Scope hint", "", f.get("Scope", ""), ""]
    out.append(marker(e.ident))
    return "\n".join(out).strip() + "\n"


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("ids", nargs="*", help="only these entries (and their epics)")
    ap.add_argument("--roadmap", type=Path, default=DEFAULT_ROADMAP)
    ap.add_argument("--validate", action="store_true")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--yes", action="store_true")
    ap.add_argument("--keep", action="store_true", help="do not delete the roadmap after a full apply")
    ap.add_argument("--no-ready", action="store_true", help="leave every issue at status:new")
    args = ap.parse_args()

    phases, epics, items = parse(args.roadmap.read_text())
    problems = validate(phases, epics, items)
    by_id = {e.ident: e for e in (*epics, *items)}
    problems += [f"unknown id on the command line: {i}" for i in args.ids if i not in by_id]
    if problems:
        print("Validation failed:\n")
        for p in problems:
            print(f"  ✗ {p}")
        return 1
    print(f"Parsed {len(phases)} phases, {len(epics)} epics, {len(items)} items — valid.")
    if args.validate:
        return 0

    epic_of = {it.ident: by_id[it.meta["epic"].strip()] for it in items}
    milestone_of = lambda e: phases[(e if e.kind == "epic" else epic_of[e.ident]).meta["phase"].strip()]  # noqa: E731
    wanted = set(args.ids)
    sel_items = [it for it in items if not wanted or it.ident in wanted or epic_of[it.ident].ident in wanted]
    sel_epics = [ep for ep in epics if not wanted or ep.ident in wanted or any(epic_of[i.ident] is ep for i in sel_items)]
    full_run = not wanted

    try:
        gh("GET", f"repos/{REPO}")
        existing = {}
        for issue in gh_list(f"repos/{REPO}/issues?state=all"):
            if "pull_request" in issue:
                continue
            m = re.search(r"<!-- roadmap:(\S+) -->", issue.get("body") or "")
            if m:
                existing[m.group(1)] = issue
        have_labels = {lab["name"] for lab in gh_list(f"repos/{REPO}/labels")}
        need_labels = {"epic"} | {lab for e in (*sel_epics, *sel_items) for lab in e.labels}
        missing_labels = sorted(need_labels - have_labels)
        milestones = {m["title"]: m["number"] for m in gh_list(f"repos/{REPO}/milestones?state=all")}
        missing_ms = sorted({milestone_of(e) for e in (*sel_epics, *sel_items)} - milestones.keys())
        todo = [e for e in (*sel_epics, *sel_items) if e.ident not in existing]

        if not args.apply:
            print(f"Target repo: {REPO}\nDRY RUN — nothing will be created. Re-run with --apply.\n")
            if missing_labels:
                print(f"Labels missing (run .claude/scripts/bootstrap-labels.sh): {', '.join(missing_labels)}")
            if missing_ms:
                print(f"Milestones to create: {', '.join(missing_ms)}")
            print(f"\nIssues to create ({len(todo)}), already filed: {len(existing)}")
            for ep in sel_epics:
                print(f"  [epic] {ep.ident:<7} {ep.title}   ({milestone_of(ep)})")
                for it in (i for i in sel_items if epic_of[i.ident] is ep):
                    flags = "".join(f" [{x}]" for x in (RISK, MAINTAINER) if x and x in it.labels)
                    deps = f"  ← {', '.join(it.depends)}" if it.depends else ""
                    print(f"      {it.ident:<9} {it.title}{flags}{deps}")
            return 0

        if missing_labels:
            print(f"Labels missing: {', '.join(missing_labels)} — run .claude/scripts/bootstrap-labels.sh first.")
            return 1
        if full_run:
            rel = args.roadmap.resolve().relative_to(ROOT)
            dirty = subprocess.run(["git", "status", "--porcelain", "--", str(rel)], capture_output=True, text=True, cwd=ROOT).stdout.strip()
            tracked = subprocess.run(["git", "ls-files", "--error-unmatch", str(rel)], capture_output=True, cwd=ROOT).returncode == 0
            if not args.keep and (dirty or not tracked):
                print(f"{rel} must be committed and unmodified before --apply, because the script deletes it afterwards.")
                return 1
        if len(todo) > 10 and not args.yes:
            print(f"About to create {len(todo)} issues in {REPO} — visible, hard-to-undo work.")
            if input("Type 'yes' to continue: ").strip().lower() != "yes":
                print("Aborted — nothing created.")
                return 0

        for title in missing_ms:
            milestones[title] = gh("POST", f"repos/{REPO}/milestones", {"title": title})["number"]  # type: ignore[index]

        def status_of(e: Entity) -> str:
            ready = e.kind == "item" and e.ready and not args.no_ready and not (MAINTAINER and MAINTAINER in e.labels)
            return "status:ready" if ready else "status:new"

        def create(e: Entity) -> dict:
            labels = sorted(set(e.labels) | {status_of(e)} | ({"epic"} if e.kind == "epic" else set()))
            issue = gh("POST", f"repos/{REPO}/issues", {
                "title": e.title, "body": render_body(e), "labels": labels,
                "milestone": milestones[milestone_of(e)],
            })
            existing[e.ident] = issue  # type: ignore[assignment]
            print(f"  {'epic' if e.kind == 'epic' else 'sub '} #{issue['number']:<5} {e.ident}  {e.title}")  # type: ignore[index]
            time.sleep(1.2)
            return issue  # type: ignore[return-value]

        for ep in sel_epics:
            if ep.ident not in existing:
                create(ep)
            for it in (i for i in sel_items if epic_of[i.ident] is ep):
                if it.ident not in existing:
                    create(it)

        # Relationship pass over everything filed, so a re-run heals gaps.
        linked = 0
        for it in sel_items:
            issue = existing[it.ident]
            n = issue["number"]
            parent = existing[epic_of[it.ident].ident]
            cur_parent = gh("GET", f"repos/{REPO}/issues/{n}").get("parent_issue_url")  # type: ignore[union-attr]
            if not cur_parent or not cur_parent.endswith(f"/{parent['number']}"):
                gh("POST", f"repos/{REPO}/issues/{parent['number']}/sub_issues", {"sub_issue_id": issue["id"]})
                linked += 1
                time.sleep(0.6)
            have = {d["number"] for d in gh_list(f"repos/{REPO}/issues/{n}/dependencies/blocked_by")}
            for dep in it.depends:
                target = existing.get(dep)
                if target and target["number"] not in have:
                    gh("POST", f"repos/{REPO}/issues/{n}/dependencies/blocked_by", {"issue_id": target["id"]})
                    linked += 1
                    time.sleep(0.6)

        # Verify before reporting success (and before deleting the roadmap).
        problems_after: list[str] = []
        for e in (*sel_epics, *sel_items):
            if e.ident not in existing:
                problems_after.append(f"{e.ident}: no issue")
        for it in sel_items:
            n = existing[it.ident]["number"]
            parent = existing[epic_of[it.ident].ident]["number"]
            got = gh("GET", f"repos/{REPO}/issues/{n}").get("parent_issue_url") or ""  # type: ignore[union-attr]
            if not got.endswith(f"/{parent}"):
                problems_after.append(f"{it.ident}: #{n} is not a sub-issue of #{parent}")
            have = {d["number"] for d in gh_list(f"repos/{REPO}/issues/{n}/dependencies/blocked_by")}
            for dep in it.depends:
                t = existing.get(dep)
                if t and t["number"] not in have:
                    problems_after.append(f"{it.ident}: #{n} is not blocked by {dep} (#{t['number']})")
                elif not t and full_run:
                    problems_after.append(f"{it.ident}: dependency {dep} has no issue")
        if problems_after:
            print("\nVerification failed — the roadmap is kept:")
            for p_ in problems_after:
                print(f"  ✗ {p_}")
            return 2
    except GhError as exc:
        print(f"\nStopped: {exc}\nRe-run to continue; filed issues are recognised by their roadmap marker.", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        print("\nInterrupted — re-run to continue.", file=sys.stderr)
        return 2

    print(f"\nDone: {len(todo)} issues created, {linked} relationships added.")
    if full_run and not args.keep:
        args.roadmap.unlink()
        print(f"Deleted {args.roadmap.relative_to(ROOT)} (the issues are the plan now; it is in git history). Commit the deletion.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
