# Agent instructions (OpenCode)

This repository's agent workflow was written for Claude Code and lives in `.claude/`. OpenCode reads only this
file, so it points at the real sources. Do not copy their content here.

## Read first

Before any work, read these files in full. They are the project's rules:

- `CLAUDE.md`, above all `## Agent workflow` (project, design docs, area → paths, hazards, implementation rules,
  risk review, security units, machine check).
- `.claude/rules/mdg-git.md` and `.claude/rules/mdg-security.md` (commits, trailers, staging, pushing, security handling).
- `.claude/workflow.json` (branches, gate, per-path checks, risk paths, models).

Never add attribution to a commit, pull request or comment: no `Co-Authored-By`, no session link, no
"Generated with" line.

## Skills

The skills in `.claude/skills/` (`orchestrate`, `triage`, `cr-review`, `open-pr`, `dev-diff`, `security-audit`,
`customer-docs`) are discovered from there. Follow them as written, with the translations below.

## Translating Claude Code terms

| The skills say | In OpenCode |
|---|---|
| `Agent({ subagent_type, model, description, prompt })` | the `subagent` tool: `agent` = `subagent_type`, same `description` and `prompt` (still inline and in full) |
| `model: "sonnet"` | omit `model`; every agent in `.opencode/agents/` carries its own model |
| `model: "opus"` for a verifier or refiner | use the agent `task-verifier-opus` or `issue-refiner-opus`; never set `model` |
| dispatch lanes "in one message" | one `subagent` call per lane head, all `background: true`, in the same message; then end the turn |
| `AskUserQuestion` | the `question` tool |
| `Bash` | the `shell` tool |
| `TaskStop` | none: stop is a user action. Ask the user to interrupt the child session, confirm nothing is still running, then redispatch |
| `ToolSearch` (Kaneo tool loading) | not needed; MCP tools are listed directly |
| session scratchpad `<scratchpad>/orchestrate` (`S`) | `/tmp/opencode/orchestrate` |
| `allowed-tools` in a skill's frontmatter | ignored; permissions come from `.opencode/opencode.jsonc` and the agent files |

## Agents

`.opencode/agents/*.md` are generated from `.claude/agents/*.md`. Never edit them by hand. Change the source, then
run `node .opencode/scripts/sync-agents.mjs`. `node .opencode/scripts/sync-agents.mjs --check` fails when they are
stale. The script also holds the translation of each agent's tool restrictions into OpenCode permission rules.

The default OpenCode policy allows every tool, so nothing prompts. Treat these as hard rules anyway: stage explicit
paths only, never force-push, never push to `main`, never merge a pull request. `.opencode/opencode.jsonc` blocks
the mechanical ones.
