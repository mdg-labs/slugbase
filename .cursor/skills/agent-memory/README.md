# Agent session memory (local only)

Working notes for orchestrator execution and verification agents. **Not tracked in git** — gitignored.

| Directory | Purpose |
|---|---|
| `active/` | In-flight session for the current task (`<SESSION-ID>.md`) |
| `archive/` | Optional local retention after verify (never committed) |

Verified outcomes are recorded on the **Linear issue** (`save_comment` + state Done; syncs to GitHub). Session files are created and deleted locally; they never leave the machine.
