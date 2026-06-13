# Agent session memory (local only)

Working notes for orchestrator execution and verification agents. **Not tracked in git** — see [DO-204](https://mdg-labs.atlassian.net/browse/DO-204).

| Directory  | Purpose                                                    |
| ---------- | ---------------------------------------------------------- |
| `active/`  | In-flight session for the current task (`<SESSION-ID>.md`) |
| `archive/` | Optional local retention after verify (never committed)    |

Verified outcomes are recorded on the **Jira issue** (verifier `Done` / `Ready` comment), not in this repo.
