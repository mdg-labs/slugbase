# Threat-model format

`security-audit` judges every finding against one document: the file
`.claude/workflow.json` `threatModel` names. The skill, its templates and its
agents refer to that document by section, so it must have the sections below,
as `##` headings numbered exactly like this, in this order. The heading text
after the number is free; the number and its meaning are not.

| Section | Holds | Referred to as |
|---------|-------|----------------|
| `## 1. Assets` | What an attacker wants: data, secrets, availability, the host. A finding's impact names one. | "the threat model's assets (§1)" |
| `## 2. Attackers` | One `### 2.<n> <name>` per attacker, each with its **capability**: what it can already do, what it cannot. One of them is the **trust ceiling** (usually the signed-in admin): what it can do by design is never a finding. | "a §2 attacker", by number (`2.3`) |
| `## 3. Entry points, mapped to code` | Every place input from outside a trust boundary arrives, each with a **bold name** and the repo paths that own it (listener, handlers, sockets, file imports, outbound fetches, CI). | "a §3 entry point", by its bold name |
| `## 4. Security invariants` | Numbered `T1`, `T2`, … `Tn`: properties that must hold (e.g. "no root write through a path a lower-trust principal controls"). Ids are never reused or renumbered. | "invariant `T<n>`" |
| `## 5. Accepted residuals` | Numbered risks the project accepts on purpose, each with its reason. A path that is one of them is `ACCEPTED-RESIDUAL <n>`, not a finding. | "accepted residual `<n>`" |
| `## 6. Severity rubric` | `critical`, `high`, `medium`, `low`, `info`, each defined by outcome and attacker, followed by **anti-inflation rules** (a path that needs the trust ceiling, a capability the attacker lacks, a developer flag, a mock or a test helper is not Critical or High) and, ideally, worked examples. A finding is rated at the **lowest** level whose definition it meets after those rules. | "the rubric (§6)" |
| `## 7. Disclosure split` | Where a confirmed finding goes: Critical and High are withheld as draft private security advisories until fixed; Medium and lower are public items labelled `security`. Also how outside reports arrive (private vulnerability reporting, `SECURITY.md`). | "the disclosure split (§7)" |

Anything after §7 (open questions, history) is ignored by the audit.

## What the skill does with it

- **§§1–6 are pasted verbatim** into every reviewer and verifier dispatch:
  the text from the `## 1.` heading up to, not including, the `## 7.` heading,
  read from the audit's read-only clone. Keep them self-contained; a
  reference to another document is not followed.
- **§2 numbers and §4 ids** appear in CLAUDE.md `### Security units` and in
  every finding (`invariant: T<n>`), so renumbering them breaks old reports
  and the unit table. Add new ones at the end.
- **§7's split is enforced mechanically** by `.claude/scripts/audit-report.sh`:
  a `critical` or `high` finding must be withheld, and anything sharing its
  root cause is withheld with it.

## Missing or partial

With `threatModel` null or the file missing, `security-audit` stops: an audit
with no yardstick only produces opinions. A model whose headings do not follow
this table is a stop too; the skill names the section it could not find.
