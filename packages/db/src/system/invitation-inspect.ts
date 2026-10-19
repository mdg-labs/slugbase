import type { InvitationInspectStore, WorkspaceRole } from "@slugbase/core";
import type postgres from "postgres";

// The wrapper of the system operation behind `POST /invitations/inspect` (doc 05 section 3.3, doc 02 section 3.4,
// doc 04 section 10.5, doc 10 T4): the one place an invitation is read by its token. It runs on the pool of the
// auth store, as the application role, outside any tenant transaction: the token is the only credential.

interface PreviewRow {
  workspace_name: string;
  inviter_name: string | null;
  invited_email: string;
  invited_role: string;
  account_exists: boolean;
}

const TOKEN_HASH_BYTES = 32;

function roleOf(value: string): WorkspaceRole {
  if (value === "owner" || value === "admin" || value === "member") {
    return value;
  }
  throw new Error("sys_invitation_inspect returned a role outside owner, admin and member");
}

/** Binds the invitation inspection to a connection pool that connects as the application role. */
export function bindInvitationInspectStore(client: postgres.Sql): InvitationInspectStore {
  return {
    async inspectInvitation(tokenHash) {
      if (tokenHash.length !== TOKEN_HASH_BYTES) {
        throw new RangeError(`tokenHash must be a ${String(TOKEN_HASH_BYTES)}-byte SHA-256 digest`);
      }
      const rows = await client<PreviewRow[]>`
        SELECT workspace_name, inviter_name, invited_email, invited_role, account_exists FROM sys_invitation_inspect(${tokenHash}::bytea)`;
      if (rows.length > 1) {
        throw new Error("sys_invitation_inspect returned more than one row");
      }
      const row = rows[0];
      return row === undefined
        ? undefined
        : {
            workspaceName: row.workspace_name,
            inviterName: row.inviter_name,
            email: row.invited_email,
            role: roleOf(row.invited_role),
            accountExists: row.account_exists,
          };
    },
  };
}
