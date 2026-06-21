# Orchestrator — Slack session-end notifications

## Why sender ≠ recipient

Slack MCP is connected as the **shared service account** so operators get push notifications (self-DMs from your own account do not notify).

| Role | Account | Slack user ID |
|---|---|---|
| **Sender (MCP auth)** | `cursor@mdg-labs.dev` | `U0BB4FVDUNR` |
| **Recipient (operator DM)** | personal workspace member | see **Default operator** below |

Orchestrator **must not** DM the authenticated MCP user when auth is the service account — that only messages the bot to itself.

## Default operator

Session-end DMs go to this user unless the run overrides (see below).

| Field | Value |
|---|---|
| Display name | Michael (operator) |
| Email | *(set your @mdg-labs Slack email if using search fallback)* |
| **user_id** | `U0ARDEK75UJ` |

Update `user_id` when the default operator changes. Find it: Slack profile → ⋮ → Copy member ID, or MCP `slack_search_users` with the operator's workspace email.

## Recipient resolution (orchestrator)

Apply in order:

1. **Run override** — user said `slack to <email>` or `slack to <user_id>` in the orchestrator prompt → use that recipient only for this run.
2. **This file** — `user_id` from **Default operator** table above.
3. **Search fallback** — if `user_id` is missing/placeholder, MCP `slack_search_users` with the operator email from this file (not GitHub/git email).
4. **Skip** — if still unresolved → `SLACK_DM: SKIPPED (no operator recipient)`; do not DM the service account.

## Sender sanity check (optional)

Before send, MCP `slack_read_user_profile` (no `user_id`) should return `cursor@mdg-labs.dev` / `U0BB4FVDUNR`. If auth is a personal account instead, warn in chat: notifications may not fire; reconnect MCP as the service account.

## Send

MCP `plugin-slack-slack` → `slack_send_message`:

- `channel_id`: operator **recipient** `user_id` (not the authenticated user)
- `message`: template from [SKILL.md](SKILL.md) § Session-end Slack DM

Confirm in chat: `Slack DM sent to <operator name> (from cursor@mdg-labs.dev)` + permalink.
