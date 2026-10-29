import type { FolderShareGrant, FolderShareList, FolderShareRecord, FolderShareStore, NewFolderShare } from "@slugbase/core";
import { and, eq, sql } from "drizzle-orm";
import { accounts } from "../schema/accounts.ts";
import { folders } from "../schema/folders.ts";
import { folderShares } from "../schema/shares.ts";
import { teams } from "../schema/teams.ts";
import { TenantContextError, tenantHandle, type TenantTx } from "../tenant.ts";
import { defineScopedRepository } from "./scoped.ts";

// The shares of folders (doc 05 section 2.5, doc 02 section 8, doc 10 T1, T2 and T11), with the shape and the rules of the shares of bookmarks
// (src/repositories/bookmark-shares.ts). Every statement names the workspace of the transaction, and the policies of `folder_shares`
// (src/sql/660-folder-shares.sql) admit a write only for a folder owned by the account of the transaction, in its own name, so a statement that forgot a
// predicate still writes no share of anyone else's folder. The caller of a write has checked that the folder is the account's own; the repository checks
// it again under the lock it takes (`ownedFolder`).
//
// A share of a folder reaches every bookmark filed in the folder, now and later, because the grant names the folder and not its bookmarks: a bookmark
// filed in the folder later is covered by the rows that exist, and one taken out of it is not. A grant locks the folder, and then its target (the
// membership row of a member, the row of a team), with `FOR KEY SHARE` before it writes: a member who leaves the workspace and a team that is deleted
// at the same time are then either found gone or waited for, and never met half-way by the composite foreign key of the share. Sharing twice with one
// target is one share: the insert does nothing for a target the folder is shared with already, and the share that exists is read back.

// The registry entry of `folder_shares` for the cross-tenant matrix (doc 08 section 3.3): the application role may read, insert (the columns of a grant) and
// delete shares, and the policies keep each to the workspace of the transaction and, for a write, to the account's own folder. Shares are written by
// `grant`, whose statement is the one the entry's insert is judged by, and removed through the entry's delete.
const scoped = defineScopedRepository("folder_shares", folderShares, {
  methods: ["select", "insert", "delete"],
  insertColumns: ["id", "folderId", "targetAccountId", "targetTeamId", "grantedBy"],
});

/** How often a grant that met a share another transaction revoked at that moment tries again. */
const GRANT_ATTEMPTS = 3;

function requireWorkspace(tx: TenantTx): string {
  if (tx.workspaceId === undefined) {
    throw new TenantContextError("workspace_required", "the shares of a workspace need a tenant transaction opened with a workspace");
  }
  return tx.workspaceId;
}

interface ShareRow extends Record<string, unknown> {
  id: string;
  folder_id: string;
  target_account_id: string | null;
  target_team_id: string | null;
  created_at: Date;
  name: string | null;
  email: string | null;
}

function recordOf(row: ShareRow): FolderShareRecord {
  if (row.name === null) {
    throw new Error("the target of a share cannot be read");
  }
  return {
    id: row.id,
    folderId: row.folder_id,
    accountId: row.target_account_id,
    teamId: row.target_team_id,
    name: row.name,
    email: row.email,
    createdAt: new Date(row.created_at),
  };
}

/**
 * The shares of the folder in the order of their creation, or the one share `filter.shareId`, or the one that names `filter.target`, with the name of
 * their target as it is now: the display name and address of a member (the co-member projection of its account), the name of a team.
 */
async function sharesOf(tx: TenantTx, folderId: string, filter: { readonly shareId?: string; readonly target?: NewFolderShare["target"] } = {}): Promise<FolderShareRecord[]> {
  const workspaceId = requireWorkspace(tx);
  const { shareId, target } = filter;
  const rows = await tenantHandle(tx).execute<ShareRow>(sql`
    SELECT s.id, s.folder_id, s.target_account_id, s.target_team_id, s.created_at, coalesce(a.display_name, t.name::text) AS name, a.email::text AS email
    FROM ${folderShares} s
    LEFT JOIN ${accounts} a ON a.id = s.target_account_id
    LEFT JOIN ${teams} t ON t.workspace_id = s.workspace_id AND t.id = s.target_team_id
    WHERE s.workspace_id = ${workspaceId}::uuid AND s.folder_id = ${folderId}::uuid
      ${shareId === undefined ? sql`` : sql`AND s.id = ${shareId}::uuid`}
      ${target === undefined ? sql`` : target.kind === "member" ? sql`AND s.target_account_id = ${target.accountId}::uuid` : sql`AND s.target_team_id = ${target.teamId}::uuid`}
    ORDER BY s.created_at, s.id`);
  return rows.map(recordOf);
}

/** The distinct members other than the owner who can read the folder through its shares: the members it is shared with and those of the teams it is shared with. */
async function audienceOf(tx: TenantTx, folderId: string): Promise<number> {
  const workspaceId = requireWorkspace(tx);
  const [row] = await tenantHandle(tx).execute<{ audience: number }>(sql`
    SELECT count(DISTINCT audience.account_id)::int AS audience
    FROM (
      SELECT s.target_account_id AS account_id
      FROM ${folderShares} s
      WHERE s.workspace_id = ${workspaceId}::uuid AND s.folder_id = ${folderId}::uuid AND s.target_account_id IS NOT NULL
      UNION ALL
      SELECT m.account_id
      FROM ${folderShares} s
      JOIN public.team_members m ON m.workspace_id = s.workspace_id AND m.team_id = s.target_team_id
      WHERE s.workspace_id = ${workspaceId}::uuid AND s.folder_id = ${folderId}::uuid
    ) audience
    WHERE audience.account_id IS DISTINCT FROM (SELECT f.owner_id FROM ${folders} f WHERE f.workspace_id = ${workspaceId}::uuid AND f.id = ${folderId}::uuid)`);
  return row?.audience ?? 0;
}

export type FolderShareRepository = FolderShareStore;

export function folderShareRepository(tx: TenantTx): FolderShareRepository {
  const rows = scoped.bind(tx);
  return {
    async ownedFolder({ folderId, ownerId, use }) {
      const workspaceId = requireWorkspace(tx);
      const query = tenantHandle(tx)
        .select({ id: folders.id })
        .from(folders)
        .where(and(eq(folders.workspaceId, workspaceId), eq(folders.id, folderId), eq(folders.ownerId, ownerId)));
      return (use === "grant" ? await query.for("key share") : await query).length === 1;
    },

    async list(folderId): Promise<FolderShareList> {
      return { shares: await sharesOf(tx, folderId), audienceSize: await audienceOf(tx, folderId) };
    },

    async grant({ id, folderId, grantedBy, target }): Promise<FolderShareGrant> {
      const workspaceId = requireWorkspace(tx);
      const handle = tenantHandle(tx);
      const held =
        target.kind === "member"
          ? await handle.execute(sql`
              SELECT account_id FROM public.workspace_members
              WHERE workspace_id = ${workspaceId}::uuid AND account_id = ${target.accountId}::uuid
              FOR KEY SHARE`)
          : await handle
              .select({ id: teams.id })
              .from(teams)
              .where(and(eq(teams.workspaceId, workspaceId), eq(teams.id, target.teamId)))
              .for("key share");
      if (held.length === 0) {
        return { kind: "unknown_target" };
      }
      for (let attempt = 0; attempt < GRANT_ATTEMPTS; attempt += 1) {
        // The statement names the columns the application role may insert (a column grant). `ON CONFLICT DO NOTHING` leaves a target the folder is shared with already, whichever of the two unique indexes judges it.
        const inserted = await handle.execute(sql`
          INSERT INTO ${folderShares} (id, workspace_id, folder_id, target_account_id, target_team_id, granted_by)
          VALUES (${id}::uuid, ${workspaceId}::uuid, ${folderId}::uuid, ${target.kind === "member" ? target.accountId : null}::uuid, ${target.kind === "team" ? target.teamId : null}::uuid, ${grantedBy}::uuid)
          ON CONFLICT DO NOTHING
          RETURNING id`);
        const [share] = await sharesOf(tx, folderId, inserted.length === 1 ? { shareId: id } : { target });
        if (share !== undefined) {
          return { kind: inserted.length === 1 ? "granted" : "existing", share };
        }
        // The share that made the insert do nothing was revoked before it could be read back: the insert is tried again.
      }
      throw new Error("a share could neither be written nor found");
    },

    async revoke({ folderId, shareId }) {
      const [share] = await sharesOf(tx, folderId, { shareId });
      if (share === undefined) {
        return undefined;
      }
      const deleted = await rows.delete(and(eq(folderShares.id, shareId), eq(folderShares.folderId, folderId)));
      return deleted.length === 1 ? share : undefined;
    },
  };
}
